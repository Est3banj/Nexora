import type { PGlite } from "@electric-sql/pglite";
import { localTx } from "../db/pglite";
import { assertWritable } from "../db/preservation";
import { scopedFetch } from "./scoped-fetch";

/**
 * Mesas Fase 2 · PULL of live comandas (CONTROL-MESAS.md · decisión 4).
 *
 * `GET /api/orders/open` is the read side the push-only sync never had: it
 * returns every table (with DERIVED board state), every open/billing
 * comanda with its lines, and bounded tombstones of recently settled
 * comandas. `pullOpenOrders` merges that server truth into the local cache
 * so `listBoardTables` can render it — a re-FETCH, never a page reload.
 *
 * Merge rules (each one is a deliberate trade-off, documented in
 * CONTROL-MESAS.md «Fase2 implementada»):
 *  - rows with a LOCAL pending/poison queue entry are NEVER clobbered by a
 *    row upsert — the device's own edit is in flight and LWW resolves it
 *    server-side (EXCEPTION: settlement tombstones below — server terminal
 *    truth beats a ghost «occupied» mesa);
 *  - everything else takes server truth (upsert keyed on
 *    unique(tenant_id, client_uuid), same as rehydrate but OVERWRITING):
 *    a comanda closed on device A must disappear from device B's board;
 *  - a settled comanda known only to the server (tombstone) is closed
 *    locally, which is what frees the board after «se cobró en otro
 *    dispositivo»;
 *  - divergence guards: a server open order for a table that THIS device
 *    already has open with a DIFFERENT order id is skipped (the local twin
 *    wins until the operator releases it — the cobro frescura check blocks
 *    charging either way), and table rows whose name collides with a
 *    different local active row are skipped (unique(tenant, name) WHERE
 *    active — an unresolved rename is an operator decision, not data loss).
 */

type Row = Record<string, unknown>;

export type OpenOrdersPayload = {
  tables?: Row[];
  orders?: Row[];
  order_lines?: Row[];
  closed_orders?: Array<{ id: string; state: string }>;
};

export type OrdersFetch = (
  path: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(String(v)).toISOString();

/** Frescura check (doble defensa ·a): null ⇒ offline/unreachable ⇒ caller decides. */
export async function fetchOpenOrders(
  tenantId: string,
  fetchFn?: OrdersFetch,
): Promise<OpenOrdersPayload | null> {
  try {
    const doFetch: OrdersFetch =
      fetchFn ??
      ((path) =>
        scopedFetch(tenantId, path, { signal: AbortSignal.timeout(5_000) }) as unknown as ReturnType<OrdersFetch>);
    const res = await doFetch("/api/orders/open");
    if (!res.ok) return null;
    return (await res.json()) as OpenOrdersPayload;
  } catch {
    return null;
  }
}

/** Fetch server truth + merge it locally. Returns rows updated, or null when unreachable. */
export async function pullOpenOrders(
  db: PGlite,
  tenantId: string,
  opts: { fetchFn?: OrdersFetch } = {},
): Promise<number | null> {
  const payload = await fetchOpenOrders(tenantId, opts.fetchFn);
  if (!payload) return null;
  return applyOpenOrdersPayload(db, tenantId, payload);
}

export async function applyOpenOrdersPayload(
  db: PGlite,
  tenantId: string,
  payload: OpenOrdersPayload,
): Promise<number> {
  return localTx(db, async (tx) => {
    await assertWritable(tx, tenantId);
    let updated = 0;

    /* (1) local rows with in-flight/poison mutations — never clobbered. */
    const inFlight = (await tx.query<{ entity: string; client_uuid: string }>(
      `SELECT entity, client_uuid FROM sync_log WHERE tenant_id = $1 AND status <> 'synced'`,
      [tenantId],
    )).rows;
    const busy = new Map<string, Set<string>>();
    for (const row of inFlight) {
      const set = busy.get(row.entity) ?? new Set<string>();
      set.add(row.client_uuid);
      busy.set(row.entity, set);
    }
    const skip = (entity: string, id: string) => busy.get(entity)?.has(id) ?? false;

    /* (2) divergence pre-checks (never let a statement abort the tx). */
    const localOpenOrders = (await tx.query<{ id: string; table_id: string }>(
      `SELECT id, table_id FROM orders WHERE tenant_id = $1 AND state = 'open'`,
      [tenantId],
    )).rows;
    const openByTable = new Map(localOpenOrders.map((o) => [o.table_id, o.id]));
    const activeLocalTables = (await tx.query<{ id: string; name: string }>(
      `SELECT id, name FROM tables WHERE tenant_id = $1 AND active`,
      [tenantId],
    )).rows;
    const tableNameOwner = new Map(activeLocalTables.map((t) => [t.name, t.id]));

    /* (3) tables — catalog upsert (server wins unless locally queued). */
    for (const table of payload.tables ?? []) {
      const id = String(table.id);
      if (skip("table", id)) continue;
      const name = String(table.name);
      const owner = tableNameOwner.get(name);
      if (owner !== undefined && owner !== id) continue; // unresolved name twin
      await tx.query(
        `INSERT INTO tables (id, tenant_id, client_uuid, name, zone, capacity, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, client_uuid) DO UPDATE SET
           name = EXCLUDED.name, zone = EXCLUDED.zone, capacity = EXCLUDED.capacity,
           active = EXCLUDED.active, updated_at = now()`,
        [id, tenantId, String(table.client_uuid ?? id), name,
          table.zone ?? null, Number(table.capacity), Boolean(table.active)],
      );
      tableNameOwner.set(name, id);
      updated += 1;
    }

    /* (4) open orders — server truth (skip divergence twins + queued rows). */
    for (const order of payload.orders ?? []) {
      const id = String(order.id);
      if (skip("order", id)) continue;
      const tableId = String(order.table_id);
      const localTwin = openByTable.get(tableId);
      if (localTwin !== undefined && localTwin !== id) continue; // forked comanda
      await tx.query(
        `INSERT INTO orders (id, tenant_id, client_uuid, table_id, state, opened_at, closed_at, billing_at, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (tenant_id, client_uuid) DO UPDATE SET
           table_id = EXCLUDED.table_id, state = EXCLUDED.state, opened_at = EXCLUDED.opened_at,
           closed_at = EXCLUDED.closed_at, billing_at = EXCLUDED.billing_at, updated_at = now()`,
        [id, tenantId, String(order.client_uuid ?? id), tableId, String(order.state),
          iso(order.opened_at) ?? new Date().toISOString(), iso(order.closed_at),
          iso(order.billing_at), order.notes ?? null],
      );
      openByTable.set(tableId, id);
      updated += 1;
    }

    /* (5) lines of the orders the server delivered (soft-deleted rows come
     *    too, so removals replicate as `deleted_at` state). */
    const knownOrders = new Set<string>();
    const allLocal = (await tx.query<{ id: string }>(
      `SELECT id FROM orders WHERE tenant_id = $1`, [tenantId],
    )).rows;
    for (const row of allLocal) knownOrders.add(row.id);
    for (const line of payload.order_lines ?? []) {
      const id = String(line.id);
      if (skip("order_line", id)) continue;
      if (!knownOrders.has(String(line.order_id))) continue; // orphan guard
      await tx.query(
        `INSERT INTO order_lines (id, tenant_id, client_uuid, order_id, variant_id, name, price, qty, notes, deleted_at, sort, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (tenant_id, client_uuid) DO UPDATE SET
           order_id = EXCLUDED.order_id, variant_id = EXCLUDED.variant_id, name = EXCLUDED.name,
           price = EXCLUDED.price, qty = EXCLUDED.qty, notes = EXCLUDED.notes,
           deleted_at = EXCLUDED.deleted_at, sort = EXCLUDED.sort, updated_at = now()`,
        [id, tenantId, String(line.client_uuid ?? id), String(line.order_id), String(line.variant_id),
          String(line.name), Number(line.price), Number(line.qty), line.notes ?? null,
          iso(line.deleted_at), Number(line.sort ?? 0), iso(line.created_at)],
      );
      updated += 1;
    }

    /* (6) tombstones: settled elsewhere ⇒ free the local board honestly.
     *    Deliberately NOT gated on pending: if the server says this comanda
     *    is settled, keeping a ghost «occupied» mesa is the worse error (it
     *    invites a double service). The local queue payload is untouched —
     *    a pending `state: open` edit will push and hit the server's
     *    terminal guard (rejected: validation → poison, visible), which is
     *    exactly the honest end state for a stale open. */
    for (const settled of payload.closed_orders ?? []) {
      await tx.query(
        `UPDATE orders SET state = $3, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND state = 'open'`,
        [tenantId, settled.id, settled.state],
      );
      updated += 1;
      openByTable.forEach((orderId, tableId) => {
        if (orderId === settled.id) openByTable.delete(tableId);
      });
    }

    return updated;
  });
}
