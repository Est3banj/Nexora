import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  creditMutation,
  joinOrg,
  pushAbono,
  pushMutations,
  resetTables,
  seedCustomer,
  type Actor,
} from "./helpers";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";
import * as t from "../src/db/schema";
import { DEFAULT_SETTINGS, ANNUL_CODE_TTL_MIN } from "../src/db/settings";
import { migrateSettings } from "../src/db/migrate-settings";

/**
 * roles-admin 3.6 + 3.7 · settings API + module backstops (design D4/D2).
 *
 *  - GET any verified role, hash-free PublicSettings (exact key set)
 *  - PUT Dueño tier: member 403 forbidden/dueño_only, admin+owner 2xx
 *  - absent row → DEFAULT_SETTINGS = current shipped behavior
 *  - strict body: annul_code_hash / unknown keys → 400 (never stripped)
 *  - iva_pct stored with ZERO financial behavior change
 *  - upsert idempotent (one row per tenant), partial patches never wipe
 *  - audit `settings.update` meta = patch
 *  - cross-tenant: B never sees A's fields (HTTP + repo)
 *  - rehydrate carries no settings key (server-only table)
 *  - boot DDL idempotent (migrateSettings twice) + 17 columns + iva CHECK
 *  - backstops (3.7, group-level): fiado OFF rejects credit sale group +
 *    credit_abono for EVERY role while the cash group of the SAME batch
 *    applies; oversell OFF rejects the whole negative sale group while an
 *    unrelated entry applies; defaults keep both behaviors as today.
 */

let app: FastifyInstance;
let owner: Actor;
let admin: Actor;
let member: Actor;
let repo: ReturnType<typeof scopedRepo>;
let shift: string;
let customer: string;

const GET_URL = "/api/settings";

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "settings-owner@test.dev", orgSlug: "settings-owner" });
  admin = await joinOrg(app, owner, "admin", "settings-admin@test.dev");
  member = await joinOrg(app, owner, "member", "settings-member@test.dev");
  repo = scopedRepo(db, owner.orgId);
  shift = (await repo.shifts.createOpen()).id;
  customer = await seedCustomer(app, owner);
});

const get = (actor: Actor) =>
  app.inject({ method: "GET", url: GET_URL, headers: authHeaders(actor) });

const put = (actor: Actor, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: GET_URL, headers: authHeaders(actor), payload });

async function seedVariant(name: string, stock: number) {
  const { variant } = await repo.catalog.createProduct({
    name,
    variant: { name: "Único", price: 4000, stock },
  });
  return variant;
}

/** The exact group a client sale emits (D3-1) — same shape stock-sale uses. */
function saleGroup(opts: {
  variant: { id: string; product_id: string; name: string; price: number; stock: number };
  qty: number;
  ticketNo: number;
  nextStock: number;
  ts: number;
  customerId?: string | null;
  withCredit?: boolean;
}) {
  const ticketId = randomUUID();
  const subtotal = opts.variant.price * opts.qty;
  const envelopes = [
    creditMutation(
      "ticket",
      {
        shift_id: shift,
        ...(opts.customerId ? { customer_id: opts.customerId } : {}),
        ticket_no: opts.ticketNo,
        status: "completed",
        total: subtotal,
      },
      ticketId,
      opts.ts,
    ),
    creditMutation(
      "ticket_line",
      { ticket_id: ticketId, variant_id: opts.variant.id, qty: opts.qty, unit_price: opts.variant.price, subtotal },
      randomUUID(),
      opts.ts + 1,
    ),
    creditMutation(
      "payment",
      opts.withCredit
        ? { ticket_id: ticketId, shift_id: shift, method: "credit", amount: subtotal, tendered: null, vuelto: null, status: "confirmed" }
        : { ticket_id: ticketId, shift_id: shift, method: "cash", amount: subtotal, tendered: subtotal, vuelto: 0, status: "confirmed" },
      randomUUID(),
      opts.ts + 2,
    ),
    creditMutation(
      "stockdiary",
      { variant_id: opts.variant.id, delta: -opts.qty, reason: "sale", note: `Venta #${opts.ticketNo}`, ref_ticket_id: ticketId },
      randomUUID(),
      opts.ts + 3,
    ),
    creditMutation(
      "variant",
      {
        product_id: opts.variant.product_id,
        name: opts.variant.name,
        price: opts.variant.price,
        stock: opts.nextStock,
        low_stock_threshold: null,
        active: true,
        ref_ticket_id: ticketId,
      },
      opts.variant.id,
      opts.ts + 4,
    ),
  ];
  return { ticketId, envelopes };
}

async function countRows(table: string, tenantId: string): Promise<number> {
  const res = await db.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE tenant_id = ${tenantId}`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

describe("GET /api/settings — any verified role, hash-free (3.5)", () => {
  it("owner, admin and member all read 200 with the exact PublicSettings key set", async () => {
    for (const actor of [owner, admin, member]) {
      const res = await get(actor);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body)).toEqual(["settings"]);
      expect(Object.keys(body.settings).sort()).toEqual(
        [
          "address",
          "allow_negative_stock",
          "annul_code_expires_at",
          "annul_code_set",
          "default_credit_limit",
          "enable_fiado",
          "iva_pct",
          "nit",
          "phone",
          "require_annul_code",
          "store_name",
          "ticket_footer",
          "ticket_prefix",
          "updated_at",
          "updated_by",
        ].sort(),
      );
      // the secret column has no line in the mapper — byte-level absence too
      expect(JSON.stringify(body)).not.toContain("annul_code_hash");
    }
  });

  it("absent row = current behavior (ST:Absent row = current behavior)", async () => {
    const res = await get(owner);
    expect(res.json().settings).toEqual(DEFAULT_SETTINGS);
    expect(res.json().settings).toMatchObject({
      enable_fiado: true,
      allow_negative_stock: true,
      require_annul_code: false,
      iva_pct: null,
      default_credit_limit: null,
      annul_code_set: false,
    });
    expect(ANNUL_CODE_TTL_MIN).toBe(15);
  });
});

describe("PUT /api/settings — Dueño tier + strict partial (3.5)", () => {
  it("member 403 forbidden/dueño_only and nothing persists", async () => {
    const res = await put(member, { store_name: "No debería existir" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden", detail: "dueño_only" });
    expect((await get(owner)).json().settings.store_name).toBeNull();
    expect(await countRows("tenant_settings", owner.orgId)).toBe(0);
  });

  it("admin and owner write 2xx, values persist tenant-scoped", async () => {
    for (const [actor, name] of [
      [admin, "Tienda Admin"],
      [owner, "Tienda Owner"],
    ] as const) {
      const res = await put(actor, { store_name: name, nit: "900123456" });
      expect(res.statusCode).toBe(200);
      expect(res.json().settings.store_name).toBe(name);
      expect(res.json().settings.nit).toBe("900123456");
    }
    const row = (await repo.settings.get());
    expect(row.store_name).toBe("Tienda Owner"); // last writer wins, still scoped
    expect(await countRows("tenant_settings", owner.orgId)).toBe(1);
    // B's tenant untouched
    expect((await get(await otherTenant())).json().settings.store_name).toBeNull();
  });

  it("strict body: annul_code_hash / unknown / tenant_id keys → 400, never stripped", async () => {
    for (const payload of [
      { store_name: "X", annul_code_hash: "deadbeef" },
      { whatever: 1 },
      { tenant_id: randomUUID(), store_name: "Forged" },
    ]) {
      const res = await put(owner, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("validation_error");
    }
    expect((await get(owner)).json().settings.store_name).toBeNull();
    expect(await countRows("tenant_settings", owner.orgId)).toBe(0);
  });

  it("first write creates the row with defaults for omitted fields + updated_at/by (ST:Row created on first write)", async () => {
    const res = await put(owner, { store_name: "Primera" });
    expect(res.statusCode).toBe(200);
    const rows = await db.select().from(t.tenantSettings).where(eq(t.tenantSettings.tenant_id, owner.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0].store_name).toBe("Primera");
    expect(rows[0].enable_fiado).toBe(true); // column default = current behavior
    expect(rows[0].allow_negative_stock).toBe(true);
    expect(rows[0].require_annul_code).toBe(false);
    expect(rows[0].iva_pct).toBeNull();
    expect(rows[0].updated_by).toBe(owner.userId);
    expect(rows[0].updated_at).toBeInstanceOf(Date);
  });

  it("upsert is idempotent: one row, partial patches never wipe earlier fields", async () => {
    await put(owner, { store_name: "Con NIT", nit: "111222333" });
    await put(owner, { enable_fiado: false });
    const rows = await db.select().from(t.tenantSettings).where(eq(t.tenantSettings.tenant_id, owner.orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      store_name: "Con NIT",
      nit: "111222333",
      enable_fiado: false,
      allow_negative_stock: true,
    });
  });

  it("clearing a field with null works (explicit null ≠ omitted)", async () => {
    await put(owner, { store_name: "Borrable", nit: "999" });
    const res = await put(owner, { store_name: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.store_name).toBeNull();
    expect(res.json().settings.nit).toBe("999");
  });

  it("writes the settings.update audit with meta = patch (void-sale.ts:66 precedent)", async () => {
    await put(owner, { store_name: "Auditada", enable_fiado: false });
    const rows = await db
      .select()
      .from(t.auditLog)
      .where(and(eq(t.auditLog.tenant_id, owner.orgId), eq(t.auditLog.action, "settings.update")));
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(owner.userId);
    expect(rows[0].meta).toMatchObject({ store_name: "Auditada", enable_fiado: false });
    // no secrets in audit either
    expect(JSON.stringify(rows[0].meta)).not.toContain("annul_code_hash");
  });
});

describe("iva_pct stored, never computed (3.6)", () => {
  it("saves 19 and changes NOTHING financial (ST:Storing IVA changes nothing financial)", async () => {
    const saved = await put(owner, { iva_pct: 19 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().settings.iva_pct).toBe(19);

    // a sale totals exactly as before: no tax math derives from iva_pct
    const variant = await seedVariant("Con IVA", 5);
    const group = saleGroup({ variant, qty: 1, ticketNo: 1, nextStock: 4, ts: Date.now() });
    const results = await pushMutations(app, owner, group.envelopes);
    expect(results.every((r) => r.status === "applied")).toBe(true);
    const ticket = await db.select().from(t.tickets).where(eq(t.tickets.id, group.ticketId));
    expect(ticket[0].total).toBe(4000);
    const payments = await db.select().from(t.payments).where(eq(t.payments.ticket_id, group.ticketId));
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe(4000);
    expect(await countRows("tenant_settings", owner.orgId)).toBe(1);
  });
});

describe("cross-tenant + plumbing negatives (3.6 / 3.11)", () => {
  it("B's session sees only B's settings (or defaults) — no A field disclosed", async () => {
    await put(owner, { store_name: "Segreta A", nit: "900999888", enable_fiado: false });
    const b = await otherTenant();
    const res = await get(b);
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual(DEFAULT_SETTINGS);
    // even the repo-level read is tenant-scoped
    expect(await scopedRepo(db, b.orgId).settings.get()).toEqual(DEFAULT_SETTINGS);
    expect(await scopedRepo(db, owner.orgId).settings.get()).toMatchObject({ store_name: "Segreta A" });
  });

  it("rehydrate payload carries no settings key (server-only table)", async () => {
    await put(owner, { store_name: "No rehidrata" });
    const res = await app.inject({ method: "GET", url: "/api/rehydrate", headers: authHeaders(owner) });
    expect(res.statusCode).toBe(200);
    const keys = Object.keys(res.json());
    expect(keys).not.toContain("settings");
    expect(keys).not.toContain("tenant_settings");
  });
});

describe("boot DDL (3.2)", () => {
  it("migrateSettings is idempotent: twice = no error, 17 columns + iva CHECK intact", async () => {
    await migrateSettings();
    await migrateSettings();
    const cols = await db.execute(
      sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='tenant_settings'`,
    );
    expect(Number(cols.rows[0]?.n)).toBe(17);
    const ck = await db.execute(
      sql`SELECT conname FROM pg_constraint WHERE conname='tenant_settings_iva_pct_ck'`,
    );
    expect(ck.rows).toHaveLength(1);
  });
});

describe("module backstops at apply (3.7, group-level, H3)", () => {
  it("defaults reproduce today: credit sale + abono apply with an absent row", async () => {
    const variant = await seedVariant("Hoy", 10);
    const group = saleGroup({ variant, qty: 1, ticketNo: 1, nextStock: 9, ts: Date.now(), customerId: customer, withCredit: true });
    const results = await pushMutations(app, owner, group.envelopes);
    expect(results.every((r) => r.status === "applied")).toBe(true);
    const abono = await pushAbono(app, owner, { customer, amount: 500, method: "cash", shift });
    expect(abono.results[0].status).toBe("applied");
  });

  it("fiado OFF: credit sale group + abono rejected:validation, cash group of the SAME batch applies (SY:Fiado off…)", async () => {
    expect((await put(owner, { enable_fiado: false })).statusCode).toBe(200);
    const variant = await seedVariant("Fiado off", 10);
    const ts = Date.now();
    const creditSale = saleGroup({ variant, qty: 1, ticketNo: 1, nextStock: 9, ts, customerId: customer, withCredit: true });
    const cashSale = saleGroup({ variant, qty: 1, ticketNo: 2, nextStock: 8, ts: ts + 100 });
    const abono = creditMutation(
      "credit_abono",
      { customer_id: customer, amount: 500, method: "cash", shift_id: shift },
      randomUUID(),
      ts + 200,
    );
    const results = await pushMutations(app, owner, [
      ...creditSale.envelopes,
      ...cashSale.envelopes,
      abono,
    ]);

    const creditSlice = results.slice(0, creditSale.envelopes.length);
    const cashSlice = results.slice(creditSale.envelopes.length, creditSale.envelopes.length + cashSale.envelopes.length);
    const abonoResult = results[results.length - 1];

    // whole credit GROUP rejected (never a per-item payment split)
    expect(creditSlice.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected", "rejected", "rejected"]);
    expect(creditSlice.every((r) => r.reason === "validation")).toBe(true);
    // sibling cash group of the same batch applies untouched
    expect(cashSlice.every((r) => r.status === "applied")).toBe(true);
    expect(abonoResult.status).toBe("rejected");
    expect(abonoResult.reason).toBe("validation");

    // no partial credit rows landed; cash sale did
    expect(await countRows("tickets", owner.orgId)).toBe(1);
    const tickets = await db.select().from(t.tickets).where(eq(t.tickets.tenant_id, owner.orgId));
    expect(tickets[0].id).toBe(cashSale.ticketId);
    expect(await countRows("credit_abonos", owner.orgId)).toBe(0);
    // stock moved only for the cash sale (initial 10 − 1)
    const inv = await db.select({ stock: t.productVariants.stock }).from(t.productVariants).where(eq(t.productVariants.id, variant.id));
    expect(inv[0].stock).toBe(9);
  });

  it("fiado OFF beats the role gate: member's abono push is also rejected (backstop is for EVERY role)", async () => {
    await put(owner, { enable_fiado: false });
    const abono = await pushAbono(app, member, { customer, amount: 250, method: "cash", shift });
    expect(abono.results[0]).toMatchObject({ status: "rejected", reason: "validation" });
  });

  it("oversell OFF: whole negative sale group rejected, unrelated entry applies, stock untouched (SY:Oversell off…)", async () => {
    expect((await put(owner, { allow_negative_stock: false })).statusCode).toBe(200);
    const variant = await seedVariant("Sin oversell", 1);
    const ts = Date.now();
    const oversell = saleGroup({ variant, qty: 3, ticketNo: 1, nextStock: -2, ts });
    const unrelated = creditMutation("category", { name: "Categoría hermana" }, randomUUID(), ts + 100);
    const results = await pushMutations(app, owner, [...oversell.envelopes, unrelated]);

    expect(results.slice(0, oversell.envelopes.length).map((r) => r.status)).toEqual([
      "rejected", "rejected", "rejected", "rejected", "rejected",
    ]);
    expect(results.slice(0, oversell.envelopes.length).every((r) => r.reason === "validation")).toBe(true);
    expect(results[results.length - 1].status).toBe("applied");

    // atomic: NO partial ticket/line/payment/stockdiary of the oversell group
    expect(await countRows("tickets", owner.orgId)).toBe(0);
    expect(await countRows("ticket_lines", owner.orgId)).toBe(0);
    expect(await countRows("payments", owner.orgId)).toBe(0);
    expect(await countRows("stockdiary", owner.orgId)).toBe(1); // only the initial seed
    const inv = await db.select({ stock: t.productVariants.stock }).from(t.productVariants).where(eq(t.productVariants.id, variant.id));
    expect(inv[0].stock).toBe(1);
  });

  it("oversell OFF still allows a sale that stays non-negative (toggle-on path applies)", async () => {
    await put(owner, { allow_negative_stock: false });
    const variant = await seedVariant("Justo", 1);
    const group = saleGroup({ variant, qty: 1, ticketNo: 1, nextStock: 0, ts: Date.now() });
    const results = await pushMutations(app, owner, group.envelopes);
    expect(results.every((r) => r.status === "applied")).toBe(true);
    const inv = await db.select({ stock: t.productVariants.stock }).from(t.productVariants).where(eq(t.productVariants.id, variant.id));
    expect(inv[0].stock).toBe(0);
  });
});

/** A second tenant for cross-tenant reads (fresh org, default settings). */
async function otherTenant(): Promise<Actor> {
  return createTenant(app, { email: "settings-other@test.dev", orgSlug: "settings-other" });
}
