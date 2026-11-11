import { useCallback, useEffect, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import {
  localDate,
  type DashboardSummaryRow,
  type InventoryValueRow,
  type LowStockRow,
  type SalesByHourRow,
  type TopProductRow,
} from "@pos/shared";
import {
  localDashboardSummary,
  localInventoryValue,
  localLowStock,
  localSalesByHour,
  localTopProducts,
} from "../db/local-reports";
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
  onNavigate?: (tab: "tickets" | "catalog") => void;
};

type Period = "today" | "7d" | "30d";

function rangeFor(period: Period): { from: string; to: string } {
  const to = localDate(0);
  const back = period === "today" ? 0 : period === "7d" ? 6 : 29;
  return { from: localDate(-back), to };
}

/** Same-length window immediately before the current one (for deltas). */
export function prevRangeFor(period: Period): { from: string; to: string } {
  const len = period === "today" ? 1 : period === "7d" ? 7 : 30;
  return { from: localDate(-len * 2 + 1), to: localDate(-len) };
}

/** % change vs previous period; null when there is no prior base. */
export function deltaPct(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function DeltaChip({ pct }: { pct: number | null }) {
  if (pct === null) {
    return (
      <span className="delta flat" data-testid="kpi-delta">
        sin dato previo
      </span>
    );
  }
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "■";
  return (
    <span className={`delta ${cls}`} data-testid="kpi-delta">
      {arrow} {Math.abs(pct)}% vs. período anterior
    </span>
  );
}

/**
 * Panel — métricas selectivas para el dueño:
 *  1. hero: ingresos del período + delta vs. período anterior
 *  2. atención: transferencias por confirmar + stock bajo (accionables)
 *  3. secundarios: ganancia, efectivo, transferencias confirmadas, inventario
 *  4. top productos del período
 * Offline-first: mismo SQL compartido sobre PGlite; staleness vía sync queue.
 */
export function Dashboard({ db, tenantId, refreshToken, onNavigate }: Props) {
  const sync = useSync();
  const [period, setPeriod] = useState<Period>("7d");
  const [summary, setSummary] = useState<DashboardSummaryRow | null>(null);
  const [prev, setPrev] = useState<DashboardSummaryRow | null>(null);
  const [inventory, setInventory] = useState<InventoryValueRow | null>(null);
  const [top, setTop] = useState<TopProductRow[]>([]);
  const [low, setLow] = useState<LowStockRow[]>([]);
  const [hours, setHours] = useState<SalesByHourRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const range = rangeFor(period);
      const [s, p, inv, t, l, h] = await Promise.all([
        localDashboardSummary(db, tenantId, range),
        localDashboardSummary(db, tenantId, prevRangeFor(period)),
        localInventoryValue(db, tenantId),
        localTopProducts(db, tenantId, range),
        localLowStock(db, tenantId),
        localSalesByHour(db, tenantId, range),
      ]);
      setSummary(s);
      setPrev(p);
      setInventory(inv);
      setTop(t);
      setLow(l);
      setHours(h);
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

  const revDelta = summary && prev ? deltaPct(summary.revenue, prev.revenue) : null;
  const ticketDelta = summary && prev ? deltaPct(summary.tickets, prev.tickets) : null;

  const periodLabel =
    period === "today" ? "Hoy" : period === "7d" ? "Últimos 7 días" : "Últimos 30 días";

  const pendingCount = summary?.pending_count ?? 0;
  const needsAttention = pendingCount > 0 || low.length > 0;

  /* Hour-of-day profile (Batch D) — pure CSS bars, zero chart deps. */
  const peakRevenue = hours.reduce((m, h) => Math.max(m, h.revenue), 0);
  const showHours = peakRevenue > 0;
  const peakHour = hours.find((h) => h.revenue === peakRevenue)?.hour;

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
          {/* ── hero: ingresos + delta vs. período anterior ── */}
          <div className="card kpi-hero" data-testid="kpi-revenue">
            <div className="kpi-hero-top">
              <span className="kpi-label">Ingresos · {periodLabel.toLowerCase()}</span>
              <DeltaChip pct={revDelta} />
            </div>
            <strong className="kpi-value hero">{cop(summary.revenue)}</strong>
            <span className="kpi-sub muted">
              {summary.tickets} ventas · {cop(avgTicket)} prom.
              {ticketDelta !== null && (
                <>
                  {" · "}
                  <span
                    className={`delta inline ${ticketDelta > 0 ? "up" : ticketDelta < 0 ? "down" : "flat"}`}
                    data-testid="kpi-tickets-delta"
                  >
                    {ticketDelta > 0 ? "▲" : ticketDelta < 0 ? "▼" : "■"}{" "}
                    {Math.abs(ticketDelta)}% tickets
                  </span>
                </>
              )}
            </span>
          </div>

          {/* ── atención: lo que requiere acción del dueño ── */}
          {needsAttention && (
            <section className="dash-attention" aria-label="Requiere atención">
              <h3 className="dash-section-title" data-testid="dash-attention-title">
                Requiere atención
              </h3>
              <div className="attention-grid">
                {pendingCount > 0 && (
                  <div className="card kpi warn" data-testid="kpi-pending">
                    <span className="kpi-label">Transferencias por confirmar</span>
                    <strong className="kpi-value">{cop(summary.pending)}</strong>
                    <span className="kpi-sub muted" data-testid="pending-count">
                      {pendingCount} {pendingCount === 1 ? "pago" : "pagos"} esperando
                      confirmación
                    </span>
                    {onNavigate && (
                      <button
                        className="btn small"
                        data-testid="goto-tickets"
                        onClick={() => onNavigate("tickets")}
                      >
                        Ver en Tickets
                      </button>
                    )}
                  </div>
                )}
                {low.length > 0 && (
                  <div className="card kpi warn" data-testid="kpi-low-stock">
                    <span className="kpi-label">Stock bajo</span>
                    <strong className="kpi-value" data-testid="low-count">
                      {inventory?.low_stock_count ?? low.length}
                    </strong>
                    <span className="kpi-sub muted">
                      {inventory?.low_stock_count === 1
                        ? "variante para reponer"
                        : "variantes para reponer"}
                    </span>
                    <ul className="dash-low" data-testid="dash-low-list">
                      {low.slice(0, 4).map((l) => (
                        <li key={l.variant_id} data-testid="dash-low-item">
                          <span>
                            {l.product_name} · {l.variant_name}
                          </span>
                          <strong>
                            {l.stock}/{l.threshold}
                          </strong>
                        </li>
                      ))}
                    </ul>
                    {onNavigate && (
                      <button
                        className="btn small"
                        data-testid="goto-catalog"
                        onClick={() => onNavigate("catalog")}
                      >
                        Ver en Catálogo
                      </button>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ── KPIs secundarios ── */}
          <div className="kpi-grid">
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
            {inventory && (
              <div className="card kpi" data-testid="kpi-inventory">
                <span className="kpi-label">Inventario (costo)</span>
                <strong className="kpi-value">{cop(inventory.inventory_cost)}</strong>
                <span className="kpi-sub muted">
                  venta {cop(inventory.inventory_retail)}
                </span>
              </div>
            )}
          </div>

          {/* ── horas pico: barras CSS puras, sin lib de gráficos ── */}
          {showHours && (
            <div className="card" data-testid="dash-hours">
              <h3>Horas pico</h3>
              <p className="muted">
                Ingresos confirmados por hora · pico a las {peakHour}h
              </p>
              <div
                className="hour-bars"
                role="img"
                aria-label={`Ingresos por hora del día; pico a las ${peakHour}h con ${cop(peakRevenue)}`}
              >
                {Array.from({ length: 24 }, (_, hour) => {
                  const row = hours.find((r) => r.hour === hour);
                  const pct =
                    row && peakRevenue > 0
                      ? Math.max(4, Math.round((row.revenue / peakRevenue) * 100))
                      : 0;
                  const isPeak = row?.revenue === peakRevenue && peakRevenue > 0;
                  return (
                    <div
                      key={hour}
                      className={`hour-bar${isPeak ? " peak" : ""}${pct === 0 ? " empty" : ""}`}
                      style={{ height: pct === 0 ? "3px" : `${pct}%` }}
                      title={`${hour}:00 — ${cop(row?.revenue ?? 0)} · ${row?.tickets ?? 0} tickets`}
                    />
                  );
                })}
              </div>
              <div className="hour-labels" aria-hidden>
                {Array.from({ length: 24 }, (_, hour) => (
                  <span
                    key={hour}
                    className={hour === 6 || hour === 18 ? "lab-opt" : ""}
                  >
                    {hour % 6 === 0 ? `${hour}h` : ""}
                  </span>
                ))}
              </div>
            </div>
          )}

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
