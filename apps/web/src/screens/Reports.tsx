import { useCallback, useEffect, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import {
  defaultReportRange,
  type LowStockRow,
  type SalesByDayRow,
  type TopProductRow,
} from "@pos/shared";
import {
  localLowStock,
  localSalesByDay,
  localTopProducts,
} from "../db/local-reports";
import { useSync } from "../hooks/useSync";
import { downloadCsv } from "../lib/csv";

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

type Props = {
  db: PGlite;
  tenantId: string;
  refreshToken: number;
};

type View = "sales" | "top" | "low";

/**
 * Reports screen (tasks D3-4 + D3-5, reports spec).
 *
 * Runs the SHARED report SQL against the local cache (identical WASM
 * Postgres) so it works offline; while the sync queue has pending rows a
 * visible "may be incomplete" banner is shown and clears by itself when
 * the queue drains (spec §Offline report behavior).
 */
export function Reports({ db, tenantId, refreshToken }: Props) {
  const sync = useSync();
  const [view, setView] = useState<View>("sales");
  const [range, setRange] = useState(() => defaultReportRange());
  const [sales, setSales] = useState<SalesByDayRow[]>([]);
  const [top, setTop] = useState<TopProductRow[]>([]);
  const [low, setLow] = useState<LowStockRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, t, l] = await Promise.all([
        localSalesByDay(db, tenantId, range),
        localTopProducts(db, tenantId, range),
        localLowStock(db, tenantId),
      ]);
      setSales(s);
      setTop(t);
      setLow(l);
      setError(null);
    } catch {
      setError("No se pudieron calcular los reportes");
    }
  }, [db, tenantId, range]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const stale = sync.pending > 0;
  const totalRevenue = sales.reduce((acc, r) => acc + r.revenue, 0);
  const totalPending = sales.reduce((acc, r) => acc + r.pending, 0);

  function exportCsv() {
    if (view === "sales") {
      downloadCsv(
        `nexora-ventas-${range.from}_${range.to}.csv`,
        ["día", "tickets", "ingresos", "pendiente", "efectivo", "transferencia"],
        sales.map((r) => [r.day, r.tickets, r.revenue, r.pending, r.cash, r.transfer]),
      );
    } else if (view === "top") {
      downloadCsv(
        `nexora-top-${range.from}_${range.to}.csv`,
        ["producto", "variante", "cantidad", "ingresos"],
        top.map((r) => [r.product_name, r.variant_name, r.qty, r.revenue]),
      );
    } else {
      downloadCsv(
        "nexora-stock-bajo.csv",
        ["producto", "variante", "stock", "mínimo"],
        low.map((r) => [r.product_name, r.variant_name, r.stock, r.threshold]),
      );
    }
  }

  return (
    <div className="screen reports">
      <div className="row space-between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Reportes</h2>
        <button
          className="btn small"
          data-testid="export-csv"
          onClick={exportCsv}
          disabled={view === "sales" ? sales.length === 0 : view === "top" ? top.length === 0 : low.length === 0}
        >
          Exportar CSV
        </button>
      </div>

      <p className="muted">Ventas y productos excluyen tickets anulados; stock incluye su restitución.</p>
      {stale && (
        <div className="warn-banner" data-testid="reports-staleness" role="status">
          Los datos pueden estar incompletos — sincronizá para ver el estado
          {sync.lastSync
            ? ` (última sync ${new Date(sync.lastSync).toLocaleTimeString("es-CO", {
                hour: "2-digit",
                minute: "2-digit",
              })})`
            : ""}.
        </div>
      )}

      <div className="range-row">
        <label htmlFor="rep-from">Desde</label>
        <input
          id="rep-from"
          data-testid="report-from"
          type="date"
          value={range.from}
          onChange={(e) =>
            setRange((r) => ({ ...r, from: e.target.value || r.from }))
          }
        />
        <label htmlFor="rep-to">Hasta</label>
        <input
          id="rep-to"
          data-testid="report-to"
          type="date"
          value={range.to}
          onChange={(e) => setRange((r) => ({ ...r, to: e.target.value || r.to }))}
        />
      </div>

      <div className="seg" role="tablist">
        <button
          className={view === "sales" ? "active" : ""}
          data-testid="tab-report-sales"
          onClick={() => setView("sales")}
        >
          Ventas
        </button>
        <button
          className={view === "top" ? "active" : ""}
          data-testid="tab-report-top"
          onClick={() => setView("top")}
        >
          Top
        </button>
        <button
          className={view === "low" ? "active" : ""}
          data-testid="tab-report-low"
          onClick={() => setView("low")}
        >
          Stock bajo
        </button>
      </div>

      {error && (
        <p className="error" data-testid="reports-error" role="alert">
          {error}
        </p>
      )}

      {view === "sales" && (
        <div className="card" data-testid="report-sales">
          <div className="row space-between">
            <span className="muted">Ingresos confirmados</span>
            <strong data-testid="sales-total">{cop(totalRevenue)}</strong>
          </div>
          {totalPending > 0 && (
            <div className="row space-between">
              <span className="muted">Pendientes (no son ingresos)</span>
              <strong data-testid="sales-pending-total">{cop(totalPending)}</strong>
            </div>
          )}
          {sales.length === 0 ? (
            <div className="empty-state" data-testid="empty-sales">
              <p>Sin ventas en este período.</p>
            </div>
          ) : (
            sales.map((r) => (
              <div className="report-row" key={r.day} data-testid="sales-day">
                <div className="row space-between">
                  <strong>{r.day}</strong>
                  <strong>{cop(r.revenue)}</strong>
                </div>
                <div className="row space-between muted">
                  <span>{r.tickets} tickets</span>
                  <span>
                    {cop(r.cash)} efectivo
                    {r.transfer > 0 ? ` · ${cop(r.transfer)} transf.` : ""}
                    {r.pending > 0 ? ` · ${cop(r.pending)} pendiente` : ""}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {view === "top" && (
        <div className="card" data-testid="report-top">
          {top.length === 0 ? (
            <div className="empty-state" data-testid="empty-top">
              <p>Sin ventas en este período.</p>
            </div>
          ) : (
            top.map((r, i) => (
              <div className="report-row" key={r.variant_id} data-testid="top-row">
                <div className="row space-between">
                  <strong>
                    {i + 1}. {r.product_name} · {r.variant_name}
                  </strong>
                  <strong>{cop(r.revenue)}</strong>
                </div>
                <div className="row space-between muted">
                  <span>{r.qty} unidades</span>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {view === "low" && (
        <div className="card" data-testid="report-low">
          {low.length === 0 ? (
            <div className="empty-state" data-testid="empty-low">
              <p>Ningún producto está por debajo del mínimo.</p>
            </div>
          ) : (
            low.map((r) => (
              <div className="report-row" key={r.variant_id} data-testid="low-row">
                <div className="row space-between">
                  <strong>
                    {r.product_name} · {r.variant_name}
                  </strong>
                  <strong className={r.stock < 0 ? "error" : ""}>
                    {r.stock} / mín {r.threshold}
                  </strong>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
