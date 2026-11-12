import { useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { registerLocalCashMovement } from "../db/local";

/** Append-only cash ledger. Both owner and member may operate Caja. */
export function CashMovementModal({ open, db, tenantId, onClose, onRegistered }: {
  open: boolean; db: PGlite; tenantId: string; onClose: () => void; onRegistered: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const valid = /^\d+$/.test(amount) && Number(amount) > 0 && Number(amount) <= 2147483647;
  useEffect(() => {
    if (open && !dialog.current?.open) {
      setAmount(""); setReason(""); setNote(""); setDirection("in"); setError(null);
      lock.current = false; setBusy(false);
      dialog.current?.showModal();
      dialog.current?.querySelector<HTMLInputElement>("#movement-amount")?.focus();
    } else if (!open) dialog.current?.close();
  }, [open]);
  function dismiss() {
    if (lock.current) return;
    dialog.current?.close(); onClose();
  }
  async function submit() {
    if (lock.current || !valid || !reason.trim()) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      await registerLocalCashMovement(db, tenantId, { direction, amount: Number(amount), reason: reason.trim(), note: note.trim() || null });
      dialog.current?.close(); onRegistered();
    } catch (err) {
      setError(err instanceof Error && err.message === "SHIFT_REQUIRED"
        ? "No hay un turno abierto. Abrí una caja antes de registrar movimientos."
        : "No se pudo guardar el movimiento. Revisá los datos e intentá de nuevo.");
    } finally { lock.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="cash-movement-modal" data-testid="cash-movement-modal" aria-labelledby="movement-title"
    onCancel={e => { if (lock.current) e.preventDefault(); else onClose(); }}>
    {open && <>
      <div className="modal-head"><h3 id="movement-title">Ingreso / Retiro de Efectivo</h3>
        <button className="modal-x" aria-label="Cerrar movimiento" disabled={busy} onClick={dismiss}>✕</button></div>
      <form className="cash-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
        <fieldset disabled={busy}><legend>Tipo de movimiento</legend><div className="seg">
          <button type="button" data-testid="movement-in" aria-pressed={direction === "in"} className={direction === "in" ? "active" : ""} onClick={() => setDirection("in")}>Ingreso</button>
          <button type="button" data-testid="movement-out" aria-pressed={direction === "out"} className={direction === "out" ? "active" : ""} onClick={() => setDirection("out")}>Retiro</button>
        </div></fieldset>
        <label htmlFor="movement-amount">Monto en efectivo (COP)</label>
        <input id="movement-amount" data-testid="movement-amount" autoFocus inputMode="numeric" value={amount} disabled={busy}
          aria-invalid={amount !== "" && !valid} aria-describedby="movement-amount-help" onChange={e => setAmount(e.target.value)} placeholder="Ingresá el importe" />
        <p id="movement-amount-help" className={amount && !valid ? "error" : "muted"}>Entero mayor a 0, hasta 2.147.483.647; sin decimales.</p>
        <label htmlFor="movement-reason">Motivo</label>
        <input id="movement-reason" data-testid="movement-reason" value={reason} maxLength={120} disabled={busy} required onChange={e => setReason(e.target.value)} placeholder="Ej.: reposición de cambio, pago a proveedor" />
        <label htmlFor="movement-note">Nota (opcional)</label>
        <textarea id="movement-note" data-testid="movement-note" value={note} maxLength={500} disabled={busy} rows={2} onChange={e => setNote(e.target.value)} />
        <p className="muted">Registro auditable e inmutable del turno. No crea una venta ni un abono. Sin conexión, queda pendiente de sincronización.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary big" data-testid="movement-save" disabled={busy || !valid || !reason.trim()} aria-busy={busy}>
          {busy ? "Guardando…" : "Guardar Movimiento"}</button>
      </form>
    </>}
  </dialog>;
}
