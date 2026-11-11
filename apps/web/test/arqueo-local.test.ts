import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../src/db/pglite";
import {
  closeLocalShift,
  computeLocalExpected,
  createLocalProduct,
  getOpenShiftLocal,
  listLocalClosedCash,
  mirrorServerClose,
  openLocalShift,
} from "../src/db/local";

/**
 * D3-2 · Offline arqueo close against the LOCAL cache.
 * AC (cash-close spec):
 *  - §Expected computed from payments (same SQL as the server): 41500 / cash 23500
 *  - §Pending transfer excluded from expected
 *  - §Counted/diff: zero diff, −1500 mismatch, negative counted rejected
 *  - §Closed shifts immutable (second close blocked, values frozen)
 *  - §Late confirmation does not touch the closed arqueo (local mirror)
 *  - §Open shift receives sales (shift_id on payments)
 */

const TENANT = "44444444-4444-4444-8444-444444444444";

let db: PGlite;
let release: () => void;

beforeEach(async () => {
  const handle = await openLocalDb({ url: "memory://", locks: null });
  db = handle!.db;
  release = handle!.release;

  await createLocalProduct(db, TENANT, {
    name: "Granizado",
    variant: { name: "Mediano", price: 1000, stock: 100 },
  });
  await openLocalShift(db, TENANT);
});

afterEach(async () => {
  release();
  await db.close();
});

describe("offline close (expected from local payments)", () => {
  it("spec numbers: 12000+7000+4500 cash + 18000 confirmed transfer = 41500", async () => {
    const shift = await getOpenShiftLocal(db, TENANT);
    expect(shift).not.toBeNull();

    // seed payments for this shift straight into the cache (same shape the
    // sale flow writes) — amounts follow the cash-close spec scenario
    await seedPayment(shift!.id, 12000, "cash", "confirmed", 1);
    await seedPayment(shift!.id, 7000, "cash", "confirmed", 2);
    await seedPayment(shift!.id, 4500, "cash", "confirmed", 3);
    await seedPayment(shift!.id, 18000, "transfer", "confirmed", 4);

    const expected = await computeLocalExpected(db, TENANT, shift!.id);
    expect(expected).toEqual({
      cash: 23500,
      transfers: 18000,
      pending: 0,
      abonos: 0,
      expected: 41500,
    });

    const closed = await closeLocalShift(db, TENANT, { counted: 41500 });
    expect(closed.diff).toBe(0);
    expect(closed.closedcash).toMatchObject({
      shift_id: shift!.id,
      expected: 41500,
      counted: 41500,
      diff: 0,
    });
    expect((await getOpenShiftLocal(db, TENANT))).toBeNull();

    const history = await listLocalClosedCash(db, TENANT);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ expected: 41500, counted: 41500, diff: 0 });
  });

  it("pending transfer is excluded; counted 10000 → diff 0, pending 18000 reported", async () => {
    const shift = await getOpenShiftLocal(db, TENANT);
    await seedPayment(shift!.id, 10000, "cash", "confirmed", 1);
    await seedPayment(shift!.id, 18000, "transfer", "pending", 2);

    const expected = await computeLocalExpected(db, TENANT, shift!.id);
    expect(expected).toEqual({
      cash: 10000,
      transfers: 0,
      pending: 18000,
      abonos: 0,
      expected: 10000,
    });

    const closed = await closeLocalShift(db, TENANT, { counted: 10000 });
    expect(closed.diff).toBe(0);
    expect(closed.closedcash.expected).toBe(10000);
  });

  it("counted mismatch → diff −1500 (derived, never entered)", async () => {
    const shift = await getOpenShiftLocal(db, TENANT);
    await seedPayment(shift!.id, 41500, "cash", "confirmed", 1);
    const closed = await closeLocalShift(db, TENANT, { counted: 40000 });
    expect(closed.diff).toBe(-1500);
    expect(closed.closedcash).toMatchObject({
      expected: 41500,
      counted: 40000,
      diff: -1500,
    });
  });

  it("negative counted is rejected and the shift STAYS OPEN", async () => {
    await expect(
      closeLocalShift(db, TENANT, { counted: -500 }),
    ).rejects.toThrow("NEGATIVE_COUNTED");
    expect(await getOpenShiftLocal(db, TENANT)).not.toBeNull();
    expect(await listLocalClosedCash(db, TENANT)).toHaveLength(0);
  });

  it("closing with no open shift is blocked", async () => {
    const before = await listLocalClosedCash(db, TENANT);
    expect(before).toHaveLength(0);

    // no open shift at all → blocked, no closed-cash record created
    await db.query(`DELETE FROM shifts WHERE tenant_id = $1`, [TENANT]);
    await expect(
      closeLocalShift(db, TENANT, { counted: 0 }),
    ).rejects.toThrow("NO_OPEN_SHIFT");
    expect(await listLocalClosedCash(db, TENANT)).toHaveLength(0);
  });

  it("closing twice is blocked — the stored row stays frozen", async () => {
    const shift = await getOpenShiftLocal(db, TENANT);
    await seedPayment(shift!.id, 5000, "cash", "confirmed", 1);
    await closeLocalShift(db, TENANT, { counted: 4500 });

    // no open shift remains → the second close can never rewrite the row
    await expect(
      closeLocalShift(db, TENANT, { counted: 9999 }),
    ).rejects.toThrow("NO_OPEN_SHIFT");

    const history = await listLocalClosedCash(db, TENANT);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ expected: 5000, counted: 4500, diff: -500 });
  });

  it("the close enqueues closedcash + shift so it syncs on reconnect", async () => {
    const shift = await getOpenShiftLocal(db, TENANT);
    await seedPayment(shift!.id, 5000, "cash", "confirmed", 1);
    await closeLocalShift(db, TENANT, { counted: 5000 });

    const queued = await db.query<{ entity: string; status: string }>(
      `SELECT entity, status FROM sync_log
       WHERE tenant_id = $1 AND entity IN ('closedcash', 'shift')`,
      [TENANT],
    );
    const entities = queued.rows.map((r) => r.entity).sort();
    expect(entities).toEqual(["closedcash", "shift"]);
    expect(queued.rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("late confirmation of a pending transfer never rewrites the local arqueo", async () => {
    const shift = await getOpenShiftLocal(db, TENANT);
    await seedPayment(shift!.id, 10000, "cash", "confirmed", 1);
    const transfer = await seedPayment(shift!.id, 18000, "transfer", "pending", 2);
    await closeLocalShift(db, TENANT, { counted: 10000 });

    // owner confirms after the close (local mirror of the server ack)
    await db.query(
      `UPDATE payments SET status = 'confirmed', confirmed_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [TENANT, transfer.id],
    );

    const history = await listLocalClosedCash(db, TENANT);
    expect(history[0]).toMatchObject({ expected: 10000, counted: 10000, diff: 0 });
    expect((await getOpenShiftLocal(db, TENANT))).toBeNull();
  });
});

describe("server close mirror (online path)", () => {
  it("mirrorServerClose inserts the server row and closes the shift, no queue", async () => {
    const shift = await getOpenShiftLocal(db, TENANT);
    const serverRow = {
      id: crypto.randomUUID(),
      client_uuid: crypto.randomUUID(),
      shift_id: shift!.id,
      expected: 7000,
      counted: 7000,
      diff: 0,
      closed_by: null,
    };
    await mirrorServerClose(db, TENANT, serverRow);

    expect(await getOpenShiftLocal(db, TENANT)).toBeNull();
    const history = await listLocalClosedCash(db, TENANT);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: serverRow.id, expected: 7000, diff: 0 });

    const queued = await db.query<{ entity: string; payload: { status?: string } }>(
      `SELECT entity, payload FROM sync_log
       WHERE tenant_id = $1 AND entity IN ('closedcash', 'shift')`,
      [TENANT],
    );
    // the mirror never queues a close (the server already holds it); the
    // only entry is the original OPEN shift from beforeEach
    expect(queued.rows.map((r) => r.entity)).not.toContain("closedcash");
    expect(
      queued.rows.filter((r) => r.entity === "shift").map((r) => r.payload.status),
    ).toEqual(["open"]);
  });
});

/** Payment row shaped exactly like commitLocalSale writes it. */
async function seedPayment(
  shiftId: string,
  amount: number,
  method: "cash" | "transfer",
  status: "pending" | "confirmed",
  ticketNo: number,
): Promise<{ id: string }> {
  const ticketId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  await db.query(
    `INSERT INTO tickets (id, tenant_id, client_uuid, shift_id, ticket_no, status, total)
     VALUES ($1, $2, $1, $3, $4, $5, $6)`,
    [
      ticketId,
      TENANT,
      shiftId,
      ticketNo,
      status === "pending" ? "transfer_pending" : "completed",
      amount,
    ],
  );
  await db.query(
    `INSERT INTO payments
       (id, tenant_id, client_uuid, ticket_id, method, amount, tendered, vuelto, status, shift_id)
     VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, $9)`,
    [
      paymentId,
      TENANT,
      ticketId,
      method,
      amount,
      method === "cash" ? amount : null,
      method === "cash" ? 0 : null,
      status,
      shiftId,
    ],
  );
  return { id: paymentId };
}
