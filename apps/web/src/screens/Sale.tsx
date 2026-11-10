import { useEffect, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { listSaleItems, type SaleItem } from "../db/local";
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

type Props = {
  db: PGlite;
  tenantId: string;
  refreshToken: number;
  showToast: (msg: string) => void;
  onCommitted: () => void;
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
        className={`change-display${change < 0 ? " short" : change > 0 ? " due" : ""}`}
        data-testid="change-display"
        aria-live="polite"
      >
        <span className="muted">{change < 0 ? "Falta" : "Vuelto"}</span>
        <strong>{cop(Math.abs(change))}</strong>
      </div>
    </div>
  );
}

export function Sale({ db, tenantId, refreshToken, showToast, onCommitted }: Props) {
  const [items, setItems] = useState<SaleItem[]>([]);
  const [view, setView] = useState<View>("browse");
  const [tendered, setTendered] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastSale, setLastSale] = useState<{
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

  useEffect(() => {
    let alive = true;
    listSaleItems(db, tenantId)
      .then((rows) => alive && setItems(rows))
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, [db, tenantId, view, lastSale, refreshToken]);

  const q = search.trim().toLowerCase();
  const filteredItems = items.filter((it) => {
    if (!q) return true;
    return (
      it.product_name.toLowerCase().includes(q) ||
      it.name.toLowerCase().includes(q)
    );
  });

  function openCheckout() {
    // tap 2 — empty cart must be blocked WITH a message (sales spec)
    if (sale.lines.length === 0) {
      setError("El carrito está vacío — tocá un producto primero");
      return;
    }
    setError(null);
    setTendered(String(sale.total));
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
    // tap 3 — cash checkout (tendered ≥ total, vuelto computed)
    if (!ensureCart()) return;
    try {
      const amount = Number(tendered.replace(/[^\d]/g, "")) || 0;
      const committed = await sale.commit(db, tenantId, { method: "cash", tendered: amount });
      setLastSale({
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
        <button
          className="btn primary"
          data-testid="new-sale"
          onClick={() => {
            setLastSale(null);
            setTendered("");
            setView("browse");
          }}
        >
          Nueva venta
        </button>
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

        <div className="card">
          <CashSection total={sale.total} tendered={tendered} setTendered={setTendered} />
        </div>

        {error && (
          <p className="error" data-testid="cart-error" role="alert">
            {error}
          </p>
        )}

        <button
          className="btn primary big"
          data-testid="checkout-confirm"
          onClick={confirmCash}
        >
          Efectivo
        </button>
        <button
          className="btn big"
          data-testid="checkout-transfer"
          onClick={confirmTransfer}
        >
          Transferencia
        </button>
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
              placeholder="Buscar producto…"
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
                    <span className="tile-photo placeholder" aria-hidden>
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

          <CashSection
            total={sale.total}
            tendered={tendered}
            setTendered={setTendered}
            compact
          />

          {error && (
            <p className="error" data-testid="cart-error" role="alert">
              {error}
            </p>
          )}

          <button
            className="btn primary big"
            data-testid="checkout-confirm"
            disabled={sale.lines.length === 0}
            onClick={confirmCash}
          >
            Cobrar en efectivo
          </button>
          <button
            className="btn big"
            data-testid="checkout-transfer"
            disabled={sale.lines.length === 0}
            onClick={confirmTransfer}
          >
            Transferencia
          </button>
        </aside>
      </div>
    );
  }

  /* ── Mobile browse: product grid + bottom cart bar ───────────────── */
  return (
    <div className="screen sale">
      <div className="sale-toolbar">
        <input
          className="search-input"
          data-testid="sale-search"
          type="search"
          placeholder="Buscar producto…"
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
                <span className="tile-photo placeholder" aria-hidden>
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
