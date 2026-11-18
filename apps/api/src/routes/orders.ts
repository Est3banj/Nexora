import type { FastifyInstance } from "fastify";
import { repoFor } from "../auth/ctx";

/**
 * GET /api/orders/open — the mesas Fase 2 PULL (CONTROL-MESAS.md · decisión
 * 4). One tenant-scoped, never-cached read that lets a board on device B
 * show what device A has open:
 *
 *  - `tables`     every table of the tenant with its DERIVED board state
 *                 (`available` | `occupied` | `billing`) + live items/total
 *                 of its open comanda. Occupancy is computed HERE from
 *                 `orders` — the stored `tables.status` column is legacy
 *                 (decision 8: no LWW fight over occupancy).
 *  - `orders`     every comanda with state `open` (billing rides as the
 *                 `billing_at` flag — billing is NOT a state).
 *  - `order_lines` ALL lines of those orders (soft-deleted rows included,
 *                 so a client can mirror removals as `deleted_at` state).
 *  - `closed_orders` bounded tombstones (id + state) of recently SETTLED
 *                 comandas — the reconcile signal for «esta mesa ya se cobró/
 *                 liberó en otro dispositivo» and the frescura check at cobro.
 *
 * Any verified role may read it (requireAuth only, members included):
 * serving a mesa IS selling. Rows come exclusively through scopedRepo —
 * session tenant, never a query param (trust rule §Tenant resolution).
 */
export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/orders/open", { preHandler: app.requireAuth }, async (req, reply) => {
    // User data (consumption + who is at which table) — never cacheable.
    reply.header("Cache-Control", "no-store");
    const repo = repoFor(req);
    const [tables, orders, closed_orders] = await Promise.all([
      repo.tables.list({ limit: 500 }),
      repo.orders.listOpen(),
      repo.orders.listSettled(200),
    ]);
    const order_lines = await repo.orderLines.listByOrders(orders.map((o) => o.id));

    // Live totals per comanda — byte-identical math to the local board
    // (SUM(qty) items, SUM(price*qty) total over non-deleted lines).
    const totals = new Map<string, { items: number; total: number }>();
    for (const line of order_lines) {
      if (line.deleted_at) continue;
      const acc = totals.get(line.order_id) ?? { items: 0, total: 0 };
      acc.items += line.qty;
      acc.total += line.price * line.qty;
      totals.set(line.order_id, acc);
    }

    // One open comanda per table (orders_tenant_table_open_uq enforces it;
    // earliest opened_at wins defensively if a legacy row ever slipped in).
    const openByTable = new Map<string, (typeof orders)[number]>();
    for (const order of orders) {
      if (!openByTable.has(order.table_id)) openByTable.set(order.table_id, order);
    }

    const board = tables.map((table) => {
      const order = openByTable.get(table.id);
      const acc = order ? totals.get(order.id) : undefined;
      return {
        ...table,
        status: !order ? "available" : order.billing_at ? "billing" : "occupied",
        order_id: order?.id ?? null,
        opened_at: order?.opened_at ?? null,
        items: acc?.items ?? 0,
        total: acc?.total ?? 0,
      };
    });

    return { tables: board, orders, order_lines, closed_orders };
  });
}
