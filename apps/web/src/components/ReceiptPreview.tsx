import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { formatTicketNo, paymentMethodLabel } from "@pos/shared";
import type { PublicSettings } from "../lib/settings";
/* Receipt print rules (58/80mm) travel with the component that owns
 * printing — Vite dedupes the sheet Tickets also imports. */
import "../screens/ticket-print.css";

/**
 * M5 · Recibo térmico compartido Venta/Tickets (prototype #modal-receipt,
 * HTML 720–764) — ONE component, two discriminants:
 *
 *  - `sale`: persisted ticket meta + lines + payments array + change,
 *    rendered from `getLocalTicket` (real data — the identity below comes
 *    ONLY from configured settings, never fabricated: no invented cashier,
 *    NIT, address or fiscal hash; the prototype sample identity stays
 *    forbidden).
 *  - `abono`: distinct collection receipt (ID/method/customer/amount/
 *    resulting balance) — an abono is NEVER a sale (abonos spec), but it
 *    carries the SAME configured identity header (receipt-identity §Abono
 *    receipt carries identity too).
 *
 * roles-admin 5.7 / design D8 — `identity` (optional): ONLY configured
 * values render, field by field; ABSENT settings (or all-null fields) keep
 * today's honest blank header byte-for-byte. `iva_pct` is NEVER rendered —
 * no IVA row, no fiscal claim (B1 deferral, decision #11).
 *
 * Print is REAL: `window.print()` + ticket-print.css 58/80mm rules.
 * «Cerrar» and «Imprimir» are separate buttons (prototype's combined
 * "Cerrar / Imprimir" would lie about printing). Portaled to <body> so
 * print media can hide the whole app shell and keep only the paper.
 *
 * IVA DEFERRED (B1): no fiscal rows, no «IVA19% incluido», no exemption
 * claim — prices/totals stay exactly as persisted.
 */

/** The six receipt-identity slots the tenant can configure (D8). */
export type ReceiptIdentity = {
  store_name?: string | null;
  nit?: string | null;
  address?: string | null;
  phone?: string | null;
  footer?: string | null;
  ticket_prefix?: string | null;
};

/**
 * Hosts (Venta, Tickets reprint, Credito abono) map the cached settings
 * state through this helper — one place, so no surface can forget a field.
 * All-null settings produce the same all-null identity as `undefined`,
 * i.e. the honest blank header.
 */
export function pickReceiptIdentity(settings: PublicSettings): ReceiptIdentity {
  return {
    store_name: settings.store_name,
    nit: settings.nit,
    address: settings.address,
    phone: settings.phone,
    footer: settings.ticket_footer,
    ticket_prefix: settings.ticket_prefix,
  };
}

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
    timeZone: "America/Bogota",
  });

type SaleDetail = {
  ticket: {
    id: string;
    ticket_no: number;
    total: number;
    status: string;
    created_at: string;
    method: string | null;
    pay_status: string | null;
    tendered: number | null;
    vuelto: number | null;
    void_reason?: string | null;
    voided_at?: string | null;
    customer_id?: string | null;
    customer_name?: string | null;
  };
  lines: Array<{
    id: string;
    qty: number;
    unit_price: number;
    subtotal: number;
    variant_name: string | null;
    product_name: string | null;
  }>;
  payments: Array<{
    id: string;
    method: string;
    amount: number;
    tendered: number | null;
    vuelto: number | null;
    status: string;
    confirmed_at: string | null;
  }>;
};

export type ReceiptData =
  | { kind: "sale"; detail: SaleDetail; tenantName?: string }
  | {
      kind: "abono";
      abono: {
        id: string;
        amount: number;
        method: "cash" | "transfer";
        created_at: string;
        note?: string | null;
      };
      customerName: string;
      balanceAfter: number;
      tenantName?: string;
    };

type Props = {
  open: boolean;
  data: ReceiptData | null;
  /** Configured tenant identity (D8) — optional so an absent/unknown
   * settings state renders exactly today's blank header. */
  identity?: ReceiptIdentity;
  onClose: () => void;
  /** Action slot (Tickets: confirm-transfer / void-sale) — outside the paper. */
  children?: ReactNode;
};

export function ReceiptPreview({ open, data, identity, onClose, children }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  /* Paper width: thermal rolls come in 58mm and 80mm — the toggle changes
   * the actual print CSS (data-print-width), not a fake label. */
  const [width, setWidth] = useState<58 | 80>(80);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && open && !dialog.open) dialog.showModal();
  }, [open]);

  if (!open || !data) return null;

  /* Native close FIRST (returns focus to the trigger), then notify the
   * parent — unmounting an open dialog would swallow the focus return. */
  function requestClose() {
    dialogRef.current?.close();
    onClose();
  }

  const paper = (
    <div
      className="receipt-paper"
      data-print-width={width}
      data-testid={data.kind === "sale" ? "ticket-detail" : "abono-detail"}
    >
      <div className="receipt-head">
        {/* D8: store name falls back to the org tenant name, then NEXORA —
         * the same blank-identity behavior as before when nothing is set. */}
        <h4>{identity?.store_name || data.tenantName || "NEXORA"}</h4>
        {/* Header lines render ONLY when configured (verbatim, no
         * placeholders, no invented values — partial config = partial
         * header). */}
        {identity?.nit && <p className="receipt-meta-line" data-testid="receipt-nit">NIT: {identity.nit}</p>}
        {identity?.address && <p className="receipt-meta-line" data-testid="receipt-address">{identity.address}</p>}
        {identity?.phone && <p className="receipt-meta-line" data-testid="receipt-phone">{identity.phone}</p>}
        {data.kind === "sale" && (
          <p className="receipt-meta-line">ID: {data.detail.ticket.id}</p>
        )}
      </div>

      {data.kind === "sale" ? (
        <>
          <div className="receipt-meta">
            <div className="row space-between">
              <span>TICKET:</span>
              {/* Display-only prefix via the shared helper (5.7): the stored
               * integer sequence and its unique index stay untouched. */}
              <strong>#{formatTicketNo(identity?.ticket_prefix ?? null, data.detail.ticket.ticket_no)}</strong>
            </div>
            <div className="row space-between">
              <span>FECHA:</span>
              <span>{when(data.detail.ticket.created_at)}</span>
            </div>
            {data.detail.ticket.customer_name && (
              <div className="row space-between" data-testid="receipt-customer">
                <span>CLIENTE:</span>
                <span>{data.detail.ticket.customer_name}</span>
              </div>
            )}
          </div>

          {data.detail.ticket.status === "voided" && (
            <div className="receipt-void" data-testid="ticket-voided" role="status">
              <p>ANULADA · excluida de ventas y caja</p>
              <p>
                Motivo: {data.detail.ticket.void_reason ?? "Consultá la auditoría del servidor"}
                {data.detail.ticket.voided_at ? ` · ${when(data.detail.ticket.voided_at)}` : ""}
              </p>
            </div>
          )}

          <div className="receipt-items">
            {data.detail.lines.map((l) => {
              const name = [l.product_name, l.variant_name].filter(Boolean).join(" ");
              return (
                <div className="row space-between" key={l.id}>
                  <span className="receipt-item-name">
                    {l.qty}x {name || cop(l.unit_price)}
                  </span>
                  <span>{cop(l.subtotal)}</span>
                </div>
              );
            })}
          </div>

          <div className="receipt-totals">
            <div className="row space-between">
              <span>SUBTOTAL:</span>
              <span>{cop(data.detail.ticket.total)}</span>
            </div>
            <div className="row space-between receipt-total">
              <span>TOTAL:</span>
              <span>{cop(data.detail.ticket.total)}</span>
            </div>
            {/* Payments array — mixed tickets show BOTH parts once. */}
            <div data-testid="ticket-pay-info">
              {data.detail.payments.map((p) => (
                <div className="row space-between" key={p.id}>
                  <span>
                    PAGO ({paymentMethodLabel(p.method)}
                    {p.status === "pending" ? " · pendiente" : ""}):
                  </span>
                  <span>{cop(p.amount)}</span>
                </div>
              ))}
            </div>
            {data.detail.ticket.method === "cash" && (
              <>
                <div className="row space-between">
                  <span>RECIBIDO:</span>
                  <span>{cop(data.detail.ticket.tendered ?? 0)}</span>
                </div>
                <div className="row space-between">
                  <span>CAMBIO:</span>
                  <span>{cop(data.detail.ticket.vuelto ?? 0)}</span>
                </div>
              </>
            )}
          </div>

          <div className="receipt-foot">
            {/* Configured footer sits ABOVE the thanks line; absent → today's
             * markup exactly (no empty <p>, no placeholder). */}
            {identity?.footer && <p data-testid="receipt-footer">{identity.footer}</p>}
            <p className="receipt-thanks">¡Gracias por su compra!</p>
          </div>
        </>
      ) : (
        <>
          <div className="receipt-meta">
            <div className="row space-between">
              <span>ABONO:</span>
               <strong className="receipt-meta-line" data-testid="abono-receipt-id">{data.abono.id}</strong>
            </div>
            <div className="row space-between">
              <span>FECHA:</span>
              <span>{when(data.abono.created_at)}</span>
            </div>
            <div className="row space-between">
              <span>CLIENTE:</span>
              <span>{data.customerName}</span>
            </div>
            <div className="row space-between">
              <span>MÉTODO:</span>
              <span>{paymentMethodLabel(data.abono.method)}</span>
            </div>
          </div>

          <div className="receipt-totals">
            <div className="row space-between receipt-total">
              <span>ABONO:</span>
              <span>{cop(data.abono.amount)}</span>
            </div>
            <div className="row space-between">
              <span>SALDO RESULTANTE:</span>
              <span>{cop(data.balanceAfter)}</span>
            </div>
            {data.abono.note && (
              <div className="row space-between">
                <span>NOTA:</span>
                <span>{data.abono.note}</span>
              </div>
            )}
          </div>

          <div className="receipt-foot">
            {/* Same identity header/footer as the sale receipt (D8). */}
            {identity?.footer && <p data-testid="receipt-footer">{identity.footer}</p>}
            <p className="receipt-thanks">Abono registrado — no es una venta.</p>
          </div>
        </>
      )}
    </div>
  );

  return createPortal(
    <dialog
      ref={dialogRef}
      className="receipt-dialog"
      data-testid="receipt-preview"
      aria-label="Comprobante"
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
    >
      <div className="receipt-body">{paper}</div>

      <div className="receipt-widths" role="group" aria-label="Ancho de papel">
        <button
          type="button"
          className={width === 58 ? "active" : ""}
          data-testid="receipt-width-58"
          onClick={() => setWidth(58)}
        >
          58 mm
        </button>
        <button
          type="button"
          className={width === 80 ? "active" : ""}
          data-testid="receipt-width-80"
          onClick={() => setWidth(80)}
        >
          80 mm
        </button>
      </div>

      {children && <div className="receipt-actions">{children}</div>}

      <div className="receipt-buttons">
        <button
          type="button"
          className="btn ghost"
          data-testid="receipt-close"
          onClick={requestClose}
        >
          Cerrar
        </button>
        <button
          type="button"
          className="btn primary"
          data-testid="receipt-print"
          onClick={() => window.print()}
        >
          Imprimir
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
