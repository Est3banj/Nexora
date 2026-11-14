import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  creditMutation,
  joinOrg,
  pushCreditSale,
  pushMutations,
  resetTables,
  seedCustomer,
  type Actor,
} from "./helpers";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";

/**
 * roles-admin 2.8 · SERVER role matrix — endpoint × {owner, admin, member}
 * (design §10 + task table). Server is authoritative; every gate added in
 * 2.1–2.5 is exercised from all three verified roles here:
 *
 *  - catalog REST      member 403 dueño_only / admin 2xx / owner 2xx (+ GET open)
 *  - financial reports member 403 / admin 2xx / owner 2xx (dashboard, sales-by-day, top-products)
 *  - operational reads ALL 200 (customer-balances, customer-accounts, low-stock, rehydrate)
 *  - payments confirm   member 403 owner_only / admin 2xx / owner 2xx
 *  - void (toggle OFF)  member 403 owner_only / admin 2xx / owner 2xx
 *  - sync mixed batch   member: catalog per-item rejected, sale group intact (D2)
 *  - credit_abono       member → applied (decision #1, supersedes fiado #6)
 */

type RoleName = "owner" | "admin" | "member";

let app: FastifyInstance;
let owner: Actor;
let admin: Actor;
let member: Actor;
let repo: ReturnType<typeof scopedRepo>;
let shift: string;
let customer: string;

const RANGE = "from=2026-11-01&to=2026-11-07";

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "matrix-owner@test.dev", orgSlug: "matrix-owner" });
  admin = await joinOrg(app, owner, "admin", "matrix-admin@test.dev");
  member = await joinOrg(app, owner, "member", "matrix-member@test.dev");
  repo = scopedRepo(db, owner.orgId);
  shift = (await repo.shifts.createOpen()).id;
  customer = await seedCustomer(app, owner);
});

const get = (url: string, actor: Actor) =>
  app.inject({ method: "GET", url, headers: authHeaders(actor) });

const ACTORS: Record<RoleName, () => Actor> = {
  owner: () => owner,
  admin: () => admin,
  member: () => member,
};

describe("role matrix · catalog REST (2.1)", () => {
  const newProduct = () => ({
    name: `Matriz ${Math.random().toString(36).slice(2, 8)}`,
    variant: { name: "Único", price: 1500 },
  });

  it("member 403 forbidden/dueño_only · admin 2xx · owner 2xx (GET stays open)", async () => {
    const denied = await app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders(member),
      payload: newProduct(),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "forbidden", detail: "dueño_only" });
    expect((await repo.products.list()).some(p => p.name.startsWith("Matriz "))).toBe(false);

    for (const actor of [admin, owner]) {
      const ok = await app.inject({
        method: "POST",
        url: "/api/catalog/products",
        headers: authHeaders(actor),
        payload: newProduct(),
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().product.tenant_id).toBe(owner.orgId);
    }

    // read-only continuity for every verified role (catalog spec §reads)
    for (const role of ["owner", "admin", "member"] as const) {
      expect((await get("/api/catalog/products", ACTORS[role]())).statusCode).toBe(200);
      expect((await get("/api/catalog/sale-items", ACTORS[role]())).statusCode).toBe(200);
      expect((await get("/api/catalog/categories", ACTORS[role]())).statusCode).toBe(200);
    }
  });
});

describe("role matrix · financial reports (2.2)", () => {
  const FINANCIAL = [
    `/api/reports/dashboard?${RANGE}`,
    `/api/reports/sales-by-day?${RANGE}`,
    `/api/reports/top-products?${RANGE}`,
  ];

  it.each(FINANCIAL)("member 403 on %s (no figure leaked)", async url => {
    const res = await get(url, member);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden", detail: "dueño_only" });
    expect(res.body).not.toContain("revenue");
  });

  it.each(FINANCIAL)("admin 200 on %s", async url => {
    expect((await get(url, admin)).statusCode).toBe(200);
  });

  it.each(FINANCIAL)("owner 200 on %s (unchanged fixtures path)", async url => {
    expect((await get(url, owner)).statusCode).toBe(200);
  });
});

describe("role matrix · operational reads stay open (2.2 non-regression)", () => {
  const OPERATIONAL = [
    "/api/reports/customer-balances",
    "/api/reports/customer-accounts",
    "/api/reports/low-stock",
    "/api/rehydrate",
  ];

  it.each(OPERATIONAL)("all three roles 200 on %s", async url => {
    for (const role of ["owner", "admin", "member"] as const) {
      const res = await get(url, ACTORS[role]());
      expect(res.statusCode, `${role} → ${url}`).toBe(200);
    }
  });
});

describe("role matrix · transfer confirm (2.3)", () => {
  async function seedPendingTransfer(): Promise<string> {
    const ticketId = randomUUID();
    await repo.tickets.upsert({
      client_uuid: ticketId,
      shift_id: null,
      ticket_no: Math.floor(Math.random() * 9000) + 100,
      total: 18_000,
      status: "transfer_pending",
    });
    const paymentId = randomUUID();
    await repo.payments.upsert({
      client_uuid: paymentId,
      ticket_id: ticketId,
      method: "transfer",
      amount: 18_000,
      status: "pending",
    });
    return paymentId;
  }

  const confirm = (paymentId: string, actor: Actor) =>
    app.inject({ method: "POST", url: `/api/payments/${paymentId}/confirm`, headers: authHeaders(actor) });

  it("member 403 owner_only · admin 2xx · owner 2xx", async () => {
    const forMember = await seedPendingTransfer();
    const denied = await confirm(forMember, member);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "forbidden", detail: "owner_only" });
    expect((await repo.payments.byUuid(forMember))?.status).toBe("pending");

    const forAdmin = await seedPendingTransfer();
    const adminOk = await confirm(forAdmin, admin);
    expect(adminOk.statusCode).toBe(200);
    expect((await repo.payments.byUuid(forAdmin))?.status).toBe("confirmed");

    const forOwner = await seedPendingTransfer();
    const ownerOk = await confirm(forOwner, owner);
    expect(ownerOk.statusCode).toBe(200);
    expect((await repo.payments.byUuid(forOwner))?.status).toBe("confirmed");
  });
});

describe("role matrix · void toggle OFF (2.4)", () => {
  /** Complete-evidence cash sale (mirrors void-sale.test.ts `sale()`).
   * `ticketNo` must be unique per tenant (tickets_tenant_ticket_no_uq). */
  async function seedVoidableSale(tag: string, ticketNo: number): Promise<string> {
    const { variant } = await repo.catalog.createProduct({
      name: `Void ${tag}`,
      variant: { name: "Único", price: 4000, cost: 1500, stock: 10 },
    });
    const id = randomUUID();
    const envelopes = [
      creditMutation("ticket", { shift_id: shift, ticket_no: ticketNo, total: 8000, status: "completed" }, id),
      creditMutation("ticket_line", { ticket_id: id, variant_id: variant.id, qty: 2, unit_price: 4000, subtotal: 8000 }),
      creditMutation("payment", { ticket_id: id, shift_id: shift, method: "cash", amount: 8000, tendered: 8000, vuelto: 0, status: "confirmed" }),
      creditMutation("stockdiary", { variant_id: variant.id, delta: -2, reason: "sale", ref_ticket_id: id, note: "Venta" }),
      creditMutation("variant", { product_id: variant.product_id, name: variant.name, price: 4000, cost: 1500, stock: 8, low_stock_threshold: null, active: true, ref_ticket_id: id }, variant.id),
    ];
    const results = await pushMutations(app, owner, envelopes);
    expect(results.map(r => r.status), `ticket_no ${ticketNo}`).toEqual(
      Array(5).fill("applied"),
    );
    return id;
  }

  const annul = (id: string, actor: Actor) =>
    app.inject({ method: "POST", url: `/api/sales/tickets/${id}/void`, headers: authHeaders(actor), payload: { reason: "Error de cobro" } });

  it("member 403 owner_only · admin 2xx · owner 2xx (nothing else changes)", async () => {
    const s = await seedVoidableSale("matrix", 500);

    // authorization precedes evidence probing: member gets the 403 body,
    // never a business error, and NOTHING is mutated (void spec D3 order).
    const denied = await annul(s, member);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "owner_only" });
    expect((await repo.tickets.byUuid(s))?.status).toBe("completed");

    const adminOk = await annul(s, admin);
    expect(adminOk.statusCode).toBe(200);
    expect((await repo.tickets.byUuid(s))?.status).toBe("voided");

    // owner on a FRESH sale (tier parity — both reach voidSale)
    const s2 = await seedVoidableSale("matrix-owner", 501);
    const ownerOk = await annul(s2, owner);
    expect(ownerOk.statusCode).toBe(200);
    expect((await repo.tickets.byUuid(s2))?.status).toBe("voided");
  });
});

describe("role matrix · sync push (2.5/2.7)", () => {
  it("member mixed batch: catalog per-item rejected (HTTP 2xx), sale group intact", async () => {
    const { product, variant } = await repo.catalog.createProduct({
      name: "Mezcla Matriz",
      variant: { name: "Único", price: 3000, stock: 10 },
    });
    const ticket = randomUUID();
    const mutations = [
      creditMutation("product", { name: "Producto Nuevo Member" }),
      creditMutation("variant", { product_id: product.id, name: "Único", price: 3000, cost: null, stock: 10, low_stock_threshold: null, active: true }),
      creditMutation("stockdiary", { variant_id: variant.id, delta: 5, reason: "reposition", note: "Ajuste manual" }),
      creditMutation("ticket", { shift_id: shift, ticket_no: 600, total: 3000, status: "completed" }, ticket),
      creditMutation("ticket_line", { ticket_id: ticket, variant_id: variant.id, qty: 1, unit_price: 3000, subtotal: 3000 }),
      creditMutation("payment", { ticket_id: ticket, shift_id: shift, method: "cash", amount: 3000, tendered: 3000, vuelto: 0, status: "confirmed" }),
      creditMutation("variant", { product_id: product.id, name: "Único", price: 3000, cost: null, stock: 9, low_stock_threshold: null, active: true, ref_ticket_id: ticket }, variant.id),
      creditMutation("stockdiary", { variant_id: variant.id, delta: -1, reason: "sale", ref_ticket_id: ticket }),
    ];
    // pushMutations throws unless HTTP 200 — member batches NEVER get a 403.
    const results = await pushMutations(app, member, mutations);
    expect(results.map(r => r.status)).toEqual([
      "rejected", "rejected", "rejected", "applied", "applied", "applied", "applied", "applied",
    ]);
    expect(results.slice(0, 3).every(r => r.reason === "validation")).toBe(true);
    expect((await repo.products.list()).some(p => p.name === "Producto Nuevo Member")).toBe(false);
    expect(await repo.tickets.byUuid(ticket)).toMatchObject({ status: "completed", total: 3000 });
    expect(await repo.stock.recount(variant.id)).toBe(9);
  });

  it("member credit_abono → applied (decision #1, supersedes fiado #6)", async () => {
    // an open credit balance to collect against (abono amount ≤ balance rule)
    await pushCreditSale(app, owner, { customer, amount: 50_000, shift });
    const results = await pushMutations(app, member, [
      creditMutation("credit_abono", { customer_id: customer, amount: 1000, method: "cash", shift_id: shift }),
    ]);
    expect(results[0].status).toBe("applied");
    expect(await repo.creditAbonos.listRecent()).toHaveLength(1);
    const accounts = await repo.reports.customerAccounts();
    expect(accounts.find(a => a.customer_id === customer)?.balance).toBe(49_000);
  });
});
