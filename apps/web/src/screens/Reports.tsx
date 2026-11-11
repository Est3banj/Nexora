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
import { downloadXlsx } from "../lib/excel";

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

/** Raw COP integer for spreadsheet cells (Excel formats poorly with $ strings). */
const num = (n: number) => n;

type Props = {
  db: PGlite;
  tenantId: string;
  refreshToken: number;
};

type View = "sales" | "top" | "low";

/**
 * Reports screen — accounting-style tables (headers + totals row),
 * real .xlsx export, offline-first over PGlite with staleness banner.
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
  const totalCash = sales.reduce((acc, r) => acc + r.cash, 0);
  const totalTransfer = sales.reduce((acc, r) => acc + r.transfer, 0);
  const totalQty = top.reduce((acc, r) => acc + r.qty, 0);

  function exportExcel() {
    if (view === "sales") {
      downloadXlsx(
        `nexora-ventas-${range.from}_${range.to}.xlsx`,
        "Ventas",
        ["Fecha", "Tickets", "Efectivo", "Transferencia", "Pendiente", "Ingresos"],
        sales.map((r) => [
          r.day,
          num(r.tickets),
          num(r.cash),
          num(r.transfer),
          num(r.pending),
          num(r.revenue),
        ]),
        [
          "TOTAL",
          sales.reduce((a, r) => a + r.tickets, 0),
          num(totalCash),
          num(totalTransfer),
          num(totalPending),
          num(totalRevenue),
        ],
      );
    } else if (view === "top") {
      downloadXlsx(
        `nexora-top-${range.from}_${range.to}.xlsx`,
        "Top productos",
        ["#", "Producto", "Variante", "Unidades", "Ingresos"],
        top.map((r, i) => [i + 1, r.product_name, r.variant_name, num(r.qty), num(r.revenue)]),
        ["", "TOTAL", "", num(totalQty), num(top.reduce((a, r) => a + r.revenue, 0))],
      );
    } else {
      downloadXlsx(
        "nexora-stock-bajo",
        "Stock bajo",
        ["Producto", "Variante", "Stock", "Mínimo"],
        low.map((r) => [r.product_name, r.variant_name, num(r.stock), num(r.threshold)]),
        ["", "TOTAL", low.reduce((a, r) => a + r.stock, 0), ""],
      );
    }
  }

  const hasData =
    view === "sales" ? sales.length > 0 : view === "top" ? top.length > 0 : low.length > 0;

  return (
    <div className="screen reports">
      <div className="row space-between" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Reportes</h2>
        <button
          className="btn small"
          data-testid="export-excel"
          onClick={exportExcel}
          disabled={!hasData}
        >
          Exportar Excel
        </button>
      </div>

      <p className="muted">
        Ventas y productos excluyen tickets anulados; stock incluye su restitución.
        Los montos en las planillas son pesos enteros (sin símbolo).
      </p>

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

      <div className="reports-toolbar">
        <div className="range-row">
          <label htmlFor="rep-from">Desde</label>
          <input
            id="rep-from"
            data-testid="report-from"
            type="date"
            value={range.from}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value || r.from }))}
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
      </div>

      {error && (
        <p className="error" data-testid="reports-error" role="alert">
          {error}
        </p>
      )}

      {view === "sales" && (
        <div className="card report-card" data-testid="report-sales">
          {sales.length === 0 ? (
            <div className="empty-state" data-testid="empty-sales">
              <p>Sin ventas en este período.</p>
            </div>
          ) : (
            <>
              <table className="rpt-table" data-testid="sales-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th className="n">Tickets</th>
                    <th className="n">Efectivo</th>
                    <th className="n">Transferencia</th>
                    <th className="n">Pendiente</th>
                    <th className="n">Ingresos</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((r) => (
                    <tr key={r.day} data-testid="sales-day">
                      <td>{r.day}</td>
                      <td className="n">{r.tickets}</td>
                      <td className="n">{cop(r.cash)}</td>
                      <td className="n">{cop(r.transfer)}</td>
                      <td className="n">{cop(r.pending)}</td>
                      <td className="n strong">{cop(r.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>TOTAL</td>
                    <td className="n">{sales.reduce((a, r) => a + r.tickets, 0)}</td>
                    <td className="n">{cop(totalCash)}</td>
                    <td className="n">{cop(totalTransfer)}</td>
                    <td className="n">{cop(totalPending)}</td>
                    <td className="n strong" data-testid="sales-total">
                      {cop(totalRevenue)}
                    </td>
                  </tr>
                </tfoot>
              </table>
              {totalPending > 0 && (
                <p className="muted" data-testid="sales-pending-total" style={{ margin: "8px 0 0" }}>
                  {cop(totalPending)} pendientes de confirmar — no son ingresos todavía.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {view === "top" && (
        <div className="card report-card" data-testid="report-top">
          {top.length === 0 ? (
            <div className="empty-state" data-testid="empty-top">
              <p>Sin ventas en este período.</p>
            </div>
          ) : (
            <table className="rpt-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Producto</th>
                  <th>Variante</th>
                  <th className="n">Unidades</th>
                  <th className="n">Ingresos</th>
                </tr>
              </thead>
              <tbody>
                {top.map((r, i) => (
                  <tr key={r.variant_id} data-testid="top-row">
                    <td>{i + 1}</td>
                    <td className="strong">{r.product_name}</td>
                    <td>{r.variant_name}</td>
                    <td className="n">{r.qty}</td>
                    <td className="n strong">{cop(r.revenue)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>TOTAL</td>
                  <td className="n">{totalQty}</td>
                  <td className="n strong">
                    {cop(top.reduce((a, r) => a + r.revenue, 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      )}

      {view === "low" && (
        <div className="card report-card" data-testid="report-low">
          {low.length === 0 ? (
            <div className="empty-state" data-testid="empty-low">
              <p>Ningún producto está por debajo del mínimo.</p>
            </div>
          ) : (
            <table className="rpt-table">
              <thead>
                <tr>
                  <th>Producto</th>
                  <th>Variante</th>
                  <th className="n">Stock</th>
                  <th className="n">Mínimo</th>
                </tr>
              </thead>
              <tbody>
                {low.map((r) => (
                  <tr key={r.variant_id} data-testid="low-row">
                    <td className="strong">{r.product_name}</td>
                    <td>{r.variant_name}</td>
                    <td className={`n ${r.stock < 0 ? "neg" : ""}`}>{r.stock}</td>
                    <td className="n">{r.threshold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
