import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import * as t from "../src/db/schema";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  creditMutation as m,
  joinOrg,
  resetTables,
  type Actor,
} from "./helpers";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";

/**
 * Mesas Fase 2 · sync multi-dispositivo (CONTROL-MESAS.md · opción B).
 *
 * Pins the Fase 2 contract:
 *  - `table` / `order` / `order_line` apply IDEMPOTENTLY (double-push →
 *    duplicate, one row each — same ledger rules as every entity);
 *  - order state is LWW with TERMINAL closed/cancelled (no resurrection);
 *  - ONE open comanda per table (concurrent-open backstop);
 *  - DOUBLE-COBRO backstop: `tickets.order_id` partial unique — same session
 *    and TWO concurrent sessions produce EXACTLY ONE ticket, the second
 *    push rejected with the deterministic `validation` reason (never a
 *    forever-retrying db_error);
 *  - `GET /api/orders/open`: requireAuth (members included), tenant-scoped,
 *    derived table state + live totals + settled tombstones, no-store;
 *  - rehydrate delivers the comanda domain to a rebuilt device;
 *  - member authority: comandas yes, table CATALOG no.
 */

let app: FastifyInstance;
let owner: Actor;
let member: Actor;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "mesas-sync@tenant.test", orgSlug: "mesas-sync" });
  member = await joinOrg(app, owner, "member", "mesas-member@tenant.test");
});

function pushRaw(actor: Actor, mutations: unknown[]) {
  return app.inject({
    method: "POST",
    url: "/api/sync/mutations",
    headers: authHeaders(actor),
    payload: { mutations },
  });
}

/** Parsed results (pushMutations shape). Non-200 = transport failure → throw. */
async function push(actor: Actor, mutations: unknown[]) {
  const res = await pushRaw(actor, mutations);
  if (res.statusCode !== 200) throw new Error(`push_${res.statusCode}: ${res.body}`);
  return res.json().results as Array<{ client_uuid: string; status: string; reason?: string }>;
}

/** table + open comanda + one live line (+ optional soft-deleted sibling). */
function comandaGroup(opts: { tableId?: string; orderId?: string; qty?: number; deletedLine?: boolean } = {}) {
  const tableId = opts.tableId ?? randomUUID();
  const orderId = opts.orderId ?? randomUUID();
  const lineId = randomUUID();
  const deletedLineId = randomUUID();
  const ts = 1_700_000_000_000;
  const table = m("table", { name: "Mesa Sinc", zone: "Salón", capacity: 4 }, tableId, ts);
  const order = m("order", {
    table_id: tableId, state: "open", opened_at: "2024-01-01T10:00:00.000Z",
    closed_at: null, billing_at: null, created_at: "2024-01-01T10:00:00.000Z",
  }, orderId, ts + 1);
  const line = m("order_line", {
    order_id: orderId, variant_id: randomUUID(), name: "Cerveza 330ml", price: 4000,
    qty: opts.qty ?? 2, sort: 0, notes: null, deleted_at: null, created_at: "2024-01-01T10:05:00.000Z",
  }, lineId, ts + 2);
  const removed = m("order_line", {
    order_id: orderId, variant_id: randomUUID(), name: "Papas Fritas", price: 8000,
    qty: 1, sort: 1, notes: null, deleted_at: "2024-01-01T10:10:00.000Z",
    created_at: "2024-01-01T10:05:00.000Z",
  }, deletedLineId, ts + 3);
  return {
    tableId, orderId, table, order, line,
    envelopes: [table, order, line, ...(opts.deletedLine ? [removed] : [])],
  };
}

function ticketForOrder(orderId: string, ticketNo: number, ts = 1_700_000_100_000) {
  const ticketId = randomUUID();
  const paymentId = randomUUID();
  const total = 8000;
  return {
    ticketId,
    envelopes: [
      m("ticket", { shift_id: null, ticket_no: ticketNo, status: "completed", total, order_id: orderId }, ticketId, ts),
      m("payment", {
        ticket_id: ticketId, method: "cash", amount: total, tendered: total, vuelto: 0,
        status: "confirmed", shift_id: null,
      }, paymentId, ts + 1),
    ],
  };
}

describe("orders/lines/table mutations are idempotent (LWW ledger)", () => {
  it("double-push applies once: duplicate acks, one row per entity", async () => {
    const g = comandaGroup({ deletedLine: true });
    const first = await push(owner, g.envelopes);
    expect(first.map((r) => r.status)).toEqual(["applied", "applied", "applied", "applied"]);

    const second = await push(owner, g.envelopes);
    expect(second.map((r) => r.status)).toEqual(["duplicate", "duplicate", "duplicate", "duplicate"]);

    const repo = scopedRepo(db, owner.orgId);
    const tables = await repo.tables.list();
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ name: "Mesa Sinc", zone: "Salón", capacity: 4, active: true });
    const orders = await repo.orders.list();
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ table_id: g.tableId, state: "open" });
    const lines = await repo.orderLines.listByOrders([g.orderId]);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.id === g.line.client_uuid)).toMatchObject({ qty: 2, deleted_at: null });
    expect(lines.find((l) => l.deleted_at !== null)).toBeDefined(); // removal = STATE, not a delete
    const ledger = await db.execute(sql`SELECT count(*) AS n FROM sync_log
      WHERE tenant_id = ${owner.orgId} AND entity IN ('table','order','order_line')`);
    expect(Number(ledger.rows[0].n)).toBe(4);
  });

  it("newer line edit wins (LWW), older one is rejected as conflict", async () => {
    const g = comandaGroup();
    await push(owner, [g.table, g.order, g.line]);
    const newer = { ...g.line, client_ts: g.line.client_ts + 5_000, payload: { ...g.line.payload, qty: 5 } };
    expect((await push(owner, [newer]))[0].status).toBe("applied");
    const older = { ...g.line, client_ts: g.line.client_ts - 1_000, payload: { ...g.line.payload, qty: 9 } };
    expect((await push(owner, [older]))[0]).toMatchObject({ status: "rejected", reason: "conflict_hash_mismatch" });
    const lines = await scopedRepo(db, owner.orgId).orderLines.listByOrders([g.orderId]);
    expect(lines[0].qty).toBe(5);
  });

  it("a settled comanda is TERMINAL: a stale `open` LWW write cannot resurrect it", async () => {
    const g = comandaGroup();
    await push(owner, [g.table, g.order, g.line]);
    const closed = { ...g.order, client_ts: g.order.client_ts + 10_000, payload: { ...g.order.payload, state: "closed", closed_at: "2024-01-01T12:00:00.000Z" } };
    expect((await push(owner, [closed]))[0].status).toBe("applied");
    const reopen = { ...g.order, client_ts: g.order.client_ts + 20_000, payload: { ...g.order.payload, state: "open" } };
    expect((await push(owner, [reopen]))[0]).toMatchObject({ status: "rejected", reason: "validation" });
    const [row] = await db.select().from(t.orders)
      .where(eq(t.orders.id, g.orderId));
    expect(row.state).toBe("closed");
  });

  it("a second OPEN comanda for the same table is rejected (one open per table)", async () => {
    const g = comandaGroup();
    await push(owner, [g.table, g.order, g.line]);
    const fork = m("order", { table_id: g.tableId, state: "open" }, randomUUID(), g.order.client_ts + 100);
    expect((await push(owner, [fork]))[0]).toMatchObject({ status: "rejected", reason: "validation" });
    const open = await scopedRepo(db, owner.orgId).orders.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(g.orderId);
  });
});

describe("DOUBLE-COBRO backstop · tickets.order_id unique", () => {
  it("same session: the second ticket of the comanda is rejected, exactly one ticket lands", async () => {
    const g = comandaGroup();
    await push(owner, [g.table, g.order, g.line]);

    const first = ticketForOrder(g.orderId, 1);
    expect((await push(owner, first.envelopes)).every((r) => r.status === "applied")).toBe(true);

    const second = ticketForOrder(g.orderId, 2, first.envelopes[0].client_ts + 1_000);
    const results = await push(owner, second.envelopes);
    expect(results[0]).toMatchObject({ status: "rejected", reason: "validation" });
    expect(results[1]).toMatchObject({ status: "rejected", reason: "validation" });

    const count = await db.execute(sql`SELECT count(*) AS n FROM tickets
      WHERE tenant_id = ${owner.orgId} AND order_id = ${g.orderId}::uuid`);
    expect(Number(count.rows[0].n)).toBe(1);
    const payments = await db.execute(sql`SELECT count(*) AS n FROM payments WHERE tenant_id = ${owner.orgId}`);
    expect(Number(payments.rows[0].n)).toBe(1);
  });

  it("two sessions charge the SAME comanda concurrently → exactly ONE ticket, loser rejected: validation", async () => {
    const g = comandaGroup();
    await push(owner, [g.table, g.order, g.line]);

    const a = ticketForOrder(g.orderId, 1, 1_700_000_200_000);
    const b = ticketForOrder(g.orderId, 2, 1_700_000_300_000);
    // owner + member, same comanda, same instant — genuinely concurrent pushes
    const [resA, resB] = await Promise.all([
      pushRaw(owner, a.envelopes),
      pushRaw(member, b.envelopes),
    ]);
    expect(resA.statusCode).toBe(200);
    expect(resB.statusCode).toBe(200);

    const statuses = [...resA.json().results, ...resB.json().results]
      .map((r: { status: string; reason?: string }) => r.status);
    const applied = statuses.filter((s) => s === "applied").length;
    // whole-group rejection: the loser's ticket AND payment never land
    expect(applied).toBeGreaterThanOrEqual(1);
    const tickets = await db.execute(sql`SELECT count(*) AS n FROM tickets
      WHERE tenant_id = ${owner.orgId} AND order_id = ${g.orderId}::uuid`);
    expect(Number(tickets.rows[0].n)).toBe(1);
    const totalPayments = await db.execute(sql`SELECT count(*) AS n FROM payments WHERE tenant_id = ${owner.orgId}`);
    expect(Number(totalPayments.rows[0].n)).toBe(1);
    // the loser must be a DETERMINISTIC rejection (validation), never db_error:
    // db_error retries forever in the queue, poison is the healthy end state.
    const rejected = [...resA.json().results, ...resB.json().results]
      .filter((r: { status: string }) => r.status === "rejected") as Array<{ reason?: string }>;
    for (const r of rejected) expect(r.reason).toBe("validation");
  });

  it("a counter sale (no order_id) is unaffected by the backstop", async () => {
    const ticketId = randomUUID();
    const res = await push(owner, [m("ticket", { shift_id: null, ticket_no: 1, status: "completed", total: 1000, order_id: null }, ticketId)]);
    expect(res[0].status).toBe("applied");
    const again = await push(owner, [m("ticket", { shift_id: null, ticket_no: 1, status: "completed", total: 1000, order_id: null }, randomUUID())]);
    expect(again[0]).toMatchObject({ status: "rejected" }); // ticket_no uq, unrelated
  });
});

describe("GET /api/orders/open — tenant-scoped pull + frescura source", () => {
  async function seedOpen(actor: Actor) {
    const g = comandaGroup({ deletedLine: true });
    const results = await push(actor, g.envelopes);
    expect(results.every((r) => r.status === "applied")).toBe(true);
    return g;
  }

  it("requires auth (401) and is never cacheable", async () => {
    const anon = await app.inject({ method: "GET", url: "/api/orders/open" });
    expect(anon.statusCode).toBe(401);
    const res = await app.inject({ method: "GET", url: "/api/orders/open", headers: authHeaders(owner) });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns tables with DERIVED state, open comanda + live lines (soft-deleted excluded)", async () => {
    const g = await seedOpen(owner);
    const res = await app.inject({ method: "GET", url: "/api/orders/open", headers: authHeaders(owner) });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.tables).toHaveLength(1);
    expect(body.tables[0]).toMatchObject({
      id: g.tableId, status: "occupied", order_id: g.orderId, items: 2, total: 8000,
    });
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({ id: g.orderId, state: "open" });
    expect(body.order_lines).toHaveLength(2);
    expect(body.closed_orders).toEqual([]);
  });

  it("billing comanda reads as status billing; settled comanda lands in closed_orders", async () => {
    const g = await seedOpen(owner);
    const billed = { ...g.order, client_ts: g.order.client_ts + 1_000, payload: { ...g.order.payload, billing_at: "2024-01-01T11:00:00.000Z" } };
    expect((await push(owner, [billed]))[0].status).toBe("applied");
    let res = await app.inject({ method: "GET", url: "/api/orders/open", headers: authHeaders(owner) });
    expect(res.json().tables[0].status).toBe("billing");

    const settled = { ...g.order, client_ts: g.order.client_ts + 2_000, payload: { ...g.order.payload, state: "closed", billing_at: null, closed_at: "2024-01-01T12:00:00.000Z" } };
    expect((await push(owner, [settled]))[0].status).toBe("applied");
    res = await app.inject({ method: "GET", url: "/api/orders/open", headers: authHeaders(owner) });
    const body = res.json();
    expect(body.orders).toEqual([]);
    expect(body.tables[0]).toMatchObject({ status: "available", order_id: null, items: 0, total: 0 });
    expect(body.closed_orders).toContainEqual({ id: g.orderId, state: "closed" });
  });

  it("members can read it (serving = selling) and see the same rows", async () => {
    const g = await seedOpen(owner);
    const res = await app.inject({ method: "GET", url: "/api/orders/open", headers: authHeaders(member) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tables.map((r: { id: string }) => r.id)).toContain(g.tableId);
    expect(body.orders).toHaveLength(1);
  });

  it("another tenant sees NONE of these rows (session tenant only)", async () => {
    await seedOpen(owner);
    const stranger = await createTenant(app, { email: "mesas-other@tenant.test", orgSlug: "mesas-other" });
    const res = await app.inject({ method: "GET", url: "/api/orders/open", headers: authHeaders(stranger) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tables: [], orders: [], order_lines: [], closed_orders: [] });
  });
});

describe("rehydrate delivers the comanda domain", () => {
  it("tables + orders + order_lines ride GET /api/rehydrate", async () => {
    const g = comandaGroup({ deletedLine: true });
    expect((await push(owner, g.envelopes)).every((r) => r.status === "applied")).toBe(true);
    // a settled comanda is delivered too (history + tombstone source)
    const settled = { ...g.order, client_ts: g.order.client_ts + 5_000, payload: { ...g.order.payload, state: "cancelled", closed_at: "2024-01-01T13:00:00.000Z" } };
    expect((await push(owner, [settled]))[0].status).toBe("applied");

    const res = await app.inject({ method: "GET", url: "/api/rehydrate", headers: authHeaders(owner) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tables.map((r: { id: string }) => r.id)).toEqual([g.tableId]);
    expect(body.orders.map((r: { id: string }) => r.id)).toContain(g.orderId);
    expect(body.orders.find((r: { id: string }) => r.id === g.orderId).state).toBe("cancelled");
    expect(body.order_lines.map((r: { order_id: string }) => r.order_id)).toContain(g.orderId);
    expect(body.next_offset).toBeNull();
  });
});

describe("member authority · comandas yes, table catalog no", () => {
  it("a member pushes orders/lines but is rejected on `table`", async () => {
    const g = comandaGroup();
    // table lands from the owner (dueño tier) first — the member's comanda
    // has its parent, so ONLY the entity authority differs
    expect((await push(owner, [g.table]))[0].status).toBe("applied");
    const memberComanda = await push(member, [g.order, g.line]);
    expect(memberComanda.map((r) => r.status)).toEqual(["applied", "applied"]);

    const rogueTable = m("table", { name: "Mesa Rebelde", capacity: 2 }, randomUUID(), Date.now());
    expect((await push(member, [rogueTable]))[0]).toMatchObject({ status: "rejected", reason: "validation" });
    const tables = await scopedRepo(db, owner.orgId).tables.list();
    expect(tables.map((r) => r.name)).toEqual(["Mesa Sinc"]);
    // rejected as a plain pre-scan — the ledger never sees it either
    const ledger = await db.execute(sql`SELECT count(*) AS n FROM sync_log
      WHERE tenant_id = ${owner.orgId} AND client_uuid = ${rogueTable.client_uuid}::uuid`);
    expect(Number(ledger.rows[0].n)).toBe(0);
  });
});
