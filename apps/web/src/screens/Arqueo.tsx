import { useCallback, useEffect, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import type { ExpectedBreakdown } from "@pos/shared";
import {
  closeLocalShift,
  computeLocalExpected,
  getOpenShiftLocal,
  listLocalClosedCash,
  mirrorOpenShift,
  mirrorServerClose,
  openLocalShift,
  type LocalClosedCash,
  type LocalShift,
} from "../db/local";
import { pushNow } from "../sync/queue";

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

const when = (iso: string) =>
  new Date(iso).toLocaleString("es-CO", {
    dateStyle: "short",
    timeStyle: "short",
  });

type Props = {
  db: PGlite;
  tenantId: string;
  refreshToken: number;
  showToast?: (msg: string) => void;
  onMutated?: () => void;
};

type ServerShift = {
  id: string;
  status: string;
  opened_at?: string;
  closed_at?: string | null;
};

type ServerClose = {
  closedcash: {
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
export function Arqueo({ db, tenantId, refreshToken, showToast, onMutated }: Props) {
  const [openShift, setOpenShift] = useState<LocalShift | null>(null);
  const [expected, setExpected] = useState<ExpectedBreakdown | null>(null);
  const [history, setHistory] = useState<LocalClosedCash[]>([]);
  const [counted, setCounted] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
  }, [db, tenantId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  // Online: adopt the SERVER's open shift when the cache has none (fresh
  // device / seed) so sales and close target the same shift on both sides.
  useEffect(() => {
    if (!online) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/shifts/open");
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
    setError(null);
    setBusy(true);
    try {
      if (online) {
        const res = await fetch("/api/shifts/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (res.ok) {
          const data = (await res.json()) as { shift: ServerShift };
          await mirrorOpenShift(db, tenantId, data.shift);
        } else if (res.status === 409) {
          const data = (await res.json()) as { shift: ServerShift | null };
          if (data.shift) await mirrorOpenShift(db, tenantId, data.shift);
        } else {
          setError("No se pudo abrir la caja — revisá la conexión");
          return;
        }
      } else {
        await openLocalShift(db, tenantId);
      }
      await refresh();
      onMutated?.();
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      if (code === "SHIFT_ALREADY_OPEN") setError("Ya hay una caja abierta");
      else setError("No se pudo abrir la caja");
    } finally {
      setBusy(false);
    }
  }

  async function handleClose() {
    if (!openShift) {
      setError("No hay caja abierta");
      return;
    }
    const amount = Number(counted.replace(/[^\d]/g, ""));
    if (!counted.trim() || Number.isNaN(amount)) {
      setError("Ingresá el conteo de efectivo");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (online) {
        // flush first: an offline-opened shift must exist server-side
        await pushNow(db, tenantId, { force: true });
        const res = await fetch(`/api/shifts/${openShift.id}/close`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ counted: amount }),
        });
        if (res.ok) {
          const data = (await res.json()) as ServerClose;
          await mirrorServerClose(db, tenantId, data.closedcash);
          showToast?.(`Caja cerrada — dif ${cop(data.diff)}`);
          setCounted("");
        } else if (res.status === 404) {
          // server never saw this shift (push failed) → close locally and
          // let the queue deliver it (same reconciliation path as offline)
          const local = await closeLocalShift(db, tenantId, { counted: amount });
          showToast?.(`Caja cerrada — dif ${cop(local.diff)}`);
          setCounted("");
        } else if (res.status === 409) {
          setError("La caja ya estaba cerrada");
        } else if (res.status === 400) {
          setError("El conteo debe ser un entero no negativo");
        } else {
          setError("No se pudo cerrar la caja — revisá la conexión");
          return;
        }
      } else {
        const local = await closeLocalShift(db, tenantId, { counted: amount });
        showToast?.(`Caja cerrada — dif ${cop(local.diff)}`);
        setCounted("");
      }
      await refresh();
      onMutated?.();
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      if (code === "NO_OPEN_SHIFT") setError("No hay caja abierta");
      else if (code === "NEGATIVE_COUNTED")
        setError("El conteo no puede ser negativo");
      else if (code === "ALREADY_CLOSED") setError("La caja ya estaba cerrada");
      else setError("No se pudo cerrar la caja");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen arqueo">
      <h2>Caja (arqueo)</h2>
      <p className="muted">El esperado excluye ventas anuladas. Las cajas cerradas conservan su arqueo y no admiten nuevas anulaciones.</p>

      {openShift ? (
        <>
          <div className="card" data-testid="shift-card">
            <div className="row space-between">
              <span>Caja abierta</span>
              <strong data-testid="shift-opened-at">{when(openShift.opened_at)}</strong>
            </div>
            <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
              {online ? "Cerrá con el conteo físico del cajón." : "Sin conexión: el cierre se calcula localmente y sincroniza después."}
            </p>
          </div>

          <div className="card" data-testid="expected-card">
            <h3>Esperado (de pagos)</h3>
            <div className="row space-between">
              <span>Efectivo confirmado</span>
              <strong data-testid="expected-cash">{cop(expected?.cash ?? 0)}</strong>
            </div>
            <div className="row space-between">
              <span>Transferencias confirmadas</span>
              <strong data-testid="expected-transfers">{cop(expected?.transfers ?? 0)}</strong>
            </div>
            <div className="row space-between">
              <span>Pendientes de confirmar (excluidas)</span>
              <strong data-testid="expected-pending">{cop(expected?.pending ?? 0)}</strong>
            </div>
            <div className="row space-between total-row">
              <span>Total esperado</span>
              <strong data-testid="expected-total">{cop(expected?.expected ?? 0)}</strong>
            </div>
          </div>

          <label htmlFor="counted">Conteo de efectivo</label>
          <input
            id="counted"
            data-testid="counted"
            inputMode="numeric"
            value={counted}
            placeholder="0"
            onChange={(e) => setCounted(e.target.value.replace(/[^\d]/g, ""))}
          />

          {error && (
            <p className="error" data-testid="arqueo-error" role="alert">
              {error}
            </p>
          )}

          <button
            className="btn primary big"
            data-testid="close-shift"
            disabled={busy}
            onClick={() => void handleClose()}
          >
            Cerrar caja
          </button>
        </>
      ) : (
        <>
          <div className="empty-state" data-testid="no-open-shift">
            <h2>Sin caja abierta</h2>
            <p className="muted">Abrí la caja para empezar a registrar ventas del turno.</p>
          </div>
          {error && (
            <p className="error" data-testid="arqueo-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="btn primary big"
            data-testid="open-shift"
            disabled={busy}
            onClick={() => void handleOpen()}
          >
            Abrir caja
          </button>
        </>
      )}

      {history.length > 0 && (
        <div className="history" data-testid="close-history">
          <h3>Cierres anteriores</h3>
          {history.map((c) => (
            <div className="card" key={c.id}>
              <div className="row space-between">
                <span className="muted">{when(c.created_at)}</span>
                <strong data-testid="history-diff">
                  dif {cop(c.diff)}
                </strong>
              </div>
              <div className="row space-between">
                <span>Esperado {cop(c.expected)} · Contado {cop(c.counted)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
