import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { paymentMethodLabel } from "@pos/shared";
/* Receipt print rules (58/80mm) travel with the component that owns
 * printing — Vite dedupes the sheet Tickets also imports. */
import "../screens/ticket-print.css";

/**
 * M5 · Recibo térmico compartido Venta/Tickets (prototype #modal-receipt,
 * HTML 720–764) — ONE component, two discriminants:
 *
 *  - `sale`: persisted ticket meta + lines + payments array + change,
 *    rendered from `getLocalTicket` (real data, no fabricated cashier,
 *    NIT, address or fiscal hash — prototype sample identity is forbidden).
 *  - `abono`: distinct collection receipt (ID/method/customer/amount/
 *    resulting balance) — an abono is NEVER a sale (abonos spec).
 *
 * Print is REAL: `window.print()` + ticket-print.css 58/80mm rules.
 * «Cerrar» and «Imprimir» are separate buttons (prototype's combined
 * "Cerrar / Imprimir" would lie about printing). Portaled to <body> so
 * print media can hide the whole app shell and keep only the paper.
 *
 * IVA DEFERRED (B1): no fiscal rows, no «IVA19% incluido», no exemption
 * claim — prices/totals stay exactly as persisted.
 */

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
  onClose: () => void;
  /** Action slot (Tickets: confirm-transfer / void-sale) — outside the paper. */
  children?: ReactNode;
};

export function ReceiptPreview({ open, data, onClose, children }: Props) {
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
        <h4>{data.tenantName || "NEXORA"}</h4>
        {data.kind === "sale" && (
          <p className="receipt-meta-line">ID: {data.detail.ticket.id}</p>
        )}
      </div>

      {data.kind === "sale" ? (
        <>
          <div className="receipt-meta">
            <div className="row space-between">
              <span>TICKET:</span>
              <strong>#{data.detail.ticket.ticket_no}</strong>
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
