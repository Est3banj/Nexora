import { useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import {
  createLocalTable,
  updateLocalTable,
  MESAS_ERRORS,
  type LocalTable,
} from "../db/local-orders";

/**
 * Modal Mesa (create / edit) — the ONE surface behind both the board's
 * «+ Agregar Mesa» and the Admin «Mesas» section (same shape as Cajas /
 * Empleados: lista + modal).
 *
 * Fields: nombre (obligatorio), zona (las 3 existentes + «Otra…» libre),
 * capacidad entero ≥ 1, activo/inactivo (soft-hide — an occupied table
 * CANNOT be deactivated, the data layer refuses it with TABLE_IN_USE so a
 * comanda is never silently destroyed).
 *
 * Native <dialog>: focus return, Escape (except while saving), inert
 * background. Draft survives a validation error.
 */

export const TABLE_ZONES = ["Salón Principal", "Terraza", "Barra"] as const;
const CUSTOM_ZONE = "Otra…";

type Props = {
  open: boolean;
  db: PGlite;
  tenantId: string;
  /** null → alta nueva · row → editar */
  table: LocalTable | null;
  onClose: () => void;
  onSaved: (table: LocalTable) => void;
};

export function TableModal({ open, db, tenantId, table, onClose, onSaved }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [zone, setZone] = useState<string>(TABLE_ZONES[0]);
  const [customZone, setCustomZone] = useState("");
  const [capacity, setCapacity] = useState("4");
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const editing = table !== null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setName(table?.name ?? "");
      const currentZone = table?.zone ?? TABLE_ZONES[0];
      const known = (TABLE_ZONES as readonly string[]).includes(currentZone);
      setZone(known ? currentZone : CUSTOM_ZONE);
      setCustomZone(known ? "" : currentZone);
      setCapacity(String(table?.capacity ?? 4));
      setActive(table?.active ?? true);
      setError(null);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, table]);

  function requestClose() {
    if (busyRef.current) return;
    dialogRef.current?.close();
    onClose();
  }

  async function save() {
    if (busyRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Ingresá el nombre de la mesa");
      return;
    }
    const zoneValue =
      zone === CUSTOM_ZONE ? customZone.trim() : zone;
    if (!zoneValue) {
      setError("Ingresá la zona de la mesa");
      return;
    }
    if (!/^\d+$/.test(capacity.trim())) {
      setError("La capacidad debe ser un entero ≥ 1");
      return;
    }
    const capacityValue = Number(capacity.trim());
    if (!Number.isInteger(capacityValue) || capacityValue < 1 || capacityValue > 999) {
      setError("La capacidad debe ser un entero entre 1 y 999");
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      let saved: LocalTable;
      if (editing) {
        await updateLocalTable(db, tenantId, table.id, {
          name: trimmed,
          zone: zoneValue,
          capacity: capacityValue,
          active,
        });
        saved = { ...table, name: trimmed, zone: zoneValue, capacity: capacityValue, active };
      } else {
        saved = await createLocalTable(db, tenantId, {
          name: trimmed,
          zone: zoneValue,
          capacity: capacityValue,
          active,
        });
      }
      busyRef.current = false;
      setBusy(false);
      dialogRef.current?.close();
      onSaved(saved);
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      setError(
        code === MESAS_ERRORS.TABLE_NAME_TAKEN
          ? "Ya existe una mesa activa con ese nombre"
          : code === MESAS_ERRORS.TABLE_IN_USE
            ? MESAS_ERRORS.TABLE_IN_USE
            : code === MESAS_ERRORS.TABLE_NOT_FOUND
              ? MESAS_ERRORS.TABLE_NOT_FOUND
              : "No se pudo guardar la mesa",
      );
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="client-modal table-modal"
      data-testid="table-modal"
      aria-labelledby="table-modal-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      {open && (
        <>
          <div className="modal-head">
            <h3 id="table-modal-title">{editing ? "Editar Mesa" : "Agregar Mesa"}</h3>
            <button
              type="button"
              className="modal-x"
              data-testid="table-modal-close"
              aria-label="Cerrar"
              disabled={busy}
              onClick={requestClose}
            >
              ✕
            </button>
          </div>

          <form
            className="modal-form"
            /* Our Spanish validation is the single source of truth — native
             * bubbles would block submit before `save()` can explain why. */
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div>
              <label htmlFor="table-name">Nombre / número</label>
              <input
                id="table-name"
                data-testid="table-name"
                value={name}
                maxLength={60}
                autoComplete="off"
                autoFocus
                required
                disabled={busy}
                placeholder="Mesa 1"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="grid-2">
              <div>
                <label htmlFor="table-zone">Zona</label>
                <select
                  id="table-zone"
                  data-testid="table-zone"
                  value={zone}
                  disabled={busy}
                  onChange={(e) => setZone(e.target.value)}
                >
                  {TABLE_ZONES.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                  <option value={CUSTOM_ZONE}>{CUSTOM_ZONE}</option>
                </select>
              </div>
              <div>
                <label htmlFor="table-capacity">Capacidad (pers.)</label>
                <input
                  id="table-capacity"
                  data-testid="table-capacity"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={999}
                  step={1}
                  className="mono"
                  value={capacity}
                  disabled={busy}
                  onChange={(e) => setCapacity(e.target.value)}
                />
              </div>
            </div>

            {zone === CUSTOM_ZONE && (
              <div>
                <label htmlFor="table-zone-custom">Zona libre</label>
                <input
                  id="table-zone-custom"
                  data-testid="table-zone-custom"
                  value={customZone}
                  maxLength={60}
                  autoComplete="off"
                  disabled={busy}
                  placeholder="Patio, Barra lateral…"
                  onChange={(e) => setCustomZone(e.target.value)}
                />
              </div>
            )}

            <label className="check-row" htmlFor="table-active">
              <input
                id="table-active"
                type="checkbox"
                data-testid="table-active"
                checked={active}
                disabled={busy}
                onChange={(e) => setActive(e.target.checked)}
              />
              <span>
                Mesa activa
                <small>
                  {editing && !active
                    ? "Inactiva: no aparece en el tablero."
                    : "Se muestra en el tablero de mesas."}
                </small>
              </span>
            </label>

            {error && (
              <p id="table-error" className="error" role="alert" data-testid="table-error">
                {error}
              </p>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                data-testid="table-cancel"
                disabled={busy}
                onClick={requestClose}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="btn primary"
                data-testid="table-submit"
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? "Guardando…" : editing ? "Guardar cambios" : "Crear mesa"}
              </button>
            </div>
          </form>
        </>
      )}
    </dialog>
  );
}
