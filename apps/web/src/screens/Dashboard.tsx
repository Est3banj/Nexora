import { useEffect, useState } from "react";
import { Banknote, ChartNoAxesCombined, CreditCard, Boxes } from "lucide-react";
import type { PGlite } from "@electric-sql/pglite";
import {
  type DashboardSummaryRow,
  type InventoryValueRow,
  type LowStockRow,
  type SalesByHourRow,
  type TopProductRow,
  localDate,
} from "@pos/shared";
import {
  localDashboardSummary,
  localInventoryValue,
  localLowStock,
  localSalesByHour,
  localTopProducts,
} from "../db/local-reports";
import { useSync } from "../hooks/useSync";
import {
  CUSTOM_RANGE_ERROR,
  customRanges,
  dashboardRanges,
  defaultCustomRange,
  deltaPct,
  inclusiveDays,
  validCustomRange,
  type DashboardPeriod,
  type DateRange,
} from "../lib/analytical-periods";

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

const periodNames: Record<DashboardPeriod, string> = {
  today: "Hoy",
  "7d": "Últimos 7 días",
  "30d": "Últimos 30 días",
  "90d": "Últimos 3 meses",
  "180d": "Últimos 6 meses",
  "365d": "Último año",
  custom: "Personalizado",
};

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
  const [period, setPeriod] = useState<DashboardPeriod>("today");
  const [customDraft, setCustomDraft] = useState<DateRange>(defaultCustomRange);
  const [customApplied, setCustomApplied] = useState<DateRange>(defaultCustomRange);
  const [summary, setSummary] = useState<DashboardSummaryRow | null>(null);
  const [prev, setPrev] = useState<DashboardSummaryRow | null>(null);
  const [inventory, setInventory] = useState<InventoryValueRow | null>(null);
  const [top, setTop] = useState<TopProductRow[]>([]);
  const [low, setLow] = useState<LowStockRow[]>([]);
  const [hours, setHours] = useState<SalesByHourRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const [loading, setLoading] = useState(true);
  const customError =
    period === "custom" && !validCustomRange(customDraft) ? CUSTOM_RANGE_ERROR : null;
  const ranges =
    period === "custom" ? customRanges(customApplied) : dashboardRanges(period);
  const { from, to } = ranges.current;
  const { from: prevFrom, to: prevTo } = ranges.previous;
  const customDays = inclusiveDays(customApplied);

  function choosePeriod(next: DashboardPeriod) {
    if (next === "custom") {
      const initial = defaultCustomRange();
      setCustomDraft(initial);
      setCustomApplied(initial);
    } else {
      setCustomDraft({ from: "", to: "" });
    }
    setPeriod(next);
  }

  /** Auto-apply: only a fully valid draft becomes the fetched range; an
   * invalid draft keeps the last applied range and surfaces customError. */
  function updateCustom(patch: Partial<DateRange>) {
    const next = { ...customDraft, ...patch };
    setCustomDraft(next);
    if (validCustomRange(next)) setCustomApplied(next);
  }

  useEffect(() => {
    let active = true;
    setLoading(true);
    async function refresh() {
    try {
      const range = { from, to };
      const [s, p, inv, t, l, h] = await Promise.all([
        localDashboardSummary(db, tenantId, range),
        localDashboardSummary(db, tenantId, { from: prevFrom, to: prevTo }),
        localInventoryValue(db, tenantId),
        localTopProducts(db, tenantId, range),
        localLowStock(db, tenantId),
        localSalesByHour(db, tenantId, range),
      ]);
      if (!active) return;
      setSummary(s);
      setPrev(p);
      setInventory(inv);
      setTop(t);
      setLow(l);
      setHours(h);
      setError(null);
    } catch {
      if (active) setError("No se pudieron calcular los indicadores");
    } finally {
      if (active) setLoading(false);
    }
    }
    void refresh();
    return () => { active = false; };
  }, [db, tenantId, from, to, prevFrom, prevTo, refreshToken, retry]);

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

  const pendingCount = summary?.pending_count ?? 0;
  const needsAttention = pendingCount > 0 || low.length > 0;

  /* Hour-of-day profile (Batch D) — pure CSS bars, zero chart deps. */
  const peakRevenue = hours.reduce((m, h) => Math.max(m, h.revenue), 0);
  const showHours = peakRevenue > 0;
  const peakHour = hours.find((h) => h.revenue === peakRevenue)?.hour;

  return (
    <div className="screen dashboard" aria-busy={loading}>
      <div className="dash-head">
        <h2>Resumen de Desempeño</h2>
        <div className="period-controls">
          <label htmlFor="dash-period">
            Período
            <select
              id="dash-period"
              value={period}
              data-testid="period-select"
              onChange={(e) => choosePeriod(e.target.value as DashboardPeriod)}
            >
              <option value="today">Hoy</option>
              <option value="7d">Últimos 7 días</option>
              <option value="30d">Últimos 30 días</option>
              <option value="90d">Últimos 3 meses</option>
              <option value="180d">Últimos 6 meses</option>
              <option value="365d">Último año</option>
              <option value="custom">Personalizado</option>
            </select>
          </label>
          {period === "custom" && (
            <div className="period-range" role="group" aria-label="Rango personalizado">
              <label>
                Desde
                <input
                  id="dash-custom-from"
                  data-testid="period-custom-from"
                  type="date"
                  value={customDraft.from}
                  max={localDate(0)}
                  aria-invalid={customError !== null}
                  aria-describedby={customError ? "dash-custom-error" : undefined}
                  onChange={(e) => updateCustom({ from: e.target.value })}
                />
              </label>
              <label>
                Hasta
                <input
                  id="dash-custom-to"
                  data-testid="period-custom-to"
                  type="date"
                  value={customDraft.to}
                  max={localDate(0)}
                  aria-invalid={customError !== null}
                  aria-describedby={customError ? "dash-custom-error" : undefined}
                  onChange={(e) => updateCustom({ to: e.target.value })}
                />
              </label>
            </div>
          )}
        </div>
      </div>
      {customError && (
        <p className="error" id="dash-custom-error" data-testid="period-custom-error" role="alert">
          {customError}
        </p>
      )}

      <p className="muted dash-subtitle" data-testid="period-label">
        {period === "custom" ? (
          <>
            Rango: {from} — {to} · comparado con{" "}
            {customDays === 1 ? "el día anterior" : `los ${customDays} días anteriores`}.
          </>
        ) : (
          <>
            {periodNames[period]} · {from} — {to} (Bogotá). Comparación: {prevFrom} — {prevTo}.
          </>
        )}
      </p>
      {loading && <p role="status">Calculando indicadores…</p>}

      {(!sync.online || sync.pending > 0) && (
        <div className="warn-banner" data-testid="dash-staleness" role="status">
          Datos posiblemente incompletos — {sync.pending} cambio(s) sin sincronizar.
        </div>
      )}

      {error && (
        <p className="error" data-testid="dash-error" role="alert">
          {error}
          {" "}<button className="btn" disabled={loading} onClick={() => setRetry(n => n + 1)}>Reintentar indicadores</button>
        </p>
      )}

      {summary && !loading && !error && (
        <>
          {/* ── hero: ingresos + delta vs. período anterior ── */}
          <div className="dash-metrics">
          <div className="card kpi kpi-revenue" data-testid="kpi-revenue">
            <div className="kpi-hero-top">
              <span className="kpi-label">Ingresos Totales</span><Banknote size={18} aria-hidden />
            </div>
            <strong className="kpi-value">{cop(summary.revenue)}</strong>
            <DeltaChip pct={revDelta} />
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

          <div className="card kpi kpi-profit" data-testid="kpi-gross">
            <span className="kpi-label">Ganancia Bruta <ChartNoAxesCombined size={18} aria-hidden /></span>
            <strong className={`kpi-value ${gross < 0 ? "neg" : ""}`}>{hasCostData ? cop(gross) : "—"}</strong>
            <span className="kpi-sub muted">{!hasCostData ? "Sin costo en las ventas del período" : `${marginPct ?? 0}% margen estimado · costo registrado ${cop(summary.cogs)}. Puede haber líneas sin costo.`}</span>
          </div>
          <div className="card kpi kpi-methods">
            <span className="kpi-label">Desglose Métodos <CreditCard size={18} aria-hidden /></span>
            <dl>
              <div data-testid="kpi-cash"><dt>Efectivo</dt><dd>{cop(summary.cash)}</dd></div>
              <div data-testid="kpi-transfer"><dt>Transferencia</dt><dd>{cop(summary.transfer)}</dd></div>
              <div data-testid="kpi-credit"><dt>Crédito</dt><dd>{cop(summary.credit)}</dd></div>
              <div className="collection" data-testid="kpi-abonos"><dt>Abonos (cobros)</dt><dd>{cop(summary.abonos)}</dd></div>
            </dl>
            <span className="kpi-sub muted">Abonos separados, no son nuevas ventas.</span>
          </div>
          <div className="card kpi kpi-stock" data-testid="kpi-inventory">
            <span className="kpi-label">Valor en Inventario <Boxes size={18} aria-hidden /></span>
            <strong className="kpi-value">{inventory?.variants_with_cost ? cop(inventory.inventory_cost) : "—"}</strong>
            <span className="kpi-sub muted">{inventory?.variants_with_cost ? "Costo registrado; variantes sin costo no incluidas" : "Sin costos de inventario"} · venta {cop(inventory?.inventory_retail ?? 0)}</span>
          </div>
          </div>
          <div className="dash-detail-grid">

          {/* ── atención: lo que requiere acción del dueño ── */}
            <section className="card dash-attention" aria-label="Requiere atención">
              <h3 className="dash-section-title" data-testid={needsAttention ? "dash-attention-title" : undefined}>
                Requiere atención
              </h3>
              {!needsAttention && <p className="muted">Sin alertas para este período.</p>}
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

          <div className="card dash-ranking">
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
          </div>
        </>
      )}
    </div>
  );
}
