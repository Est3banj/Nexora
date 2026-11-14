import { useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { createLocalCustomer, updateLocalCustomer, type LocalCustomer } from "../db/local";

/**
 * M6 ·13.1 — Modal Cliente (prototype #modal-client, HTML 819–850).
 *
 * Create mode = «Registrar Cliente con Crédito»: nombre, teléfono y LÍMITE
 * COP entero ≥ 0 EXPLÍCITO (customers spec §Explicit credit limit — the
 * prototype's silent `0 || 100000` fallback is forbidden; null/empty is
 * rejected, 0 means "no new credit", never unlimited).
 *
 * Edit mode = name/phone/limit/notes/active (soft delete — reactivate sets
 * active back; the sync pipeline is upsert-only, no hard delete exists).
 * An explicitly cleared limit (`null`) is a deliberate action via the
 * «Sin límite» checkbox — legacy rows keep their configured limit when the
 * field is left untouched.
 *
 * Native <dialog>: focus return, Escape (except while saving), inert
 * background. Draft values survive a validation error (never discarded).
 */

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

type Props = {
  open: boolean;
  db: PGlite;
  tenantId: string;
  /** null → alta nueva · row → editar (incluye reactivar) */
  customer: LocalCustomer | null;
  /**
   * roles-admin 5.10 / D4b — cached `default_credit_limit`, used as the
   * INITIAL value of the limit field for NEW customers only (UI pre-fill;
   * the server never injects defaults). The operator can still clear it
   * (empty → the required-limit validation fires exactly as before) or
   * type an explicit 0 (stays 0 — never overwritten by the default).
   */
  defaultLimit?: number | null;
  onClose: () => void;
  onSaved: (customer: LocalCustomer) => void;
};

export function ClientModal({ open, db, tenantId, customer, defaultLimit, onClose, onSaved }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [limit, setLimit] = useState("");
  const [limitNone, setLimitNone] = useState(false);
  const [notes, setNotes] = useState("");
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const editing = customer !== null;

  /* Open/close lifecycle: reset the draft from the target row (or blank
   * for alta) — a failed submit never closes the dialog. */
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setName(customer?.name ?? "");
      setPhone(customer?.phone ?? "");
      if (customer) {
        setLimit(customer.credit_limit == null ? "" : String(customer.credit_limit));
        setLimitNone(customer.credit_limit === null);
      } else {
        /* Alta: pre-fill con el default cacheado (5.10). Sólo es el valor
         * INICIAL — borrarlo vuelve a disparar la validación obligatoria y
         * un 0 explícito se guarda como 0 (semántica intacta). */
        setLimit(defaultLimit == null ? "" : String(defaultLimit));
        setLimitNone(false);
      }
      setNotes(customer?.notes ?? "");
      setActive(customer?.active ?? true);
      setError(null);
      setBusy(false);
      busyRef.current = false;
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open, customer]);

  function requestClose() {
    if (busyRef.current) return;
    dialogRef.current?.close();
    onClose();
  }

  async function save() {
    if (busyRef.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Ingresá el nombre del cliente");
      return;
    }
    if (trimmed.length > 120) {
      setError("El nombre supera los 120 caracteres");
      return;
    }
    if (phone.trim().length > 40) {
      setError("El teléfono supera los 40 caracteres");
      return;
    }

    let limitValue: number | null;
    if (editing && limitNone) {
      limitValue = null; // explicit clear — legacy "sin configurar"
    } else {
      const digits = limit.replace(/[^\d]/g, "");
      if (limit.trim() === "" || digits === "" || !/^\d+$/.test(limit.trim())) {
        setError(
          editing
            ? "El límite es un entero COP ≥ 0 (o marcá «Sin límite»)"
            : "El límite es un entero COP ≥ 0 obligatorio en altas nuevas",
        );
        return;
      }
      limitValue = Number(digits);
      if (!Number.isInteger(limitValue) || limitValue < 0 || limitValue > 2147483647) {
        setError("El límite debe ser un entero COP entre 0 y 2.147.483.647");
        return;
      }
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = editing
        ? await updateLocalCustomer(db, tenantId, customer.id, {
            // Only user-edited fields: a refresh while this draft is open
            // must not overwrite newer values in unrelated customer fields.
            ...(trimmed !== customer.name ? { name: trimmed } : {}),
            ...((phone.trim() || null) !== customer.phone ? { phone: phone.trim() || null } : {}),
            ...(limitValue !== customer.credit_limit ? { credit_limit: limitValue } : {}),
            ...((notes.trim() || null) !== customer.notes ? { notes: notes.trim() || null } : {}),
            ...(active !== customer.active ? { active } : {}),
          })
        : await createLocalCustomer(db, tenantId, {
            name: trimmed,
            phone: phone.trim() || null,
            credit_limit: limitValue as number,
          });
      dialogRef.current?.close();
      onSaved(saved);
    } catch (err) {
      const code = err instanceof Error ? err.message : String(err);
      setError(
        code === "CREDIT_LIMIT_REQUIRED"
          ? "El límite es obligatorio"
          : code.includes("CUSTOMER_NOT_FOUND")
            ? "Cliente no encontrado en este comercio"
            : "No se pudo guardar el cliente",
      );
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="client-modal"
      data-testid="client-modal"
      aria-labelledby="client-modal-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      {open && (
        <>
          <div className="modal-head">
            <h3 id="client-modal-title">
              {editing ? "Editar Cliente" : "Registrar Cliente con Crédito"}
            </h3>
            <button
              type="button"
              className="modal-x"
              data-testid="client-modal-close"
              aria-label="Cerrar"
              disabled={busy}
              onClick={requestClose}
            >
              ✕
            </button>
          </div>

          <form
            className="modal-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div>
              <label htmlFor="client-name">Nombre Completo</label>
              <input
                id="client-name"
                data-testid="client-name"
                value={name}
                maxLength={120}
                disabled={busy}
                placeholder="Ej: Marcela Benítez"
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="grid-2">
              <div>
                <label htmlFor="client-phone">
                  Teléfono / Celular{editing ? "" : " *"}
                </label>
                <input
                  id="client-phone"
                  data-testid="client-phone"
                  className="mono"
                  inputMode="tel"
                  value={phone}
                  maxLength={40}
                  disabled={busy}
                  placeholder="300 456 7890"
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="client-limit">
                  Límite de Crédito Max ($){editing ? "" : " *"}
                </label>
                <input
                  id="client-limit"
                  data-testid="client-limit"
                  className="mono"
                  inputMode="numeric"
                  value={limitNone ? "" : limit}
                  maxLength={10}
                  disabled={busy || limitNone}
                  placeholder="150000"
                  onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ""))}
                />
              </div>
            </div>

            {editing && (
              <label className="check-row" htmlFor="client-limit-none">
                <input
                  id="client-limit-none"
                  data-testid="client-limit-none"
                  type="checkbox"
                  checked={limitNone}
                  disabled={busy}
                  onChange={(e) => setLimitNone(e.target.checked)}
                />
                <span>
                  Sin límite configurado (deuda existente se conserva ·{" "}
                  {customer?.credit_limit != null
                    ? `antes ${cop(customer.credit_limit)}`
                    : "ya sin límite"}
                  )
                </span>
              </label>
            )}

            {editing && (
              <>
                <div>
                  <label htmlFor="client-notes">Notas</label>
                  <textarea
                    id="client-notes"
                    data-testid="client-notes"
                    value={notes}
                    maxLength={500}
                    rows={2}
                    disabled={busy}
                    placeholder="Referencias, dirección de entrega…"
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
                <label className="check-row" htmlFor="client-active">
                  <input
                    id="client-active"
                    data-testid="client-active"
                    type="checkbox"
                    checked={active}
                    disabled={busy}
                    onChange={(e) => setActive(e.target.checked)}
                  />
                  <span>
                    {active
                      ? "Cliente activo (aparece en el picker de Venta)"
                      : "Inactivo (no aparece en el picker; el historial conserva su nombre)"}
                  </span>
                </label>
              </>
            )}

            {!editing && (
              <p className="muted modal-hint">
                El límite es obligatorio: 0 no concede crédito nuevo, no es
                ilimitado. Legacy sin límite se muestra como «Sin configurar».
              </p>
            )}

            {error && (
              <p className="error" role="alert" data-testid="client-error">
                {error}
              </p>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                data-testid="client-cancel"
                disabled={busy}
                onClick={requestClose}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="btn primary"
                data-testid="client-save"
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? "Guardando…" : "Guardar Cliente"}
              </button>
            </div>
          </form>
        </>
      )}
    </dialog>
  );
}
