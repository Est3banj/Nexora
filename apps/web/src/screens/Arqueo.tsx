import { useCallback, useEffect, useRef, useState } from "react";
import { Calculator, Coins, Wallet } from "lucide-react";
import type { PGlite } from "@electric-sql/pglite";
import type { ExpectedBreakdown } from "@pos/shared";
import {
  closeLocalShift,
  computeLocalExpected,
  getOpenShiftLocal,
  hasPendingShiftEvidence,
  listLocalClosedCash,
  listLocalCashMovements,
  localShiftTransferAbonos,
  mirrorOpenShift,
  mirrorServerClose,
  openLocalShift,
  type LocalClosedCash,
  type LocalShift,
  type LocalCashMovement,
} from "../db/local";
import { CashMovementModal } from "../components/CashMovementModal";
import { pushNow } from "../sync/queue";
import { scopedFetch } from "../sync/scoped-fetch";
import { useSync } from "../hooks/useSync";

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "short",
    timeStyle: "short",
  });

type Props = {
  actorId?: string | null;
  actorName?: string | null;
  db: PGlite;
  tenantId: string;
  refreshToken: number;
  tenantName?: string;
  showToast?: (msg: string) => void;
  onMutated?: () => void;
};

type ServerShift = {
  opening_cash?: number;
  opened_by?: string | null;
  calculation_version?: string;
  id: string;
  status: string;
  opened_at?: string;
  closed_at?: string | null;
};

type ServerClose = {
  closedcash: {
    closing_note?: string | null;
    calculation_version?: string;
    created_at?: string;
    id: string;
    client_uuid: string;
    shift_id: string;
    expected: number;
    counted: number;
    diff: number;
    closed_by: string | null;
  };
  expected: ExpectedBreakdown;
  diff: number;
};

/**
 * Arqueo screen (task D3-2, cash-close spec).
 *
 * Online close goes through `POST /api/shifts/:id/close` — the SERVER
 * computes `expected` from payments and the client sends only `counted`.
 * Offline close runs the SAME SQL over the local payments cache and
 * enqueues both mutations (reconciliation property, D3-3).
 */
export function Arqueo({ db, tenantId, refreshToken, tenantName, showToast, onMutated, actorId, actorName }: Props) {
  const sync = useSync();
  const [openShift, setOpenShift] = useState<LocalShift | null>(null);
  const [expected, setExpected] = useState<ExpectedBreakdown | null>(null);
  const [history, setHistory] = useState<LocalClosedCash[]>([]);
  const [counted, setCounted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const countInput = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [base, setBase] = useState("");
  const [note, setNote] = useState("");
  const [movementOpen, setMovementOpen] = useState(false);
  const [movements, setMovements] = useState<LocalCashMovement[]>([]);
  const [transferAbonos, setTransferAbonos] = useState(0);
  const validMoney = (text: string) => /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) <= 2147483647;
  const validCount = validMoney(counted);
  const difference = validCount && expected ? Number(counted) - expected.expected : null;
  const v2 = openShift?.calculation_version === "drawer_cash_v2";
  // Known actor → display name; unknown/absent → null (omit the clause).
  // Never surface raw uuids or "No registrado" — the prototype never does.
  const actor = (id: string | null | undefined): string | null =>
    !id ? null : id === actorId ? actorName || null : null;
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );

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

  const refresh = useCallback(async () => {
    const shift = await getOpenShiftLocal(db, tenantId);
    setOpenShift(shift);
    setExpected(shift ? await computeLocalExpected(db, tenantId, shift.id) : null);
    setHistory(await listLocalClosedCash(db, tenantId));
    setMovements(shift ? await listLocalCashMovements(db, tenantId, shift.id) : []);
    setTransferAbonos(shift ? await localShiftTransferAbonos(db, tenantId, shift.id) : 0);
    setLoading(false);
  }, [db, tenantId]);

  useEffect(() => {
    void refresh().catch(() => { setLoading(false); setError("No se pudo cargar la caja. Volvé a intentar."); });
  }, [refresh, refreshToken]);

  // Online: adopt the SERVER's open shift when the cache has none (fresh
  // device / seed) so sales and close target the same shift on both sides.
  useEffect(() => {
    if (!online) return;
    let alive = true;
    void (async () => {
      try {
        const res = await scopedFetch(tenantId, "/api/shifts/open");
        if (!res.ok || !alive) return;
        const data = (await res.json()) as { shift: ServerShift | null };
        if (data.shift && alive) {
          const adopted = await mirrorOpenShift(db, tenantId, data.shift);
          if (adopted && alive) await refresh();
        }
      } catch {
        /* raced offline — the local state stays authoritative */
      }
    })();
    return () => {
      alive = false;
    };
  }, [online, db, tenantId, refresh]);

  async function handleOpen() {
    if (lock.current || !validMoney(base)) return;
    lock.current = true;
    setError(null);
    setBusy(true);
    try {
      if (online) {
        const res = await scopedFetch(tenantId, "/api/shifts/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ opening_cash: Number(base), calculation_version: "drawer_cash_v2" }),
        });
        if (res.ok) {
          const data = (await res.json()) as { shift: ServerShift };
          await mirrorOpenShift(db, tenantId, data.shift);
        } else if (res.status === 409) {
          const data = (await res.json()) as { shift: ServerShift | null };
          if (data.shift) await mirrorOpenShift(db, tenantId, data.shift);
          setError("Ya hay una caja abierta. Se conserva su base y versión originales.");
        } else {
          setError("No se pudo abrir la caja — revisá la conexión");
          return;
        }
      } else {
        await openLocalShift(db, tenantId, { opening_cash: Number(base), opened_by: actorId ?? null, calculation_version: "drawer_cash_v2" });
      }
      await refresh();
      setBase(""); setCounted(""); setNote("");
      onMutated?.();
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      if (code === "SHIFT_ALREADY_OPEN") setError("Ya hay una caja abierta");
      else setError("No se pudo abrir la caja");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function handleClose() {
    if (lock.current) return;
    if (!openShift) {
      setError("No hay caja abierta");
      return;
    }
    const amount = Number(counted);
    if (!validCount) {
      setError("Ingresá un conteo entero no negativo, hasta 2.147.483.647");
      return;
    }
    lock.current = true;
    setError(null);
    setBusy(true);
    try {
      if (online) {
        // flush first: an offline-opened shift must exist server-side
        await pushNow(db, tenantId, { force: true });
        if (await hasPendingShiftEvidence(db, tenantId, openShift.id)) {
          setError("Hay operaciones de este turno pendientes de sincronizar. Reintentá antes del cierre online.");
          return;
        }
        const res = await scopedFetch(tenantId, `/api/shifts/${openShift.id}/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ counted: amount, closing_note: note.trim() || null }),
        });
        if (res.ok) {
          const data = (await res.json()) as ServerClose;
          await mirrorServerClose(db, tenantId, data.closedcash);
          showToast?.(`Caja cerrada — dif ${cop(data.diff)}`);
          setCounted("");
        } else if (res.status === 404) {
          // server never saw this shift (push failed) → close locally and
          // let the queue deliver it (same reconciliation path as offline)
          const local = await closeLocalShift(db, tenantId, { counted: amount, closingNote: note.trim() || null, closedBy: actorId });
          showToast?.(`Cierre guardado localmente — dif ${cop(local.diff)}. Pendiente de sincronización.`);
          setCounted("");
        } else if (res.status === 409) {
          setError("La caja ya estaba cerrada");
          return;
        } else if (res.status === 400) {
          setError("El conteo debe ser un entero no negativo");
          return;
        } else {
          setError("No se pudo cerrar la caja — revisá la conexión");
          return;
        }
      } else {
        const local = await closeLocalShift(db, tenantId, { counted: amount, closingNote: note.trim() || null, closedBy: actorId });
        showToast?.(`Cierre guardado localmente — dif ${cop(local.diff)}. Pendiente de sincronización.`);
        setCounted("");
      }
      await refresh();
      setNote("");
      onMutated?.();
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      if (code === "NO_OPEN_SHIFT") setError("No hay caja abierta");
      else if (code === "NEGATIVE_COUNTED")
        setError("El conteo no puede ser negativo");
      else if (code === "ALREADY_CLOSED") setError("La caja ya estaba cerrada");
      else setError("No se pudo cerrar la caja");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="screen arqueo cash-screen" aria-busy={loading}>
      <section className="card cash-banner" data-testid={openShift ? "shift-card" : "no-open-shift"}>
        <div><span className={`cash-status ${openShift ? "is-open" : ""}`}>{openShift && <span className="cash-dot" aria-hidden="true" />}<Wallet size={16} aria-hidden="true" />{loading ? "Cargando caja…" : openShift ? "Turno de Caja Activo" : "Sin caja abierta"}</span>
          <h2>{openShift ? (tenantName ? `Caja · ${tenantName}` : "Caja") : "Abrí un Nuevo Turno"}</h2>
          {openShift ? <p>Abierta <strong data-testid="shift-opened-at">{when(openShift.opened_at)}</strong>{actor(openShift.opened_by) && <> · Por <span data-testid="shift-actor" title={openShift.opened_by ?? undefined}>{actor(openShift.opened_by)}</span></>}</p>
            : <p>Ingresá la base real antes de empezar a registrar ventas.</p>}</div>
        <div className="cash-banner-actions"><button className="btn" data-testid="cash-movement-open" disabled={!openShift || busy || loading} onClick={() => setMovementOpen(true)}>+ Ingreso / Retiro</button>
          <button className="btn cash-close-focus" disabled={!openShift || busy} onClick={() => { countInput.current?.scrollIntoView({ block: "center" }); countInput.current?.focus(); }}>Cerrar Turno Actual</button></div>
      </section>
      {/* Staleness only when it actually matters — clean online state stays quiet */}
      {(!online || sync.pending > 0) && (
        <p className="cash-staleness muted" data-testid="cash-staleness">
          {online
            ? `${sync.pending} cambio(s) sin sincronizar — datos posiblemente incompletos.`
            : "Sin conexión: datos locales posiblemente incompletos. Movimientos y cierre quedan pendientes de sincronización."}
        </p>
      )}
      {error && <p className="error" data-testid="arqueo-error" role="alert">{error}</p>}
      {!openShift && !loading && <form className="card cash-opening cash-form" onSubmit={e => { e.preventDefault(); void handleOpen(); }}>
        <h3>Fondo Inicial (Base)</h3><p className="muted">Base fija — no se auto-completa. Para ajustarla: ingreso o retiro.</p>
        <label htmlFor="opening-cash">Base inicial en efectivo (COP)</label>
        <input id="opening-cash" data-testid="opening-cash" inputMode="numeric" value={base} disabled={busy} placeholder="Ingresá la base; 0 si no hay fondo" aria-invalid={base !== "" && !validMoney(base)} aria-describedby="base-help" onChange={e => setBase(e.target.value)} />
        <p id="base-help" className={base && !validMoney(base) ? "error" : "muted"}>Entero entre 0 y 2.147.483.647, sin decimales. No se completa automáticamente.</p>
        <button className="btn primary" data-testid="open-shift" aria-busy={busy} disabled={busy || !validMoney(base)}>{busy ? "Abriendo…" : "Abrir Caja"}</button>
      </form>}
      <div className="cash-grid">
        <div className="cash-summary">
          {openShift && <section data-testid="expected-card">
            <h3 className="cash-section-title"><Calculator size={18} aria-hidden="true" /> Resumen del Sistema · Turno Actual</h3>
            <div className="cash-metrics">
              <div className="card"><span>Fondo Inicial (Base)</span><strong data-testid="expected-base">{cop(openShift.opening_cash)}</strong></div>
              <div className="card cash-metric-cash"><span>Ventas Efectivo</span><strong data-testid="expected-cash">{cop(expected?.cash ?? 0)}</strong></div>
              <div className="card cash-metric-transfer"><span>Ventas Transferencia · confirmadas{v2 ? " (aparte)" : ""}</span><strong data-testid="expected-transfers">{cop(expected?.transfers ?? 0)}</strong></div>
            </div>
            <div className="card cash-expected">
              <div className="cash-expected-top">
                <div>
                  <span>{v2 ? "Efectivo Total Esperado en Gaveta" : "Esperado Consolidado · Legacy v1"}</span>
                  <p>{v2 ? "Base + ventas efectivo + abonos efectivo + ingresos − retiros" : "Efectivo + transferencias + abonos — NO es efectivo físico de gaveta."}</p>
                </div>
                <strong data-testid="expected-total">{cop(expected?.expected ?? 0)}</strong>
              </div>
              <div className="cash-breakdown">
                <div><span>Abonos en efectivo</span><strong data-testid="expected-abonos">{cop(expected?.abonos ?? 0)}</strong></div>
                <div><span>Ingresos de caja{!v2 ? " (no suman en legacy)" : ""}</span><strong data-testid="expected-income">{cop(movements.filter(m => m.direction === "in").reduce((s, m) => s + m.amount, 0))}</strong></div>
                <div><span>Retiros de caja{!v2 ? " (no restan en legacy)" : ""}</span><strong data-testid="expected-withdrawals">{cop(movements.filter(m => m.direction === "out").reduce((s, m) => s + m.amount, 0))}</strong></div>
                <div><span>Abonos por transferencia (aparte)</span><strong data-testid="expected-transfer-abonos">{cop(transferAbonos)}</strong></div>
                <div><span>Transferencias pendientes (excluidas)</span><strong data-testid="expected-pending">{cop(expected?.pending ?? 0)}</strong></div>
              </div>
            </div>
          </section>}
          <section className="card cash-history" data-testid="close-history"><h3>Historial de Turnos Recientes</h3><p className="muted">Últimos 20 · valores guardados, sin recalcular.</p>
            {history.length ? <div className="table-scroll" tabIndex={0} role="region" aria-label="Historial de cierres"><table><thead><tr><th>Fecha / Hora · Bogotá</th><th>Cajero / Versión</th><th>Esperado</th><th>Contado</th><th>Diferencia</th><th>Notas / Estado</th></tr></thead><tbody>
              {history.map(c => <tr key={c.id} data-testid="close-history-row"><td><time>{when(c.created_at)}</time><small className="cash-id">ID {c.id.slice(0, 8)}</small></td><td title={c.closed_by ?? undefined}>{actor(c.closed_by)}<small>{c.calculation_version === "drawer_cash_v2" ? "Gaveta v2 · físico" : "Legacy v1 · consolidado"}</small></td><td className="mono">{cop(c.expected)}</td><td className="mono">{cop(c.counted)}</td><td><strong className={`cash-diff-pill ${c.diff < 0 ? "short" : c.diff > 0 ? "over" : "exact"}`} data-testid="history-diff">{cop(c.diff)}{c.diff === 0 ? " (Exacto)" : c.diff > 0 ? " (Sobrante)" : " (Faltante)"}</strong></td><td className="cash-history-note">{c.closing_note || "Sin observaciones"}<small>{c.sync_pending ? "Pendiente de sincronización · provisional hasta ACK" : "Guardado en servidor"}</small></td></tr>)}
            </tbody></table></div> : <p className="muted">Sin cierres aún.</p>}
          </section>
          {openShift && movements.length > 0 && <section className="card cash-ledger"><h3>Movimientos del Turno</h3><div className="table-scroll" tabIndex={0} role="region" aria-label="Libro de movimientos"><table><thead><tr><th>Fecha · Bogotá</th><th>Tipo / Importe</th><th>Motivo / Nota</th></tr></thead><tbody>{movements.map(m => <tr key={m.id} data-testid="cash-movement-row"><td>{when(m.created_at)}</td><td className="mono">{m.direction === "in" ? "Ingreso +" : "Retiro −"}{cop(m.amount)}</td><td>{m.reason}<small>{m.note}</small></td></tr>)}</tbody></table></div></section>}
        </div>
        {openShift && <form className="card cash-count cash-form" onSubmit={e => { e.preventDefault(); void handleClose(); }}>
          <h3><Coins size={18} aria-hidden="true" />{v2 ? "Conteo Físico para Arqueo" : "Conteo Consolidado · Legacy"}</h3>
          <p className="muted">{v2 ? "Efectivo contado físicamente. Sin transferencias." : "Política anterior: efectivo + transferencias confirmadas — no solo la gaveta. No se convierte a v2."}</p>
          <label htmlFor="counted">{v2 ? "Monto Físico Contado (COP)" : "Monto Consolidado Contado (COP)"}</label>
          <div className="cash-input-wrap">
            <span aria-hidden="true">$</span>
            <input ref={countInput} id="counted" data-testid="counted" inputMode="numeric" value={counted} disabled={busy || movementOpen} placeholder="0" aria-invalid={counted !== "" && !validCount} aria-describedby={counted !== "" && !validCount ? "count-help" : undefined} onChange={e => setCounted(e.target.value)} />
          </div>
          {counted !== "" && !validCount && <p id="count-help" className="error">Usá un entero no negativo, hasta 2.147.483.647. Sin decimales.</p>}
          <div className={`cash-difference ${difference === null ? "" : difference === 0 ? "exact" : difference > 0 ? "over" : "short"}`} data-testid="cash-difference" aria-live="polite"><span>Resultado de Arqueo</span><strong>{difference === null ? "—" : `${difference > 0 ? "+" : ""}${cop(difference)}`}</strong><p>{difference === null ? "Ingresá un valor para comparar" : difference === 0 ? "Cuadre Exacto · Sin diferencias en caja" : difference > 0 ? "Sobrante en caja" : "Faltante en caja"}</p></div>
          <label htmlFor="closing-note">Notas / Observaciones del Cierre</label>
          <textarea id="closing-note" data-testid="closing-note" value={note} maxLength={500} rows={3} disabled={busy} placeholder="Opcional: justificación de descuadres…" onChange={e => setNote(e.target.value)} />
          <button className="btn cash-save" data-testid="close-shift" aria-busy={busy} disabled={busy || !validCount || !expected || movementOpen}>{busy ? "Guardando…" : "Guardar Arqueo y Finalizar Turno"}</button>
          <p className="muted">{online ? "El servidor calcula el cierre al sincronizar." : "Cierre local, provisional hasta la conciliación."} El arqueo guardado no se edita.</p>
        </form>}
      </div>
      <CashMovementModal open={movementOpen} db={db} tenantId={tenantId} onClose={() => setMovementOpen(false)} onRegistered={() => {
        setMovementOpen(false);
        showToast?.("Movimiento guardado localmente. Pendiente de sincronización.");
        void refresh(); onMutated?.();
        if (online) void pushNow(db, tenantId).then(refresh).catch(() => setError("Movimiento guardado; no se pudo sincronizar. Reintentá desde el estado de sincronización."));
      }} />
    </div>
  );
}
