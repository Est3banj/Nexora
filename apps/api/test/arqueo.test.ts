import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
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
 * D3-2 · Shifts + arqueo close (server-side expected).
 * AC (cash-close spec):
 *  - §Shift lifecycle: open receives sales, 2nd shift blocked, close w/o shift blocked
 *  - §Expected from payments: 12000+7000+4500+18000 = 41500, cash 23500
 *  - §Pending transfer excluded from expected
 *  - §Counted/diff: zero diff, −1500 mismatch, negative counted rejected
 *  - §Closed shifts immutable
 *  - §Late confirmation leaves arqueo untouched
 *  - §Tenant-scoped
 */

let app: FastifyInstance;
let owner: Actor;
let other: Actor;
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
  owner = await createTenant(app, { email: "arqueo@tenant.test", orgSlug: "org-arqueo" });
  other = await createTenant(app, { email: "arqueo-b@tenant.test", orgSlug: "org-arqueo-b" });
  repo = scopedRepo(db, owner.orgId);
});

function headers(actor: Actor = owner) {
  return authHeaders(actor);
}

async function openShift(actor: Actor = owner): Promise<{ id: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/shifts/open",
    headers: headers(actor),
    payload: {},
  });
  expect(res.statusCode).toBe(201);
  return res.json().shift;
}

async function close(
  shiftId: string,
  counted: number,
  actor: Actor = owner,
  clientUuid?: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/shifts/${shiftId}/close`,
    headers: headers(actor),
    payload: { counted, ...(clientUuid ? { client_uuid: clientUuid } : {}) },
  });
}

/** A committed sale row attached to a shift (payments-derived expected). */
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
  const payment = await repo.payments.upsert({
    client_uuid: randomUUID(),
    ticket_id: ticket.id,
    method: opts.method,
    amount: opts.amount,
    status: opts.status,
    shift_id: shiftId,
    ...(opts.status === "confirmed" ? { confirmed_at: new Date() } : {}),
  });
  return { ticket, payment };
}

async function closedcashCount(tenantId?: string): Promise<number> {
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(t.closedcash)
    .where(tenantId ? sql`tenant_id = ${tenantId}` : sql`true`);
  return Number(rows[0]?.n ?? 0);
}

describe("shift lifecycle", () => {
  it("open shift receives the sales completed during it", async () => {
    const shift = await openShift();

    // a real sale group pushed through the sync spine, attached to the shift
    const ticketId = randomUUID();
    const res = await app.inject({
      method: "POST",
      url: "/api/sync/mutations",
      headers: headers(),
      payload: {
        mutations: [
          {
            client_uuid: ticketId,
            client_ts: Date.now(),
            entity: "ticket",
            op: "upsert",
            payload: {
              shift_id: shift.id,
              ticket_no: 1,
              status: "completed",
              total: 5000,
            },
          },
          {
            client_uuid: randomUUID(),
            client_ts: Date.now() + 1,
            entity: "payment",
            op: "upsert",
            payload: {
              ticket_id: ticketId,
              method: "cash",
              amount: 5000,
              tendered: 5000,
              vuelto: 0,
              status: "confirmed",
              shift_id: shift.id,
            },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().results.every((r: { status: string }) => r.status === "applied"),
    ).toBe(true);

    const payments = await db
      .select()
      .from(t.payments)
      .where(eq(t.payments.tenant_id, owner.orgId));
    expect(payments).toHaveLength(1);
    expect(payments[0].shift_id).toBe(shift.id);

    const expected = await repo.shifts.expected(shift.id);
    expect(expected.expected).toBe(5000);
  });

  it("a second concurrent shift is rejected — exactly one stays open", async () => {
    const first = await openShift();
    const second = await app.inject({
      method: "POST",
      url: "/api/shifts/open",
      headers: headers(),
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("shift_already_open");
    expect(second.json().shift.id).toBe(first.id);

    const open = await db
      .select()
      .from(t.shifts)
      .where(eq(t.shifts.tenant_id, owner.orgId));
    expect(open).toHaveLength(1);
    expect(open[0].status).toBe("open");
  });

  it("close with no open shift is blocked and creates NO closed-cash record", async () => {
    const res = await close(randomUUID(), 1000);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
    expect(await closedcashCount()).toBe(0);
  });
});

describe("expected computed from payments (server-side source of truth)", () => {
  it("spec numbers: 12000+7000+4500 cash + 18000 transfer = 41500 (cash 23500)", async () => {
    const shift = await openShift();
    await seedSale(shift.id, { amount: 12000, method: "cash", status: "confirmed", ticketNo: 1 });
    await seedSale(shift.id, { amount: 7000, method: "cash", status: "confirmed", ticketNo: 2 });
    await seedSale(shift.id, { amount: 4500, method: "cash", status: "confirmed", ticketNo: 3 });
    await seedSale(shift.id, { amount: 18000, method: "transfer", status: "confirmed", ticketNo: 4 });

    const res = await close(shift.id, 41500);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.expected).toEqual({
      cash: 23500,
      transfers: 18000,
      pending: 0,
      abonos: 0,
      expected: 41500,
    });
    expect(body.diff).toBe(0);
    expect(body.closedcash).toMatchObject({
      shift_id: shift.id,
      expected: 41500,
      counted: 41500,
      diff: 0,
    });

    // stored row == recomputed value (spec §Recomputation is stable)
    const stored = await repo.closedcash.byShift(shift.id);
    expect(stored?.expected).toBe(41500);
    expect(await repo.shifts.expected(shift.id)).toMatchObject({
      cash: 23500,
      transfers: 18000,
      abonos: 0,
      expected: 41500,
    });

    const shiftRow = await repo.shifts.byUuid(shift.id);
    expect(shiftRow?.status).toBe("closed");
    expect(shiftRow?.closed_at).not.toBeNull();
  });

  it("pending transfer is excluded from expected and reported separately", async () => {
    const shift = await openShift();
    await seedSale(shift.id, { amount: 10000, method: "cash", status: "confirmed", ticketNo: 1 });
    await seedSale(shift.id, { amount: 18000, method: "transfer", status: "pending", ticketNo: 2 });

    const res = await close(shift.id, 10000);
    expect(res.statusCode).toBe(200);
    expect(res.json().expected).toEqual({
      cash: 10000,
      transfers: 0,
      pending: 18000,
      abonos: 0,
      expected: 10000,
    });
    expect(res.json().diff).toBe(0);
  });

  it("counted mismatch is reported as diff −1500", async () => {
    const shift = await openShift();
    await seedSale(shift.id, { amount: 12000, method: "cash", status: "confirmed", ticketNo: 1 });
    await seedSale(shift.id, { amount: 7000, method: "cash", status: "confirmed", ticketNo: 2 });
    await seedSale(shift.id, { amount: 4500, method: "cash", status: "confirmed", ticketNo: 3 });
    await seedSale(shift.id, { amount: 18000, method: "transfer", status: "confirmed", ticketNo: 4 });

    const res = await close(shift.id, 40000);
    expect(res.statusCode).toBe(200);
    expect(res.json().diff).toBe(-1500);
    const stored = await repo.closedcash.byShift(shift.id);
    expect(stored).toMatchObject({ expected: 41500, counted: 40000, diff: -1500 });
  });

  it("negative counted is rejected and the shift STAYS OPEN", async () => {
    const shift = await openShift();
    await seedSale(shift.id, { amount: 5000, method: "cash", status: "confirmed", ticketNo: 1 });

    const res = await close(shift.id, -500);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
    expect(await closedcashCount()).toBe(0);
    expect((await repo.shifts.byUuid(shift.id))?.status).toBe("open");
  });

  it("closing twice is rejected (already closed)", async () => {
    const shift = await openShift();
    await seedSale(shift.id, { amount: 5000, method: "cash", status: "confirmed", ticketNo: 1 });
    expect((await close(shift.id, 5000)).statusCode).toBe(200);

    const again = await close(shift.id, 9999);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_closed");
    const stored = await repo.closedcash.byShift(shift.id);
    expect(stored).toMatchObject({ counted: 5000, diff: 0 });
    expect(await closedcashCount()).toBe(1);
  });
});

describe("closed arqueo is immutable + late confirmation", () => {
  it("a replayed/tampered closedcash push can never rewrite the stored row", async () => {
    const shift = await openShift();
    await seedSale(shift.id, { amount: 41500, method: "cash", status: "confirmed", ticketNo: 1 });
    const closed = await close(shift.id, 40000);
    expect(closed.statusCode).toBe(200);
    const row = closed.json().closedcash;

    // same uuid, different money figures, newer client_ts → must NOT stick
    const res = await app.inject({
      method: "POST",
      url: "/api/sync/mutations",
      headers: headers(),
      payload: {
        mutations: [
          {
            client_uuid: row.id,
            client_ts: Date.now() + 10_000,
            entity: "closedcash",
            op: "upsert",
            payload: {
              shift_id: shift.id,
              expected: 999999,
              counted: 999999,
              diff: 0,
            },
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);

    const stored = await repo.closedcash.byShift(shift.id);
    expect(stored).toMatchObject({ expected: 41500, counted: 40000, diff: -1500 });
    expect(await closedcashCount()).toBe(1);
  });

  it("transfer confirmed AFTER close leaves expected/counted/diff untouched", async () => {
    const shift = await openShift();
    const pendingSale = await seedSale(shift.id, {
      amount: 18000,
      method: "transfer",
      status: "pending",
      ticketNo: 1,
    });
    await seedSale(shift.id, { amount: 10000, method: "cash", status: "confirmed", ticketNo: 2 });

    const before = await close(shift.id, 10000);
    expect(before.json().expected).toMatchObject({ expected: 10000, pending: 18000 });

    // owner confirms the pending transfer the next day
    const confirm = await app.inject({
      method: "POST",
      url: `/api/payments/${pendingSale.payment.id}/confirm`,
      headers: headers(),
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().payment.status).toBe("confirmed");
    expect(confirm.json().payment.confirmed_at).not.toBeNull();

    // closed arqueo untouched — confirmation lives on the payment only
    const stored = await repo.closedcash.byShift(shift.id);
    expect(stored).toMatchObject({ expected: 10000, counted: 10000, diff: 0 });
    expect(await closedcashCount()).toBe(1);
  });
});

describe("arqueo is tenant-scoped", () => {
  it("tenant B cannot see or close tenant A's shift; A stays open", async () => {
    const shift = await openShift(owner);

    const openForB = await app.inject({
      method: "GET",
      url: "/api/shifts/open",
      headers: headers(other),
    });
    expect(openForB.statusCode).toBe(200);
    expect(openForB.json().shift).toBeNull();

    const closeForB = await close(shift.id, 12345, other);
    expect(closeForB.statusCode).toBe(404);

    const aShift = await repo.shifts.byUuid(shift.id);
    expect(aShift?.status).toBe("open");
    expect(await closedcashCount(owner.orgId)).toBe(0);
    expect(await closedcashCount(other.orgId)).toBe(0);
  });
});
