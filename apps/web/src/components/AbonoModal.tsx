import { useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { paymentMethodLabel } from "@pos/shared";
import {
  listLocalCustomerTickets,
  registerLocalAbono,
  type LocalTicketRow,
} from "../db/local";

/**
 * M6 ·13.2 — Modal Abono (prototype #modal-pay-debt, HTML 852–883).
 *
 * Real collection against the customer's derived balance:
 *  - Efectivo by default, Transferencia allowed (settled decision #1 — the
 *    prototype shows cash only; OUR contract registers both methods).
 *  - amount / note / ticket link optional-but-validated: integer COP > 0,
 *    NEVER clamped (overpayment is rejected with the balance in the
 *    message — `Math.max(0, debt-payment)` is forbidden), zero-balance
 *    cards stay visible as Al Día with the confirm DISABLED + reason.
 *  - owner pre-gate lives in Credito (role11.3); the server keeps the
 *    per-item rejection as authority (D4).
 *  - one write: busyRef blocks a second synchronous click; the abono is
 *    own-table + queue in ONE local transaction (`registerLocalAbono`),
 *    never a sale/payment.
 *  - SHIFT_REQUIRED surfaces as a clear message (same gate as a sale).
 *
 * On durable success the parent opens the shared ReceiptPreview with the
 * `abono` discriminator (M5) — ID/method/amount/resulting balance, and
 * «no es una venta».
 */

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

export type AbonoResult = {
  id: string;
  amount: number;
  method: "cash" | "transfer";
  created_at: string;
  note: string | null;
  balanceAfter: number;
};

type Props = {
  open: boolean;
  db: PGlite;
  tenantId: string;
  account: { customer_id: string; name: string; balance: number } | null;
  onClose: () => void;
  onRegistered: (result: AbonoResult) => void;
};

export function AbonoModal({ open, db, tenantId, account, onClose, onRegistered }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<"cash" | "transfer">("cash");
  const [note, setNote] = useState("");
  const [ticketId, setTicketId] = useState("");
  const [tickets, setTickets] = useState<LocalTicketRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const balance = account?.balance ?? 0;
  const value = Number(amount);
  const validAmount = /^\d+$/.test(amount) && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setAmount("");
      setMethod("cash");
      setNote("");
      setTicketId("");
      setError(null);
      setBusy(false);
      busyRef.current = false;
      dialog.querySelector<HTMLInputElement>("#abono-amount")?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, account]);

  /* Attribution options: the customer's own tickets (server accepts a link
   * whose customer_id is null-or-equal; the local guard enforces the same). */
  useEffect(() => {
    if (!open || !account) return;
    let alive = true;
    listLocalCustomerTickets(db, tenantId, account.customer_id)
      .then((rows) => {
        if (alive) setTickets(rows);
      })
      .catch(() => {
        if (alive) setTickets([]);
      });
    return () => {
      alive = false;
    };
  }, [open, account, db, tenantId]);

  function requestClose() {
    if (busyRef.current) return;
    dialogRef.current?.close();
    onClose();
  }

  /* Confirm gate: zero balance → disabled + reason (never a silent no-op);
   * amount must be an integer > 0 and ≤ balance (no clamp, no partial). */
  const zeroBalance = balance <= 0;
  const overpay = !zeroBalance && value > balance;
  const amountInvalid = !zeroBalance && amount !== "" && !validAmount;
  const confirmDisabled = busy || zeroBalance || !validAmount || overpay;

  async function confirm() {
    if (busyRef.current || !account) return;
    if (zeroBalance || !validAmount || overpay) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await registerLocalAbono(db, tenantId, {
        customer_id: account.customer_id,
        amount: value,
        method,
        ticket_id: ticketId || null,
        note: note.trim() || null,
      });
      // Close first so native focus returns to the card before the receipt
      // captures it as its return target (never the disappearing confirm).
      dialogRef.current?.close();
      onRegistered({
        id: result.id,
        amount: result.amount,
        method: result.method,
        created_at: result.created_at ?? new Date().toISOString(),
        note: result.note ?? null,
        balanceAfter: result.balance,
      });
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      setError(
        code === "SHIFT_REQUIRED"
          ? "Abrí una caja para registrar abonos (mismo requisito que una venta)."
          : code.startsWith("ABONO_EXCEEDS_BALANCE")
             ? `El abono excede el saldo pendiente (${cop(Number(code.split(":")[1]))}).`
            : code === "ABONO_TICKET_MISMATCH"
              ? "Ese ticket no pertenece a este cliente."
              : code === "CUSTOMER_NOT_FOUND"
                ? "Cliente no encontrado en este comercio."
                : "No se pudo registrar el abono.",
      );
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="abono-modal"
      data-testid="abono-modal"
      aria-labelledby="abono-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      {open && account && (
        <>
          <div className="modal-head">
            <h3 id="abono-title">Registrar Abono a Deuda</h3>
            <button
              type="button"
              className="modal-x"
              data-testid="abono-close"
              aria-label="Cerrar"
              disabled={busy}
              onClick={requestClose}
            >
              ✕
            </button>
          </div>

          <div className="abono-body">
            <div className="abono-field">
              <span className="muted">Cliente:</span>
              <strong data-testid="abono-client">{account.name}</strong>
            </div>
            <div className="abono-field">
              <span className="muted">Saldo Actual Pendiente:</span>
              <strong className="abono-balance" data-testid="abono-balance">
                {cop(balance)}
              </strong>
            </div>

            <fieldset className="abono-method" aria-label="Método del abono">
              <legend>Método</legend>
              <div className="seg" role="group">
                <button
                  type="button"
                  className={method === "cash" ? "active" : ""}
                  data-testid="abono-cash"
                  disabled={busy}
                  onClick={() => setMethod("cash")}
                >
                  Efectivo
                </button>
                <button
                  type="button"
                  className={method === "transfer" ? "active" : ""}
                  data-testid="abono-transfer"
                  disabled={busy}
                  onClick={() => setMethod("transfer")}
                >
                  Transferencia
                </button>
              </div>
              <p className="muted abono-method-note">
                {method === "cash"
                  ? "Entra a la gaveta del turno (esperado de caja)."
                  : "Queda fuera de la gaveta; entra a la cuenta del banco."}
              </p>
            </fieldset>

            <div className="abono-field">
              <label htmlFor="abono-amount">Monto del Abono</label>
              <div className="abono-amount-wrap">
                <span aria-hidden="true">$</span>
                <input
                  id="abono-amount"
                  data-testid="abono-amount"
                  className="mono"
                  inputMode="numeric"
                   value={amount}
                   autoFocus
                   aria-invalid={amountInvalid || overpay}
                   aria-describedby={overpay ? "abono-overpay" : amountInvalid ? "abono-amount-error" : error ? "abono-submit-error" : undefined}
                  disabled={busy || zeroBalance}
                  placeholder="0"
                   onChange={(e) => setAmount(e.target.value)}
                />
              </div>
            </div>

            <div className="abono-field">
              <label htmlFor="abono-ticket">Aplicar a ticket (opcional)</label>
              <select
                id="abono-ticket"
                data-testid="abono-ticket"
                value={ticketId}
                disabled={busy}
                onChange={(e) => setTicketId(e.target.value)}
              >
                <option value="">Sin aplicar (cliente)</option>
                {tickets.map((t) => (
                  <option key={t.id} value={t.id}>
                    #{t.ticket_no} · {cop(t.total)} ·{" "}
                    {new Date(t.created_at).toLocaleDateString("es-CO")}
                  </option>
                ))}
              </select>
            </div>

            <div className="abono-field">
              <label htmlFor="abono-note">Nota (opcional)</label>
              <input
                id="abono-note"
                data-testid="abono-note"
                value={note}
                maxLength={300}
                disabled={busy}
                placeholder="Efectivo recibido en tienda"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            {zeroBalance && (
              <p className="fiado-block" role="status" data-testid="abono-zero-note">
                Sin saldo pendiente — no hay nada por cobrar. Este cliente
                está Al Día.
              </p>
            )}
            {overpay && (
               <p id="abono-overpay" className="fiado-block" role="status" data-testid="abono-overpay">
                El abono excede el saldo pendiente ({cop(balance)}) — no se
                acepta sobrepago.
              </p>
            )}
            {amountInvalid && (
               <p id="abono-amount-error" className="error" role="alert" data-testid="abono-error">
                 Ingresá un monto entero mayor a 0 y hasta 2.147.483.647.
              </p>
            )}
            {error && (
               <p id="abono-submit-error" className="error" role="alert" data-testid="abono-error">
                {error}
              </p>
            )}

            <button
              type="button"
              className="btn primary big abono-confirm"
              data-testid="abono-confirm"
              disabled={confirmDisabled}
              aria-busy={busy}
              onClick={() => void confirm()}
            >
              {busy ? "Registrando…" : "Confirmar Abono y Recibo"}
            </button>
            <p className="muted abono-hint">
              El abono es un cobro, no una venta: no suma ingresos ni toca los
              pagos del ticket. Método actual: {paymentMethodLabel(method)}.
            </p>
          </div>
        </>
      )}
    </dialog>
  );
}
