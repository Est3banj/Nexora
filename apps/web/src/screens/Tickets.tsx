import { useCallback, useEffect, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import {
  confirmLocalPayment,
  getLocalTicket,
  listLocalTickets,
  type LocalTicketRow,
} from "../db/local";
import "./ticket-print.css";

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
  const [detail, setDetail] = useState<TicketDetail>(null);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
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
      const res = await fetch(`/api/payments/${paymentId}/confirm`, {
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

  return (
    <div className="screen tickets">
      <h2>Tickets ({tickets.length})</h2>
      {tickets.map((t) => (
        <button
          key={t.id}
          className="card ticket-card"
          data-testid="ticket-item"
          onClick={() => setOpenId(openId === t.id ? null : t.id)}
        >
          <div className="row space-between">
            <strong data-testid="ticket-no">#{t.ticket_no}</strong>
            <strong>{cop(t.total)}</strong>
          </div>
          <div className="row space-between muted">
            <span>{when(t.created_at)}</span>
            <span>
              {t.method === "cash" ? "Efectivo" : "Transferencia"}
              {t.pay_status === "pending" ? " · pendiente" : ""}
              {t.vuelto ? ` · vuelto ${cop(t.vuelto)}` : ""}
            </span>
          </div>
        </button>
      ))}

      {detail && (
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
            <button
              className="btn ghost"
              data-testid="ticket-print"
              onClick={() => window.print()}
            >
              Imprimir
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
