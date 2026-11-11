import { useCallback, useEffect, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import {
  localDate,
  type DashboardSummaryRow,
  type InventoryValueRow,
  type TopProductRow,
} from "@pos/shared";
import { localDashboardSummary, localInventoryValue, localTopProducts } from "../db/local-reports";
import { useSync } from "../hooks/useSync";

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

type Period = "today" | "7d" | "30d";

function rangeFor(period: Period): { from: string; to: string } {
  const to = localDate(0);
  const back = period === "today" ? 0 : period === "7d" ? 6 : 29;
  return { from: localDate(-back), to };
}

/**
 * Dashboard contable (Tanda B) — KPIs the owner needs to know their numbers.
 * Offline-first: same shared SQL over PGlite; staleness via sync queue.
 */
export function Dashboard({ db, tenantId, refreshToken }: Props) {
  const sync = useSync();
  const [period, setPeriod] = useState<Period>("7d");
  const [summary, setSummary] = useState<DashboardSummaryRow | null>(null);
  const [inventory, setInventory] = useState<InventoryValueRow | null>(null);
  const [top, setTop] = useState<TopProductRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const range = rangeFor(period);
      const [s, inv, t] = await Promise.all([
        localDashboardSummary(db, tenantId, range),
        localInventoryValue(db, tenantId),
        localTopProducts(db, tenantId, range),
      ]);
      setSummary(s);
      setInventory(inv);
      setTop(t);
      setError(null);
    } catch {
      setError("No se pudieron calcular los indicadores");
    }
  }, [db, tenantId, period]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  const gross = summary ? summary.revenue - summary.cogs : 0;
  const avgTicket =
    summary && summary.tickets > 0 ? Math.round(summary.revenue / summary.tickets) : 0;
  // Honest margin: only when we actually captured costs on sale lines.
  const costed = summary?.costed_lines ?? 0;
  const hasCostData = costed > 0;
  const marginPct =
    hasCostData && summary && summary.revenue > 0
      ? Math.round((gross / summary.revenue) * 100)
      : null;

  const periodLabel =
    period === "today" ? "Hoy" : period === "7d" ? "Últimos 7 días" : "Últimos 30 días";

  return (
    <div className="screen dashboard">
      <div className="dash-head">
        <h2>Panel</h2>
        <div className="seg" role="tablist" aria-label="Período">
          <button
            className={period === "today" ? "active" : ""}
            data-testid="period-today"
            onClick={() => setPeriod("today")}
          >
            Hoy
          </button>
          <button
            className={period === "7d" ? "active" : ""}
            data-testid="period-7d"
            onClick={() => setPeriod("7d")}
          >
            7 días
          </button>
          <button
            className={period === "30d" ? "active" : ""}
            data-testid="period-30d"
            onClick={() => setPeriod("30d")}
          >
            30 días
          </button>
        </div>
      </div>

      <p className="muted dash-subtitle" data-testid="period-label">
        {periodLabel}
      </p>

      <p className="muted">Ventas netas de anulaciones completas. Los tickets originales se conservan en Tickets.</p>
      {sync.pending > 0 && (
        <div className="warn-banner" data-testid="dash-staleness" role="status">
          Datos posiblemente incompletos — {sync.pending} cambio(s) sin sincronizar.
        </div>
      )}

      {error && (
        <p className="error" data-testid="dash-error" role="alert">
          {error}
        </p>
      )}

      {summary && (
        <>
          <div className="kpi-grid">
            <div className="card kpi" data-testid="kpi-revenue">
              <span className="kpi-label">Ingresos</span>
              <strong className="kpi-value">{cop(summary.revenue)}</strong>
              <span className="kpi-sub muted">
                {summary.tickets} ventas · {cop(avgTicket)} prom.
              </span>
            </div>
            <div className="card kpi" data-testid="kpi-gross">
              <span className="kpi-label">Ganancia bruta</span>
              <strong className={`kpi-value ${gross < 0 ? "neg" : ""}`}>
                {cop(gross)}
              </strong>
              <span className="kpi-sub muted">
                {!hasCostData
                  ? "Sin costo en las ventas del período"
                  : marginPct !== null
                    ? `${marginPct}% margen · costo ${cop(summary.cogs)}`
                    : "Costos registrados · sin ingresos"}
              </span>
            </div>
            <div className="card kpi" data-testid="kpi-cash">
              <span className="kpi-label">Efectivo</span>
              <strong className="kpi-value">{cop(summary.cash)}</strong>
              <span className="kpi-sub muted">confirmado</span>
            </div>
            <div className="card kpi" data-testid="kpi-transfer">
              <span className="kpi-label">Transferencias</span>
              <strong className="kpi-value">{cop(summary.transfer)}</strong>
              <span className="kpi-sub muted">confirmado</span>
            </div>
            {summary.pending > 0 && (
              <div className="card kpi warn" data-testid="kpi-pending">
                <span className="kpi-label">Por confirmar</span>
                <strong className="kpi-value">{cop(summary.pending)}</strong>
                <span className="kpi-sub muted">transferencias pendientes</span>
              </div>
            )}
            {inventory && (
              <div className="card kpi" data-testid="kpi-inventory">
                <span className="kpi-label">Inventario (costo)</span>
                <strong className="kpi-value">{cop(inventory.inventory_cost)}</strong>
                <span className="kpi-sub muted">
                  venta {cop(inventory.inventory_retail)} · {inventory.low_stock_count} bajo
                </span>
              </div>
            )}
          </div>

          <div className="card">
            <h3>Top productos</h3>
            {top.length === 0 ? (
              <p className="muted" data-testid="dash-empty-top">
                Sin ventas en este período.
              </p>
            ) : (
              <ul className="dash-top" data-testid="dash-top">
                {top.slice(0, 5).map((t, i) => (
                  <li key={t.variant_id} className="row space-between">
                    <span>
                      {i + 1}. {t.product_name} · {t.variant_name}
                    </span>
                    <strong>
                      {t.qty} ud · {cop(t.revenue)}
                    </strong>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
