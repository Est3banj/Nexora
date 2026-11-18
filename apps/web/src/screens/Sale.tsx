import { useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import {
  CircleDollarSign,
  Save,
  Search,
  ShoppingBasket,
  ShoppingCart,
  Trash2,
  Utensils,
} from "lucide-react";
import { paymentMethodLabel } from "@pos/shared";
import {
  getLocalTicket,
  listCategories,
  listSaleItems,
  type LocalCategory,
  type SaleItem,
} from "../db/local";
import {
  getTable,
  listTables,
  loadTableOrder,
  saveOrderToTable,
  type LocalTable,
} from "../db/local-orders";
import { annulTicket, AnnulError } from "../db/annul";
import { ticketHasAbonos } from "../db/void-sale";
import { fetchOpenOrders, pullOpenOrders } from "../sync/open-orders";
import { isDueñoHint, type RoleHint } from "../components/navigation";
import { useSale } from "../hooks/useSale";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { PaymentModal, type PayMethod } from "../components/PaymentModal";
import { ReceiptPreview, pickReceiptIdentity, type ReceiptData } from "../components/ReceiptPreview";
import { ProductIcon } from "../components/ProductIcon";
import type { PublicSettings } from "../lib/settings";

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

type Props = {
  db: PGlite;
  tenantId: string;
  /** Role hint lifted from App (roles-admin 5.2) — never authority. */
  role: RoleHint;
  /** Cached tenant settings (3.10): annul-code toggle + receipt identity. */
  settings: PublicSettings;
  tenantName?: string;
  refreshToken: number;
  showToast: (msg: string) => void;
  onCommitted: () => void;
  /** Set by the command palette → add this product to the cart on mount/focus. */
  pendingProduct: SaleItem | null;
  onPendingProductUsed: () => void;
  /* ── Mesas (Fase 1) ────────────────────────────────────────────────
   * `activeTableId` lives in App so it survives the POS unmounting on a
   * tab switch; the cart itself stays ephemeral (Sale's useState) — the
   * leave-POS guard confirms before it is lost, never destroys silently. */
  activeTableId: string | null;
  onActiveTableChange: (id: string | null) => void;
  /** Board «Abrir / Cobrar» → load this comanda into the cart on mount. */
  pendingTableOrder: { tableId: string; orderId: string } | null;
  onPendingTableOrderUsed: () => void;
  /** Reported to App so the tab-switch guard knows the cart is dirty. */
  onCartCountChange: (count: number) => void;
  /** Fase 2 · the frescura check found the comanda settled/forked on ANOTHER
   * device — App bumps refreshToken so the board re-pulls on next render. */
  onStaleOrder?: () => void;
};

type View = "browse" | "success";

/** Prototype stock badge threshold (POS card amber when stock ≤ 5). */
const LOW_STOCK_BADGE = 5;

export function Sale({
  db,
  tenantId,
  role,
  settings,
  tenantName,
  refreshToken,
  showToast,
  onCommitted,
  pendingProduct,
  onPendingProductUsed,
  activeTableId,
  onActiveTableChange,
  pendingTableOrder,
  onPendingTableOrderUsed,
  onCartCountChange,
  onStaleOrder,
}: Props) {
  const [items, setItems] = useState<SaleItem[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogRetry, setCatalogRetry] = useState(0);
  const [categories, setCategories] = useState<LocalCategory[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
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
    /** Credit part owed — credit-sales spec §Success copy shows it. */
    credit: number | null;
    /** mesas: table the ticket settled — receipt + success copy. */
    tableName: string | null;
  } | null>(null);
  const sale = useSale();
  const isWide = useMediaQuery("(min-width: 1024px)");
  // D3-1 / catalog spec §Overselling: warn BEFORE checkout completes, but
  // completing is always allowed (negative balance is legal + visible).
  const oversell = sale.lines.filter((l) => l.qty > l.stock);
  const [search, setSearch] = useState("");
  const [scanMessage, setScanMessage] = useState("");
  /* Single payment modal (M5): one surface for both breakpoints. */
  const [payOpen, setPayOpen] = useState(false);
  const [payMethod, setPayMethod] = useState<PayMethod>("cash");
  /* Busy = one commit in flight — never double-fire (12.2 gate).
   * The ref is the SYNCHRONOUS guard: two clicks in the same tick never
   * reach React's re-render, so state alone would let both through. */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /* Receipt opens only AFTER the durable local commit (spec). */
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);

  /* Command palette hand-off: product picked → land in the cart. */
  useEffect(() => {
    if (!pendingProduct) return;
    sale.addItem(pendingProduct);
    onPendingProductUsed();
  }, [pendingProduct, sale.addItem, onPendingProductUsed]);

  /* ── Mesas · Fase 1 ─────────────────────────────────────────────── */
  const [activeTableName, setActiveTableName] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTables, setPickerTables] = useState<LocalTable[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const pickerDialog = useRef<HTMLDialogElement>(null);

  /* Banner name: resolved from the local table row (the id is the only
   * thing that survives a POS unmount — App owns `activeTableId`). */
  useEffect(() => {
    if (!activeTableId) {
      setActiveTableName(null);
      return;
    }
    let alive = true;
    getTable(db, tenantId, activeTableId)
      .then((row) => {
        if (alive) setActiveTableName(row?.name ?? null);
      })
      .catch(() => {
        if (alive) setActiveTableName(null);
      });
    return () => {
      alive = false;
    };
  }, [db, tenantId, activeTableId]);

  /* Board «Abrir / Cobrar» hand-off: replace the cart with the comanda. */
  useEffect(() => {
    if (!pendingTableOrder) return;
    let alive = true;
    loadTableOrder(db, tenantId, pendingTableOrder.tableId)
      .then((resumed) => {
        if (alive && resumed) sale.loadLines(resumed.lines);
      })
      .catch(() => {
        /* the board only offers tables that HAVE an open order — a race
         * (released elsewhere) just lands on an empty cart + banner */
      })
      .finally(() => {
        if (alive) onPendingTableOrderUsed();
      });
    return () => {
      alive = false;
    };
  }, [pendingTableOrder, db, tenantId, sale.loadLines, onPendingTableOrderUsed]);

  /* App reads this to decide whether leaving the POS needs the
   * «Tenés consumos sin guardar ni cobrar» confirmation. */
  useEffect(() => {
    onCartCountChange(sale.lines.length);
  }, [sale.lines.length, onCartCountChange]);

  useEffect(() => {
    const dialog = pickerDialog.current;
    if (!dialog) return;
    if (pickerOpen && !dialog.open) dialog.showModal();
    else if (!pickerOpen && dialog.open) dialog.close();
  }, [pickerOpen]);

  /* ── Batch B: quick annul + keyboard shortcuts ─────────────────────
     All hooks live here, BEFORE the success/checkout early returns
     (Rules of Hooks — a hook after an early return crashes on toggle). */
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  /* ── roles-admin 5.6 · afforance matrix (design D6, mirrors Tickets) ──
   * void → Dueño tier OR member while `require_annul_code` is ON; `null`
   * (unverified) → hidden. Never a disabled button pretending to exist. */
  const canVoid = isDueñoHint(role) || (role === "member" && settings.require_annul_code);
  const [voidTarget, setVoidTarget] = useState<{
    id: string;
    ticket_no: number;
  } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidBusy, setVoidBusy] = useState(false);
  const [voidErr, setVoidErr] = useState<string | null>(null);
  /* Code field: shown while the cached toggle is ON; `voidCodeForced` is
   * the staleness fallback (server said `annul_code_required` while the
   * cache said OFF → reveal + focus instead of a dead end). */
  const [voidCode, setVoidCode] = useState("");
  const [voidCodeForced, setVoidCodeForced] = useState(false);
  const voidCodeRef = useRef<HTMLInputElement>(null);
  const codeRequired = settings.require_annul_code || voidCodeForced;
  const voidDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (voidCodeForced) voidCodeRef.current?.focus();
  }, [voidCodeForced]);

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
    setCatalogLoading(true);
    Promise.all([listSaleItems(db, tenantId), listCategories(db, tenantId)])
      .then(([rows, cats]) => {
        if (!alive) return;
        setItems(rows);
        setCategories(cats.filter((c) => c.active));
        setCatalogError(false);
      })
      .catch(() => {
        if (alive) setCatalogError(true);
      }).finally(() => { if (alive) setCatalogLoading(false); });
    return () => {
      alive = false;
    };
  }, [db, tenantId, view, lastSale, refreshToken, catalogRetry]);

  /* Keyboard shortcuts for peak hours:
     F1 = efectivo exacto · F2 = transferencia · Enter = ir al cobro /
     cobrar dentro del modal. Deliberately re-attached every render (no
     deps array) so the closure always sees the fresh state. Skips:
     buttons (native activation wins — never double-charge), other
     inputs, and any dialog that is not the payment modal (void/receipt
     own the keyboard while open). No F3 — Fiado is pointer/tap only. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || document.querySelector("dialog[open]:not([data-testid='payment-modal']), [role='dialog']:not([data-testid='payment-modal'])")) return;
      if (e.key === "F1" || e.key === "F2") {
        e.preventDefault();
        if (sale.lines.length === 0 && !activeTableId) return;
        const cash = e.key === "F1";
        /* Same preparation as the pointer path: a mesa must be persisted and
         * reloaded BEFORE the modal opens, so F1 never charges a stale total. */
        void prepareCheckout().then((total) => {
          if (total === null) return;
          setPayMethod(cash ? "cash" : "transfer");
          if (cash) setTendered(String(total));
          setError(null);
          setPayOpen(true);
          requestAnimationFrame(() => {
            document
              .querySelector<HTMLButtonElement>(
                cash
                  ? '[data-testid="checkout-confirm"]'
                  : '[data-testid="checkout-transfer"]',
              )
              ?.focus();
          });
        });
        return;
      }
      if (e.key !== "Enter") return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      if (tag === "BUTTON" || tag === "A" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (t.isContentEditable) return;
      if (view === "success") return;
      const paymentOpen = !!document.querySelector(
        '[data-testid="payment-modal"][open]',
      );
      const otherDialog = document.querySelector(
        "dialog[open]:not([data-testid='payment-modal'])",
      );
      if (otherDialog) return;
      const inTendered = t.getAttribute("data-testid") === "tendered";
      if (tag === "INPUT" && !inTendered) return;
      e.preventDefault();
      if (!paymentOpen) {
        /* Enter from the browse grid = open the shared cobro modal. */
        if (sale.lines.length === 0 && !activeTableId) return;
        openCheckout();
        return;
      }
      /* Inside the modal: Enter commits the active cash/transfer method.
         Fiado stays pointer-only (credit-sales spec: no keyboard shortcut
         for the third method) — its confirm button is the only path. */
      if (payMethod === "cash") void confirmCash();
      else if (payMethod === "transfer") void confirmTransfer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const q = search.trim().toLowerCase();
  /* Category AND search (prototype filterPOSProducts) — «Todos» resets
   * the category only, keeping the search text (modernization spec). */
  const filteredItems = items.filter((it) => {
    if (selectedCategory && it.category_id !== selectedCategory) return false;
    if (!q) return true;
    return (
      it.product_name.toLowerCase().includes(q) ||
      it.name.toLowerCase().includes(q) ||
      it.code?.toLowerCase().includes(q)
    );
  });

  /* countsumqty (tasks 12.1): badge counts UNITS, not distinct lines. */
  const cartUnits = sale.lines.reduce((acc, l) => acc + l.qty, 0);

  /* Prototype POS: ONE search field doubles as the scan surface —
   * Enter with an EXACT SKU/barcode adds a unit (hardware scanners type
   * the code into whatever is focused); any other query on Enter must
   * NEVER add or sell (variant-code: "Enter in a normal search input
   * must neither add nor sell"). Code-looking misses report honestly. */
  function submitSearch() {
    const code = search.trim();
    if (!code) return;
    const item = items.find((candidate) => candidate.code === code);
    if (!item) {
      if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(code)) {
        setScanMessage(
          `Código no encontrado: ${code}. No se agregó ningún producto.`,
        );
      }
      return;
    }
    sale.addItem(item);
    setError(null);
    setSearch("");
    setScanMessage(`Agregado: ${item.product_name} ${item.name}, una unidad.`);
  }

  const chips = categories.length > 0 && (
    <div className="pos-chips" role="group" aria-label="Categorías">
      <button
        type="button"
        className={`pos-chip${selectedCategory === null ? " active" : ""}`}
        data-testid="category-chip-all"
        aria-pressed={selectedCategory === null}
        onClick={() => setSelectedCategory(null)}
      >
        Todos
      </button>
      {categories.map((c) => (
        <button
          key={c.id}
          type="button"
          className={`pos-chip${selectedCategory === c.id ? " active" : ""}`}
          data-testid="category-chip"
          aria-pressed={selectedCategory === c.id}
          onClick={() => setSelectedCategory(c.id)}
        >
          {c.name}
        </button>
      ))}
    </div>
  );

  const searchRow = (
    <div className="sale-toolbar pos-toolbar">
      <div className="pos-search-wrap">
        <Search size={16} aria-hidden="true" />
        <input
          className="search-input"
          data-testid="sale-search"
          type="search"
          placeholder="Buscar por Nombre, SKU o Código…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submitSearch();
          }}
          aria-label="Buscar producto o escanear código"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="go"
        />
      </div>
      {chips}
    </div>
  );

  const scanStatus = scanMessage ? (
    <p className="scan-status" role="status" aria-live="polite" data-testid="scan-message">
      {scanMessage}
    </p>
  ) : null;

  /* ── Mesas context row + quick table picker (shared by both layouts) ── */
  const showTableContext = Boolean(activeTableId || sale.lines.length > 0);

  const tableContext = showTableContext ? (
    <div className="table-context" data-testid="table-context">
      <span
        className={`table-context-banner${activeTableId ? " attending" : ""}`}
        data-testid="table-context-name"
      >
        <Utensils size={16} aria-hidden="true" />
        {activeTableId ? `Atendiendo: ${activeTableName ?? "…"}` : "Venta de mostrador"}
      </span>
      <button
        type="button"
        className="btn primary"
        data-testid="save-to-table"
        disabled={sale.lines.length === 0}
        onClick={() => void handleSaveToTable()}
      >
        <Save size={16} aria-hidden="true" />
        Guardar en Mesa
      </button>
    </div>
  ) : null;

  const tablePicker = (
    <dialog
      ref={pickerDialog}
      className="client-modal table-picker"
      data-testid="table-picker"
      aria-labelledby="table-picker-title"
      onCancel={() => {
        if (!pickerLoading) setPickerOpen(false);
      }}
    >
      {pickerOpen && (
        <>
          <div className="modal-head">
            <h3 id="table-picker-title">Elegir mesa para guardar</h3>
            <button
              type="button"
              className="modal-x"
              data-testid="table-picker-close"
              aria-label="Cerrar"
              onClick={() => setPickerOpen(false)}
            >
              ✕
            </button>
          </div>
          <p className="muted">
            Vinculás el consumo actual con una mesa libre y se guarda al instante.
          </p>
          {pickerLoading ? (
            <p role="status">Cargando mesas…</p>
          ) : pickerTables.length === 0 ? (
            <p className="muted" data-testid="table-picker-empty">
              No hay mesas disponibles ahora.
            </p>
          ) : (
            <ul className="table-picker-list">
              {pickerTables.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    data-testid="table-picker-item"
                    data-table-id={t.id}
                    onClick={() => void pickTable(t)}
                  >
                    <span>{t.name}</span>
                    <span className="table-picker-zone">
                      {t.zone ?? "Sin zona"} · {t.capacity} pers.
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="btn ghost"
              data-testid="table-picker-cancel"
              onClick={() => setPickerOpen(false)}
            >
              Cancelar
            </button>
          </div>
        </>
      )}
    </dialog>
  );

  const grid = catalogError ? (
    <div role="alert" data-testid="sale-catalog-error"><p>No se pudo consultar el catálogo. Tus cambios siguen guardados.</p><button className="btn" onClick={() => setCatalogRetry(n => n + 1)}>Reintentar catálogo</button></div>
  ) : catalogLoading && items.length === 0 ? <p role="status">Consultando catálogo…</p> : items.length === 0 ? (
    <div className="empty-state" data-testid="empty-catalog">
      <h2>Sin productos</h2>
      <p className="muted">
        Cargá el catálogo en la pestaña Catálogo para empezar a vender.
      </p>
    </div>
  ) : filteredItems.length === 0 ? (
    <div className="empty-state" data-testid="empty-sale-search">
      <p className="muted">
        {q && selectedCategory
          ? "No se encontraron productos en esta categoría."
          : "Ningún producto coincide con la búsqueda."}
      </p>
    </div>
  ) : (
    <div className="sale-grid" data-testid="sale-grid">
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
          <span className="tile-top">
            {item.photo ? (
              <img className="tile-photo" src={item.photo} alt="" />
            ) : (
              <span className="tile-icon" aria-hidden>
                <ProductIcon iconKey={item.icon_key} size={18} />
              </span>
            )}
            <span
              className={`tile-stock${item.stock <= LOW_STOCK_BADGE ? " low" : ""}`}
            >
              Stock: {item.stock}
            </span>
          </span>
          <span className="tile-product">{item.product_name}</span>
          <span className="tile-variant">{item.name}</span>
          {item.code && <span className="tile-sku">{item.code}</span>}
          <span className="tile-foot">
            <span className="tile-price">{cop(item.price)}</span>
            <span className="tile-add" aria-hidden>
              +
            </span>
          </span>
        </button>
      ))}
    </div>
  );

  /* ── Mesas · guardar / retomar / preparar el cobro ───────────────── */

  function cartAsOrderLines() {
    return sale.lines.map((l) => ({
      variant_id: l.variantId,
      name: l.label,
      price: l.price,
      qty: l.qty,
    }));
  }

  /**
   * «Guardar en Mesa» (Flujo B): the cart REPLACES the comanda's live
   * lines (insert / update / soft-delete — never a hard delete) and the
   * table flips to `occupied`. Stock is untouched: it debits at cobro.
   * `silent` = the implicit save before a cobro (the cart is about to be
   * replaced by the full comanda, so clearing it would flash empty).
   */
  async function saveToTable(opts: { silent?: boolean } = {}): Promise<boolean> {
    if (!activeTableId) return false;
    if (sale.lines.length === 0) {
      setError("El carrito está vacío — tocá un producto primero");
      return false;
    }
    try {
      await saveOrderToTable(db, tenantId, activeTableId, cartAsOrderLines());
      if (!opts.silent) {
        sale.clear();
        setError(null);
        showToast("Consumo guardado en la mesa");
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo guardar en la mesa";
      setError(message);
      if (!opts.silent) showToast(message);
      return false;
    }
  }

  /** Quick picker: cart has items but no table bound yet (Flujo B). */
  async function openTablePicker() {
    if (sale.lines.length === 0) {
      setError("El carrito está vacío — tocá un producto primero");
      return;
    }
    setPickerLoading(true);
    try {
      const rows = await listTables(db, tenantId, { activeOnly: true });
      setPickerTables(rows.filter((t) => t.status === "available"));
      setPickerOpen(true);
    } catch {
      setError("No se pudieron cargar las mesas");
    } finally {
      setPickerLoading(false);
    }
  }

  async function pickTable(table: LocalTable) {
    if (sale.lines.length === 0) {
      setPickerOpen(false);
      return;
    }
    try {
      /* Save FIRST with the picked id — `activeTableId` only lands on the
       * next render, so `saveToTable` (which reads the prop) cannot be used
       * here without a stale-id race. */
      await saveOrderToTable(db, tenantId, table.id, cartAsOrderLines());
      onActiveTableChange(table.id);
      sale.clear();
      setError(null);
      setPickerOpen(false);
      showToast(`Consumo guardado en ${table.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar en la mesa");
    }
  }

  async function handleSaveToTable() {
    if (!activeTableId) {
      await openTablePicker();
      return;
    }
    await saveToTable();
  }

  /**
   * One preparation step shared by every cobro entry point (button, Enter,
   * F1/F2). Returns the TOTAL to charge, or null when the modal must not
   * open. For a mesa it persists the cart first and then reloads the FULL
   * comanda, so the ticket can never miss previously saved lines.
   *
   * FASE 2 · doble defensa (a) — FRESCURA before the payment modal: while
   * online, `GET /api/orders/open` must still know this comanda as OPEN.
   * A tombstone (closed elsewhere) or a DIFFERENT open comanda on the same
   * table means another device settled/took the mesa → block with a clear
   * message, re-pull so the board is honest, and never open the modal. The
   * milliseconds between this check and the actual commit are the residual
   * race window — covered server-side by the `tickets.order_id` unique
   * backstop (b). Offline (or unreachable) → no check, offline-first wins.
   */
  async function prepareCheckout(): Promise<number | null> {
    if (activeTableId) {
      if (sale.lines.length > 0) {
        const saved = await saveToTable({ silent: true });
        if (!saved) return null;
      }
      const resumed = await loadTableOrder(db, tenantId, activeTableId);
      if (!resumed || resumed.lines.length === 0) {
        setError("La mesa no tiene consumo guardado");
        return null;
      }
      if (typeof navigator === "undefined" || navigator.onLine !== false) {
        const fresh = await fetchOpenOrders(tenantId);
        if (fresh) {
          const settled = (fresh.closed_orders ?? []).some((c) => c.id === resumed.orderId);
          const forked = (fresh.orders ?? []).some(
            (o) => String(o.table_id) === activeTableId && String(o.id) !== resumed.orderId,
          );
          if (settled || forked) {
            try {
              await pullOpenOrders(db, tenantId);
            } catch {
              /* best-effort: the message + board refresh still stand */
            }
            const message = settled
              ? "Esta mesa se cobró en otro dispositivo — el tablero se actualizó"
              : "Esta mesa se está atendiendo en otro dispositivo — el tablero se actualizó";
            setError(message);
            showToast(message);
            onStaleOrder?.();
            return null;
          }
        }
      }
      sale.loadLines(resumed.lines);
      return resumed.lines.reduce((acc, l) => acc + l.price * l.qty, 0);
    }
    if (sale.lines.length === 0) {
      setError("El carrito está vacío — tocá un producto primero");
      return null;
    }
    return sale.total;
  }

  function openCheckout() {
    // tap 2 — empty cart must be blocked WITH a message (sales spec);
    // a mesa with a saved comanda is chargeable from an empty cart.
    void prepareCheckout().then((total) => {
      if (total === null) return;
      setError(null);
      setPayMethod("cash");
      setTendered("");
      setPayOpen(true);
    });
  }

  /* Method switch invalidates the previous method's validation error:
   * a cash tendered error must not stay visible under Fiado/Transferencia. */
  function changePayMethod(next: PayMethod) {
    setPayMethod(next);
    setError(null);
  }

  function clearOrder() {
    sale.clear();
    setError(null);
    setPayOpen(false);
  }

  function ensureCart(): boolean {
    if (sale.lines.length === 0) {
      setError("El carrito está vacío — tocá un producto primero");
      return false;
    }
    setError(null);
    return true;
  }

  /* One post-commit hand-off: close the modal, persist the receipt view
   * and open the thermal preview ONLY after the local tx succeeded.
   * Mesas (Flujo C): the order was closed + the table freed INSIDE the
   * commit (commitTableSale) — here we only drop the attending context. */
  async function afterCommit(committed: Awaited<ReturnType<typeof sale.commit>>) {
    const cashPay = committed.payments.find((p) => p.method === "cash");
    const creditPay = committed.payments.find((p) => p.method === "credit");
    const transferPay = committed.payments.find((p) => p.method === "transfer");
    setLastSale({
      id: committed.ticket.id,
      ticketNo: committed.ticket.ticket_no,
      total: committed.ticket.total,
      vuelto: cashPay?.vuelto ?? null,
      method: committed.payments.map((p) => p.method).join(","),
      status: transferPay?.status ?? cashPay?.status ?? creditPay?.status ?? "confirmed",
      credit: creditPay?.amount ?? null,
      tableName: committed.ticket.table_name,
    });
    if (activeTableId) onActiveTableChange(null);
    const detail = await getLocalTicket(db, tenantId, committed.ticket.id);
    setReceipt(detail ? { kind: "sale", detail, tenantName } : null);
    setPayOpen(false);
    setView("success");
    setTendered("");
    showToast("Venta registrada (pendiente de sync)");
    onCommitted();
  }

  function mapCommitError(err: unknown): string {
    const code = err instanceof Error ? err.message : String(err);
    if (code === "EMPTY_CART") return "El carrito está vacío";
    if (code === "UNDERPAYMENT") return "El efectivo recibido es menor al total";
    if (code === "CREDIT_CUSTOMER_REQUIRED")
      return "Seleccioná un cliente para vender a crédito";
    if (code === "CREDIT_LIMIT_REQUIRED")
      return "Configurá el límite de crédito del cliente";
    if (code === "CREDIT_LIMIT_EXCEEDED")
      return "El cliente excede su límite de crédito";
    if (code === "MIXED_AMOUNT_INVALID")
      return "El efectivo ahora debe ser menor al total";
    if (code === "NEGATIVE_STOCK")
      return "Stock insuficiente: el comercio no permite ventas con stock negativo";
    if (code === "ORDER_NOT_OPEN")
      return "La comanda ya no está abierta — volvé al tablero de mesas";
    if (code === "TABLE_NOT_FOUND" || code === "TABLE_INACTIVE")
      return "La mesa ya no está disponible";
    return "No se pudo registrar la venta";
  }

  /* Mesas: the cobro settles the comanda — the ticket carries the table's
   * name and the order closes right after it lands (commitTableSale). */
  const commitTable = activeTableId
    ? { id: activeTableId, ...(activeTableName ? { name: activeTableName } : {}) }
    : undefined;

  async function confirmCash() {
    if (busyRef.current) return;
    // Cashier must state what was received — no auto-filled total (UX fix).
    if (!ensureCart()) return;
    if (tendered === "" || tendered === "0") {
      setError("Ingresá el efectivo recibido o tocá Exacto");
      return;
    }
    if (!/^\d+$/.test(tendered) || Number(tendered) > 2147483647) {
      setError("El efectivo recibido debe ser un entero COP entre 0 y 2.147.483.647");
      return;
    }
    const amount = Number(tendered);
    if (amount === 0) {
      setError("Ingresá el efectivo recibido o tocá Exacto");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const committed = await sale.commit(db, tenantId, { method: "cash", tendered: amount }, commitTable);
      await afterCommit(committed);
    } catch (err) {
      setError(mapCommitError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function confirmTransfer() {
    if (busyRef.current) return;
    if (!ensureCart()) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const committed = await sale.commit(db, tenantId, { method: "transfer" }, commitTable);
      await afterCommit(committed);
    } catch (err) {
      setError(mapCommitError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function confirmCredit(customerId: string, cashAmount: number) {
    if (busyRef.current) return;
    if (!ensureCart()) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const committed = await sale.commit(
        db,
        tenantId,
        { method: "credit", customerId, cashAmount },
        commitTable,
      );
      await afterCommit(committed);
    } catch (err) {
      setError(mapCommitError(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /* ── Quick annul (Batch B): same auditable core as Tickets ──────── */
  async function openVoid(t: { id: string; ticket_no: number }) {
    if (!canVoid) return;
    if (await ticketHasAbonos(db, tenantId, t.id)) {
      showToast("No se puede anular: este cliente tiene abonos registrados.");
      return;
    }
    setVoidTarget(t);
    setVoidReason("");
    setVoidErr(null);
    /* Fresh dialog = fresh code state (never remembered across attempts). */
    setVoidCode("");
    setVoidCodeForced(false);
    voidDialog.current?.showModal();
  }

  async function annulQuick() {
    if (!voidTarget) return;
    setVoidBusy(true);
    setVoidErr(null);
    try {
      await annulTicket(
        db,
        tenantId,
        voidTarget.id,
        voidReason.trim(),
        codeRequired ? voidCode.trim() : undefined,
      );
      voidDialog.current?.close();
      showToast("Venta anulada · stock restituido. Registrá por fuera de NEXORA cualquier reintegro de dinero.");
      setLastSale(null);
      setReceipt(null);
      setView("browse");
      onCommitted();
    } catch (err) {
      /* Staleness fallback (D3/R4): cache said OFF, server demands the code
       * → reveal + focus the field so the operator can comply. */
      if (err instanceof AnnulError && err.kind === "code_required") {
        setVoidCodeForced(true);
        setVoidCode("");
      }
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
      onClose={() => {
        /* Code never survives the dialog (state-only, D3/H4). */
        setVoidCode("");
        setVoidCodeForced(false);
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
        {codeRequired && (
          <div>
            <label htmlFor="void-quick-code">Código de anulación</label>
            <input
              id="void-quick-code"
              ref={voidCodeRef}
              data-testid="void-quick-code"
              className="mono"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="Código de 8 caracteres"
              maxLength={64}
              value={voidCode}
              onChange={(e) => setVoidCode(e.target.value)}
              disabled={voidBusy}
            />
          </div>
        )}
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
            disabled={
              voidBusy ||
              !online ||
              voidReason.trim().length < 3 ||
              (codeRequired && voidCode.trim().length === 0)
            }
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
          {lastSale.tableName && (
            <div className="row space-between">
              <span>Mesa</span>
              <strong data-testid="ticket-table">{lastSale.tableName}</strong>
            </div>
          )}
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
          {lastSale.credit !== null && (
            <div className="row space-between">
              <span>Crédito</span>
              <strong data-testid="ticket-credit">{cop(lastSale.credit)}</strong>
            </div>
          )}
          <div className="row space-between">
            <span>Método</span>
            <strong data-testid="ticket-method">
              {paymentMethodLabel(lastSale.method)}
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
              setReceipt(null);
              setTendered("");
              setPayMethod("cash");
              setView("browse");
            }}
          >
            Nueva venta
          </button>
          <button
            className="btn"
            data-testid="view-receipt"
            onClick={() => {
              if (receipt) return;
              void getLocalTicket(db, tenantId, lastSale.id).then((detail) =>
                setReceipt(detail ? { kind: "sale", detail, tenantName } : null),
              );
            }}
          >
            Ver comprobante
          </button>
          <button
            className="btn"
            data-testid="print-sale"
            onClick={() => window.print()}
          >
            Imprimir
          </button>
          {/* roles-admin 5.6: the affordance renders ONLY when the matrix
           * allows it (Dueño tier, or member with the annul-code toggle ON);
           * `null`/member-with-toggle-off → hidden, not a dead disabled
           * button. Copy is tier+code-aware. */}
          {canVoid && (
            <button
              className="btn ghost void-trigger"
              data-testid="void-last-sale"
              disabled={!online || voidBusy}
              title={
                !online
                  ? "Se necesita conexión"
                  : settings.require_annul_code
                    ? "Requiere el código de anulación vigente"
                    : "Solo el dueño o un administrador puede anular"
              }
              onClick={() => openVoid({ id: lastSale.id, ticket_no: lastSale.ticketNo })}
            >
              Anular esta venta
            </button>
          )}
        </div>
        {voidDialogEl}
        <ReceiptPreview
          open={receipt !== null}
          data={receipt}
          identity={pickReceiptIdentity(settings)}
          onClose={() => setReceipt(null)}
        />
      </div>
    );
  }

  /* ── Desktop ≥1024: two-panel — products | Orden Actual ──────────── */
  if (isWide) {
    return (
      <div className="screen sale sale-layout" data-testid="sale-screen">
        <div className="sale-products">
          {tableContext}
          {searchRow}
          {scanStatus}
          {grid}
        </div>

        <aside className="sale-order card" data-testid="order-panel">
          <div className="order-head">
            <ShoppingCart size={16} aria-hidden="true" className="order-head-icon" />
            <h3>Orden Actual</h3>
            <span className="cart-count-pill" data-testid="cart-count">
              {cartUnits} ítems
            </span>
            <button
              type="button"
              className="cart-clear"
              data-testid="cart-clear"
              onClick={() => {
                sale.clear();
                setError(null);
              }}
            >
              <Trash2 size={14} aria-hidden="true" />
              Limpiar
            </button>
          </div>

          {sale.lines.length === 0 ? (
            <div className="order-empty">
              <ShoppingBasket size={40} aria-hidden="true" />
              <p className="order-empty-title">El carrito está vacío</p>
              <p className="muted">Haz clic en los productos para agregarlos</p>
            </div>
          ) : (
            <ul className="order-lines">
              {sale.lines.map((l) => (
                <li key={l.variantId} className="order-line" data-testid="order-line">
                  <div className="order-line-info">
                    <span className="order-line-label">{l.label}</span>
                    <span className="order-line-unit">{cop(l.price)} c/u</span>
                  </div>
                  <div
                    className="order-line-qty"
                    role="group"
                    aria-label={`Cantidad de ${l.label}`}
                  >
                    <button
                      type="button"
                      className="btn small qty-btn"
                      aria-label={`Restar una unidad de ${l.label}`}
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
                      aria-label={`Agregar una unidad de ${l.label}`}
                      onClick={() => sale.setQty(l.variantId, l.qty + 1)}
                    >
                      +
                    </button>
                  </div>
                  <strong className="order-line-total">
                    {cop(l.price * l.qty)}
                  </strong>
                  <button
                    type="button"
                    className="order-line-remove"
                    aria-label={`Eliminar ${l.label} de la orden`}
                    onClick={() => sale.setQty(l.variantId, 0)}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* IVA DEFERRED (B1): subtotal == total, no fiscal row. */}
          <div className="row space-between order-sub">
            <span>Subtotal</span>
            <strong>{cop(sale.total)}</strong>
          </div>
          <div className="row space-between order-total" data-testid="cart-total">
            <span>Total a Pagar</span>
            <strong className="order-total-value">{cop(sale.total)}</strong>
          </div>

          <button
            className="btn primary big pay-cta"
            data-testid="checkout-open"
            disabled={sale.lines.length === 0 && !activeTableId}
            onClick={openCheckout}
          >
            <CircleDollarSign size={18} aria-hidden="true" />
            Procesar Cobro
          </button>

          {error && !payOpen && (
            <p className="error" data-testid="cart-error" role="alert">
              {error}
            </p>
          )}
        </aside>
        <PaymentModal
          open={payOpen}
          settings={settings}
          db={db}
          tenantId={tenantId}
          total={sale.total}
          lines={sale.lines.map((l) => ({
            label: l.label,
            qty: l.qty,
            price: l.price,
          }))}
          oversell={oversell}
          method={payMethod}
          onMethodChange={changePayMethod}
          tendered={tendered}
          onTenderedChange={setTendered}
          error={error}
          busy={busy}
          onClose={() => {
            setPayOpen(false);
            setError(null);
          }}
          onClearOrder={clearOrder}
          onConfirmCash={() => void confirmCash()}
          onConfirmTransfer={() => void confirmTransfer()}
          onConfirmCredit={(customerId, cashAmount) =>
            void confirmCredit(customerId, cashAmount)
          }
        />
        {tablePicker}
      </div>
    );
  }

  /* ── Mobile browse: product grid + bottom cart bar ───────────────── */
  return (
    <div className="screen sale">
      {tableContext}
      {searchRow}
      {scanStatus}
      {grid}

      {error && !payOpen && (
        <p className="error floating" data-testid="cart-error" role="alert">
          {error}
        </p>
      )}

      <div className="cart-bar" data-testid="cart-bar">
        <span data-testid="cart-count">{cartUnits} ítems</span>
        <strong data-testid="cart-total">{cop(sale.total)}</strong>
        <button
          className="btn primary"
          data-testid="checkout-open"
          onClick={openCheckout}
        >
          Cobrar
        </button>
      </div>
      <PaymentModal
        open={payOpen}
        settings={settings}
        db={db}
        tenantId={tenantId}
        total={sale.total}
        lines={sale.lines.map((l) => ({
          label: l.label,
          qty: l.qty,
          price: l.price,
        }))}
        oversell={oversell}
        method={payMethod}
        onMethodChange={changePayMethod}
        tendered={tendered}
        onTenderedChange={setTendered}
        error={error}
        busy={busy}
        onClose={() => {
          setPayOpen(false);
          setError(null);
        }}
        onClearOrder={clearOrder}
        onConfirmCash={() => void confirmCash()}
        onConfirmTransfer={() => void confirmTransfer()}
        onConfirmCredit={(customerId, cashAmount) =>
          void confirmCredit(customerId, cashAmount)
        }
      />
      {tablePicker}
    </div>
  );
}
