import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
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
 * D4-3 · Full isolation sweep — ALL 10 business tables [MERGE GATE][CROSS]
 * AC (tenancy-auth spec):
 *  - §Cross-tenant read: B observes zero A rows on every business table
 *  - §Isolation holds on detail lookup (known uuid → not-found / undefined)
 *  - §Cross-tenant write: update affects zero rows; A row unchanged
 *  - §Forged tenant_id ignored
 *  - §Isolation sweep passes on every business table (merge gate)
 * Tables: products, product_variants, tickets, ticket_lines, payments,
 *         closedcash, shifts, stockcurrent, stockdiary, sync_log
 *
 * Also covers: founder endpoints rejected for tenant owner (founder-control),
 * and reports aggregates never include foreign tenant values.
 */

let app: FastifyInstance;
let tenantA: Actor;
let tenantB: Actor;

type Seeded = {
  productId: string;
  variantId: string;
  ticketId: string;
  lineId: string;
  paymentId: string;
  shiftId: string;
  closedCashId: string;
  diaryId: string;
  syncId: string;
  stockCurrentId: string;
};
let a: Seeded;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

/** Seed one full row set for tenant A across every business table. */
async function seedTenantA(): Promise<Seeded> {
  const repoA = scopedRepo(db, tenantA.orgId);

  const created = await app.inject({
    method: "POST",
    url: "/api/catalog/products",
    headers: authHeaders(tenantA),
    payload: {
      name: "Cerveza",
      variant: { name: "330ml", price: 4000, stock: 10 },
    },
  });
  expect(created.statusCode).toBe(201);
  const productId = created.json().product.id as string;
  const variantId = created.json().variant.id as string;

  const shiftId = randomUUID();
  await repoA.shifts.upsert({
    client_uuid: shiftId,
    status: "closed",
    opened_at: new Date(Date.now() - 3600_000),
    closed_at: new Date(),
  });

  const closedCashId = randomUUID();
  await repoA.closedcash.upsert({
    client_uuid: closedCashId,
    shift_id: shiftId,
    expected: 8000,
    counted: 8000,
    diff: 0,
    closed_by: tenantA.userId,
  });

  const ticketId = randomUUID();
  await repoA.tickets.upsert({
    client_uuid: ticketId,
    shift_id: shiftId,
    ticket_no: 1,
    total: 8000,
  });

  const lineId = randomUUID();
  await repoA.ticketLines.insertMany([
    {
      client_uuid: lineId,
      ticket_id: ticketId,
      variant_id: variantId,
      qty: 2,
      unit_price: 4000,
      subtotal: 8000,
    },
  ]);

  const paymentId = randomUUID();
  await repoA.payments.upsert({
    client_uuid: paymentId,
    ticket_id: ticketId,
    method: "cash",
    amount: 8000,
    tendered: 10000,
    vuelto: 2000,
    status: "confirmed",
    shift_id: shiftId,
  });

  const diaryId = randomUUID();
  await repoA.stock.adjust({
    client_uuid: diaryId,
    variant_id: variantId,
    delta: -2,
    reason: "sale",
    note: "isolation seed",
    ref_ticket_id: ticketId,
  });

  const stockRow = await repoA.stock.byVariant(variantId);
  expect(stockRow).toBeTruthy();

  const syncId = randomUUID();
  await repoA.syncLog.enqueue({
    client_uuid: syncId,
    client_ts: Date.now(),
    entity: "product",
        op: "upsert",
        payload: { name: "A-secret", active: true },
  });

  return {
    productId,
    variantId,
    ticketId,
    lineId,
    paymentId,
    shiftId,
    closedCashId,
    diaryId,
    syncId,
    stockCurrentId: stockRow!.id,
  };
}

beforeEach(async () => {
  await resetTables();
  tenantA = await createTenant(app, { email: "a@tenant.test", orgSlug: "org-a" });
  tenantB = await createTenant(app, { email: "b@tenant.test", orgSlug: "org-b" });
  a = await seedTenantA();
});

describe("D4-3 · cross-tenant read — all 10 tables", () => {
  it("products / product_variants: B lists empty, byUuid undefined", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: authHeaders(tenantB),
    });
    expect(res.json().products).toEqual([]);

    const repoB = scopedRepo(db, tenantB.orgId);
    expect(await repoB.products.byUuid(a.productId)).toBeUndefined();
    expect(await repoB.products.list()).toEqual([]);
    expect(await repoB.productVariants.byUuid(a.variantId)).toBeUndefined();
    expect(await repoB.productVariants.list()).toEqual([]);
    expect(await repoB.productVariants.listForSale()).toEqual([]);
  });

  it("tickets / ticket_lines / payments: B empty + detail not-found", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sales/tickets",
      headers: authHeaders(tenantB),
    });
    expect(res.json().tickets).toEqual([]);

    const detail = await app.inject({
      method: "GET",
      url: `/api/sales/tickets/${a.ticketId}`,
      headers: authHeaders(tenantB),
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toEqual({ error: "not_found" });

    const repoB = scopedRepo(db, tenantB.orgId);
    expect(await repoB.tickets.byUuid(a.ticketId)).toBeUndefined();
    expect(await repoB.tickets.list()).toEqual([]);
    expect(await repoB.ticketLines.listByTicket(a.ticketId)).toEqual([]);
    expect(await repoB.payments.byUuid(a.paymentId)).toBeUndefined();
    expect(await repoB.payments.list()).toEqual([]);
    expect(await repoB.payments.listByTicket(a.ticketId)).toEqual([]);
  });

  it("closedcash / shifts: B empty, byUuid undefined, open() null", async () => {
    const repoB = scopedRepo(db, tenantB.orgId);
    expect(await repoB.closedcash.list()).toEqual([]);
    expect(await repoB.closedcash.byUuid(a.closedCashId)).toBeUndefined();
    expect(await repoB.closedcash.byShift(a.shiftId)).toBeUndefined();
    expect(await repoB.shifts.byUuid(a.shiftId)).toBeUndefined();
    expect(await repoB.shifts.open()).toBeUndefined();
  });

  it("stockcurrent / stockdiary: B empty", async () => {
    const repoB = scopedRepo(db, tenantB.orgId);
    expect(await repoB.stock.currentAll()).toEqual([]);
    expect(await repoB.stock.byVariant(a.variantId)).toBeUndefined();
    expect(await repoB.stock.recount(a.variantId)).toBe(0);
    expect(await repoB.stockdiary.listByVariant(a.variantId)).toEqual([]);
    expect(await repoB.stockdiary.listRecent()).toEqual([]);
  });

  it("sync_log: B pending/list empty (never sees A's queue)", async () => {
    const repoB = scopedRepo(db, tenantB.orgId);
    expect(await repoB.syncLog.list()).toEqual([]);
    expect(await repoB.syncLog.pendingCount()).toBe(0);

    const repoA = scopedRepo(db, tenantA.orgId);
    expect(await repoA.syncLog.pendingCount()).toBe(1);
    expect(await repoA.syncLog.list()).toHaveLength(1);
  });

  it("reports aggregates never include tenant A values for B", async () => {
    const repoB = scopedRepo(db, tenantB.orgId);
    const sales = await repoB.reports.salesByDay();
    expect(sales).toEqual([]);
    const top = await repoB.reports.topProducts();
    expect(top).toEqual([]);
    const low = await repoB.reports.lowStock();
    // B has no catalog → no rows (never A's low-stock products)
    expect(low).toEqual([]);
  });

  it("rehydrate page for B carries no A rows", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/rehydrate",
      headers: authHeaders(tenantB),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.products ?? []).toEqual([]);
    expect(body.variants ?? []).toEqual([]);
    expect(body.tickets ?? []).toEqual([]);
    expect(body.ticket_lines ?? []).toEqual([]);
    expect(body.payments ?? []).toEqual([]);
    expect(body.stockdiary ?? []).toEqual([]);
    expect(body.stock ?? []).toEqual([]);
    expect(body.open_shift ?? null).toBeNull();
  });
});

describe("D4-3 · cross-tenant write — zero affected rows", () => {
  it("products / variants / tickets / payments updates affect 0 rows; A unchanged", async () => {
    const repoB = scopedRepo(db, tenantB.orgId);
    expect(await repoB.products.update(a.productId, { name: "HACKED" })).toBe(0);
    expect(
      await repoB.productVariants.update(a.variantId, { price: 1 }),
    ).toBe(0);
    expect(await repoB.tickets.update(a.ticketId, { status: "void" })).toBe(0);
    expect(await repoB.payments.update(aPayment(), { status: "pending" })).toBe(0);

    const repoA = scopedRepo(db, tenantA.orgId);
    expect((await repoA.products.byUuid(a.productId))?.name).toBe("Cerveza");
    expect((await repoA.productVariants.byUuid(a.variantId))?.price).toBe(4000);
    expect((await repoA.tickets.byUuid(a.ticketId))?.status).toBe("completed");
    expect((await repoA.payments.byUuid(a.paymentId))?.status).toBe("confirmed");
  });

  it("HTTP PATCH product as B → 404, A row unchanged", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/catalog/products/${a.productId}`,
      headers: authHeaders(tenantB),
      payload: { name: "HACKED" },
    });
    expect(res.statusCode).toBe(404);
    const repoA = scopedRepo(db, tenantA.orgId);
    expect((await repoA.products.byUuid(a.productId))?.name).toBe("Cerveza");
  });

  it("B cannot confirm A payment; A confirmed_at stays null", async () => {
    const repoB = scopedRepo(db, tenantB.orgId);
    const affected = await repoB.payments.update(a.paymentId, {
      status: "confirmed",
      confirmed_at: new Date(),
    });
    expect(affected).toBe(0);
    const repoA = scopedRepo(db, tenantA.orgId);
    expect((await repoA.payments.byUuid(a.paymentId))?.confirmed_at).toBeNull();
  });

  it("B stock.adjust on A's variant is a no-op (variant invisible → null)", async () => {
    const repoB = scopedRepo(db, tenantB.orgId);
    const result = await repoB.stock.adjust({
      variant_id: a.variantId,
      delta: -100,
      reason: "sale",
      note: "hack",
    });
    expect(result).toBeNull();
    const repoA = scopedRepo(db, tenantA.orgId);
    expect((await repoA.stock.byVariant(a.variantId))?.stock).toBe(8);
    expect(await repoA.stock.recount(a.variantId)).toBe(8);
    // B's stockcurrent still empty
    expect(await repoB.stock.currentAll()).toEqual([]);
  });

  it("B enqueue lands in B's sync_log only; A's queue untouched", async () => {
    const repoB = scopedRepo(db, tenantB.orgId);
    await repoB.syncLog.enqueue({
      client_uuid: randomUUID(),
      client_ts: Date.now(),
      entity: "product",
        op: "upsert",
        payload: { name: "B-only", active: true },
    });
    expect(await repoB.syncLog.pendingCount()).toBe(1);

    const repoA = scopedRepo(db, tenantA.orgId);
    const rows = await repoA.syncLog.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ name: "A-secret" });
  });
});

describe("D4-3 · forged tenant_id ignored", () => {
  it("create body tenant_id → session tenant; B still empty", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders(tenantA),
      payload: {
        name: "Producto Bonificado",
        variant: { name: "Único", price: 1000 },
        tenant_id: tenantB.orgId,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().product.tenant_id).toBe(tenantA.orgId);
    expect(res.json().variant.tenant_id).toBe(tenantA.orgId);

    const bList = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: authHeaders(tenantB),
    });
    expect(bList.json().products).toEqual([]);
  });

  it("update body tenant_id ignored", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/catalog/products/${a.productId}`,
      headers: authHeaders(tenantA),
      payload: { name: "Cerveza Andina", tenant_id: tenantB.orgId },
    });
    expect(res.statusCode).toBe(200);

    const repoB = scopedRepo(db, tenantB.orgId);
    expect(await repoB.products.list()).toEqual([]);
    const repoA = scopedRepo(db, tenantA.orgId);
    expect((await repoA.products.byUuid(a.productId))?.name).toBe("Cerveza Andina");
  });
});

describe("D4-3 · founder endpoints rejected for tenant owner", () => {
  it("owner without platformAdmin → 403 on create + sync-status", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/api/founder/tenants",
      headers: authHeaders(tenantA),
      payload: { name: "Nope", email: "nope@x.test", password: "secret1234" },
    });
    expect(create.statusCode).toBe(403);

    const status = await app.inject({
      method: "GET",
      url: "/api/founder/sync-status",
      headers: authHeaders(tenantA),
    });
    expect(status.statusCode).toBe(403);
  });
});

function aPayment(): string {
  return a.paymentId;
}
