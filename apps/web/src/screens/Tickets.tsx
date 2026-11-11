import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import {
  confirmLocalPayment,
  getLocalTicket,
  listLocalTickets,
  type LocalTicketRow,
} from "../db/local";
import { useMediaQuery } from "../hooks/useMediaQuery";
import "./ticket-print.css";
import { mirrorVoidedSale, type VoidSnapshot } from "../db/void-sale";
import { pushNow } from "../sync/queue";
import { scopedFetch } from "../sync/scoped-fetch";

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-CO", {
    dateStyle: "short",
    timeStyle: "short",
  });

type Props = {
  db: PGlite;
  tenantId: string;
  refreshToken: number;
  tenantName?: string;
  showToast?: (msg: string) => void;
  onMutated?: () => void;
};

type TicketDetail = Awaited<ReturnType<typeof getLocalTicket>>;

export function Tickets({
  db,
  tenantId,
  refreshToken,
  tenantName,
  showToast,
  onMutated,
}: Props) {
  const [tickets, setTickets] = useState<LocalTicketRow[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [methodFilter, setMethodFilter] = useState<"all" | "cash" | "transfer" | "voided">("all");
  const [detail, setDetail] = useState<TicketDetail>(null);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [voiding, setVoiding] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  /* Desktop: master-detail (list | sticky side panel).
     Mobile: accordion — detail renders right under the tapped row.
     MUST sit with the other hooks (before the empty-state early return). */
  const isWide = useMediaQuery("(min-width: 1024px)");

  async function annul() {
    if (!detail) return;
    setVoiding(true);
    setConfirmErr(null);
    try {
      await pushNow(db, tenantId, { force: true });
      const pending = await db.query("SELECT id FROM sync_log WHERE tenant_id=$1 AND status<>'synced' LIMIT 1", [tenantId]);
      if (pending.rows.length) throw new Error("Terminá la sincronización antes de anular la venta");
      const res = await scopedFetch(tenantId, `/api/sales/tickets/${detail.ticket.id}/void`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(res.status === 403 ? "Solo el dueño puede anular ventas" : res.status === 404 ? "La venta todavía no sincronizó" : data.error === "shift_closed" ? "No se puede anular: el turno ya cerró o no tiene caja abierta" : data.error === "incomplete_sale" ? "La venta no sincronizó completa; revisá la sincronización" : "No se pudo anular la venta; revisá el motivo y la conexión");
      await mirrorVoidedSale(db, tenantId, data as VoidSnapshot);
      dialog.current?.close();
      showToast?.("Venta anulada · stock restituido. Registrá por fuera de NEXORA cualquier reintegro de dinero.");
      await refresh();
      setDetail(await getLocalTicket(db, tenantId, detail.ticket.id));
      onMutated?.();
    } catch (err) {
      setConfirmErr(err instanceof Error ? err.message : "La anulación necesita conexión; podés seguir vendiendo offline");
    } finally { setVoiding(false); }
  }
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  const refresh = useCallback(async () => {
    setTickets(await listLocalTickets(db, tenantId));
  }, [db, tenantId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    void getLocalTicket(db, tenantId, openId).then(setDetail);
  }, [db, tenantId, openId, refreshToken]);

  /**
   * Owner confirmation goes through the ROLE-CHECKED server endpoint first
   * (D2-6: a member gets 403); the local mirror + queue refresh happen only
   * after the server acked. Offline → explicit refusal (no silent local
   * confirm that would bypass the owner gate on sync).
   */
  async function confirmTransfer(paymentId: string) {
    setConfirmErr(null);
    setConfirming(true);
    try {
      const res = await scopedFetch(tenantId, `/api/payments/${paymentId}/confirm`, {
        method: "POST",
      });
      if (res.status === 403) {
        setConfirmErr("Solo el dueño puede confirmar transferencias");
        return;
      }
      if (res.status === 404) {
        setConfirmErr("La transferencia todavía no sincronizó — esperá a que termine la sync");
        return;
      }
      if (res.status === 409) {
        setConfirmErr("La transferencia ya estaba confirmada");
        return;
      }
      if (!res.ok) {
        setConfirmErr("No se pudo confirmar — revisá la conexión");
        return;
      }
      const data = (await res.json()) as { payment: { confirmed_at: string } };
      await confirmLocalPayment(db, tenantId, paymentId, data.payment.confirmed_at);
      setConfirmErr(null);
      showToast?.("Transferencia confirmada");
      await refresh();
      onMutated?.();
    } catch {
      setConfirmErr("Sin conexión con el servidor — la confirmación necesita internet");
    } finally {
      setConfirming(false);
    }
  }

  if (tickets.length === 0) {
    return (
      <div className="screen tickets">
        <h2>Tickets</h2>
        <div className="empty-state" data-testid="empty-tickets">
          <h2>Sin ventas todavía</h2>
          <p className="muted">
            Los tickets aparecen acá después de la primera venta en este dispositivo.
          </p>
        </div>
      </div>
    );
  }

  const methodName = (m: string | null) =>
    m === "cash" ? "Efectivo" : m === "transfer" ? "Transferencia" : "—";

  const q = search.trim().toLowerCase();
  const visible = tickets.filter((t) => {
    if (methodFilter === "voided" && t.status !== "voided") return false;
    if (methodFilter === "cash" && (t.method !== "cash" || t.status === "voided")) return false;
    if (methodFilter === "transfer" && (t.method !== "transfer" || t.status === "voided")) return false;
    if (!q) return true;
    if (String(t.ticket_no).includes(q)) return true;
    if (String(t.total).includes(q.replace(/[.\s]/g, ""))) return true;
    if ((t.items ?? "").toLowerCase().includes(q)) return true;
    if (t.status === "voided" && "anulada".includes(q)) return true;
    return when(t.created_at).toLowerCase().includes(q);
  });

  const detailCard = detail ? (
    <div className="card ticket-detail" data-testid="ticket-detail">
      {tenantName && (
        <p className="ticket-tenant" data-testid="ticket-tenant">
          {tenantName}
        </p>
      )}
      <h3>
        Ticket #{detail.ticket.ticket_no}{" "}
        <span className="muted">({when(detail.ticket.created_at)})</span>
      </h3>
      {detail.ticket.status === "voided" && <div role="status" data-testid="ticket-voided"><p>ANULADA · excluida de ventas y caja. Los importes y pagos siguientes son los originales.</p><p>Motivo: {detail.ticket.void_reason ?? "Consultá la auditoría del servidor"}{detail.ticket.voided_at ? ` · ${when(detail.ticket.voided_at)}` : ""}</p></div>}
      <p className="muted ticket-uuid" data-testid="ticket-uuid">
        {detail.ticket.id.slice(0, 8)}
      </p>

      {detail.lines.map((l) => {
        const name = [l.product_name, l.variant_name].filter(Boolean).join(" ");
        return (
          <div className="row space-between line" key={l.id}>
            <span>
              {l.qty} × {name || cop(l.unit_price)}
              {name && <span className="muted"> · {cop(l.unit_price)}</span>}
            </span>
            <span>{cop(l.subtotal)}</span>
          </div>
        );
      })}

      <div className="row space-between total-row">
        <span>Total</span>
        <strong>{cop(detail.ticket.total)}</strong>
      </div>

      <div className="row space-between" data-testid="ticket-pay-info">
        <span className="muted">Método</span>
        <span>
          {methodName(detail.ticket.method)}
          {detail.ticket.pay_status === "pending" ? " · pendiente" : " · confirmado"}
        </span>
      </div>
      {detail.ticket.method === "cash" && (
        <>
          <div className="row space-between" data-testid="ticket-tendered">
            <span className="muted">Recibido</span>
            <span>{cop(detail.ticket.tendered ?? 0)}</span>
          </div>
          <div className="row space-between" data-testid="ticket-vuelto">
            <span className="muted">Vuelto</span>
            <span>{cop(detail.ticket.vuelto ?? 0)}</span>
          </div>
        </>
      )}

      {confirmErr && (
        <p className="error" data-testid="confirm-error" role="alert">
          {confirmErr}
        </p>
      )}

      <div className="row gap ticket-actions">
        {detail.ticket.method === "transfer" &&
          detail.ticket.status !== "voided" &&
          detail.ticket.pay_status === "pending" && (
            <button
              className="btn primary"
              data-testid="confirm-transfer"
              disabled={
                confirming || !online || !detail.payment_synced
              }
              title={
                !online
                  ? "Se necesita conexión"
                  : !detail.payment_synced
                    ? "Esperando sincronización"
                    : undefined
              }
              onClick={() =>
                detail.payment_id && void confirmTransfer(detail.payment_id)
              }
            >
              {confirming ? "Confirmando…" : "Confirmar transferencia"}
            </button>
          )}
        {detail.ticket.status !== "voided" && <button className="btn danger" data-testid="void-sale"
          disabled={!online || !detail.payment_synced || confirming}
          onClick={() => { setReason(""); setConfirmErr(null); dialog.current?.showModal(); }}>
          Anular venta completa
        </button>}
        <button
          className="btn ghost"
          data-testid="ticket-print"
          onClick={() => window.print()}
        >
          Imprimir
        </button>
      </div>
      {!online && <p className="muted">La anulación necesita conexión. Podés seguir vendiendo offline.</p>}
      <p className="muted">Solo el dueño puede anular ventas sincronizadas de un turno abierto. Las cajas cerradas no se modifican.</p>
    </div>
  ) : null;

  return (
    <div className="screen tickets">
      <div className="tickets-toolbar">
        <h2 style={{ margin: 0 }}>Tickets ({visible.length})</h2>
        <input
          className="search-input"
          data-testid="ticket-search"
          type="search"
          placeholder="Buscar #, monto o producto…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar tickets"
        />
      </div>

      <div className="seg ticket-filters" role="tablist" aria-label="Filtrar tickets">
        {(
          [
            ["all", "Todos"],
            ["cash", "Efectivo"],
            ["transfer", "Transferencia"],
            ["voided", "Anuladas"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={methodFilter === key}
            className={methodFilter === key ? "active" : ""}
            data-testid={`filter-${key}`}
            onClick={() => setMethodFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {visible.length === 0 && (
        <div className="empty-state" data-testid="no-ticket-results">
          <h2>Sin resultados</h2>
          <p className="muted">Ningún ticket coincide con la búsqueda o el filtro.</p>
        </div>
      )}

      <div className={`tickets-layout${isWide && detailCard ? " with-detail" : ""}`}>
        <div className="ticket-list">
          {visible.map((t) => (
            <Fragment key={t.id}>
              <button
                className={`ticket-row${openId === t.id ? " open" : ""}${t.status === "voided" ? " voided" : ""}`}
                data-testid="ticket-item"
                onClick={() => setOpenId(openId === t.id ? null : t.id)}
              >
                <span className="ticket-row-no" data-testid="ticket-no">
                  #{t.ticket_no}
                </span>
                <span className="ticket-row-meta">
                  <span className="muted">{when(t.created_at)}</span>
                  <span className="ticket-row-items">{t.items ?? ""}</span>
                </span>
                <span className="ticket-row-right">
                  <strong>{cop(t.total)}</strong>
                  <span className={`ticket-badge b-${t.status === "voided" ? "void" : t.method === "transfer" ? "transfer" : "cash"}`}>
                    {t.status === "voided"
                      ? "Anulada"
                      : t.method === "transfer"
                        ? t.pay_status === "pending"
                          ? "Transf. pend."
                          : "Transferencia"
                        : "Efectivo"}
                  </span>
                </span>
              </button>
              {!isWide && openId === t.id && detailCard}
            </Fragment>
          ))}
        </div>

        {isWide && detailCard && <aside className="ticket-side">{detailCard}</aside>}
      </div>

      {/* Void dialog lives OUTSIDE detailCard: the card moves between the
          inline (mobile) and side-panel (desktop) positions when the
          breakpoint flips, and a remount would silently close the dialog. */}
      {detail && (
        <dialog ref={dialog} aria-labelledby="void-title" aria-describedby="void-description" onCancel={e => { if (voiding) e.preventDefault(); }}>
          <form onSubmit={e => { e.preventDefault(); void annul(); }}>
            <h3 id="void-title">Anular venta #{detail.ticket.ticket_no}</h3>
            <p id="void-description">Se anula toda la venta y se restituye el stock una sola vez. El historial se conserva. No realiza un reintegro bancario ni de efectivo.</p>
            <label htmlFor="void-reason">Motivo obligatorio</label>
            <textarea id="void-reason" data-testid="void-reason" autoFocus required minLength={3} maxLength={500}
              value={reason} onChange={e => setReason(e.target.value)} disabled={voiding} />
            {confirmErr && <p role="alert" data-testid="void-error">{confirmErr}</p>}
            <div className="row gap">
              <button type="button" className="btn ghost" disabled={voiding} onClick={() => dialog.current?.close()}>Cancelar</button>
              <button type="submit" className="btn danger" data-testid="void-confirm" disabled={voiding || !online || reason.trim().length < 3}>
                {voiding ? "Anulando…" : "Confirmar anulación total"}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}
