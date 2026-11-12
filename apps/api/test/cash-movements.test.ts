import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { authHeaders, buildTestApp, createTenant, resetTables, seedCustomer, pushMixedSale, pushAbono, pushMutations, creditMutation, type Actor } from "./helpers";
import { db, pool, closeDb } from "../src/db";
import { scopedRepo } from "../src/db/scope";
import { getAuth } from "../src/auth/auth";

let app: FastifyInstance, owner: Actor;
let repo: ReturnType<typeof scopedRepo>;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  await resetTables(); owner = await createTenant(app, { email: "drawer@test.co", orgSlug: "drawer" });
  repo = scopedRepo(db, owner.orgId);
});
async function open(fields: Record<string, unknown> = {}) {
  const r = await app.inject({ method: "POST", url: "/api/shifts/open", headers: authHeaders(owner), payload: fields });
  expect(r.statusCode).toBe(201); return r.json().shift;
}
function movement(shift: string, direction: "in" | "out", amount: number) {
  return creditMutation("cash_movement", { shift_id: shift, direction, amount, reason: "Reposición / retiro", note: "Registro real", created_at: "2026-11-11T12:00:00.000Z" });
}

it.each(["legacy_v1", "drawer_cash_v2"] as const)("%s pinned ledger keeps transfers separate and close/notes immutable after late evidence", async version => {
  const shift = await open({ opening_cash: 10000, calculation_version: version });
  expect(shift.opened_by).toBe(owner.userId);
  const customer = await seedCustomer(app, owner);
  const sale = await pushMixedSale(app, owner, { customer, cash: 5000, credit: 20000, shift: shift.id });
  await pushAbono(app, owner, { customer, amount: 2000, method: "cash", shift: shift.id });
  await pushAbono(app, owner, { customer, amount: 3000, method: "transfer", shift: shift.id });
  const ticket = await repo.tickets.upsert({ client_uuid: randomUUID(), shift_id: shift.id, ticket_no: 999, total: 9000 });
  await repo.payments.upsert({ client_uuid: randomUUID(), ticket_id: ticket.id, shift_id: shift.id, method: "transfer", status: "confirmed", amount: 9000 });
  expect((await pushMutations(app, owner, [movement(shift.id,"in",1000), movement(shift.id,"out",3000)])).map(r => r.status)).toEqual(["applied","applied"]);
  const expected = version === "drawer_cash_v2" ? 15000 : 16000;
  expect(await repo.shifts.expected(shift.id)).toMatchObject({ expected, transfers: 9000, abonos: 2000 });
  const close = creditMutation("closedcash", { shift_id: shift.id, counted: expected, expected: 999, diff: 999,
    calculation_version: version === "drawer_cash_v2" ? "legacy_v1" : "drawer_cash_v2", closing_note: "Contado y revisado" });
  const ack = (await app.inject({ method: "POST", url: "/api/sync/mutations", headers: authHeaders(owner), payload: { mutations: [close] } })).json().results[0];
  expect(ack.closedcash).toMatchObject({ expected, counted: expected, diff: 0, calculation_version: version, closing_note: "Contado y revisado" });
  const before = await repo.closedcash.byShift(shift.id);
  expect(before).toMatchObject({ expected, calculation_version: version });
  const saleBefore = { ticket: await repo.tickets.byUuid(sale.ticket), payments: await repo.payments.listByTicket(sale.ticket) };
  for (const old of sale.mutations.filter(m => m.entity === "ticket" || m.entity === "payment" || m.entity === "ticket_line")) {
    const change = old.entity === "ticket" ? { total: 1 } : old.entity === "payment" ? { amount: 1 } : { unit_price: 1 };
    expect((await pushMutations(app, owner, [{ ...old, client_ts: old.client_ts+100, payload: { ...old.payload, ...change } } as typeof old]))[0].status).toBe("rejected");
  }
  expect({ ticket: await repo.tickets.byUuid(sale.ticket), payments: await repo.payments.listByTicket(sale.ticket) }).toEqual(saleBefore);
  expect((await pushMutations(app, owner, [movement(shift.id,"in",7000)]))[0].status).toBe("applied");
  expect((await pushAbono(app, owner, { customer, amount: 1000, method: "cash", shift: shift.id })).results[0].status).toBe("applied");
  expect((await pushMixedSale(app, owner, { customer, cash: 100, credit: 100, shift: shift.id })).results.every(r => r.status === "applied")).toBe(true);
  await pushMutations(app, owner, [{ ...close, client_ts: close.client_ts+10, payload: { ...close.payload, counted: 0, closing_note: "Ataque" } } as typeof close]);
  expect(await repo.closedcash.byShift(shift.id)).toEqual(before);
  expect((await repo.shifts.byUuid(shift.id))?.status).toBe("closed");
  // Reusing the close UUID must not close another live shift as a side effect.
  const next = await open({ calculation_version: "drawer_cash_v2" });
  expect((await pushMutations(app, owner, [{ ...close, client_ts: close.client_ts+20, payload: { ...close.payload, shift_id: next.id } } as typeof close]))[0].status).toBe("rejected");
  expect((await repo.shifts.byUuid(next.id))?.status).toBe("open");
  expect(await repo.closedcash.byShift(shift.id)).toEqual(before);
  expect(await repo.closedcash.byShift(next.id)).toBeUndefined();
});

it("movement replay cannot edit history or advance ledger, even with a missing ledger", async () => {
  const shift = await open();
  const m = movement(shift.id,"in",1000);
  expect((await pushMutations(app, owner, [m]))[0].status).toBe("applied");
  const before = await repo.cashMovements.listByShift(shift.id);
  const ledger = (await pool.query("SELECT * FROM sync_log WHERE client_uuid=$1", [m.client_uuid])).rows;
  for (const change of [{ amount: 2000 }, { reason: "Edit" }, { direction: "out" }, { note: null }, { shift_id: randomUUID() }, { created_at: "2026-11-12T12:00:00.000Z" }]) {
    expect((await pushMutations(app, owner, [{ ...m, client_ts: m.client_ts+10, payload: { ...m.payload, ...change } } as typeof m]))[0].status).toBe("rejected");
    expect((await pool.query("SELECT * FROM sync_log WHERE client_uuid=$1", [m.client_uuid])).rows).toEqual(ledger);
  }
  expect((await pushMutations(app, owner, [{ ...m, client_ts: m.client_ts+20 }]))[0].status).toBe("duplicate");
  await pool.query("DELETE FROM sync_log WHERE client_uuid=$1", [m.client_uuid]);
  expect((await pushMutations(app, owner, [{ ...m, client_ts: m.client_ts+30, payload: { ...m.payload, amount: 99 } } as typeof m]))[0].status).toBe("rejected");
  expect(await repo.cashMovements.listByShift(shift.id)).toEqual(before);
});

it("M8 HTTP rejects missing, negative, fractional and overflow money without closing or writing a snapshot", async () => {
  for (const opening_cash of [-1, 1.5, 2147483648]) {
    const response = await app.inject({ method: "POST", url: "/api/shifts/open", headers: authHeaders(owner), payload: { opening_cash } });
    expect(response.statusCode).toBe(400);
  }
  expect(await repo.shifts.open()).toBeUndefined();
  const shift = await open({ opening_cash: 150000, calculation_version: "drawer_cash_v2" });
  for (const payload of [{}, { counted: -1 }, { counted: 0.5 }, { counted: 2147483648 }, { counted: "" }]) {
    const response = await app.inject({ method: "POST", url: `/api/shifts/${shift.id}/close`, headers: authHeaders(owner), payload });
    expect(response.statusCode).toBe(400);
    expect(await repo.closedcash.byShift(shift.id)).toBeUndefined();
    expect((await repo.shifts.open())?.id).toBe(shift.id);
  }
  for (const amount of [0, -1, 1.5, 2147483648]) {
    const valid = movement(shift.id, "in", 1);
    const response = await app.inject({ method: "POST", url: "/api/sync/mutations", headers: authHeaders(owner),
      payload: { mutations: [{ ...valid, payload: { ...valid.payload, amount } }] } });
    expect(response.json().results[0].status).toBe("rejected");
  }
  expect(await repo.cashMovements.listByShift(shift.id)).toEqual([]);
});

it("M8 prototype financial contract: server close 335000 with bank 72000 separate, then forward-only movements change next expected", async () => {
  const shift = await open({ opening_cash: 150000, calculation_version: "drawer_cash_v2" });
  for (const [method, amount] of [["cash", 185000], ["transfer", 72000]] as const) {
    const ticket = await repo.tickets.upsert({ client_uuid: randomUUID(), shift_id: shift.id, ticket_no: amount, total: amount });
    await repo.payments.upsert({ client_uuid: randomUUID(), ticket_id: ticket.id, shift_id: shift.id, method, amount, status: "confirmed" });
  }
  expect(await repo.shifts.expected(shift.id)).toMatchObject({ expected: 335000, transfers: 72000 });
  await pushMutations(app, owner, [movement(shift.id, "in", 10000), movement(shift.id, "out", 3000)]);
  const response = await app.inject({ method: "POST", url: `/api/shifts/${shift.id}/close`, headers: authHeaders(owner), payload: { counted: 342000, closing_note: "M8 HTTP canónico" } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ expected: { transfers: 72000, expected: 342000 }, closedcash: { counted: 342000, expected: 342000, diff: 0, closing_note: "M8 HTTP canónico", calculation_version: "drawer_cash_v2" } });
  expect(await repo.payments.list()).toHaveLength(2);
});

it("legacy open stays legacy; stale clients cannot edit opening base/version/actor or reopen a close", async () => {
  const shift = await open();
  expect(shift).toMatchObject({ opening_cash: 0, calculation_version: "legacy_v1" });
  for (const fields of [{ opening_cash: 50 }, { calculation_version: "drawer_cash_v2" }, { opened_by: randomUUID() }]) {
    expect((await pushMutations(app, owner, [creditMutation("shift", { status: "open", ...fields }, shift.id)]))[0].status).toBe("rejected");
  }
  const res = await app.inject({ method: "POST", url: `/api/shifts/${shift.id}/close`, headers: authHeaders(owner), payload: { counted: 0, closing_note: "Online" } });
  expect(res.json().closedcash).toMatchObject({ calculation_version: "legacy_v1", closing_note: "Online" });
  await pushMutations(app, owner, [creditMutation("shift", { status: "open" }, shift.id)]);
  expect((await repo.shifts.byUuid(shift.id))?.status).toBe("closed");
});

it("member may operate cash; foreign tenant cannot read/write movements or history; pagination is complete", async () => {
  const shift = await open({ opening_cash: 5000, calculation_version: "drawer_cash_v2" });
  const other = await createTenant(app, { email: "drawer-member@test.co", orgSlug: "drawer-member" });
  const foreign = scopedRepo(db, other.orgId);
  const m = movement(shift.id,"out",100);
  expect((await pushMutations(app, other, [m]))[0].status).toBe("rejected");
  await getAuth().api.addMember({ body: { organizationId: owner.orgId, userId: other.userId, role: "member" }, headers: new Headers(authHeaders(owner)) });
  await app.inject({ method: "POST", url: "/api/auth/organization/set-active", headers: authHeaders(other), payload: { organizationId: owner.orgId } });
  expect((await pushMutations(app, other, [m, movement(shift.id,"in",200), movement(shift.id,"in",300)] )).every(r => r.status === "applied")).toBe(true);
  expect(await foreign.cashMovements.listRecent()).toEqual([]);
  expect(await foreign.cashMovements.listByShift(shift.id)).toEqual([]);
  expect(await foreign.shifts.listRecent()).toEqual([]);
  expect(await foreign.closedcash.listRecent()).toEqual([]);
  const p1 = (await app.inject({ method: "GET", url: "/api/rehydrate?limit=2", headers: authHeaders(owner) })).json();
  const p2 = (await app.inject({ method: "GET", url: "/api/rehydrate?limit=2&offset=2", headers: authHeaders(owner) })).json();
  expect(p1.cash_movements).toHaveLength(2); expect(p1.next_offset).toBe(2);
  expect(p2.cash_movements).toHaveLength(1); expect(p2.next_offset).toBeNull();
  expect(p1.shifts[0]).toMatchObject({ opening_cash: 5000, calculation_version: "drawer_cash_v2" });
  expect(await repo.payments.list()).toEqual([]);
  expect(await repo.reports.salesByDay()).toEqual([]);
});
