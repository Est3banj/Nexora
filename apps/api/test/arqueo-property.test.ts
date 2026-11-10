import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import {
  EXPECTED_FROM_PAYMENTS_SQL,
  LOCAL_SCHEMA_SQL,
  parseExpectedRow,
} from "@pos/shared";
import * as t from "../src/db/schema";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  resetTables,
  type Actor,
} from "./helpers";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";

/**
 * D3-3 · Arqueo property + reconciliation tests [MERGE GATE].
 * AC (cash-close spec):
 *  - §Recomputation is stable — random payment sets, fast-check property
 *  - §Offline close reconciles to server value (zero drift)
 *  - §Late confirmation leaves the closed arqueo untouched
 * CI red = D3 arqueo gate red.
 */

let app: FastifyInstance;
let owner: Actor;
let repo: ReturnType<typeof scopedRepo>;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "arqueo-prop@tenant.test", orgSlug: "org-prop" });
  repo = scopedRepo(db, owner.orgId);
});

function headers() {
  return authHeaders(owner);
}

async function openShift(): Promise<{ id: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/shifts/open",
    headers: headers(),
    payload: {},
  });
  expect(res.statusCode).toBe(201);
  return res.json().shift;
}

async function closeShift(shiftId: string, counted: number) {
  return app.inject({
    method: "POST",
    url: `/api/shifts/${shiftId}/close`,
    headers: headers(),
    payload: { counted },
  });
}

async function seedSale(
  shiftId: string,
  opts: {
    amount: number;
    method: "cash" | "transfer";
    status: "pending" | "confirmed";
    ticketNo: number;
  },
) {
  const ticket = await repo.tickets.upsert({
    client_uuid: randomUUID(),
    shift_id: shiftId,
    ticket_no: opts.ticketNo,
    total: opts.amount,
    status: opts.status === "pending" ? "transfer_pending" : "completed",
  });
  return repo.payments.upsert({
    client_uuid: randomUUID(),
    ticket_id: ticket.id,
    method: opts.method,
    amount: opts.amount,
    status: opts.status,
    shift_id: shiftId,
    ...(opts.status === "confirmed" ? { confirmed_at: new Date() } : {}),
  });
}

function push(mutations: unknown[]) {
  return app.inject({
    method: "POST",
    url: "/api/sync/mutations",
    headers: headers(),
    payload: { mutations },
  });
}

describe("arqueo property (cash-close §Recomputation is stable)", () => {
  it("random payment sets → recomputed expected always equals the stored close", async () => {
    let ticketNo = 1;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            amount: fc.integer({ min: 0, max: 50_000 }),
            method: fc.constantFrom("cash" as const, "transfer" as const),
            status: fc.constantFrom("confirmed" as const, "pending" as const),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (payments, counted) => {
          // one open→close cycle per run (partial unique: one open at a time)
          const shift = await openShift();
          for (const p of payments) {
            await seedSale(shift.id, { ...p, ticketNo: ticketNo++ });
          }

          const atClose = await repo.shifts.expected(shift.id);
          const res = await closeShift(shift.id, counted);
          expect(res.statusCode).toBe(200);
          const body = res.json();

          // server-side computation at close == independent recompute
          expect(body.expected.expected).toBe(atClose.expected);

          // stored expected == recomputed after close (stability)
          const stored = await repo.closedcash.byShift(shift.id);
          const recompute = await repo.shifts.expected(shift.id);
          expect(stored?.expected).toBe(recompute.expected);
          expect(stored?.expected).toBe(body.expected.expected);

          // diff is DERIVED (counted − expected), never entered
          expect(stored?.diff).toBe(counted - recompute.expected);
          expect(body.diff).toBe(counted - body.expected.expected);

          expect((await repo.shifts.byUuid(shift.id))?.status).toBe("closed");
          expect(stored?.counted).toBe(counted);
        },
      ),
      { numRuns: 12 },
    );
  }, 60_000);
});

describe("offline close reconciliation (cash-close §Arqueo works offline)", () => {
  it("local expected E == server recomputation post-sync (zero drift)", async () => {
    /* ---------------- server: shift + payments (truth) --------------- */
    const shift = await openShift();
    await seedSale(shift.id, { amount: 12000, method: "cash", status: "confirmed", ticketNo: 9001 });
    await seedSale(shift.id, { amount: 7000, method: "cash", status: "confirmed", ticketNo: 9002 });
    await seedSale(shift.id, { amount: 4500, method: "cash", status: "confirmed", ticketNo: 9003 });
    await seedSale(shift.id, { amount: 18000, method: "transfer", status: "pending", ticketNo: 9004 });

    /* ------------- local cache: the SAME rows (offline device) ------- */
    const local = new PGlite("memory://");
    try {
      await local.exec(LOCAL_SCHEMA_SQL);
      await local.query(
        `INSERT INTO shifts (id, tenant_id, client_uuid, status, opened_at)
         VALUES ($1, $2, $1, 'open', now())`,
        [shift.id, owner.orgId],
      );
      const serverPayments = await db
        .select()
        .from(t.payments)
        .where(eq(t.payments.shift_id, shift.id));
      for (const p of serverPayments) {
        await local.query(
          `INSERT INTO payments
             (id, tenant_id, client_uuid, ticket_id, method, amount, tendered,
              vuelto, status, confirmed_at, shift_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            p.id,
            p.tenant_id,
            p.client_uuid,
            p.ticket_id,
            p.method,
            p.amount,
            p.tendered,
            p.vuelto,
            p.status,
            p.confirmed_at,
            p.shift_id,
            p.created_at,
          ],
        );
      }

      /* ------- offline close: SAME SQL over the local payments -------- */
      const localRes = await local.query(EXPECTED_FROM_PAYMENTS_SQL, [
        owner.orgId,
        shift.id,
      ]);
      const E = parseExpectedRow(localRes.rows[0] as Record<string, unknown>);
      expect(E).toEqual({ cash: 23500, transfers: 0, pending: 18000, expected: 23500 });

      const counted = 23500;
      const diff = counted - E.expected;
      const closedUuid = randomUUID();
      await local.query(
        `INSERT INTO closedcash
           (id, tenant_id, client_uuid, shift_id, expected, counted, diff, closed_by)
         VALUES ($1, $2, $1, $3, $4, $5, $6, NULL)
         ON CONFLICT (tenant_id, shift_id) DO NOTHING`,
        [closedUuid, owner.orgId, shift.id, E.expected, counted, diff],
      );
      await local.query(
        `UPDATE shifts SET status = 'closed', closed_at = now() WHERE id = $1`,
        [shift.id],
      );

      /* ------------------- reconnect → push the close ------------------ */
      const res = await push([
        {
          client_uuid: closedUuid,
          client_ts: Date.now(),
          entity: "closedcash",
          op: "upsert",
          payload: {
            shift_id: shift.id,
            expected: E.expected,
            counted,
            diff,
            closed_by: null,
          },
        },
        {
          client_uuid: shift.id,
          client_ts: Date.now() + 1,
          entity: "shift",
          op: "upsert",
          payload: { status: "closed", closed_at: new Date().toISOString() },
        },
      ]);
      expect(res.statusCode).toBe(200);
      expect(
        res.json().results.every((r: { status: string }) => r.status === "applied"),
      ).toBe(true);

      /* ------------------- zero drift: server == E --------------------- */
      const serverExpected = await repo.shifts.expected(shift.id);
      expect(serverExpected.expected).toBe(E.expected);
      expect(serverExpected).toMatchObject({
        cash: E.cash,
        transfers: E.transfers,
        pending: E.pending,
      });

      const stored = await repo.closedcash.byShift(shift.id);
      expect(stored).toMatchObject({
        expected: E.expected,
        counted,
        diff, // stored diff unchanged by the sync
      });
      expect((await repo.shifts.byUuid(shift.id))?.status).toBe("closed");
    } finally {
      await local.close();
    }
  }, 30_000);
});

describe("late confirmation (cash-close §Confirmed after close)", () => {
  it("confirming the pending transfer after close never reopens or rewrites the arqueo", async () => {
    const shift = await openShift();
    const pending = await seedSale(shift.id, {
      amount: 18000,
      method: "transfer",
      status: "pending",
      ticketNo: 1,
    });
    await seedSale(shift.id, {
      amount: 10000,
      method: "cash",
      status: "confirmed",
      ticketNo: 2,
    });

    const closed = await closeShift(shift.id, 10000);
    expect(closed.statusCode).toBe(200);
    expect(closed.json().expected).toMatchObject({
      expected: 10000,
      pending: 18000,
    });

    const confirm = await app.inject({
      method: "POST",
      url: `/api/payments/${pending.id}/confirm`,
      headers: headers(),
    });
    expect(confirm.statusCode).toBe(200);

    const stored = await repo.closedcash.byShift(shift.id);
    expect(stored).toMatchObject({ expected: 10000, counted: 10000, diff: 0 });
    expect((await repo.shifts.byUuid(shift.id))?.status).toBe("closed");
    // payment carries its own confirmation timestamp
    const payment = await repo.payments.byUuid(pending.id);
    expect(payment?.status).toBe("confirmed");
    expect(payment?.confirmed_at).not.toBeNull();
  });
});
