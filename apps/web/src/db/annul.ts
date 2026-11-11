import type { PGlite } from "@electric-sql/pglite";
import { pushNow } from "../sync/queue";
import { scopedFetch } from "../sync/scoped-fetch";
import { mirrorVoidedSale, type VoidSnapshot } from "./void-sale";

/**
 * Operator-facing annulment errors — anything else (network, timeout,
 * unexpected) is NOT one of these and callers should show the generic
 * "needs connection" message instead of leaking fetch internals.
 */
export class AnnulError extends Error {}

/**
 * Owner annulment core shared by Tickets and the Sale quick-void (Batch B):
 *   1. drain the local queue (force) so the server sees the full sale
 *   2. refuse while unsynced work remains (same guard as Tickets)
 *   3. POST the role-checked void endpoint (server is the only authority)
 *   4. mirror the canonical evidence locally (stock restitution, once)
 *
 * Lives in its own module because sync/queue already imports db/void-sale —
 * putting pushNow in void-sale would create an import cycle.
 */
export async function annulTicket(
  db: PGlite,
  tenantId: string,
  ticketId: string,
  reason: string,
): Promise<void> {
  await pushNow(db, tenantId, { force: true });
  const pending = await db.query(
    "SELECT id FROM sync_log WHERE tenant_id=$1 AND status<>'synced' LIMIT 1",
    [tenantId],
  );
  if (pending.rows.length)
    throw new AnnulError("Terminá la sincronización antes de anular la venta");
  const res = await scopedFetch(tenantId, `/api/sales/tickets/${ticketId}/void`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  const data = await res.json();
  if (!res.ok)
    throw new AnnulError(
      res.status === 403
        ? "Solo el dueño puede anular ventas"
        : res.status === 404
          ? "La venta todavía no sincronizó"
          : data.error === "shift_closed"
            ? "No se puede anular: el turno ya cerró o no tiene caja abierta"
            : data.error === "incomplete_sale"
              ? "La venta no sincronizó completa; revisá la sincronización"
              : "No se pudo anular la venta; revisá el motivo y la conexión",
    );
  await mirrorVoidedSale(db, tenantId, data as VoidSnapshot);
}
