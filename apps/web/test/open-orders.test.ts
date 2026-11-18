import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../src/db/pglite";
import {
  createLocalTable,
  listBoardTables,
  saveOrderToTable,
} from "../src/db/local-orders";
import { applyRehydratePage } from "../src/sync/rehydrate";
import {
  fetchOpenOrders,
  pullOpenOrders,
  type OrdersFetch,
} from "../src/sync/open-orders";

/**
 * Mesas Fase 2 · PULL + REHYDRATE of the comanda domain.
 *
 *  - a rebuilt device receives tables/orders/order_lines through
 *    GET /api/rehydrate (decision 5 — fixture with orders included);
 *  - `pullOpenOrders` merges `GET /api/orders/open` into the local cache:
 *    server truth wins, EXCEPT rows with a local queued mutation and the
 *    documented divergence guards (forked comanda / name twin);
 *  - settled tombstones free the local board («se cobró en otro
 *    dispositivo»), while a queued edit is never clobbered;
 *  - unreachable server ⇒ null (offline-first: local truth still renders).
 */

const TENANT = "55555555-5555-4555-8555-555555555555";
const REMOTE_TABLE = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const REMOTE_ORDER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const REMOTE_LINE = "cccccccc-3333-4333-8333-cccccccccccc";
const REMOTE_VARIANT = "dddddddd-4444-4444-8444-dddddddddddd";
const NOW = "2024-06-01T10:00:00.000Z";

let db: PGlite;
let release: () => void;
beforeEach(async () => {
  const handle = await openLocalDb({ url: "memory://", locks: null });
  db = handle!.db;
  release = handle!.release;
});

afterEach(async () => {
  release();
  await db.close();
});

function remoteTable(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: REMOTE_TABLE, tenant_id: TENANT, client_uuid: REMOTE_TABLE,
    name: "Mesa Remota", zone: "Terraza", capacity: 4, active: true,
    status: "available", current_order_id: null, opened_at: null,
    created_at: NOW, updated_at: NOW, ...overrides,
  };
}

function remoteOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: REMOTE_ORDER, tenant_id: TENANT, client_uuid: REMOTE_ORDER,
    table_id: REMOTE_TABLE, state: "open", opened_at: NOW, closed_at: null,
    billing_at: null, notes: null, created_at: NOW, updated_at: NOW, ...overrides,
  };
}

function remoteLine(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: REMOTE_LINE, tenant_id: TENANT, client_uuid: REMOTE_LINE,
    order_id: REMOTE_ORDER, variant_id: REMOTE_VARIANT, name: "Cerveza 330ml",
    price: 4000, qty: 2, notes: null, deleted_at: null, sort: 0,
    created_at: NOW, updated_at: NOW, ...overrides,
  };
}

function serve(payload: unknown, opts: { ok?: boolean } = {}): OrdersFetch {
  return async () => ({
    ok: opts.ok ?? true,
    status: opts.ok === false ? 500 : 200,
    json: async () => payload,
  });
}

describe("rehydrate (decision 5): un dispositivo nuevo recibe mesas + órdenes", () => {
  it("applyRehydratePage inserts tables, orders and their lines → board renders them", async () => {
    const inserted = await applyRehydratePage(db, TENANT, {
      tables: [remoteTable()],
      orders: [remoteOrder()],
      order_lines: [remoteLine()],
      next_offset: null,
    });
    expect(inserted).toBe(3);

    const board = await listBoardTables(db, TENANT);
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({
      id: REMOTE_TABLE, name: "Mesa Remota", status: "occupied",
      order_id: REMOTE_ORDER, items: 2, total: 8000,
    });
  });

  it("re-inserting the same page is a no-op (ON CONFLICT DO NOTHING)", async () => {
    const page = { tables: [remoteTable()], orders: [remoteOrder()], order_lines: [remoteLine()], next_offset: null };
    await applyRehydratePage(db, TENANT, page);
    await applyRehydratePage(db, TENANT, page);
    const board = await listBoardTables(db, TENANT);
    expect(board).toHaveLength(1);
    expect(board[0].total).toBe(8000);
  });
});

describe("pullOpenOrders · server truth → local cache", () => {
  it("an open mesa seeded by ANOTHER device appears on the board after pull", async () => {
    const updated = await pullOpenOrders(db, TENANT, {
      fetchFn: serve({ tables: [remoteTable()], orders: [remoteOrder()], order_lines: [remoteLine()], closed_orders: [] }),
    });
    expect(updated).toBe(3);
    const board = await listBoardTables(db, TENANT);
    expect(board[0]).toMatchObject({ name: "Mesa Remota", status: "occupied", total: 8000 });
  });

  it("unreachable server → null, local state untouched (offline-first)", async () => {
    const table = await createLocalTable(db, TENANT, { name: "Mesa Local", zone: null, capacity: 2 });
    await saveOrderToTable(db, TENANT, table.id, [
      { variant_id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee", name: "Papas", price: 8000, qty: 1 },
    ]);
    const before = await listBoardTables(db, TENANT);

    expect(await pullOpenOrders(db, TENANT, { fetchFn: serve(null, { ok: false }) })).toBeNull();
    expect(await fetchOpenOrders(TENANT, serve(null, { ok: false }))).toBeNull();
    const throwing: OrdersFetch = async () => { throw new Error("network down"); };
    expect(await pullOpenOrders(db, TENANT, { fetchFn: throwing })).toBeNull();

    expect(await listBoardTables(db, TENANT)).toEqual(before);
  });

  it("a locally QUEUED edit is never clobbered; after its ACK the next pull lands", async () => {
    const table = await createLocalTable(db, TENANT, { name: "Mesa En Cola", zone: null, capacity: 2 });
    /* the table row has a pending `table` mutation in sync_log right now */
    const renamedRemotely = remoteTable({ id: table.id, client_uuid: table.id, name: "Mesa Renombrada" });
    await pullOpenOrders(db, TENANT, {
      fetchFn: serve({ tables: [renamedRemotely], orders: [], order_lines: [], closed_orders: [] }),
    });
    expect((await listBoardTables(db, TENANT))[0].name).toBe("Mesa En Cola");

    await db.query(
      `UPDATE sync_log SET status = 'synced' WHERE tenant_id = $1 AND entity = 'table'`,
      [TENANT],
    );
    await pullOpenOrders(db, TENANT, {
      fetchFn: serve({ tables: [renamedRemotely], orders: [], order_lines: [], closed_orders: [] }),
    });
    expect((await listBoardTables(db, TENANT))[0].name).toBe("Mesa Renombrada");
  });

  it("tombstones free the board: a comanda settled elsewhere closes locally", async () => {
    const table = await createLocalTable(db, TENANT, { name: "Mesa Cobrada", zone: null, capacity: 2 });
    await saveOrderToTable(db, TENANT, table.id, [
      { variant_id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee", name: "Papas", price: 8000, qty: 1 },
    ]);
    const localOrderId = (await listBoardTables(db, TENANT))[0].order_id!;
    expect((await listBoardTables(db, TENANT))[0].status).toBe("occupied");

    await pullOpenOrders(db, TENANT, {
      fetchFn: serve({ tables: [], orders: [], order_lines: [], closed_orders: [{ id: localOrderId, state: "closed" }] }),
    });
    const board = await listBoardTables(db, TENANT);
    expect(board[0]).toMatchObject({ status: "available", order_id: null, total: 0 });
  });

  it("fork guard: another device's open comanda on an occupied table waits until the local twin settles", async () => {
    /* device B first learns the SHARED table row from the server (same id
     * on both sides — that's how a real second device gets the catalog) */
    await pullOpenOrders(db, TENANT, {
      fetchFn: serve({ tables: [remoteTable({ name: "Mesa Fork" })], orders: [], order_lines: [], closed_orders: [] }),
    });
    await saveOrderToTable(db, TENANT, REMOTE_TABLE, [
      { variant_id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee", name: "Papas", price: 8000, qty: 1 },
    ]);
    const localOrderId = (await listBoardTables(db, TENANT))[0].order_id!;
    const payload = {
      tables: [remoteTable({ name: "Mesa Fork" })],
      orders: [remoteOrder()],
      order_lines: [remoteLine()],
      closed_orders: [{ id: localOrderId, state: "closed" }],
    };

    /* server truth: local twin settled + remote comanda open — merge order
     * (orders before tombstones) skips the fork, then frees the twin */
    await pullOpenOrders(db, TENANT, { fetchFn: serve(payload) });
    let board = await listBoardTables(db, TENANT);
    expect(board[0].order_id).toBeNull(); // twin closed by tombstone

    /* next refresh (focus/tab) adopts the remote comanda — no ghost state */
    await pullOpenOrders(db, TENANT, { fetchFn: serve(payload) });
    board = await listBoardTables(db, TENANT);
    expect(board[0]).toMatchObject({ order_id: REMOTE_ORDER, status: "occupied", total: 8000 });
  });
});
