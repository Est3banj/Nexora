import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { saleDigest, type MutationEnvelope } from "@pos/shared";
import { sql } from "drizzle-orm";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";
import { authHeaders, buildTestApp, createTenant, creditMutation as m, joinOrg, pushMutations, resetTables, seedCustomer, type Actor } from "./helpers";

let app: FastifyInstance, owner: Actor, member: Actor;
let repo: ReturnType<typeof scopedRepo>;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  await resetTables(); owner = await createTenant(app, { email: "authority@test.dev", orgSlug: "authority" });
  member = await joinOrg(app, owner, "member", "cashier-authority@test.dev"); repo = scopedRepo(db, owner.orgId);
});
async function fixture(method: "cash" | "transfer" | "credit" = "cash", count = 1) {
  const { product, variant } = await repo.catalog.createProduct({ name: "Café", variant: { name: "Único", price: 100, cost: 40, code: "CAF", stock: 100 } });
  const shift = await repo.shifts.createOpen(), ticket = randomUUID();
  const customer = method === "credit" ? await seedCustomer(app, member) : null;
  const items = [
    m("ticket", { shift_id: shift.id, ticket_no: 1, total: count * 90, status: method === "transfer" ? "transfer_pending" : "completed", customer_id: customer }, ticket),
    ...Array.from({ length: count }, () => m("ticket_line", { ticket_id: ticket, variant_id: variant.id, qty: 1, unit_price: 90, subtotal: 90 })),
    m("payment", { ticket_id: ticket, shift_id: shift.id, method, amount: count * 90, tendered: method === "cash" ? count * 90 : null, vuelto: method === "cash" ? 0 : null, status: method === "transfer" ? "pending" : "confirmed" }),
    m("stockdiary", { variant_id: variant.id, ref_ticket_id: ticket, delta: -count, reason: "sale" }),
    m("variant", { product_id: product.id, name: "Snapshot viejo", price: 90, cost: 1, code: "VIEJO", stock: 999, low_stock_threshold: 99, active: false, ref_ticket_id: ticket }, variant.id),
  ];
  return { product, variant, ticket, items };
}
async function stage(items: MutationEnvelope[], ticket: string, actor = member) {
  const operation = randomUUID(), parts = [];
  for (let i = 0; i < items.length; i += 50) parts.push(items.slice(i, i + 50));
  const manifest = { ticket_id: ticket, count: items.length, hash: await saleDigest(items), parts: await Promise.all(parts.map(saleDigest)) };
  for (let index = 0; index < parts.length; index++) {
    const res = await app.inject({ method: "POST", url: `/api/sync/sales/${operation}/parts`, headers: authHeaders(actor), payload: { manifest, index, mutations: parts[index] } });
    expect(res.statusCode).toBe(200);
  }
  return () => app.inject({ method: "POST", url: `/api/sync/sales/${operation}/finalize`, headers: authHeaders(actor), payload: manifest });
}

it.each(["variant", "stockdiary"])("fake/nonexistent ref is not %s authority", async entity => {
  const s = await fixture();
  const attack = s.items.find(i => i.entity === entity)!;
  Object.assign(attack.payload, { ref_ticket_id: randomUUID() });
  expect((await pushMutations(app, member, [attack]))[0]).toMatchObject({ status: "rejected", reason: "validation" });
  expect(await repo.productVariants.byUuid(s.variant.id)).toMatchObject({ price: 100, stock: 100 });
});
it.each(["cash", "transfer", "credit"] as const)("legacy %s sale ACKs stale metadata without catalog/ledger writes", async method => {
  const s = await fixture(method);
  expect((await pushMutations(app, member, s.items)).every(r => r.status === "applied")).toBe(true);
  expect(await repo.productVariants.byUuid(s.variant.id)).toMatchObject({ name: "Único", price: 100, cost: 40, code: "CAF", stock: 99, active: true, low_stock_threshold: null });
  expect(await repo.ticketLines.listByTicket(s.ticket)).toMatchObject([{ unit_price: 90 }]);
  expect((await db.execute(sql`SELECT * FROM sync_log WHERE tenant_id=${owner.orgId} AND client_uuid=${s.variant.id}`)).rows).toHaveLength(0);
});
it.each([-2, 1])("rejects forged movement delta %s atomically", async delta => {
  const s = await fixture(); Object.assign(s.items.find(i => i.entity === "stockdiary")!.payload, { delta });
  expect((await pushMutations(app, member, s.items)).every(r => r.status === "rejected")).toBe(true);
  expect(await repo.tickets.byUuid(s.ticket)).toBeUndefined(); expect(await repo.stock.recount(s.variant.id)).toBe(100);
});
it("rejects changed-content movement replay even with newer timestamp; original evidence survives", async () => {
  const s = await fixture(); await pushMutations(app, member, s.items);
  const movement = structuredClone(s.items.find(i => i.entity === "stockdiary")!); movement.client_ts += 1000;
  Object.assign(movement.payload, { note: "changed" });
  expect((await pushMutations(app, member, [movement]))[0]).toMatchObject({ status: "rejected", reason: "validation" });
  expect(await repo.stock.recount(s.variant.id)).toBe(99);
});
it("legacy ticket/lines can precede movement/refresh and identical retry converges", async () => {
  const s = await fixture();
  expect((await pushMutations(app, member, s.items.slice(0, 3))).every(r => r.status === "applied")).toBe(true);
  expect((await pushMutations(app, member, s.items.slice(3))).every(r => r.status === "applied")).toBe(true);
  expect((await pushMutations(app, member, s.items.slice(3))).every(r => ["applied", "duplicate"].includes(r.status))).toBe(true);
  expect(await repo.stock.recount(s.variant.id)).toBe(99);
});
it("legacy split movement deliveries consume the same quantity budget once; extra UUID cannot overspend it", async () => {
  const s = await fixture("cash", 2);
  const evidence = s.items.filter(i => i.entity !== "stockdiary" && i.entity !== "variant");
  expect((await pushMutations(app, member, evidence)).every(r => r.status === "applied")).toBe(true);
  const movement = m("stockdiary", { variant_id: s.variant.id, ref_ticket_id: s.ticket, delta: -1, reason: "sale" });
  expect((await pushMutations(app, member, [movement]))[0].status).toBe("applied");
  expect((await pushMutations(app, member, [movement]))[0].status).toBe("duplicate");
  expect((await pushMutations(app, member, [{ ...movement, client_uuid: randomUUID() }]))[0].status).toBe("applied");
  expect((await pushMutations(app, member, [{ ...movement, client_uuid: randomUUID() }]))[0]).toMatchObject({ status: "rejected", reason: "validation" });
  expect(await repo.stock.recount(s.variant.id)).toBe(98);
});
it("valid large staged sale cannot use refresh metadata as catalog authority", async () => {
  const s = await fixture("cash", 60), finalize = await stage(s.items, s.ticket);
  expect((await finalize()).statusCode).toBe(200); expect((await finalize()).statusCode).toBe(200);
  expect(await repo.productVariants.byUuid(s.variant.id)).toMatchObject({ price: 100, cost: 40, code: "CAF", name: "Único", stock: 40, active: true });
});
it("staged sale cannot create a variant, including after uploader is demoted before finalize", async () => {
  const s = await fixture();
  const id = randomUUID();
  for (const item of s.items) {
    if (item.entity === "variant") item.client_uuid = id;
    if (item.entity === "ticket_line" || item.entity === "stockdiary") item.payload.variant_id = id;
  }
  const finalize = await stage(s.items, s.ticket, owner);
  await db.execute(sql`UPDATE member SET role='member' WHERE "userId"=${owner.userId}`);
  expect((await finalize()).statusCode).toBe(409);
  expect(await repo.productVariants.byUuid(id)).toBeUndefined(); expect(await repo.tickets.byUuid(s.ticket)).toBeUndefined();
});
