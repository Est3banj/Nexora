import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { authHeaders, buildTestApp, createTenant, resetTables, seedCustomer, pushCreditSale, pushMixedSale, pushAbono, pushMutations, creditMutation, type Actor } from "./helpers";
import { db, pool, closeDb } from "../src/db";
import { scopedRepo } from "../src/db/scope";
import { getAuth } from "../src/auth/auth";
import { computeExpected, closeShift } from "../src/db/arqueo";

let app: FastifyInstance, owner: Actor, customer: string, shift: string;
let repo: ReturnType<typeof scopedRepo>;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  await resetTables(); owner = await createTenant(app, { email: "credit@test.co", orgSlug: "credit" });
  repo = scopedRepo(db, owner.orgId); shift = (await repo.shifts.createOpen()).id;
  customer = await seedCustomer(app, owner);
  expect((await pushCreditSale(app, owner, { customer, amount: 35000, shift })).results.every(r => r.status === "applied")).toBe(true);
});

it.each([-1, 0, 1])("abono rejects changed history at timestamp delta %s without changing row or ledger", async delta => {
  const { mutation } = await pushAbono(app, owner, { customer, amount: 5000, method: "cash", shift });
  const snapshot = async () => ({ abonos: await repo.creditAbonos.listRecent(), ledger: (await pool.query("SELECT * FROM sync_log WHERE tenant_id=$1 AND client_uuid=$2", [owner.orgId, mutation.client_uuid])).rows });
  const before = await snapshot();
  for (const change of [{ amount: 6000 }, { method: "transfer" }, { customer_id: randomUUID() }, { shift_id: randomUUID() }, { note: "editada" }, { ticket_id: randomUUID() }, { created_at: "2026-01-01T00:00:00.000Z" }]) {
    expect((await pushMutations(app, owner, [{ ...mutation, client_ts: mutation.client_ts + delta, payload: { ...mutation.payload, ...change } } as typeof mutation]))[0].status).toBe("rejected");
    expect(await snapshot()).toEqual(before);
  }
  expect((await pushMutations(app, owner, [{ ...mutation, client_ts: mutation.client_ts + 100 }]))[0].status).toBe("duplicate");
  expect(await snapshot()).toEqual(before);
});

it("missing sync ledger cannot bypass immutable business evidence", async () => {
  const { mutation } = await pushAbono(app, owner, { customer, amount: 5000, method: "cash", shift });
  await pool.query("DELETE FROM sync_log WHERE tenant_id=$1 AND client_uuid=$2", [owner.orgId, mutation.client_uuid]);
  const before = await repo.creditAbonos.listRecent();
  expect((await pushMutations(app, owner, [{ ...mutation, client_ts: mutation.client_ts + 1, payload: { ...mutation.payload, amount: 6000 } } as typeof mutation]))[0].status).toBe("rejected");
  expect((await pushMutations(app, owner, [mutation]))[0].status).toBe("duplicate");
  expect(await repo.creditAbonos.listRecent()).toEqual(before);
  expect((await pool.query("SELECT * FROM sync_log WHERE client_uuid=$1", [mutation.client_uuid])).rows).toEqual([]);
});

it("concurrent overpayments serialize on customer balance; no extra payments or negative debt", async () => {
  const results = await Promise.all([1, 2].map(() => pushAbono(app, owner, { customer, amount: 20000, method: "cash", shift })));
  expect(results.map(r => r.results[0].status).sort()).toEqual(["applied", "rejected"]);
  expect((await repo.reports.customerAccounts())[0].balance).toBe(15000);
  expect(await repo.creditAbonos.listRecent()).toHaveLength(1);
  expect((await pool.query("SELECT * FROM payments WHERE tenant_id=$1", [owner.orgId])).rows).toHaveLength(1);
});

it("newer ticket/payment edits cannot remove already-collected credit", async () => {
  const sale = await pushCreditSale(app, owner, { customer, amount: 20000, shift });
  await pushAbono(app, owner, { customer, amount: 55000, method: "cash", shift });
  const before = await repo.reports.customerAccounts();
  const credit = sale.mutations.find(m => m.entity === "payment")!;
  const altered = { ...credit, client_ts: credit.client_ts + 1, payload: { ...credit.payload, amount: 1 } } as typeof credit;
  expect((await pushMutations(app, owner, [altered]))[0].status).toBe("rejected");
  const ticket = sale.mutations[0];
  expect((await pushMutations(app, owner, [{ ...ticket, client_ts: ticket.client_ts + 1, payload: { ...ticket.payload, customer_id: null } } as typeof ticket]))[0].status).toBe("rejected");
  expect(await repo.reports.customerAccounts()).toEqual(before);
});

it("identical lines have identical COGS under cash and credit; pending count unchanged", async () => {
  const creditDate = "2026-11-01T15:00:00.000Z", cashDate = "2026-11-02T15:00:00.000Z";
  await pushCreditSale(app, owner, { customer, amount: 20000, shift, created_at: creditDate });
  const cash = await pushCreditSale(app, owner, { customer, amount: 20000, shift, created_at: cashDate });
  const payment = cash.mutations.find(m => m.entity === "payment")!;
  expect((await pushMutations(app, owner, [{ ...payment, client_ts: payment.client_ts+1, payload: { ...payment.payload, method: "cash", tendered: 20000, vuelto: 0 } } as typeof payment]))[0].status).toBe("applied");
  const summaries = [];
  for (const day of ["2026-11-01","2026-11-02"]) {
    const res = await app.inject({ url: `/api/reports/dashboard?from=${day}&to=${day}`, headers: authHeaders(owner) });
    summaries.push(res.json().summary);
  }
  expect(summaries[0]).toMatchObject({revenue:20000,cogs:4000,gross:16000,credit:20000,cash:0,pending_count:0});
  expect(summaries[1]).toMatchObject({revenue:20000,cogs:4000,gross:16000,credit:0,cash:20000,pending_count:0});
});

// roles-admin 2.7 · FLIP + SUPERSESSION: fiado decision #6 (owner-only
// abonos → member pushes rejected) is SUPERSEDED by roles-admin decision #1
// (ANY verified role registers abonos). The deliberate case flips from
// `["rejected","applied"]` to `["applied","applied"]` — the member's abono
// now lands exactly once (immutable replay rules untouched, see the first
// test in this file).
it("member abono applies (supersedes fiado #6) alongside member customer mutations", async () => {
  const member = await createTenant(app, { email: "credit-member@test.co", orgSlug: "credit-member" });
  await getAuth().api.addMember({ body: { organizationId: owner.orgId, userId: member.userId, role: "member" }, headers: new Headers(authHeaders(owner)) });
  await app.inject({ method: "POST", url: "/api/auth/organization/set-active", headers: authHeaders(member), payload: { organizationId: owner.orgId } });
  const results = await pushMutations(app, member, [creditMutation("credit_abono", { customer_id: customer, amount: 1, method: "cash", shift_id: shift }), creditMutation("customer", { name: "Permitido" })]);
  expect(results.map(r => r.status)).toEqual(["applied", "applied"]);
  expect(await repo.creditAbonos.listRecent()).toHaveLength(1);
  expect((await pushAbono(app, owner, { customer, amount: 1, method: "cash", shift })).results[0].status).toBe("applied");
  expect(await repo.creditAbonos.listRecent()).toHaveLength(2);
});

// roles-admin 2.7 · D2 trap proof: a member batch mixing SOLO catalog
// mutations with a real sale group must reject ONLY the catalog entries
// (per-item `rejected/validation`, HTTP 2xx — never a blanket 403) while the
// sale group applies intact. ref_ticket_id groups entries, but tenant-owned
// ticket/line quantity evidence authorizes movements, not the ref alone.
it("member mixed batch: catalog items rejected per-item, sale group applies intact", async () => {
  const member = await createTenant(app, { email: "credit-mixed@test.co", orgSlug: "credit-mixed" });
  await getAuth().api.addMember({ body: { organizationId: owner.orgId, userId: member.userId, role: "member" }, headers: new Headers(authHeaders(owner)) });
  await app.inject({ method: "POST", url: "/api/auth/organization/set-active", headers: authHeaders(member), payload: { organizationId: owner.orgId } });

  const { product, variant } = await repo.catalog.createProduct({ name: "Mezcla D2", variant: { name: "Único", price: 3000, stock: 10 } });
  const ticket = randomUUID();
  const mutations = [
    // SOLO catalog entries (NO ref_ticket_id) → rejected:validation
    creditMutation("product", { name: "Producto Nuevo Member" }),
    creditMutation("variant", { product_id: product.id, name: "Único", price: 3000, cost: null, stock: 10, low_stock_threshold: null, active: true }),
    creditMutation("stockdiary", { variant_id: variant.id, delta: 5, reason: "reposition", note: "Ajuste manual del member" }),
    // sale group (variant/stockdiary WITH ref_ticket_id) → applies intact
    creditMutation("ticket", { shift_id: shift, ticket_no: 1001, total: 3000, status: "completed" }, ticket),
    creditMutation("ticket_line", { ticket_id: ticket, variant_id: variant.id, qty: 1, unit_price: 3000, subtotal: 3000 }),
    creditMutation("payment", { ticket_id: ticket, shift_id: shift, method: "cash", amount: 3000, tendered: 3000, vuelto: 0, status: "confirmed" }),
    creditMutation("variant", { product_id: product.id, name: "Único", price: 3000, cost: null, stock: 9, low_stock_threshold: null, active: true, ref_ticket_id: ticket }, variant.id),
    creditMutation("stockdiary", { variant_id: variant.id, delta: -1, reason: "sale", ref_ticket_id: ticket }),
  ];
  const results = await pushMutations(app, member, mutations); // throws unless HTTP 200
  expect(results.map(r => r.status)).toEqual(["rejected", "rejected", "rejected", "applied", "applied", "applied", "applied", "applied"]);
  expect(results.slice(0, 3).every(r => r.reason === "validation")).toBe(true);
  // catalog untouched by the rejected entries…
  expect((await repo.products.list()).map(p => p.name)).not.toContain("Producto Nuevo Member");
  expect((await repo.stockdiary.listByVariant(variant.id)).some(d => d.reason === "reposition")).toBe(false);
  // …and the sale group landed whole (ticket + payment + movement + refresh).
  expect(await repo.tickets.byUuid(ticket)).toMatchObject({ status: "completed", total: 3000 });
  expect((await repo.payments.listByTicket((await repo.tickets.byUuid(ticket))!.id))).toHaveLength(1);
  expect(await repo.stock.recount(variant.id)).toBe(9);
  expect((await repo.productVariants.byUuid(variant.id))?.stock).toBe(9);
});

it("same-tenant customer, shift and optional linked-ticket validation; null attribution accepted", async () => {
  const other = await createTenant(app, { email: "credit-other@test.co", orgSlug: "credit-other" });
  const foreign = await seedCustomer(app, other);
  const foreignShift = (await scopedRepo(db, other.orgId).shifts.createOpen()).id;
  const second = await seedCustomer(app, owner);
  const mismatched = await pushCreditSale(app, owner, { customer: second, amount: 100, shift });
  for (const fields of [{ customer_id: foreign }, { shift_id: foreignShift }, { shift_id: null }, { customer_id: randomUUID() }, { ticket_id: mismatched.ticket }, { ticket_id: randomUUID() }, { amount: 35001 }]) {
    const m = creditMutation("credit_abono", { customer_id: customer, amount: 1, method: "cash", shift_id: shift, ...fields });
    expect((await pushMutations(app, owner, [m]))[0].status).toBe("rejected");
  }
  const ticket = randomUUID();
  await pushMutations(app, owner, [creditMutation("ticket", { shift_id: shift, ticket_no: 10, total: 100, status: "completed" }, ticket)]);
  expect((await pushAbono(app, owner, { customer, amount: 100, method: "transfer", shift, ticket })).results[0].status).toBe("applied");
});

it("customer-before-sale server backstop, pending credit and orphan claims reject atomically", async () => {
  const missing = randomUUID();
  const sale = await pushCreditSale(app, owner, { customer: missing, amount: 100, shift });
  expect(sale.results.every(r => r.status === "rejected")).toBe(true);
  await pushMutations(app, owner, [creditMutation("customer", { name: "Offline", credit_limit: 1000 }, missing)]);
  expect((await pushMutations(app, owner, sale.mutations)).every(r => r.status === "applied")).toBe(true);
  for (const orphan of [false, true]) {
    const ticket = randomUUID();
    const results = await pushMutations(app, owner, [
      creditMutation("ticket", { shift_id: shift, ticket_no: 20, total: 100, status: "completed", customer_id: orphan ? null : customer }, ticket),
      creditMutation("payment", { ticket_id: ticket, shift_id: shift, method: "credit", amount: 100, tendered: null, vuelto: null, status: orphan ? "confirmed" : "pending" }),
    ]);
    expect(results.every(r => r.status === "rejected")).toBe(true);
    expect(await repo.tickets.byUuid(ticket)).toBeUndefined();
  }
});

it("two real offline sales converge above limit, remain idempotent and visible without clamping", async () => {
  const id = await seedCustomer(app, owner, { credit_limit: 100000 });
  const sales = await Promise.all([1, 2].map(() => pushCreditSale(app, owner, { customer: id, amount: 60000, shift })));
  expect(sales.flatMap(s => s.results).every(r => r.status === "applied")).toBe(true);
  for (const sale of sales) expect((await pushMutations(app, owner, sale.mutations)).every(r => r.status === "duplicate")).toBe(true);
  expect((await repo.reports.customerAccounts()).find(r => r.customer_id === id)).toMatchObject({ balance: 120000, credit_limit: 100000 });
});

it("pinned Day3 through real sync: accrual, cobros, COGS, pending and legacy expected stay distinct; late abono preserves close", async () => {
  // The beforeEach debt is outside the pinned reporting period.
  const x = await seedCustomer(app, owner, { name: "X" }), y = await seedCustomer(app, owner, { name: "Y" });
  const created_at = "2026-11-03T15:00:00.000Z";
  await pushCreditSale(app, owner, { customer: x, amount: 35000, shift, created_at });
  await pushMixedSale(app, owner, { customer: y, cash: 10000, credit: 20000, shift, created_at });
  await pushAbono(app, owner, { customer: x, amount: 5000, method: "cash", shift, created_at });
  await pushAbono(app, owner, { customer: y, amount: 3000, method: "transfer", shift, created_at });
  const report = await app.inject({ url: "/api/reports/sales-by-day?from=2026-11-03&to=2026-11-03", headers: authHeaders(owner) });
  expect(report.json().rows).toEqual([{ day: "2026-11-03", tickets: 2, revenue: 65000, cash: 10000, transfer: 0, credit: 55000, abonos: 8000, pending: 0 }]);
  const dashboard = await app.inject({ url: "/api/reports/dashboard?from=2026-11-03&to=2026-11-03", headers: authHeaders(owner) });
  expect(dashboard.json().summary).toMatchObject({ revenue:65000,credit:55000,abonos:8000,cogs:8000,pending:0,pending_count:0 });
  expect((await repo.reports.customerAccounts()).filter(r => [x,y].includes(r.customer_id)).map(r => r.balance).sort()).toEqual([17000,30000]);
  expect(await computeExpected(owner.orgId, shift)).toMatchObject({ expected: 15000, abonos: 5000, pending: 0 });
  await closeShift({ tenantId: owner.orgId, closedBy: owner.userId, shiftId: shift, counted: 15000 });
  const before = await repo.closedcash.byShift(shift);
  expect((await pushAbono(app, owner, { customer: x, amount: 1000, method: "cash", shift, created_at })).results[0].status).toBe("applied");
  expect(await repo.closedcash.byShift(shift)).toEqual(before);
});
