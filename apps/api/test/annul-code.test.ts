import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  joinOrg,
  pushAbono,
  pushCreditSale,
  resetTables,
  seedCustomer,
  type Actor,
} from "./helpers";
import { closeDb, db, pool } from "../src/db";
import { scopedRepo } from "../src/db/scope";
import * as t from "../src/db/schema";
import { ANNUL_CODE_ALPHABET, ANNUL_CODE_LENGTH } from "../src/db/settings";

/**
 * roles-admin 4.6 · annul-code lifecycle matrix (spec void §Security code
 * model + scenarios, design D3):
 *
 *  - generate → plaintext EXACTLY once (HMAC/expires/created_by persisted)
 *  - GET settings whole body: no hash key, no hash value, no plaintext
 *  - toggle ON: void w/o code → `required`; wrong → `mismatch`;
 *    valid → 200 for owner AND member (code replaces the tier gate)
 *  - rotation kills the previous code instantly, the new one validates
 *  - expiry forced via SQL past `expires_at` → `expired`, nothing mutated
 *  - POST /api/settings/annul-code: member 403 (no code created), admin 2xx
 *  - abonos block survives a VALID code → still 409 (H5, never bypassed)
 */

let app: FastifyInstance;
let owner: Actor;
let admin: Actor;
let member: Actor;
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
  owner = await createTenant(app, { email: "annul-owner@test.dev", orgSlug: "annul-owner" });
  admin = await joinOrg(app, owner, "admin", "annul-admin@test.dev");
  member = await joinOrg(app, owner, "member", "annul-member@test.dev");
  repo = scopedRepo(db, owner.orgId);
});

const gen = (actor: Actor) =>
  app.inject({ method: "POST", url: "/api/settings/annul-code", headers: authHeaders(actor) });

const put = (actor: Actor, payload: Record<string, unknown>) =>
  app.inject({ method: "PUT", url: "/api/settings", headers: authHeaders(actor), payload });

const get = (actor: Actor) =>
  app.inject({ method: "GET", url: "/api/settings", headers: authHeaders(actor) });

function annul(
  id: string,
  actor: Actor = owner,
  payload: Record<string, unknown> = { reason: "Error de cobro" },
) {
  return app.inject({
    method: "POST",
    url: `/api/sales/tickets/${id}/void`,
    headers: authHeaders(actor),
    payload,
  });
}

/** Generate + return the plaintext (the only place it ever exists). */
async function currentCode(actor: Actor = owner): Promise<{ code: string; expires_at: string }> {
  const res = await gen(actor);
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function toggleOn(actor: Actor = owner) {
  expect((await put(actor, { require_annul_code: true })).statusCode).toBe(200);
}

/** Cash sale with complete evidence (pattern: void-sale.test.ts `sale()`).
 * One open shift per tenant + unique ticket_no → siblings reuse `opts`. */
async function sale(opts: { shiftId?: string; ticketNo?: number } = {}) {
  const shift = opts.shiftId ? { id: opts.shiftId } : await repo.shifts.createOpen();
  const { variant } = await repo.catalog.createProduct({
    name: "Café",
    variant: { name: "Único", price: 4000, cost: 1500, stock: 10 },
  });
  const id = randomUUID();
  const env = (entity: string, payload: unknown, client_uuid: string = randomUUID()) => ({
    entity,
    payload,
    client_uuid,
    client_ts: Date.now(),
    op: "upsert",
  });
  const envelopes = [
    env("ticket", { shift_id: shift.id, ticket_no: opts.ticketNo ?? 1, total: 8000, status: "completed" }, id),
    env("ticket_line", { ticket_id: id, variant_id: variant.id, qty: 2, unit_price: 4000, subtotal: 8000 }),
    env("payment", { ticket_id: id, shift_id: shift.id, method: "cash", amount: 8000, tendered: 10000, vuelto: 2000, status: "confirmed" }),
    env("stockdiary", { variant_id: variant.id, delta: -2, reason: "sale", ref_ticket_id: id, note: "Venta #1" }),
    env("variant", { product_id: variant.product_id, name: variant.name, price: 4000, stock: 8, low_stock_threshold: null, active: true, ref_ticket_id: id }, variant.id),
  ];
  const res = await app.inject({
    method: "POST",
    url: "/api/sync/mutations",
    headers: authHeaders(owner),
    payload: { mutations: envelopes },
  });
  expect(res.json().results.every((r: { status: string }) => r.status === "applied")).toBe(true);
  return { id, shift, variant };
}

const settingsRow = () =>
  db.select().from(t.tenantSettings).where(eq(t.tenantSettings.tenant_id, owner.orgId));

const rotateAudits = () =>
  db.select().from(t.auditLog).where(eq(t.auditLog.action, "annul_code.rotate"));

describe("generate → plaintext once, zero leak (4.6 / VD:Settings never leak the secret)", () => {
  it("POST returns {code, expires_at} once; the row stores only HMAC/expires/created_by", async () => {
    const res = await gen(owner);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["code", "expires_at"]);
    // 8 chars, no ambiguous I/O/0/1 (D3 alphabet)
    expect(body.code).toMatch(new RegExp(`^[${ANNUL_CODE_ALPHABET}]{${ANNUL_CODE_LENGTH}}$`));
    const ttlMin = (new Date(body.expires_at).getTime() - Date.now()) / 60_000;
    expect(ttlMin).toBeGreaterThan(14);
    expect(ttlMin).toBeLessThan(16);

    const rows = await settingsRow();
    expect(rows).toHaveLength(1);
    expect(rows[0].annul_code_hash).toBeTruthy();
    expect(rows[0].annul_code_hash).not.toBe(body.code); // stored form ≠ plaintext
    expect(rows[0].annul_code_created_by).toBe(owner.userId);

    // audit meta = {expires_at, created_by} EXACTLY — never code or hash
    const audits = await rotateAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0].actor).toBe(owner.userId);
    expect(audits[0].meta).toEqual({ expires_at: body.expires_at, created_by: owner.userId });
    const meta = JSON.stringify(audits[0].meta);
    expect(meta).not.toContain(body.code);
    expect(meta).not.toContain(rows[0].annul_code_hash!);
  });

  it("GET settings whole body: no hash key, no hash value, no plaintext, for every role", async () => {
    const { code, expires_at } = await currentCode();
    const rows = await settingsRow();
    const hash = rows[0].annul_code_hash!;
    expect(hash).toBeTruthy();

    for (const actor of [owner, admin, member]) {
      const res = await get(actor);
      expect(res.statusCode).toBe(200);
      // WHOLE raw body scanned — not just an object path
      expect(res.body).not.toContain("annul_code_hash");
      expect(res.body).not.toContain(hash);
      expect(res.body).not.toContain(code);
      const settings = res.json().settings;
      expect(settings.annul_code_set).toBe(true);
      expect(settings.annul_code_expires_at).toBe(expires_at);
      expect(settings.require_annul_code).toBe(false); // toggle untouched by generation
    }
  });
});

describe("void under toggle ON (4.4 D3 + 4.6 matrix)", () => {
  it("nobody annuls raw: no code → required (owner AND member), wrong → mismatch, valid → 200 owner AND member", async () => {
    await toggleOn();
    const { code } = await currentCode();
    const s = await sale();
    const s2 = await sale({ shiftId: s.shift.id, ticketNo: 2 });

    // owner-without-code 403 — the toggle ON gate is absolute (D3 #2)
    const ownerRaw = await annul(s.id, owner);
    expect(ownerRaw.statusCode).toBe(403);
    expect(ownerRaw.json()).toEqual({ error: "annul_code_required" });
    const memberRaw = await annul(s.id, member);
    expect(memberRaw.statusCode).toBe(403);
    expect(memberRaw.json()).toEqual({ error: "annul_code_required" });
    // nothing mutated by either rejection
    expect((await repo.tickets.byUuid(s.id))?.status).toBe("completed");

    // wrong code → distinct `mismatch`, still nothing mutated
    const wrongCode = code === "ZZZZZZZZ" ? "YYYYYYYY" : "ZZZZZZZZ";
    const wrong = await annul(s.id, owner, { reason: "Error de cobro", code: wrongCode });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: "annul_code_invalid", detail: "mismatch" });
    expect((await repo.tickets.byUuid(s.id))?.status).toBe("completed");
    const variant = await repo.productVariants.byUuid(s.variant.id);
    expect(variant?.stock).toBe(8);

    // valid code → 200 for the OWNER…
    expect((await annul(s.id, owner, { reason: "Error de cobro", code })).statusCode).toBe(200);
    expect((await repo.tickets.byUuid(s.id))?.status).toBe("voided");

    // …and for the MEMBER (code replaces the tier gate when ON)
    expect((await annul(s2.id, member, { reason: "Error de cobro", code })).statusCode).toBe(200);
    expect((await repo.tickets.byUuid(s2.id))?.status).toBe("voided");
  });

  it("rotation invalidates the old code INSTANTLY; the new one validates (single active row)", async () => {
    await toggleOn();
    const a = await currentCode();
    const b = await currentCode();
    expect(b.code).not.toBe(a.code);
    const s = await sale();

    const old = await annul(s.id, owner, { reason: "Error de cobro", code: a.code });
    expect(old.statusCode).toBe(403);
    expect(old.json()).toEqual({ error: "annul_code_invalid", detail: "mismatch" });
    expect((await repo.tickets.byUuid(s.id))?.status).toBe("completed");

    expect((await annul(s.id, owner, { reason: "Error de cobro", code: b.code })).statusCode).toBe(200);
    expect((await repo.tickets.byUuid(s.id))?.status).toBe("voided");

    // one row per tenant = one active code; two rotations, no code in audit
    const rows = await settingsRow();
    expect(rows).toHaveLength(1);
    expect(rows[0].annul_code_expires_at?.toISOString()).toBe(b.expires_at);
    const audits = await rotateAudits();
    expect(audits).toHaveLength(2);
    for (const audit of audits) expect(JSON.stringify(audit.meta)).not.toMatch(/code/);
  });

  it("expired code → 403 annul_code_invalid/expired, nothing mutated (TTL expiry rejects)", async () => {
    await toggleOn();
    const { code } = await currentCode();
    // force expiry via SQL — no waiting out the 15-min TTL in the suite
    await pool.query(
      "UPDATE tenant_settings SET annul_code_expires_at = now() - interval '1 minute' WHERE tenant_id=$1",
      [owner.orgId],
    );
    const s = await sale();
    const res = await annul(s.id, owner, { reason: "Error de cobro", code });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "annul_code_invalid", detail: "expired" });
    expect((await repo.tickets.byUuid(s.id))?.status).toBe("completed");
    const variant = await repo.productVariants.byUuid(s.variant.id);
    expect(variant?.stock).toBe(8);
  });

  it("abonos block survives a VALID code: still 409 abonos_exist, nothing mutated (VD:Abonos block…)", async () => {
    await toggleOn();
    const { code } = await currentCode();
    const base = await sale();
    const customer = await seedCustomer(app, owner);
    const credit = await pushCreditSale(app, owner, {
      customer,
      amount: 35000,
      shift: base.shift.id,
      variant: base.variant.id,
    });
    await pushAbono(app, owner, { customer, amount: 5000, method: "cash", shift: base.shift.id, ticket: credit.ticket });

    const res = await annul(credit.ticket, owner, { reason: "Error de cobro", code });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "abonos_exist" });
    expect((await repo.tickets.byUuid(credit.ticket))?.status).toBe("completed");
    expect((await repo.reports.customerAccounts())[0]?.balance).toBe(30000);
  });
});

describe("generation endpoint tier (4.3 / VD:Member cannot generate codes)", () => {
  it("member → 403 dueño_only with NO code row or audit; admin → 200 (Dueño tier)", async () => {
    const denied = await gen(member);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "forbidden", detail: "dueño_only" });
    expect(await settingsRow()).toHaveLength(0);
    expect(await rotateAudits()).toHaveLength(0);

    const allowed = await gen(admin);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().code).toMatch(
      new RegExp(`^[${ANNUL_CODE_ALPHABET}]{${ANNUL_CODE_LENGTH}}$`),
    );
    expect(await settingsRow()).toHaveLength(1);
    expect(await rotateAudits()).toHaveLength(1);
    expect((await rotateAudits())[0].actor).toBe(admin.userId);
  });
});
