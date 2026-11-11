import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { PGlite } from "@electric-sql/pglite";
import { listSaleItems, type SaleItem } from "../db/local";

/**
 * Command palette (Batch C) — Ctrl/Cmd+K or "/" from anywhere:
 * jump sections, add a product to the cart, or open a ticket without
 * touching the mouse. Keyboard-first: NO open/close animation (this is a
 * hundreds-of-times-a-day action — animation would only add latency).
 */

type PaletteTab = "sale" | "arqueo" | "tickets" | "catalog" | "dashboard" | "reports";

type Props = {
  db: PGlite;
  tenantId: string;
  onClose: () => void;
  onNavigate: (tab: PaletteTab) => void;
  onPickProduct: (item: SaleItem) => void;
  onPickTicket: (ticket: { id: string; ticket_no: number }) => void;
};

type TicketRow = {
  id: string;
  ticket_no: number;
  total: number;
  method: string | null;
  status: string;
};

type Entry = {
  key: string;
  group: string;
  primary: string;
  secondary?: string;
  run: () => void;
};

const NAV: Array<{ tab: PaletteTab; label: string }> = [
  { tab: "sale", label: "Venta" },
  { tab: "arqueo", label: "Caja" },
  { tab: "tickets", label: "Tickets" },
  { tab: "catalog", label: "Catálogo" },
  { tab: "dashboard", label: "Panel" },
  { tab: "reports", label: "Reportes" },
];

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

export function CommandPalette({
  db,
  tenantId,
  onClose,
  onNavigate,
  onPickProduct,
  onPickTicket,
}: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [products, setProducts] = useState<SaleItem[]>([]);
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      listSaleItems(db, tenantId).catch(() => [] as SaleItem[]),
      db
        .query<TicketRow>(
          `SELECT t.id, t.ticket_no, t.total, t.status,
                  (SELECT p.method FROM payments p WHERE p.ticket_id = t.id LIMIT 1) AS method
           FROM tickets t
           WHERE t.tenant_id = $1
           ORDER BY t.ticket_no DESC
           LIMIT 30`,
          [tenantId],
        )
        .then((r) => r.rows)
        .catch(() => [] as TicketRow[]),
    ])
      .then(([items, tix]) => {
        if (!alive) return;
        setProducts(items);
        setTickets(tix);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [db, tenantId]);

  const q = query.trim().toLowerCase().replace(/^#/, "");

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const n of NAV) {
      if (!q || n.label.toLowerCase().includes(q)) {
        out.push({
          key: `nav:${n.tab}`,
          group: "Ir a",
          primary: n.label,
          run: () => {
            onNavigate(n.tab);
            onClose();
          },
        });
      }
    }
    if (q) {
      for (const p of products
        .filter(
          (p) =>
            p.product_name.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            (p.code ?? "").toLowerCase().includes(q),
        )
        .slice(0, 6)) {
        out.push({
          key: `prod:${p.id}`,
          group: "Productos",
          primary: `${p.product_name} · ${p.name}`,
          secondary: cop(p.price),
          run: () => {
            onPickProduct(p);
            onClose();
          },
        });
      }
      for (const t of tickets
        .filter(
          (t) =>
            String(t.ticket_no).includes(q) ||
            String(t.total).includes(q.replace(/[.\s]/g, "")),
        )
        .slice(0, 5)) {
        out.push({
          key: `tix:${t.id}`,
          group: "Tickets",
          primary: `#${t.ticket_no}`,
          secondary: `${cop(t.total)} · ${t.status === "voided" ? "anulada" : t.method === "transfer" ? "transferencia" : "efectivo"}`,
          run: () => {
            onPickTicket({ id: t.id, ticket_no: t.ticket_no });
            onClose();
          },
        });
      }
    } else {
      // no query → recent tickets as one-tap shortcuts
      for (const t of tickets.slice(0, 4)) {
        out.push({
          key: `tix:${t.id}`,
          group: "Tickets recientes",
          primary: `#${t.ticket_no}`,
          secondary: `${cop(t.total)} · ${t.status === "voided" ? "anulada" : t.method === "transfer" ? "transferencia" : "efectivo"}`,
          run: () => {
            onPickTicket({ id: t.id, ticket_no: t.ticket_no });
            onClose();
          },
        });
      }
    }
    return out;
  }, [q, products, tickets, onNavigate, onPickProduct, onPickTicket, onClose]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    itemRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, entries.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      entries[active]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }

  let lastGroup: string | null = null;

  return (
    <div
      className="palette-backdrop"
      data-testid="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Buscador rápido">
        <input
          ref={inputRef}
          className="palette-input"
          data-testid="palette-input"
          type="text"
          placeholder="Buscar producto, ticket o sección…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Buscador rápido"
          autoComplete="off"
        />
        <div className="palette-results" role="listbox" aria-label="Resultados">
          {entries.length === 0 && (
            <p className="palette-empty" data-testid="palette-empty">
              Sin resultados para “{query.trim()}”.
            </p>
          )}
          {entries.map((entry, i) => {
            const header = entry.group !== lastGroup ? entry.group : null;
            lastGroup = entry.group;
            return (
              <div key={entry.key}>
                {header && (
                  <div className="palette-group" role="presentation">
                    {header}
                  </div>
                )}
                <button
                  type="button"
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  className={`palette-item${i === active ? " active" : ""}`}
                  data-testid="palette-item"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={entry.run}
                >
                  <span>{entry.primary}</span>
                  {entry.secondary && (
                    <span className="muted">{entry.secondary}</span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot" aria-hidden>
          <span>
            <kbd className="kbd-chip">↑↓</kbd> navegar
          </span>
          <span>
            <kbd className="kbd-chip">↵</kbd> abrir
          </span>
          <span>
            <kbd className="kbd-chip">esc</kbd> cerrar
          </span>
        </div>
      </div>
    </div>
  );
}
