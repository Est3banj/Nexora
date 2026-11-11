import { randomUUID } from "node:crypto";
import {
  EXPECTED_FROM_PAYMENTS_SQL,
  arqueoDiff,
  parseExpectedRow,
  type ExpectedBreakdown,
} from "@pos/shared";
import type { Pool, PoolClient } from "pg";
import { pool } from "./index";

/**
 * Arqueo close (task D3-2, design §7) — raw Postgres transaction.
 *
 * WHY raw SQL and not the drizzle builder: the close must compute
 * `expected` from the payments table INSIDE the same transaction that
 * locks the shift and writes `closedcash`, using the exact statement the
 * offline client runs (@pos/shared EXPECTED_FROM_PAYMENTS_SQL). Sharing
 * the SQL text is what makes the D3-3 reconciliation property
 * (local expected == server recomputation) hold by construction.
 *
 * Invariant (cash-close spec):
 *  - expected = confirmed cash + confirmed transfers + cash abonos of the
 *    shift (pending EXCLUDED; credit payments and transfer abonos enter
 *    neither expected nor pending)
 *  - diff = counted − expected, derived, never editable
 *  - closedcash is IMMUTABLE: ON CONFLICT DO NOTHING, no update path
 *  - close requires the tenant's OPEN shift; otherwise blocked
 */

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type ClosedCashRow = {
  id: string;
  tenant_id: string;
  client_uuid: string;
  shift_id: string;
  expected: number;
  counted: number;
  diff: number;
  closed_by: string | null;
};

export type CloseShiftResult =
  | { closedcash: ClosedCashRow; expected: ExpectedBreakdown; diff: number }
  | { error: "not_found" | "not_open" | "already_closed" };

/** Read-only expected computation — same SQL as the offline close path. */
export async function computeExpected(
  tenantId: string,
  shiftId: string,
  conn: Queryable = pool,
): Promise<ExpectedBreakdown> {
  const res = await conn.query(EXPECTED_FROM_PAYMENTS_SQL, [tenantId, shiftId]);
  return parseExpectedRow(res.rows[0]);
}

async function readShift(
  client: PoolClient,
  tenantId: string,
  shiftId: string,
): Promise<{ id: string; status: string } | undefined> {
  const res = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM shifts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, shiftId],
  );
  return res.rows[0];
}

/**
 * Close the tenant's open shift. One transaction:
 *   lock shift → expected from payments → insert closedcash → close shift.
 * The client supplies ONLY `counted` (≥0 int) plus an optional row uuid;
 * every money figure is derived server-side (never from the UI).
 */
export async function closeShift(input: {
  tenantId: string;
  shiftId: string;
  counted: number;
  closedBy?: string | null;
  clientUuid?: string;
}): Promise<CloseShiftResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const shift = await readShift(client, input.tenantId, input.shiftId);
    if (!shift) {
      await client.query("ROLLBACK");
      return { error: "not_found" };
    }
    if (shift.status !== "open") {
      // distinguish "already closed with an arqueo" from "never open"
      const existing = await client.query(
        `SELECT id FROM closedcash WHERE tenant_id = $1 AND shift_id = $2`,
        [input.tenantId, input.shiftId],
      );
      await client.query("ROLLBACK");
      return existing.rows[0] ? { error: "already_closed" } : { error: "not_open" };
    }

    const expected = await computeExpected(input.tenantId, input.shiftId, client);
    const diff = arqueoDiff(input.counted, expected.expected);
    const id = input.clientUuid ?? randomUUID();

    const inserted = await client.query<ClosedCashRow>(
      `INSERT INTO closedcash
         (id, tenant_id, client_uuid, shift_id, expected, counted, diff, closed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (tenant_id, shift_id) DO NOTHING
       RETURNING id, tenant_id, client_uuid, shift_id, expected, counted, diff, closed_by`,
      [
        id,
        input.tenantId,
        id,
        input.shiftId,
        expected.expected,
        input.counted,
        diff,
        input.closedBy ?? null,
      ],
    );
    if (inserted.rows.length === 0) {
      // a closedcash row already exists for this shift — never rewrite it
      await client.query("ROLLBACK");
      return { error: "already_closed" };
    }

    const closed = await client.query(
      `UPDATE shifts SET status = 'closed', closed_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'open'`,
      [input.tenantId, input.shiftId],
    );
    if (closed.rowCount === 0) {
      await client.query("ROLLBACK");
      return { error: "already_closed" };
    }

    await client.query("COMMIT");
    return { closedcash: inserted.rows[0], expected, diff };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
