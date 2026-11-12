import { useEffect, useMemo, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import {
  createLocalCustomer,
  customerAccountById,
  listLocalCustomers,
  type LocalCustomer,
} from "../db/local";

/**
 * M5 · Cobro único modal (prototype #modal-payment, HTML 629–718).
 *
 * ONE shared modal for desktop and mobile with the three prototype
 * methods (Efectivo / Transferencia / Fiado). The existing CashSection
 * moved here wholesale — no duplicated cash logic. Fiado carries the
 * required active-customer picker, the amber note, the client-side
 * credit-limit gate and the optional mixed cash part (M2 payments[]
 * exact split: cash part + credit remainder).
 *
 * The modal NEVER commits by itself: it delegates to Sale's confirm*
 * callbacks so the atomic `commitLocalSale` (task 9.7) stays the single
 * write path. Cancel/error always retain the cart (the parent keeps it).
 */

export type PayMethod = "cash" | "transfer" | "credit";

/** Colombian bills for one-tap cash entry (prototype denominations). */
const BILLS = [1000, 2000, 5000, 10000, 20000, 50000] as const;

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

/**
 * Cash block: recibido + vuelto + bills de un tap.
 * Moved from Sale.tsx — now lives inside the payment modal only.
 */
function CashSection({
  total,
  tendered,
  setTendered,
}: {
  total: number;
  tendered: string;
  setTendered: (v: string) => void;
}) {
  const received = /^\d+$/.test(tendered) ? Number(tendered) : 0;
  const change = received - total;

  function addBill(n: number) {
    setTendered(String(received + n));
  }

  // Nothing entered yet → no scary "Falta $total"; only show shortfall
  // once the cashier started typing an amount.
  const changeLabel =
    received === 0 ? "Ingresado" : change < 0 ? "Falta" : "Vuelto";
  const changeValue = received === 0 ? "—" : cop(Math.abs(change));
  const changeClass =
    received === 0 ? "" : change < 0 ? " short" : " due";

  return (
    <div className="cash-section">
      <label htmlFor="tendered">Efectivo recibido</label>
      <input
        id="tendered"
        data-testid="tendered"
        inputMode="numeric"
        className="cash-input"
        value={tendered}
        onChange={(e) => setTendered(e.target.value)}
        placeholder="0"
      />

      <div className="quick-cash" role="group" aria-label="Billetes">
        <button
          type="button"
          className="btn small quick-cash-btn"
          data-testid="quick-cash-exact"
          onClick={() => setTendered(String(total))}
        >
          Exacto
        </button>
        {BILLS.map((b) => (
          <button
            key={b}
            type="button"
            className="btn small quick-cash-btn"
            data-testid={`quick-cash-${b}`}
            onClick={() => addBill(b)}
          >
            {b >= 1000 ? `${b / 1000}k` : b}
          </button>
        ))}
      </div>

      <div
        className={`change-display${changeClass}`}
        data-testid="change-display"
        aria-live="polite"
      >
        <span className="muted">{changeLabel}</span>
        <strong>{changeValue}</strong>
      </div>
    </div>
  );
}

type Props = {
  open: boolean;
  db: PGlite;
  tenantId: string;
  total: number;
  /** Cart lines for the modal order summary (mobile shows no order panel). */
  lines: Array<{ label: string; qty: number; price: number }>;
  /** Oversell lines — the warning MUST sit where the sale completes. */
  oversell: Array<{ label: string; stock: number }>;
  method: PayMethod;
  onMethodChange: (m: PayMethod) => void;
  tendered: string;
  onTenderedChange: (v: string) => void;
  error: string | null;
  /** Busy locks the confirm button — one commit, never double-fired. */
  busy: boolean;
  onClose: () => void;
  /** Empty the cart from the modal summary (mobile has no order panel). */
  onClearOrder: () => void;
  onConfirmCash: () => void;
  onConfirmTransfer: () => void;
  onConfirmCredit: (customerId: string, cashAmount: number) => void;
};

export function PaymentModal({
  open,
  db,
  tenantId,
  total,
  lines,
  oversell,
  method,
  onMethodChange,
  tendered,
  onTenderedChange,
  error,
  busy,
  onClose,
  onClearOrder,
  onConfirmCash,
  onConfirmTransfer,
  onConfirmCredit,
}: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [cashPart, setCashPart] = useState("");
  const [account, setAccount] = useState<{
    balance: number;
    credit_limit: number | null;
    active: boolean;
  } | null>(null);
  const [accountLoading, setAccountLoading] = useState(false);
  /* Inline "Nuevo cliente fiado" (tasks 12.2 — alta from the cobro, 9.6 core) */
  const [showNewClient, setShowNewClient] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newLimit, setNewLimit] = useState("");
  const [newErr, setNewErr] = useState<string | null>(null);
  const [newBusy, setNewBusy] = useState(false);
  const newBusyRef = useRef(false);
  const validCop = (value: string) => /^\d+$/.test(value) && Number(value) <= 2147483647;

  /* Open/close lifecycle: native dialog + draft reset (the CART is kept
   * by the parent — only the payment draft restarts, like the prototype). */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setCustomerId("");
      setCustomerSearch("");
      setCashPart("");
      setShowNewClient(false);
      setNewName("");
      setNewPhone("");
      setNewLimit("");
      setNewErr(null);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, dialogRef]);

  /* Customers load when the modal opens (Fiado picker needs them ready). */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    listLocalCustomers(db, tenantId, customerSearch)
      .then((rows) => {
        if (alive) setCustomers(rows);
      })
      .catch(() => {
        if (alive) setCustomers([]);
      });
    return () => {
      alive = false;
    };
  }, [open, db, tenantId, customerSearch]);

  /* Account (balance + limit) for the selected client — the client-side
   * credit gate reads the SAME derived balance as the commit (9.7). */
  useEffect(() => {
    if (!open || method !== "credit" || !customerId) {
      setAccount(null);
      return;
    }
    let alive = true;
    setAccountLoading(true);
    customerAccountById(db, tenantId, customerId)
      .then((row) => {
        if (alive) setAccount(row);
      })
      .catch(() => {
        if (alive) setAccount(null);
      })
      .finally(() => {
        if (alive) setAccountLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, method, customerId, db, tenantId]);

  const cashAmount = cashPart === "" ? 0 : Number(cashPart);
  const creditPart = total - cashAmount;
  const cashPartInvalid =
    method === "credit" && ((cashPart !== "" && !validCop(cashPart)) || (cashAmount >= total && total > 0));

  /* Client-side limit gate (prototype confirmTransaction + credit-sales
   * spec §Credit part respects configured limit locally): block BEFORE
   * the tx with a visible reason. This is a LOCAL cap, not a global
   * reservation: the server retains real concurrent offline sales. */
  const limitBlock = useMemo(() => {
    if (method !== "credit") return null;
    if (!customerId) return "Seleccioná un cliente para vender a crédito.";
    if (cashPartInvalid)
      return "El efectivo ahora debe ser un entero COP ≥ 0 y menor al total — para cobrar todo en efectivo usá Efectivo.";
    if (!account) return accountLoading ? "Consultando cuenta…" : null;
    if (!account.active) return "El cliente debe estar activo.";
    if (account.credit_limit === null)
      return "Configurá el límite de crédito del cliente antes de vender a crédito.";
    if (account.balance + creditPart > account.credit_limit)
      return `El cliente excede su límite de crédito (${cop(account.credit_limit)}).`;
    return null;
  }, [method, customerId, cashPartInvalid, account, accountLoading, creditPart]);

  const confirmDisabled =
    busy || newBusy || (method === "credit" && (limitBlock !== null || !account));

  async function createClient() {
    if (newBusyRef.current) return;
    const name = newName.trim();
    const limit = Number(newLimit);
    if (!name) {
      setNewErr("Ingresá el nombre del cliente");
      return;
    }
    if (!validCop(newLimit)) {
      setNewErr("El límite es un entero COP ≥ 0 obligatorio en altas nuevas");
      return;
    }
    newBusyRef.current = true;
    setNewBusy(true);
    setNewErr(null);
    try {
      const created = await createLocalCustomer(db, tenantId, {
        name,
        phone: newPhone.trim() || null,
        credit_limit: limit,
      });
      setCustomers((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setCustomerId(created.id);
      setShowNewClient(false);
      setNewName("");
      setNewPhone("");
      setNewLimit("");
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      setNewErr(
        code === "CREDIT_LIMIT_REQUIRED"
          ? "El límite es obligatorio"
          : "No se pudo crear el cliente",
      );
    } finally {
      newBusyRef.current = false;
      setNewBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="payment-modal"
      data-testid="payment-modal"
      aria-labelledby="payment-title"
      onKeyDownCapture={(e) => { if (newBusyRef.current && ["F1", "F2", "Enter"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); } }}
      onCancel={(e) => {
        /* Escape cancels ONLY when not committing — draft/cart survive. */
        if (busy || newBusyRef.current) e.preventDefault();
        else onClose();
      }}
    >
      {/* Content only while open: a closed dialog must not keep testids
       * (and errors) in the DOM — strict-mode selectors would see them. */}
      {open && (
        <>
      <div className="payment-head">
        <div>
          <h3 id="payment-title">Procesar Cobro NEXORA</h3>
          <p className="muted">Selecciona el método de pago y calcula el cambio</p>
        </div>
        <button
          type="button"
          className="payment-x"
          data-testid="payment-close"
          aria-label="Cerrar cobro"
          disabled={busy || newBusy}
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {/* 3-method switcher — prototype pay-method-btn grammar */}
      <div className="pay-switch" role="tablist" aria-label="Método de pago">
        <button
          type="button"
          role="tab"
          aria-selected={method === "cash"}
          className={`pay-method-btn${method === "cash" ? " active" : ""}`}
          data-testid="pay-cash"
          disabled={busy}
          onClick={() => onMethodChange("cash")}
        >
          Efectivo
          <kbd className="pay-kbd">F1</kbd>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === "transfer"}
          className={`pay-method-btn${method === "transfer" ? " active" : ""}`}
          data-testid="pay-transfer"
          disabled={busy}
          onClick={() => onMethodChange("transfer")}
        >
          Transferencia
          <kbd className="pay-kbd">F2</kbd>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={method === "credit"}
          className={`pay-method-btn${method === "credit" ? " active" : ""}`}
          data-testid="pay-fiado"
          disabled={busy}
          onClick={() => onMethodChange("credit")}
        >
          Fiado (Crédito)
        </button>
      </div>

      {/* Total a Cobrar */}
      <div className="pay-total-box">
        <span className="muted">Total a Cobrar</span>
        <div className="pay-total" data-testid="checkout-total">
          {cop(total)}
        </div>
      </div>

      {oversell.length > 0 && (
        <div className="warn-banner" data-testid="oversell-warning" role="status">
          Stock insuficiente:{" "}
          {oversell.map((l) => `${l.label} (quedan ${l.stock})`).join(", ")}
          . Podés vender igual — el saldo quedará en negativo.
        </div>
      )}

      {/* Order summary — the mobile order panel equivalent (variant codes
       * AC: "× qty" visible right after opening the cobro). */}
      <div className="pay-summary" data-testid="checkout-summary">
        <div className="pay-summary-head">
          <span className="muted">Orden Actual</span>
          <button
            type="button"
            className="btn ghost small"
            data-testid="summary-clear"
            disabled={busy}
            onClick={onClearOrder}
          >
            Limpiar
          </button>
        </div>
        {lines.length === 0 ? (
          <p className="muted">El carrito está vacío.</p>
        ) : (
          lines.map((l) => (
            <div className="row space-between line" key={l.label}>
              <span className="line-label">
                {l.label} × {l.qty}
              </span>
              <span className="line-amount">{cop(l.price * l.qty)}</span>
            </div>
          ))
        )}
      </div>

      {method === "cash" && (
        <CashSection total={total} tendered={tendered} setTendered={onTenderedChange} />
      )}

      {method === "transfer" && (
        <div className="transfer-note" data-testid="transfer-note">
          <p>
            Se registra la venta por <strong>{cop(total)}</strong> como
            transferencia <strong>pendiente de confirmar</strong>.
          </p>
          <p className="muted">
            El dueño la confirma desde <strong>Tickets</strong> cuando vea el
            pago en el banco. No hay efectivo ni vuelto en este paso.
          </p>
        </div>
      )}

      {method === "credit" && (
        <div className="fiado-section" data-testid="fiado-section">
          <label htmlFor="fiado-search">Buscar cliente por nombre o teléfono</label>
          <input id="fiado-search" data-testid="fiado-search" type="search"
            value={customerSearch} disabled={busy || newBusy}
            onChange={(e) => { setCustomerSearch(e.target.value); setCustomerId(""); }} />
          <label htmlFor="fiado-client">Seleccionar Cliente Fiado</label>
          <select
            id="fiado-client"
            data-testid="fiado-client"
            value={customerId}
            disabled={busy}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">
              {customers.length === 0
                ? "Sin clientes activos — creá uno abajo"
                : "Seleccioná un cliente…"}
            </option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}{c.phone ? ` · ${c.phone}` : ""}
                {c.credit_limit !== null ? ` · límite ${cop(c.credit_limit)}` : " · sin límite"}
              </option>
            ))}
          </select>

          <p className="fiado-note" data-testid="fiado-note">
            ℹ Esta venta se sumará al saldo pendiente de la cuenta del cliente
            seleccionado.
          </p>

          {customerId && account && (
            <div className="fiado-account" data-testid="fiado-account">
              <span>
                Saldo actual <strong>{cop(account.balance)}</strong>
              </span>
              <span>
                Límite{" "}
                <strong>
                  {account.credit_limit === null ? "sin configurar" : cop(account.credit_limit)}
                </strong>
              </span>
              <span>
                Crédito en esta venta{" "}
                <strong>{cashPartInvalid ? "—" : cop(creditPart)}</strong>
              </span>
            </div>
          )}

          <div className="fiado-mixed">
            <label htmlFor="fiado-cash">Efectivo ahora (opcional — mixto)</label>
            <input
              id="fiado-cash"
              data-testid="fiado-cash"
              inputMode="numeric"
              value={cashPart}
              aria-invalid={cashPartInvalid}
              aria-describedby={cashPartInvalid ? "credit-limit-error" : undefined}
              disabled={busy}
              placeholder="0"
              onChange={(e) => setCashPart(e.target.value)}
            />
            <p className="muted" data-testid="credit-split">
              {cashAmount > 0 && !cashPartInvalid
                ? `Se cobra ${cop(cashAmount)} en efectivo ahora y ${cop(creditPart)} quedan a crédito.`
                : cashPartInvalid ? "Ingresá un importe entero válido." : `Venta a crédito completa: ${cop(creditPart)}.`}
            </p>
          </div>

          {limitBlock && (
            <p id="credit-limit-error" className="fiado-block" role="status" data-testid="credit-limit-note">
              {limitBlock}
            </p>
          )}

          <button
            type="button"
            className="btn ghost"
            data-testid="fiado-new-toggle"
            disabled={busy}
            onClick={() => {
              setNewErr(null);
              setShowNewClient((v) => !v);
            }}
          >
            {showNewClient ? "Cancelar alta" : "＋ Nuevo cliente fiado"}
          </button>
          {showNewClient && (
            <div className="fiado-new">
              <label htmlFor="fiado-new-name">Nombre</label>
              <input
                id="fiado-new-name"
                data-testid="fiado-new-name"
                value={newName}
                maxLength={120}
                disabled={newBusy}
                onChange={(e) => setNewName(e.target.value)}
              />
              <label htmlFor="fiado-new-phone">Teléfono (opcional)</label>
              <input
                id="fiado-new-phone"
                data-testid="fiado-new-phone"
                value={newPhone}
                maxLength={40}
                disabled={newBusy}
                onChange={(e) => setNewPhone(e.target.value)}
              />
              <label htmlFor="fiado-new-limit">Límite de crédito COP (≥ 0)</label>
              <input
                id="fiado-new-limit"
                data-testid="fiado-new-limit"
                inputMode="numeric"
                value={newLimit}
                aria-invalid={!!newErr}
                aria-describedby={newErr ? "fiado-new-error" : undefined}
                disabled={newBusy}
                placeholder="100000"
                onChange={(e) => setNewLimit(e.target.value)}
              />
              {newErr && (
                <p id="fiado-new-error" className="error" role="alert" data-testid="fiado-new-error">
                  {newErr}
                </p>
              )}
              <button
                type="button"
                className="btn primary"
                data-testid="fiado-new-save"
                disabled={newBusy}
                onClick={() => void createClient()}
              >
                {newBusy ? "Creando…" : "Crear y seleccionar"}
              </button>
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="error" data-testid="cart-error" role="alert">
          {error}
        </p>
      )}

      {method === "transfer" ? (
        <button
          type="button"
          className="btn primary big pay-confirm"
          data-testid="checkout-transfer"
          disabled={busy}
          aria-busy={busy}
          onClick={onConfirmTransfer}
        >
          {busy ? "Registrando…" : "Registrar transferencia"}
        </button>
      ) : (
        <button
          type="button"
          className="btn primary big pay-confirm"
          data-testid="checkout-confirm"
          disabled={confirmDisabled}
          aria-busy={busy}
          onClick={() => {
            if (method === "credit") {
              if (limitBlock || !customerId) return;
              onConfirmCredit(customerId, cashAmount);
            } else {
              onConfirmCash();
            }
          }}
        >
          {busy
            ? "Procesando…"
            : method === "credit"
              ? "Confirmar y Generar Ticket"
              : "Cobrar en efectivo"}
        </button>
      )}

      <button
        type="button"
        className="btn ghost pay-cancel"
        data-testid="checkout-cancel"
        disabled={busy || newBusy}
        onClick={onClose}
      >
        Seguir vendiendo
      </button>
        </>
      )}
    </dialog>
  );
}
