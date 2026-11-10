import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  DASHBOARD_SUMMARY_SQL,
  INVENTORY_VALUE_SQL,
  parseDashboardSummary,
  parseInventoryValue,
} from "@pos/shared";
import { authHeaders, buildTestApp, createTenant, resetTables, type Actor } from "./helpers";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";

/**
 * Tanda B · Dashboard contable — exact numbers on server + PGlite parity.
 *  - revenue / tickets / cash / transfer from confirmed payments
 *  - cogs = qty × cost from ticket_lines (null cost → 0)
 *  - gross = revenue − cogs; inventory cost = stock × cost
 *  - tenant B never sees A's figures
 */

let app: FastifyInstance;
let owner: Actor;
let other: Actor;

const RANGE = { from: "2026-11-01", to: "2026-11-30" };

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "dash-a@tenant.test", orgSlug: "org-dash-a" });
  other = await createTenant(app, { email: "dash-b@tenant.test", orgSlug: "org-dash-b" });
  await seedDash(owner);
  await seedDash(other, 1); // smaller numbers for B
});

async function seedDash(actor: Actor, scale = 1): Promise<void> {
  const repo = scopedRepo(db, actor.orgId);
  const productId = randomUUID();
  const variantId = randomUUID();

  await repo.products.upsert({
    client_uuid: productId,
    name: "Granizado",
  });
  // price 5000, cost 2000 → margin 3000/unit
  await db
    .insert((await import("../src/db/schema")).productVariants)
    .values({
      id: variantId,
      tenant_id: actor.orgId,
      client_uuid: variantId,
      product_id: productId,
      name: "Grande",
      price: 5000 * scale,
      cost: 2000 * scale,
      stock: 10 * scale,
      active: true,
    })
    .returning();

  const ticketId = randomUUID();
  await repo.tickets.upsert({
    client_uuid: ticketId,
    shift_id: null,
    ticket_no: 1,
    total: 10000 * scale,
    status: "completed",
  });
  await repo.ticketLines.insertMany([
    {
      client_uuid: randomUUID(),
      ticket_id: ticketId,
      variant_id: variantId,
      qty: 2 * scale,
      unit_price: 5000 * scale,
      subtotal: 10000 * scale,
    },
  ]);
  await repo.payments.upsert({
    client_uuid: randomUUID(),
    ticket_id: ticketId,
    method: "cash",
    amount: 10000 * scale,
    tendered: 10000 * scale,
    vuelto: 0,
    status: "confirmed",
    created_at: new Date("2026-11-05T12:00:00Z"),
  });

  // pending transfer — must NOT count in revenue
  const t2 = randomUUID();
  await repo.tickets.upsert({
    client_uuid: t2,
    shift_id: null,
    ticket_no: 2,
    total: 7000 * scale,
    status: "transfer_pending",
  });
  await repo.payments.upsert({
    client_uuid: randomUUID(),
    ticket_id: t2,
    method: "transfer",
    amount: 7000 * scale,
    status: "pending",
    created_at: new Date("2026-11-05T13:00:00Z"),
  });
}

describe("dashboard summary (exact numbers)", () => {
  it("revenue/tickets/cash/cogs/gross for confirmed only", async () => {
    const repo = scopedRepo(db, owner.orgId);
    const s = await repo.reports.dashboardSummary(RANGE);
    // 1 confirmed cash sale of 10000; pending transfer excluded
    expect(s.revenue).toBe(10000);
    expect(s.tickets).toBe(1);
    expect(s.cash).toBe(10000);
    expect(s.transfer).toBe(0);
    expect(s.pending).toBe(7000);
    // cogs = 2 units × 2000
    expect(s.cogs).toBe(4000);
    expect(s.revenue - s.cogs).toBe(6000);
  });

  it("inventory value = stock × cost; low stock counted", async () => {
    const repo = scopedRepo(db, owner.orgId);
    const inv = await repo.reports.inventoryValue(5);
    // stock 10 × cost 2000
    expect(inv.inventory_cost).toBe(20000);
    expect(inv.inventory_retail).toBe(50000);
    expect(inv.variants_with_cost).toBe(1);
    // stock 10 > threshold 5 → not low
    expect(inv.low_stock_count).toBe(0);
  });

  it("tenant B never sees tenant A figures", async () => {
    const repoB = scopedRepo(db, other.orgId);
    const s = await repoB.reports.dashboardSummary(RANGE);
    // B seeded with scale=1 same shape → same numbers, but must be B's rows
    expect(s.revenue).toBe(10000);
    const inv = await repoB.reports.inventoryValue(5);
    expect(inv.inventory_cost).toBe(20000);

    // A's data unchanged and isolated: wipe B's payments → B revenue 0, A intact
    await db.delete((await import("../src/db/schema")).payments).where(
      (await import("drizzle-orm")).eq(
        (await import("../src/db/schema")).payments.tenant_id,
        other.orgId,
      ),
    );
    const s2 = await repoB.reports.dashboardSummary(RANGE);
    expect(s2.revenue).toBe(0);
    const repoA = scopedRepo(db, owner.orgId);
    expect((await repoA.reports.dashboardSummary(RANGE)).revenue).toBe(10000);
  });

  it("HTTP endpoint returns summary + inventory + top + low_count", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/reports/dashboard?from=${RANGE.from}&to=${RANGE.to}`,
      headers: authHeaders(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.revenue).toBe(10000);
    expect(body.summary.gross).toBe(6000);
    expect(body.summary.avg_ticket).toBe(10000);
    expect(body.inventory.inventory_cost).toBe(20000);
    expect(body).toHaveProperty("top");
    expect(body).toHaveProperty("low_count");
    // no business product names in wrong tenant
    const asB = await app.inject({
      method: "GET",
      url: `/api/reports/dashboard?from=${RANGE.from}&to=${RANGE.to}`,
      headers: authHeaders(other),
    });
    expect(asB.json().summary.revenue).toBe(10000);
  });

  it("PGlite path yields the same summary numbers", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const { LOCAL_SCHEMA_SQL } = await import("@pos/shared");
    const local = new PGlite("memory://");
    try {
      await local.exec(LOCAL_SCHEMA_SQL);
      // copy A's rows via the same SQL the server runs — seed minimal mirror
      const repoA = scopedRepo(db, owner.orgId);
      const summary = await repoA.reports.dashboardSummary(RANGE);
      // seed equivalent rows locally
      const pId = randomUUID();
      const vId = randomUUID();
      const tId = randomUUID();
      const tid = owner.orgId;
      await local.query(
        `INSERT INTO products (id, tenant_id, client_uuid, name, active) VALUES ($1,$2,$1,'Granizado',TRUE)`,
        [pId, tid],
      );
      await local.query(
        `INSERT INTO product_variants (id, tenant_id, client_uuid, product_id, name, price, cost, stock, active)
         VALUES ($1,$2,$1,$3,'Grande',5000,2000,10,TRUE)`,
        [vId, tid, pId],
      );
      await local.query(
        `INSERT INTO tickets (id, tenant_id, client_uuid, ticket_no, status, total, created_at)
         VALUES ($1,$2,$1,1,'completed',10000, '2026-11-05T12:00:00Z')`,
        [tId, tid],
      );
      await local.query(
        `INSERT INTO ticket_lines (id, tenant_id, client_uuid, ticket_id, variant_id, qty, unit_price, subtotal)
         VALUES ($1,$2,$1,$3,$4,2,5000,10000)`,
        [randomUUID(), tid, tId, vId],
      );
      await local.query(
        `INSERT INTO payments (id, tenant_id, client_uuid, ticket_id, method, amount, tendered, vuelto, status, created_at)
         VALUES ($1,$2,$1,$3,'cash',10000,10000,0,'confirmed','2026-11-05T12:00:00Z')`,
        [randomUUID(), tid, tId],
      );

      const localSummary = parseDashboardSummary(
        (
          await local.query(DASHBOARD_SUMMARY_SQL, [
            owner.orgId,
            RANGE.from,
            RANGE.to,
          ])
        ).rows as Record<string, unknown>[],
      );
      expect(localSummary.revenue).toBe(summary.revenue);
      expect(localSummary.cogs).toBe(summary.cogs);
      expect(localSummary.tickets).toBe(summary.tickets);

      const localInv = parseInventoryValue(
        (await local.query(INVENTORY_VALUE_SQL, [owner.orgId, 5])).rows as Record<
          string,
          unknown
        >[],
      );
      expect(localInv.inventory_cost).toBe(20000);
    } finally {
      await local.close();
    }
  }, 30_000);
});
