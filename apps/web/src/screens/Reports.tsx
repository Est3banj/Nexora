import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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
import { validReportRange } from "../lib/analytical-periods";

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
  tenantName?: string;
};

type View = "sales" | "top" | "low";

/** 'YYYY-MM-DD' → '05/11/2026' (noon anchor avoids TZ day-shift). */
const fmtDay = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString("es-CO");

/**
 * Reports screen — accounting-style tables (headers + totals row),
 * real .xlsx export, offline-first over PGlite with staleness banner.
 */
export function Reports({ db, tenantId, refreshToken, tenantName }: Props) {
  const sync = useSync();
  const [view, setView] = useState<View>("sales");
  const [range, setRange] = useState(() => defaultReportRange());
  const [draft, setDraft] = useState(range);
  const [requested, setRequested] = useState(range);
  const [validation, setValidation] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sales, setSales] = useState<SalesByDayRow[]>([]);
  const [top, setTop] = useState<TopProductRow[]>([]);
  const [low, setLow] = useState<LowStockRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    async function refresh() {
    try {
      const [s, t, l] = await Promise.all([
        localSalesByDay(db, tenantId, requested),
        localTopProducts(db, tenantId, requested),
        localLowStock(db, tenantId),
      ]);
      if (!active) return;
      setRange(requested);
      setSales(s);
      setTop(t);
      setLow(l);
      setError(null);
    } catch {
      if (active) setError("No se pudieron calcular los reportes. El rango aplicado se conserva; volvé a aplicar para reintentar.");
    } finally {
      if (active) setLoading(false);
    }
    }
    void refresh();
    return () => { active = false; };
  }, [db, tenantId, requested, refreshToken]);

  function applyRange(event: React.FormEvent) {
    event.preventDefault();
    if (!validReportRange(draft)) {
      setValidation("Ingresá fechas válidas; Desde debe ser anterior o igual a Hasta.");
      return;
    }
    setValidation(null);
    setRequested({ ...draft });
  }

  const stale = !sync.online || sync.pending > 0;
  const totalRevenue = sales.reduce((acc, r) => acc + r.revenue, 0);
  const totalPending = sales.reduce((acc, r) => acc + r.pending, 0);
  const totalCash = sales.reduce((acc, r) => acc + r.cash, 0);
  const totalTransfer = sales.reduce((acc, r) => acc + r.transfer, 0);
  const totalCredit = sales.reduce((acc, r) => acc + r.credit, 0);
  const totalAbonos = sales.reduce((acc, r) => acc + r.abonos, 0);
  const totalQty = top.reduce((acc, r) => acc + r.qty, 0);

  function exportExcel() {
    if (view === "sales") {
      downloadXlsx(
        `nexora-ventas-${range.from}_${range.to}.xlsx`,
        "Ventas",
        ["Fecha", "Tickets", "Efectivo", "Transferencia", "Crédito", "Abonos (cobros)", "Pendiente", "Ingresos"],
        sales.map((r) => [
          r.day,
          num(r.tickets),
          num(r.cash),
          num(r.transfer),
          num(r.credit),
          num(r.abonos),
          num(r.pending),
          num(r.revenue),
        ]),
        [
          "TOTAL",
          sales.reduce((a, r) => a + r.tickets, 0),
          num(totalCash),
          num(totalTransfer),
          num(totalCredit),
          num(totalAbonos),
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

  /**
   * Corte de caja for thermal printers (58/80mm) — browser print dialog, no
   * PDF lib (jsPDF scales badly on receipt paper; the dialog also offers
   * "Save as PDF"). The class gates the print CSS so ONLY the corte prints —
   * ticket/success prints keep their own chrome-hiding rules untouched.
   * window.print() blocks until the dialog closes → finally is safe.
   */
  function printCorte() {
    document.body.classList.add("printing-corte");
    try {
      window.print();
    } finally {
      document.body.classList.remove("printing-corte");
    }
  }

  const totalTickets = sales.reduce((acc, r) => acc + r.tickets, 0);

  const corte = createPortal(
    <div className="print-corte" data-testid="print-corte">
      <h1>NEXORA</h1>
      {tenantName && <p className="pc-center">{tenantName}</p>}
      <p className="pc-center">CORTE DE CAJA</p>
      <p className="pc-center">
        {fmtDay(range.from)} — {fmtDay(range.to)}
      </p>
      <div className="pc-dash" />
      <div className="pc-row">
        <span>Tickets</span>
        <span>{totalTickets}</span>
      </div>
      <div className="pc-row">
        <span>Efectivo</span>
        <span>{cop(totalCash)}</span>
      </div>
      <div className="pc-row">
        <span>Transferencia</span>
        <span>{cop(totalTransfer)}</span>
      </div>
      <div className="pc-row">
        <span>Crédito</span><span>{cop(totalCredit)}</span>
      </div>
      <div className="pc-row">
        <span>Abonos (cobros)</span><span>{cop(totalAbonos)}</span>
      </div>
      <p>Abonos: cobros de deuda, no nuevas ventas. Ingresos = efectivo + transferencia + crédito confirmados.</p>
      <div className="pc-row">
        <span>Pendiente</span>
        <span>{cop(totalPending)}</span>
      </div>
      <div className="pc-row pc-strong">
        <span>Ingresos</span>
        <span>{cop(totalRevenue)}</span>
      </div>
      <div className="pc-dash" />
      <table className="pc-table">
        <thead>
          <tr>
            <th>Fecha</th>
            <th>T</th>
            <th>Efect.</th>
            <th>Transf.</th>
            <th>Crédito</th>
            <th>Abonos</th>
            <th>Pend.</th>
            <th>Ingresos</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((r) => (
            <tr key={r.day}>
              <td data-label="Fecha">{fmtDay(r.day)}</td>
              <td data-label="Tickets">{r.tickets}</td>
              <td data-label="Efectivo">{cop(r.cash)}</td>
              <td data-label="Transferencia">{cop(r.transfer)}</td>
              <td data-label="Crédito">{cop(r.credit)}</td>
              <td data-label="Abonos (cobros)">{cop(r.abonos)}</td>
              <td data-label="Pendiente">{cop(r.pending)}</td>
              <td data-label="Ingresos">{cop(r.revenue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pc-dash" />
      {totalPending > 0 && (
        <p>
          ¡Atención! {cop(totalPending)} pendientes de confirmar — no son
          ingresos todavía.
        </p>
      )}
      <p className="pc-center">
        Generado {new Date().toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })}
        {" · "}Excluye tickets anulados.
      </p>
    </div>,
    document.body,
  );

  return (
    <>
       <div className="screen reports" aria-busy={loading}>
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

       <div className="card reports-toolbar">
         <form onSubmit={applyRange} noValidate>
         <div className="range-row">
           <div>
          <label htmlFor="rep-from">Desde</label>
          <input
            id="rep-from"
            data-testid="report-from"
            type="date"
             value={draft.from}
             aria-invalid={!!validation}
             aria-describedby={validation ? "report-range-error" : undefined}
             onChange={(e) => setDraft((r) => ({ ...r, from: e.target.value }))}
           />
           </div><div>
          <label htmlFor="rep-to">Hasta</label>
          <input
            id="rep-to"
            data-testid="report-to"
            type="date"
             value={draft.to}
             aria-invalid={!!validation}
             aria-describedby={validation ? "report-range-error" : undefined}
             onChange={(e) => setDraft((r) => ({ ...r, to: e.target.value }))}
           />
           </div>
           <button className="btn" data-testid="report-apply" disabled={loading} aria-busy={loading}>{loading ? "Calculando…" : "Aplicar Filtro"}</button>
         </div>
          </form>
          <div className="report-actions">
            <button className="btn" data-testid="corte-print" onClick={printCorte} disabled={loading || !!error || sales.length === 0} title="Imprimir en térmica o Guardar como PDF">Corte de caja</button>
            <button className="btn report-export" data-testid="export-excel" onClick={exportExcel} disabled={loading || !!error || !hasData}>Exportar a Excel</button>
          </div>
        </div>
        <div className="seg report-views" role="group" aria-label="Tipo de reporte">
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
       {validation && <p className="error" id="report-range-error" role="alert">{validation}</p>}
       <p className="muted" data-testid="report-applied">Rango aplicado: {range.from} — {range.to} (Bogotá). {view === "low" ? "Stock actual; no depende del rango." : ""}</p>
       {(draft.from !== range.from || draft.to !== range.to) && <p className="muted" data-testid="report-draft">Cambios sin aplicar. La tabla y las exportaciones conservan el rango aplicado.</p>}
       {loading && <p role="status" data-testid="report-loading">Calculando reportes…</p>}
       <div className="report-description">
         <p className="muted">Ingresos = efectivo + transferencia + crédito confirmados. Abonos (cobros) son deuda cobrada, no nuevas ventas.</p>
         <p className="muted">Ventas y productos excluyen tickets anulados; stock incluye su restitución. Planillas en pesos enteros.</p>
       </div>

      {error && (
        <p className="error" data-testid="reports-error" role="alert">
          {error}
        </p>
      )}

       {view === "sales" && (
         <div className="card report-card" data-testid="report-sales">
           <div className="report-table-heading"><h3>Resumen Consolidado de Ventas por Día</h3><span data-testid="report-count">{sales.length} registros</span></div>
          {sales.length === 0 ? (
            <div className="empty-state" data-testid="empty-sales">
              <p>Sin ventas en este período.</p>
            </div>
          ) : (
            <>
              <div className="table-scroll"><table className="rpt-table" data-testid="sales-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th className="n">Tickets</th>
                    <th className="n">Efectivo</th>
                     <th className="n">Transferencia</th>
                     <th className="n">Crédito</th>
                     <th className="n">Abonos (cobros)</th>
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
                       <td className="n">{cop(r.credit)}</td>
                       <td className="n">{cop(r.abonos)}</td>
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
                     <td className="n" data-testid="sales-credit-total">{cop(totalCredit)}</td>
                     <td className="n" data-testid="sales-abonos-total">{cop(totalAbonos)}</td>
                    <td className="n">{cop(totalPending)}</td>
                    <td className="n strong" data-testid="sales-total">
                      {cop(totalRevenue)}
                    </td>
                  </tr>
                </tfoot>
              </table></div>
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
           <div className="report-table-heading"><h3>Top productos</h3><span data-testid="report-count">{top.length} registros</span></div>
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
           <div className="report-table-heading"><h3>Stock bajo actual</h3><span data-testid="report-count">{low.length} registros</span></div>
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
      {corte}
    </>
  );
}
