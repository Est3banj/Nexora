import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { localDate } from "@pos/shared";
import { db, pool, closeDb } from "../src/db";
import * as t from "../src/db/schema";
import { scopedRepo } from "../src/db/scope";
import { computeExpected, closeShift } from "../src/db/arqueo";
import { getAuth } from "../src/auth/auth";
import { buildTestApp, resetTables, createTenant, authHeaders, seedCustomer, pushCreditSale, pushMixedSale, pushAbono, type Actor } from "./helpers";

let app: FastifyInstance;
let owner: Actor;
let repo: ReturnType<typeof scopedRepo>;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "void@tenant.test", orgSlug: "void" });
  repo = scopedRepo(db, owner.orgId);
});
function push(mutations: unknown[], actor = owner) {
  return app.inject({ method: "POST", url: "/api/sync/mutations", headers: authHeaders(actor), payload: { mutations } });
}
function annul(id: string, actor = owner, reason: unknown = "Error de cobro") {
  return app.inject({ method: "POST", url: `/api/sales/tickets/${id}/void`, headers: authHeaders(actor), payload: { reason } });
}
async function sale(method = "cash") {
  const shift = await repo.shifts.createOpen();
  const { variant } = await repo.catalog.createProduct({ name: "Café", variant: { name: "Único", price: 4000, cost: 1500, stock: 10 } });
  const id = randomUUID();
  const env = (entity: string, payload: unknown, client_uuid: string = randomUUID()) => ({ entity, payload, client_uuid, client_ts: Date.now(), op: "upsert" });
  const envelopes = [
    env("ticket", { shift_id: shift.id, ticket_no: 1, total: 8000, status: method === "cash" ? "completed" : "transfer_pending" }, id),
    env("ticket_line", { ticket_id: id, variant_id: variant.id, qty: 2, unit_price: 4000, subtotal: 8000 }),
    env("payment", { ticket_id: id, shift_id: shift.id, method, amount: 8000, tendered: method === "cash" ? 10000 : null, vuelto: method === "cash" ? 2000 : null, status: method === "cash" ? "confirmed" : "pending" }),
    env("stockdiary", { variant_id: variant.id, delta: -2, reason: "sale", ref_ticket_id: id, note: "Venta #1" }),
    env("variant", { product_id: variant.product_id, name: variant.name, price: 4000, stock: 8, low_stock_threshold: null, active: true, ref_ticket_id: id }, variant.id),
  ];
  const res = await push(envelopes);
  expect(res.json().results.every((r: { status: string }) => r.status === "applied")).toBe(true);
  return { id, shift, variant, envelopes, paymentId: envelopes[2].client_uuid };
}
async function balances(variantId: string) {
  const variant = await repo.productVariants.byUuid(variantId);
  return { stock: variant?.stock, current: (await repo.stock.byVariant(variantId))?.stock, diary: await repo.stock.recount(variantId), cost: variant?.cost };
}

it.each(["full-linked", "mixed-unlinked"])("credit void blocked by any customer abono: %s, cash-only still voidable and history byte-identical", async kind => {
  const cash = await sale();
  const customer = await seedCustomer(app, owner);
  const s = kind === "full-linked"
    ? await pushCreditSale(app, owner, { customer, amount: 35000, shift: cash.shift.id, variant: cash.variant.id })
    : await pushMixedSale(app, owner, { customer, cash: 10000, credit: 25000, shift: cash.shift.id, variant: cash.variant.id });
  await pushAbono(app, owner, { customer, amount: 5000, method: "cash", shift: cash.shift.id, ticket: kind === "full-linked" ? s.ticket : null });
  const before = await repo.creditAbonos.listRecent();
  expect((await annul(s.ticket)).json()).toEqual({ error: "abonos_exist" });
  expect((await repo.tickets.byUuid(s.ticket))?.status).toBe("completed");
  expect((await annul(cash.id)).statusCode).toBe(200);
  expect(await repo.creditAbonos.listRecent()).toEqual(before);
});

it("credit void without abonos drops derived debt; concurrent abono/void cannot strand negative balance", async () => {
  const base = await sale();
  const customer = await seedCustomer(app, owner);
  const s = await pushCreditSale(app, owner, { customer, amount: 20000, shift: base.shift.id, variant: base.variant.id });
  const [voided, abono] = await Promise.all([
    annul(s.ticket), pushAbono(app, owner, { customer, amount: 5000, method: "cash", shift: base.shift.id }),
  ]);
  const account = (await repo.reports.customerAccounts())[0];
  expect(account.balance).toBe(voided.statusCode === 200 ? 0 : 15000);
  expect(abono.results[0].status).toBe(voided.statusCode === 200 ? "rejected" : "applied");
  if (voided.statusCode !== 200) expect(voided.json()).toEqual({ error: "abonos_exist" });
});

it.each(["cash", "transfer", "confirmed-transfer"])("annuls %s once; preserves history, exact reports and cash", async method => {
  const s = await sale(method === "cash" ? "cash" : "transfer");
  if (method === "confirmed-transfer") expect((await app.inject({ method: "POST", url: `/api/payments/${s.paymentId}/confirm`, headers: authHeaders(owner) })).statusCode).toBe(200);
  const beforeLines = await repo.ticketLines.listByTicket(s.id);
  const beforePayments = await repo.payments.listByTicket(s.id);
  expect(await balances(s.variant.id)).toEqual({ stock: 8, current: 8, diary: 8, cost: 1500 });
  const first = await annul(s.id);
  expect(first.statusCode).toBe(200);
  const again = await annul(s.id, owner, "Otro motivo que no debe reescribir");
  expect(again.statusCode).toBe(200);
  expect(again.json().stockdiary.map((d: { id: string }) => d.id)).toEqual(first.json().stockdiary.map((d: { id: string }) => d.id));
  expect(again.json().audit.meta.reason).toBe("Error de cobro");
  expect(again.json().audit.actor).toBe(owner.userId);
  expect(await balances(s.variant.id)).toEqual({ stock: 10, current: 10, diary: 10, cost: 1500 });
  expect(await repo.ticketLines.listByTicket(s.id)).toEqual(beforeLines);
  expect(await repo.payments.listByTicket(s.id)).toEqual(beforePayments);
  expect((await repo.tickets.byUuid(s.id))?.total).toBe(8000);
  expect((await computeExpected(owner.orgId, s.shift.id))).toEqual({ cash: 0, transfers: 0, pending: 0, abonos: 0, expected: 0 });
  const date = localDate();
  const report = await app.inject({ url: `/api/reports/dashboard?from=${date}&to=${date}`, headers: authHeaders(owner) });
  expect(report.statusCode).toBe(200);
  expect(report.json().summary).toMatchObject({ revenue: 0, tickets: 0, cash: 0, transfer: 0, pending: 0, cogs: 0 });
  expect(await repo.reports.topProducts({ from: date, to: date })).toEqual([]);
  expect(await repo.reports.salesByDay({ from: date, to: date })).toEqual([]);
  const audits = await db.select().from(t.auditLog).where(eq(t.auditLog.action, "sale.void"));
  expect(audits).toHaveLength(1);
  if (method === "transfer") expect((await app.inject({ method: "POST", url: `/api/payments/${s.paymentId}/confirm`, headers: authHeaders(owner) })).statusCode).toBe(409);
});

it("serializes concurrent annulments; a retry after close never changes the frozen close", async () => {
  const s = await sale();
  const responses = await Promise.all([annul(s.id), annul(s.id)]);
  expect(responses.map(r => r.statusCode)).toEqual([200, 200]);
  expect(await balances(s.variant.id)).toMatchObject({ stock: 10, diary: 10 });
  const closed = await closeShift({ tenantId: owner.orgId, shiftId: s.shift.id, counted: 0 });
  expect(closed).toMatchObject({ closedcash: { expected: 0, diff: 0 } });
  expect((await annul(s.id)).statusCode).toBe(200); // response-loss retry remains safe after close
  expect(await repo.closedcash.byShift(s.shift.id)).toMatchObject({ expected: 0, diff: 0 });
});

it("racing a close with annulment produces one coherent frozen result", async () => {
  const s = await sale();
  const [annulled, closed] = await Promise.all([
    annul(s.id), closeShift({ tenantId: owner.orgId, shiftId: s.shift.id, counted: 8000 }),
  ]);
  expect([200, 409]).toContain(annulled.statusCode);
  const expected = annulled.statusCode === 200 ? 0 : 8000;
  expect(closed).toMatchObject({ closedcash: { expected, diff: 8000 - expected } });
  expect(await balances(s.variant.id)).toMatchObject({ stock: expected === 0 ? 10 : 8 });
});

it("rejects annulment after close explicitly, preserving all figures and inventory", async () => {
  const s = await sale();
  await closeShift({ tenantId: owner.orgId, shiftId: s.shift.id, counted: 8000 });
  expect((await annul(s.id)).json()).toEqual({ error: "shift_closed" });
  expect((await annul(s.id)).statusCode).toBe(409);
  expect(await repo.closedcash.byShift(s.shift.id)).toMatchObject({ expected: 8000, diff: 0 });
  expect(await balances(s.variant.id)).toMatchObject({ stock: 8, diary: 8 });
});

it("identical and newer altered replays cannot resurrect ticket/payment/stock; forged parents cannot bypass", async () => {
  const s = await sale();
  await annul(s.id);
  const replay = (await push(s.envelopes)).json().results;
  expect(replay.every((r: { status: string; voided_ticket: string }) => r.status === "duplicate" && r.voided_ticket === s.id)).toBe(true);
  const altered = s.envelopes.map(m => ({ ...m, client_ts: m.client_ts + 50000 }));
  (altered[0].payload as { total: number }).total = 1;
  expect((await push(altered)).json().results.every((r: { status: string }) => r.status === "rejected")).toBe(true);
  const forged = { ...s.envelopes[2], client_ts: Date.now() + 99999, payload: { ...(s.envelopes[2].payload as object), ticket_id: randomUUID(), amount: 1 } };
  expect((await push([forged])).json().results[0].status).toBe("rejected");
  // Variant refresh without any parent also cannot overwrite compensated stock.
  const variant = { ...s.envelopes[4], client_ts: Date.now() + 999999, payload: { ...(s.envelopes[4].payload as object), ref_ticket_id: null, stock: -999 } };
  await push([variant]);
  expect(await balances(s.variant.id)).toEqual({ stock: 10, current: 10, diary: 10, cost: 1500 });
  expect(await repo.tickets.byUuid(s.id)).toMatchObject({ status: "voided", total: 8000 });
  expect(await repo.payments.byUuid(s.paymentId)).toMatchObject({ amount: 8000, status: "confirmed" });
});

it("validates reason and rejects client-controlled status, amount, or reversal diary", async () => {
  const s = await sale();
  for (const reason of ["", "  ", "ab", "x".repeat(501), null]) expect((await annul(s.id, owner, reason)).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url: `/api/sales/tickets/${s.id}/void`, headers: authHeaders(owner), payload: { reason: "error", total: 1 } })).statusCode).toBe(400);
  for (const status of ["voided", "refund", "refunded"]) {
    const forged = { ...s.envelopes[0], payload: { ...(s.envelopes[0].payload as object), status } };
    expect((await push([forged])).json().results[0].reason).toBe("validation");
  }
  const forged = { ...s.envelopes[3], client_uuid: randomUUID(), payload: { ...(s.envelopes[3].payload as object), reason: "sale_void", delta: 2 } };
  expect((await push([forged])).json().results[0].reason).toBe("validation");
  expect(await balances(s.variant.id)).toMatchObject({ stock: 8 });
});

it("enforces owner-only 403 and tenant 404 on server", async () => {
  const s = await sale();
  const other = await createTenant(app, { email: "other@tenant.test", orgSlug: "other" });
  expect((await annul(s.id, other)).statusCode).toBe(404);
  const member = await createTenant(app, { email: "member@tenant.test", orgSlug: "member" });
  await getAuth().api.addMember({ body: { organizationId: owner.orgId, userId: member.userId, role: "member" }, headers: new Headers(authHeaders(owner)) });
  await app.inject({ method: "POST", url: "/api/auth/organization/set-active", headers: authHeaders(member), payload: { organizationId: owner.orgId } });
  expect((await annul(s.id, member)).statusCode).toBe(403);
  const forbidden = { ...s.envelopes[0], payload: { ...(s.envelopes[0].payload as object), status: "voided" } };
  expect((await push([forbidden], member)).json().results[0].reason).toBe("validation");
  expect(await balances(s.variant.id)).toMatchObject({ stock: 8 });
});

it("refuses a partially synced sale instead of inventing compensation", async () => {
  const s = await sale();
  await pool.query("DELETE FROM stockdiary WHERE tenant_id=$1 AND ref_ticket_id=$2", [owner.orgId, s.id]);
  expect((await annul(s.id)).statusCode).toBe(409);
  expect((await repo.tickets.byUuid(s.id))?.status).toBe("completed");
});

it("offline close sync derives net expected on server and ACKs canonical frozen values", async () => {
  const s = await sale();
  await annul(s.id);
  const mutation = { client_uuid: randomUUID(), entity: "closedcash", op: "upsert", client_ts: Date.now(), payload: { shift_id: s.shift.id, expected: 8000, counted: 0, diff: -8000 } };
  for (let i = 0; i < 2; i++) {
    const result = (await push([mutation])).json().results[0];
    expect(result.status).toBe(i === 0 ? "applied" : "duplicate");
    expect(result.closedcash).toEqual({ shift_id: s.shift.id, expected: 0, counted: 0, diff: 0, calculation_version: "legacy_v1", closing_note: null });
  }
  expect(await repo.closedcash.byShift(s.shift.id)).toMatchObject({ expected: 0, counted: 0, diff: 0 });
});
