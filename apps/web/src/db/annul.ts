import type { PGlite } from "@electric-sql/pglite";
import { pushNow } from "../sync/queue";
import { scopedFetch } from "../sync/scoped-fetch";
import { mirrorVoidedSale, type VoidSnapshot } from "./void-sale";

/**
 * Operator-facing annulment errors — anything else (network, timeout,
 * unexpected) is NOT one of these and callers should show the generic
 * "needs connection" message instead of leaking fetch internals.
 *
 * roles-admin 5.6: `kind` carries the D3 error CLASS (not just the copy) so
 * a dialog can react — `code_required` reveals+focuses its code field when
 * the server demands a code the cached toggle said was off (staleness
 * fallback: never a dead end).
 */
export class AnnulError extends Error {
  readonly kind?: "code_required" | "code_invalid";
  constructor(message: string, kind?: "code_required" | "code_invalid") {
    super(message);
    this.kind = kind;
  }
}

/**
 * Owner annulment core shared by Tickets and the Sale quick-void (Batch B):
 *   1. drain the local queue (force) so the server sees the full sale
 *   2. refuse while unsynced work remains (same guard as Tickets)
 *   3. POST the role-checked void endpoint (server is the only authority)
 *   4. mirror the canonical evidence locally (stock restitution, once)
 *
 * Lives in its own module because sync/queue already imports db/void-sale —
 * putting pushNow in void-sale would create an import cycle.
 *
 * roles-admin 4.5 / design D3: `code` is sent ONLY when the caller has one
 * (toggle ON dialogs, batch 5). The server decides — this function just
 * maps its 403 bodies to operator-facing Spanish via the D3 table.
 */
export async function annulTicket(
  db: PGlite,
  tenantId: string,
  ticketId: string,
  reason: string,
  code?: string,
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
    body: JSON.stringify(code === undefined ? { reason } : { reason, code }),
  });
  const data = await res.json();
  if (!res.ok) {
    const message =
      res.status === 403
        ? // D3 table (403 branch): code errors first, then the toggle-OFF
          // tier body — copy is tier-aware (owner OR admin can anular).
          data.error === "annul_code_required"
            ? "Ingresá el código de anulación para anular"
            : data.error === "annul_code_invalid"
              ? data.detail === "expired"
                ? "El código de anulación venció; pedí uno nuevo en Administración"
                : "Código de anulación incorrecto"
              : "Solo el dueño o un administrador puede anular ventas"
        : res.status === 404
          ? "La venta todavía no sincronizó"
          : data.error === "shift_closed"
            ? "No se puede anular: el turno ya cerró o no tiene caja abierta"
            : data.error === "incomplete_sale"
              ? "La venta no sincronizó completa; revisá la sincronización"
              : "No se pudo anular la venta; revisá el motivo y la conexión";
    const kind =
      res.status === 403 && data.error === "annul_code_required"
        ? "code_required"
        : res.status === 403 && data.error === "annul_code_invalid"
          ? "code_invalid"
          : undefined;
    throw new AnnulError(message, kind);
  }
  await mirrorVoidedSale(db, tenantId, data as VoidSnapshot);
}
