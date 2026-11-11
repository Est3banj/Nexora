import { useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { listSaleItems, type SaleItem } from "../db/local";
import { annulTicket, AnnulError } from "../db/annul";
import { useSale } from "../hooks/useSale";
import { useMediaQuery } from "../hooks/useMediaQuery";

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

/** Colombian bills for one-tap cash entry. */
const BILLS = [1000, 2000, 5000, 10000, 20000, 50000] as const;

/**
 * Flat avatar palette for products without photo — deterministic hash so
 * the same product always gets the same color (all pass ≥3:1 vs white
 * for the bold initial, which is large-scale text).
 */
const AVATAR_COLORS = [
  "#3d7dff",
  "#0284c7",
  "#0d9488",
  "#8b5cf6",
  "#f43f5e",
  "#d97706",
  "#64748b",
  "#ec4899",
] as const;

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

type Props = {
  db: PGlite;
  tenantId: string;
  refreshToken: number;
  showToast: (msg: string) => void;
  onCommitted: () => void;
  /** Set by the command palette → add this product to the cart on mount/focus. */
  pendingProduct: SaleItem | null;
  onPendingProductUsed: () => void;
};

type View = "browse" | "checkout" | "success";

/**
 * Cash block: recibido + vuelto + bills de un tap.
 * Shared by mobile checkout view and the desktop order panel.
 */
function CashSection({
  total,
  tendered,
  setTendered,
  compact = false,
}: {
  total: number;
  tendered: string;
  setTendered: (v: string) => void;
  compact?: boolean;
}) {
  const received = Number(tendered.replace(/[^\d]/g, "")) || 0;
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
    <div className={`cash-section${compact ? " compact" : ""}`}>
      <div className="row space-between cash-total-row">
        <span className="muted">Total a pagar</span>
        <strong className="cash-total" data-testid="checkout-total">
          {cop(total)}
        </strong>
      </div>

      <label htmlFor="tendered">Efectivo recibido</label>
      <input
        id="tendered"
        data-testid="tendered"
        inputMode="numeric"
        className="cash-input"
        value={tendered}
        onChange={(e) => setTendered(e.target.value.replace(/[^\d]/g, ""))}
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

export function Sale({
  db,
  tenantId,
  refreshToken,
  showToast,
  onCommitted,
  pendingProduct,
  onPendingProductUsed,
}: Props) {
  const [items, setItems] = useState<SaleItem[]>([]);
  const [view, setView] = useState<View>("browse");
  const [tendered, setTendered] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastSale, setLastSale] = useState<{
    id: string;
    ticketNo: number;
    total: number;
    vuelto: number | null;
    method: string;
    status: string;
  } | null>(null);
  const sale = useSale();
  const isWide = useMediaQuery("(min-width: 1024px)");
  // D3-1 / catalog spec §Overselling: warn BEFORE checkout completes, but
  // completing is always allowed (negative balance is legal + visible).
  const oversell = sale.lines.filter((l) => l.qty > l.stock);
  const [search, setSearch] = useState("");
  const [scanCode, setScanCode] = useState("");
  const [scanMessage, setScanMessage] = useState("");
  const [payMethod, setPayMethod] = useState<"cash" | "transfer">("cash");

  /* Command palette hand-off: product picked → land in the cart. */
  useEffect(() => {
    if (!pendingProduct) return;
    sale.addItem(pendingProduct);
    onPendingProductUsed();
  }, [pendingProduct, sale.addItem, onPendingProductUsed]);

  /* ── Batch B: quick annul + keyboard shortcuts ─────────────────────
     All hooks live here, BEFORE the success/checkout early returns
     (Rules of Hooks — a hook after an early return crashes on toggle). */
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  const [lastTicket, setLastTicket] = useState<{
    id: string;
    ticket_no: number;
  } | null>(null);
  const [voidTarget, setVoidTarget] = useState<{
    id: string;
    ticket_no: number;
  } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidErr, setVoidErr] = useState<string | null>(null);
  const voidDialog = useRef<HTMLDialogElement>(null);

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

  useEffect(() => {
    let alive = true;
    Promise.all([
      listSaleItems(db, tenantId),
      db.query<{ id: string; ticket_no: number }>(
        "SELECT id, ticket_no FROM tickets WHERE tenant_id=$1 AND status<>'voided' ORDER BY ticket_no DESC LIMIT 1",
        [tenantId],
      ),
    ])
      .then(([rows, last]) => {
        if (!alive) return;
        setItems(rows);
        setLastTicket(last.rows[0] ?? null);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [db, tenantId, view, lastSale, refreshToken]);

  /* Keyboard shortcuts for peak hours:
     F1 = efectivo exacto · F2 = transferencia · Enter = cobrar.
     Deliberately re-attached every render (no deps array) so the closure
     always sees the fresh tendered/sale state. Skips: buttons (native
     activation wins — never double-charge), other inputs, open dialogs. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F1" || e.key === "F2") {
        e.preventDefault();
        if (sale.lines.length === 0) return;
        const cash = e.key === "F1";
        setPayMethod(cash ? "cash" : "transfer");
        if (cash) setTendered(String(sale.total));
        if (!isWide) {
          setView("checkout");
          return;
        }
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLButtonElement>(
              cash ? '[data-testid="checkout-confirm"]' : '[data-testid="checkout-transfer"]',
            )
            ?.focus();
        });
        return;
      }
      if (e.key !== "Enter") return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      if (tag === "BUTTON" || tag === "A" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (t.isContentEditable) return;
      if (t.closest("dialog")) return;
      const inTendered = t.getAttribute("data-testid") === "tendered";
      if (tag === "INPUT" && !inTendered) return;
      if (view === "success") return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      if (payMethod === "cash") void confirmCash();
      else void confirmTransfer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const q = search.trim().toLowerCase();
  const filteredItems = items.filter((it) => {
    if (!q) return true;
    return (
      it.product_name.toLowerCase().includes(q) ||
      it.name.toLowerCase().includes(q) ||
      it.code?.toLowerCase().includes(q)
    );
  });

  const scanner = (
    <form className="card scanner" data-testid="scanner-form" onSubmit={(event) => {
      event.preventDefault();
      const code = scanCode.trim();
      if (!code) return;
      const item = items.find((candidate) => candidate.code === code);
      if (!item) {
        setScanMessage(`Código no encontrado: ${code}. No se agregó ningún producto.`);
        return;
      }
      sale.addItem(item);
      setError(null);
      setScanCode("");
      setScanMessage(`Agregado: ${item.product_name} ${item.name}, una unidad.`);
    }}>
      <label htmlFor="sale-code">SKU / código de barras</label>
      <div className="row gap">
        <input id="sale-code" data-testid="sale-code" type="text" maxLength={120}
          autoComplete="off" autoCapitalize="none" spellCheck={false} enterKeyHint="go"
          aria-describedby="scan-help scan-message" value={scanCode}
          onChange={(event) => setScanCode(event.target.value)} />
        <button type="submit" className="btn" data-testid="scan-add">Agregar</button>
      </div>
      <p id="scan-help" className="muted">Lector USB o teclado + Enter. Agrega una unidad; no cobra.</p>
      <p id="scan-message" role="status" aria-live="polite" data-testid="scan-message">{scanMessage}</p>
    </form>
  );

  function openCheckout() {
    // tap 2 — empty cart must be blocked WITH a message (sales spec)
    if (sale.lines.length === 0) {
      setError("El carrito está vacío — tocá un producto primero");
      return;
    }
    setError(null);
    setPayMethod("cash");
    setTendered("");
    setView("checkout");
  }

  function ensureCart(): boolean {
    if (sale.lines.length === 0) {
      setError("El carrito está vacío — tocá un producto primero");
      return false;
    }
    setError(null);
    return true;
  }

  async function confirmCash() {
    // Cashier must state what was received — no auto-filled total (UX fix).
    if (!ensureCart()) return;
    const amount = Number(tendered.replace(/[^\d]/g, "")) || 0;
    if (amount === 0) {
      setError("Ingresá el efectivo recibido o tocá Exacto");
      return;
    }
    try {
      const committed = await sale.commit(db, tenantId, { method: "cash", tendered: amount });
      setLastSale({
        id: committed.ticket.id,
        ticketNo: committed.ticket.ticket_no,
        total: committed.payment.amount,
        vuelto: committed.payment.vuelto,
        method: committed.payment.method,
        status: committed.payment.status,
      });
      setView("success");
      setTendered("");
      showToast("Venta registrada (pendiente de sync)");
      onCommitted();
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      if (code === "EMPTY_CART") setError("El carrito está vacío");
      else if (code === "UNDERPAYMENT")
        setError("El efectivo recibido es menor al total");
      else setError("No se pudo registrar la venta");
    }
  }

  async function confirmTransfer() {
    // tap 3 — bank transfer: payment pending, ticket transfer_pending
    if (!ensureCart()) return;
    try {
      const committed = await sale.commit(db, tenantId, { method: "transfer" });
      setLastSale({
        id: committed.ticket.id,
        ticketNo: committed.ticket.ticket_no,
        total: committed.payment.amount,
        vuelto: null,
        method: committed.payment.method,
        status: committed.payment.status,
      });
      setView("success");
      setTendered("");
      showToast("Venta registrada (pendiente de sync)");
      onCommitted();
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      if (code === "EMPTY_CART") setError("El carrito está vacío");
      else setError("No se pudo registrar la venta");
    }
  }

  /* ── Quick annul (Batch B): same auditable core as Tickets ──────── */
  function openVoid(t: { id: string; ticket_no: number }) {
    setVoidTarget(t);
    setVoidReason("");
    setVoidErr(null);
    voidDialog.current?.showModal();
  }

  async function annulQuick() {
    if (!voidTarget) return;
    setVoidBusy(true);
    setVoidErr(null);
    try {
      await annulTicket(db, tenantId, voidTarget.id, voidReason.trim());
      voidDialog.current?.close();
      showToast("Venta anulada · stock restituido. Registrá por fuera de NEXORA cualquier reintegro de dinero.");
      setLastSale(null);
      setView("browse");
      onCommitted();
    } catch (err) {
      // AnnulError carries the operator message; anything else is a
      // network/timeout failure — never leak fetch internals.
      setVoidErr(
        err instanceof AnnulError
          ? err.message
          : "La anulación necesita conexión; podés seguir vendiendo offline",
      );
    } finally {
      setVoidBusy(false);
    }
  }

  const voidDialogEl = (
    <dialog
      ref={voidDialog}
      aria-labelledby="void-quick-title"
      onCancel={(e) => {
        if (voidBusy) e.preventDefault();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void annulQuick();
        }}
      >
        <h3 id="void-quick-title">
          Anular venta {voidTarget ? `#${voidTarget.ticket_no}` : ""}
        </h3>
        <p>
          Se anula toda la venta y se restituye el stock una sola vez. El
          historial se conserva. No realiza un reintegro bancario ni de
          efectivo.
        </p>
        <label htmlFor="void-quick-reason">Motivo obligatorio</label>
        <textarea
          id="void-quick-reason"
          data-testid="void-quick-reason"
          autoFocus
          required
          minLength={3}
          maxLength={500}
          value={voidReason}
          onChange={(e) => setVoidReason(e.target.value)}
          disabled={voidBusy}
        />
        {voidErr && (
          <p role="alert" data-testid="void-quick-error">
            {voidErr}
          </p>
        )}
        <div className="row gap">
          <button
            type="button"
            className="btn ghost"
            disabled={voidBusy}
            onClick={() => voidDialog.current?.close()}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="btn danger"
            data-testid="void-quick-confirm"
            disabled={voidBusy || !online || voidReason.trim().length < 3}
          >
            {voidBusy ? "Anulando…" : "Confirmar anulación total"}
          </button>
        </div>
      </form>
    </dialog>
  );

  if (view === "success" && lastSale) {
    return (
      <div className="screen sale-success" data-testid="sale-success">
        <div className="success-icon" aria-hidden>
          ✓
        </div>
        <h2>Venta registrada</h2>
        <p className="muted" data-testid="pending-note">
          Pendiente de sincronizar
        </p>
        <div className="card">
          <div className="row space-between">
            <span>Ticket</span>
            <strong data-testid="ticket-no">#{lastSale.ticketNo}</strong>
          </div>
          <div className="row space-between">
            <span>Total</span>
            <strong data-testid="ticket-total">{cop(lastSale.total)}</strong>
          </div>
          <div className="row space-between">
            <span>Vuelto</span>
            <strong data-testid="ticket-vuelto">
              {lastSale.vuelto === null ? "—" : cop(lastSale.vuelto)}
            </strong>
          </div>
          <div className="row space-between">
            <span>Método</span>
            <strong data-testid="ticket-method">
              {lastSale.method === "cash" ? "Efectivo" : "Transferencia"}
              {lastSale.status === "pending" ? " · pendiente de confirmar" : ""}
            </strong>
          </div>
        </div>
        <div className="row gap" style={{ justifyContent: "center", flexWrap: "wrap" }}>
          <button
            className="btn primary"
            data-testid="new-sale"
            onClick={() => {
              setLastSale(null);
              setTendered("");
              setPayMethod("cash");
              setView("browse");
            }}
          >
            Nueva venta
          </button>
          <button
            className="btn"
            data-testid="print-sale"
            onClick={() => window.print()}
          >
            Imprimir
          </button>
          <button
            className="btn ghost void-trigger"
            data-testid="void-last-sale"
            disabled={!online || voidBusy}
            title={!online ? "Se necesita conexión" : undefined}
            onClick={() => openVoid({ id: lastSale.id, ticket_no: lastSale.ticketNo })}
          >
            Anular esta venta
          </button>
        </div>
        {voidDialogEl}
      </div>
    );
  }

  /* ── Mobile: checkout full-screen view (E2E @375px path) ─────────── */
  if (view === "checkout" && !isWide) {
    return (
      <div className="screen checkout">
        <h2>Cobrar</h2>

        {oversell.length > 0 && (
          <div className="warn-banner" data-testid="oversell-warning" role="status">
            Stock insuficiente:{" "}
            {oversell.map((l) => `${l.label} (quedan ${l.stock})`).join(", ")}
            . Podés vender igual — el saldo quedará en negativo.
          </div>
        )}

        <div className="card" data-testid="checkout-summary">
          {sale.lines.map((l) => (
            <div className="row space-between line" key={l.variantId}>
              <span className="line-label">
                {l.label} × {l.qty}
              </span>
              <span className="line-amount">{cop(l.price * l.qty)}</span>
            </div>
          ))}
        </div>

        <div className="seg pay-method" role="tablist" aria-label="Método de pago">
          <button
            type="button"
            role="tab"
            aria-selected={payMethod === "cash"}
            className={payMethod === "cash" ? "active" : ""}
            data-testid="pay-cash"
            onClick={() => setPayMethod("cash")}
          >
            Efectivo
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={payMethod === "transfer"}
            className={payMethod === "transfer" ? "active" : ""}
            data-testid="pay-transfer"
            onClick={() => setPayMethod("transfer")}
          >
            Transferencia
          </button>
        </div>

        {payMethod === "cash" ? (
          <div className="card">
            <CashSection
              total={sale.total}
              tendered={tendered}
              setTendered={setTendered}
            />
          </div>
        ) : (
          <div className="card transfer-note" data-testid="transfer-note">
            <p>
              Se registra la venta por <strong>{cop(sale.total)}</strong> como
              transferencia <strong>pendiente de confirmar</strong>.
            </p>
            <p className="muted">
              El dueño la confirma desde <strong>Tickets</strong> cuando vea el
              pago en el banco. No hay efectivo ni vuelto en este paso.
            </p>
          </div>
        )}

        {error && (
          <p className="error" data-testid="cart-error" role="alert">
            {error}
          </p>
        )}

        {payMethod === "cash" ? (
          <button
            className="btn primary big"
            data-testid="checkout-confirm"
            onClick={confirmCash}
          >
            Cobrar en efectivo
          </button>
        ) : (
          <button
            className="btn primary big"
            data-testid="checkout-transfer"
            onClick={confirmTransfer}
          >
            Registrar transferencia
          </button>
        )}
        <button
          className="btn ghost"
          data-testid="checkout-cancel"
          onClick={() => {
            setError(null);
            setView("browse");
          }}
        >
          Seguir vendiendo
        </button>
      </div>
    );
  }

  /* ── Desktop ≥1024: two-panel — products | order + cash ──────────── */
  if (isWide) {
    return (
      <div className="screen sale sale-layout" data-testid="sale-screen">
        <div className="sale-products">
          {scanner}
          {oversell.length > 0 && (
            <div className="warn-banner" data-testid="oversell-warning" role="status">
              Stock insuficiente:{" "}
              {oversell.map((l) => `${l.label} (quedan ${l.stock})`).join(", ")}
              . Podés vender igual — el saldo quedará en negativo.
            </div>
          )}

          <div className="sale-toolbar">
            <input
              className="search-input"
              data-testid="sale-search"
              type="search"
              placeholder="Buscar nombre, SKU o código…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Buscar producto"
            />
          </div>

          {items.length === 0 ? (
            <div className="empty-state" data-testid="empty-catalog">
              <h2>Sin productos</h2>
              <p className="muted">
                Cargá el catálogo en la pestaña Catálogo para empezar a vender.
              </p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="empty-state" data-testid="empty-sale-search">
              <p className="muted">Ningún producto coincide con la búsqueda.</p>
            </div>
          ) : (
            <div className="sale-grid">
              {filteredItems.map((item) => (
                <button
                  key={item.id}
                  className="sale-tile"
                  data-testid="sale-item"
                  onClick={() => {
                    setError(null);
                    if (sale.lines.length === 0) setTendered("");
                    sale.addItem(item);
                  }}
                >
                  {item.photo ? (
                    <img className="tile-photo" src={item.photo} alt="" />
                  ) : (
                    <span
                      className="tile-photo placeholder"
                      aria-hidden
                      style={{
                        background: avatarColor(item.product_name),
                        color: "#fff",
                      }}
                    >
                      {item.product_name.charAt(0)}
                    </span>
                  )}
                  <span className="tile-product">{item.product_name}</span>
                  <span className="tile-variant">{item.name}</span>
                  <span className="tile-price">{cop(item.price)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="sale-order card" data-testid="order-panel">
          <div className="order-head">
            <h3>Orden</h3>
            <span className="muted" data-testid="cart-count">
              {sale.lines.length} ítems
            </span>
          </div>

          {sale.lines.length === 0 ? (
            <p className="muted order-empty">
              Tocá un producto para agregarlo a la orden.
            </p>
          ) : (
            <ul className="order-lines">
              {sale.lines.map((l) => (
                <li key={l.variantId} className="order-line" data-testid="order-line">
                  <div className="order-line-main">
                    <span className="order-line-label">{l.label}</span>
                    <strong>{cop(l.price * l.qty)}</strong>
                  </div>
                  <div className="order-line-qty">
                    <button
                      type="button"
                      className="btn small qty-btn"
                      aria-label={`Quitar ${l.label}`}
                      onClick={() => sale.setQty(l.variantId, l.qty - 1)}
                    >
                      −
                    </button>
                    <span className="qty-value" data-testid="order-qty">
                      {l.qty}
                    </span>
                    <button
                      type="button"
                      className="btn small qty-btn"
                      aria-label={`Agregar ${l.label}`}
                      onClick={() => sale.setQty(l.variantId, l.qty + 1)}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="btn small ghost qty-btn"
                      aria-label={`Eliminar ${l.label}`}
                      onClick={() => sale.setQty(l.variantId, 0)}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="row space-between order-total" data-testid="cart-total">
            <span>Total</span>
            <strong>{cop(sale.total)}</strong>
          </div>

          <div className="seg pay-method" role="tablist" aria-label="Método de pago">
            <button
              type="button"
              role="tab"
              aria-selected={payMethod === "cash"}
              className={payMethod === "cash" ? "active" : ""}
              data-testid="pay-cash"
              onClick={() => setPayMethod("cash")}
            >
              Efectivo
              <kbd className="pay-kbd">F1</kbd>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={payMethod === "transfer"}
              className={payMethod === "transfer" ? "active" : ""}
              data-testid="pay-transfer"
              onClick={() => setPayMethod("transfer")}
            >
              Transferencia
              <kbd className="pay-kbd">F2</kbd>
            </button>
          </div>

          {payMethod === "cash" ? (
            <CashSection
              total={sale.total}
              tendered={tendered}
              setTendered={setTendered}
              compact
            />
          ) : (
            <div className="transfer-note" data-testid="transfer-note">
              <p>
                Venta por <strong>{cop(sale.total)}</strong> como transferencia{" "}
                <strong>pendiente</strong>.
              </p>
              <p className="muted">
                El dueño la confirma desde Tickets. Sin efectivo ni vuelto.
              </p>
            </div>
          )}

          {error && (
            <p className="error" data-testid="cart-error" role="alert">
              {error}
            </p>
          )}

          {payMethod === "cash" ? (
            <button
              className="btn primary big"
              data-testid="checkout-confirm"
              disabled={sale.lines.length === 0}
              onClick={confirmCash}
            >
              Cobrar en efectivo
            </button>
          ) : (
            <button
              className="btn primary big"
              data-testid="checkout-transfer"
              disabled={sale.lines.length === 0}
              onClick={confirmTransfer}
            >
              Registrar transferencia
            </button>
          )}

          {lastTicket && (
            <button
              className="btn ghost void-trigger"
              data-testid="void-last-quick"
              disabled={!online || voidBusy}
              title={!online ? "Se necesita conexión" : undefined}
              onClick={() => openVoid(lastTicket)}
            >
              Anular última venta #{lastTicket.ticket_no}
            </button>
          )}
          {voidDialogEl}
        </aside>
      </div>
    );
  }

  /* ── Mobile browse: product grid + bottom cart bar ───────────────── */
  return (
    <div className="screen sale">
      {scanner}
      <div className="sale-toolbar">
        <input
          className="search-input"
          data-testid="sale-search"
          type="search"
          placeholder="Buscar nombre, SKU o código…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar producto"
        />
      </div>

      {items.length === 0 ? (
        <div className="empty-state" data-testid="empty-catalog">
          <h2>Sin productos</h2>
          <p className="muted">
            Cargá el catálogo en la pestaña Catálogo para empezar a vender.
          </p>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="empty-state" data-testid="empty-sale-search">
          <p className="muted">Ningún producto coincide con la búsqueda.</p>
        </div>
      ) : (
        <div className="sale-grid">
          {filteredItems.map((item) => (
            <button
              key={item.id}
              className="sale-tile"
              data-testid="sale-item"
              onClick={() => {
                setError(null);
                sale.addItem(item);
              }}
            >
              {item.photo ? (
                <img className="tile-photo" src={item.photo} alt="" />
              ) : (
                <span
                  className="tile-photo placeholder"
                  aria-hidden
                  style={{
                    background: avatarColor(item.product_name),
                    color: "#fff",
                  }}
                >
                  {item.product_name.charAt(0)}
                </span>
              )}
              <span className="tile-product">{item.product_name}</span>
              <span className="tile-variant">{item.name}</span>
              <span className="tile-price">{cop(item.price)}</span>
            </button>
          ))}
        </div>
      )}

      {error && (
        <p className="error floating" data-testid="cart-error" role="alert">
          {error}
        </p>
      )}

      <div className="cart-bar" data-testid="cart-bar">
        <span data-testid="cart-count">{sale.lines.length} ítems</span>
        <strong data-testid="cart-total">{cop(sale.total)}</strong>
        <button
          className="btn primary"
          data-testid="checkout-open"
          onClick={openCheckout}
        >
          Cobrar
        </button>
      </div>
    </div>
  );
}
