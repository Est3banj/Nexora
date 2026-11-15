import { useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { CreditCard, Plus, ReceiptText, Utensils, X } from "lucide-react";
import { isDueñoHint, type RoleHint } from "../components/navigation";
import { TableModal } from "../components/TableModal";
import {
  listBoardTables,
  releaseTable,
  setTableBilling,
  type BoardTable,
  type LocalTable,
} from "../db/local-orders";
import type { ToastKind } from "../components/Toast";
import "./mesas.css";

/**
 * Fase 1 · Board «Control de Mesas & Comandas» (tab `mesas`, tier all —
 * the same tier as Venta, because serving a table IS selling).
 *
 * Layout follows the reference composition: hero (eyebrow + H + subtítulo)
 * with the status pills + «+ Agregar Mesa» on the right, then a FLAT grid of
 * one card per table (zone lives in each card header — no grouping by zone).
 *
 * Every affordance reuses the POS instead of duplicating it:
 *  · DISPONIBLE → sets `activeTableId` and lands on Venta with a clean cart
 *    (the banner says which table is being attended);
 *  · OCUPADA «Abrir / Cobrar» → loads the comanda into the POS cart and
 *    resumes it (decision documented in CONTROL-MESAS.md: NO drawer — one
 *    serving surface, zero duplicated cart/payment code);
 *  · «Pedir cuenta» → table.status = billing;
 *  · ✕ → confirm dialog, then the order is CANCELLED and the table freed
 *    (never a ticket — liberar sin cobrar is explicit and auditable).
 *
 * «+ Agregar Mesa» renders ONLY for Dueño/Admin (decision #5) — a cashier
 * gets the board, not the catalog of tables.
 */

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);

const hhmm = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" })
    : "—";

const STATUS_LABEL = { available: "DISPONIBLE", occupied: "OCUPADA", billing: "POR COBRAR" } as const;

type Props = {
  db: PGlite;
  tenantId: string;
  refreshToken: number;
  role: RoleHint;
  showToast: (message: string, kind?: ToastKind) => void;
  onOpenTable: (table: BoardTable, mode: "new" | "resume") => void;
};

export function Mesas({ db, tenantId, refreshToken, role, showToast, onOpenTable }: Props) {
  const [tables, setTables] = useState<BoardTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTarget, setModalTarget] = useState<LocalTable | null>(null);
  const [releaseTarget, setReleaseTarget] = useState<BoardTable | null>(null);
  const releaseDialog = useRef<HTMLDialogElement>(null);

  const canManage = isDueñoHint(role);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    listBoardTables(db, tenantId)
      .then((rows) => {
        if (alive) setTables(rows);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [db, tenantId, refreshToken, reload]);

  useEffect(() => {
    const dialog = releaseDialog.current;
    if (!dialog) return;
    if (releaseTarget && !dialog.open) dialog.showModal();
    else if (!releaseTarget && dialog.open) dialog.close();
  }, [releaseTarget]);

  const counts = {
    available: tables.filter((t) => t.status === "available").length,
    occupied: tables.filter((t) => t.status === "occupied").length,
    billing: tables.filter((t) => t.status === "billing").length,
  };

  async function confirmRelease() {
    if (!releaseTarget) return;
    try {
      await releaseTable(db, tenantId, releaseTarget.id);
      showToast("Mesa liberada · la comanda quedó cancelada (sin ticket)");
      setReload((n) => n + 1);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo liberar la mesa", "error");
    } finally {
      setReleaseTarget(null);
    }
  }

  async function askBill(table: BoardTable) {
    try {
      await setTableBilling(db, tenantId, table.id);
      showToast(`Cuenta pedida en ${table.name}`);
      setReload((n) => n + 1);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "No se pudo pedir la cuenta", "error");
    }
  }

  return (
    <div className="screen mesas" data-testid="mesas-screen">
      <header className="mesas-hero">
        <div className="mesas-hero-copy">
          <p className="mesas-eyebrow">GESTIÓN DE SALÓN &amp; COMANDAS</p>
          <h2>Control de Mesas en Tiempo Real</h2>
          <p className="muted">
            Selecciona una mesa para abrir cuenta, agregar productos o liquidar el cobro en caja.
          </p>
        </div>
        <div className="mesas-hero-actions">
          <div className="mesas-pills" role="status" aria-label="Estado del salón">
            <span className="mesas-pill available" data-testid="count-available">
              ● Disponible ({counts.available})
            </span>
            <span className="mesas-pill occupied" data-testid="count-occupied">
              ● Ocupada ({counts.occupied})
            </span>
            {counts.billing > 0 && (
              <span className="mesas-pill billing" data-testid="count-billing">
                ● Por cobrar ({counts.billing})
              </span>
            )}
          </div>
          {canManage && (
            <button
              type="button"
              className="btn primary"
              data-testid="table-add"
              onClick={() => {
                setModalTarget(null);
                setModalOpen(true);
              }}
            >
              <Plus size={16} aria-hidden="true" />
              Agregar Mesa
            </button>
          )}
        </div>
      </header>

      {error && (
        <div role="alert" data-testid="mesas-error">
          <p>No se pudieron cargar las mesas.</p>
          <button type="button" className="btn" onClick={() => setReload((n) => n + 1)}>
            Reintentar
          </button>
        </div>
      )}

      {loading && tables.length === 0 && !error && <p role="status">Consultando mesas…</p>}

      {!loading && !error && tables.length === 0 && (
        <div className="empty-state" data-testid="mesas-empty">
          <h2>Sin mesas cargadas</h2>
          <p className="muted">
            {canManage
              ? "Creá la primera mesa con «+ Agregar Mesa» para empezar a atender."
              : "Todavía no hay mesas cargadas en este comercio."}
          </p>
        </div>
      )}

      {tables.length > 0 && (
        <div className="mesas-grid" data-testid="tables-grid">
          {tables.map((table) => (
            <article
              key={table.id}
              className={`mesas-card ${table.status}`}
              data-testid="table-card"
              data-table-id={table.id}
              data-state={table.status}
              /* Clicking anywhere on a FREE card opens it in POS — the green
               * CTA inside does the same (stopPropagation → one navigation). */
              onClick={
                table.status === "available" ? () => onOpenTable(table, "new") : undefined
              }
            >
              <header className="mesas-card-head">
                <span className="mesas-card-zone">
                  {(table.zone ?? "Sin zona").toUpperCase()} · {table.capacity} PERS.
                </span>
                <span className={`mesas-badge ${table.status}`} data-testid="table-badge">
                  {STATUS_LABEL[table.status]}
                </span>
              </header>

              <h3 className="mesas-card-name">{table.name}</h3>

              {table.status === "available" ? (
                <div className="mesas-card-body available-body">
                  <Utensils size={28} aria-hidden="true" className="mesas-placeholder-icon" />
                  <p className="muted" data-testid="table-placeholder">
                    Mesa libre lista para atender
                  </p>
                  <button
                    type="button"
                    className="btn success"
                    data-testid="table-open"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenTable(table, "new");
                    }}
                  >
                    <Plus size={16} aria-hidden="true" />
                    Abrir Mesa en POS
                  </button>
                </div>
              ) : (
                <div className="mesas-card-body occupied-body">
                  <dl className="mesas-consumption">
                    <div>
                      <dt>Abierta</dt>
                      <dd className="mono" data-testid="table-opened">
                        {hhmm(table.opened_at)}
                      </dd>
                    </div>
                    <div>
                      <dt>Ítems</dt>
                      <dd className="mono" data-testid="table-items">
                        {table.items}
                      </dd>
                    </div>
                    <div className="full">
                      <dt>Consumo Actual</dt>
                      <dd className="mono mesas-total" data-testid="table-total">
                        {cop(table.total)}
                      </dd>
                    </div>
                  </dl>

                  <div className="mesas-card-actions">
                    <button
                      type="button"
                      className="btn primary"
                      data-testid="table-charge"
                      onClick={() => onOpenTable(table, "resume")}
                    >
                      <CreditCard size={16} aria-hidden="true" />
                      Abrir / Cobrar
                    </button>
                    {table.status === "occupied" && (
                      <button
                        type="button"
                        className="btn ghost"
                        data-testid="table-bill"
                        onClick={() => void askBill(table)}
                      >
                        <ReceiptText size={16} aria-hidden="true" />
                        Pedir cuenta
                      </button>
                    )}
                    <button
                      type="button"
                      className="mesas-release"
                      data-testid="table-release"
                      aria-label={`Liberar ${table.name} sin cobrar`}
                      title="Liberar sin cobrar"
                      onClick={() => setReleaseTarget(table)}
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <TableModal
        open={modalOpen}
        db={db}
        tenantId={tenantId}
        table={modalTarget}
        onClose={() => setModalOpen(false)}
        onSaved={(saved) => {
          setModalOpen(false);
          setModalTarget(null);
          setReload((n) => n + 1);
          showToast(modalTarget ? `Mesa «${saved.name}» actualizada` : `Mesa «${saved.name}» creada`);
        }}
      />

      <dialog
        ref={releaseDialog}
        className="client-modal release-modal"
        data-testid="release-confirm"
        aria-labelledby="release-title"
        onCancel={() => setReleaseTarget(null)}
        onClose={() => setReleaseTarget(null)}
      >
        {releaseTarget && (
          <>
            <div className="modal-head">
              <h3 id="release-title">Liberar {releaseTarget.name} sin cobrar</h3>
            </div>
            <p>
              La comanda de <strong>{cop(releaseTarget.total)}</strong> se cancela y la mesa queda
              disponible. <strong>No se emite ningún ticket</strong> y no se toca el stock.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                data-testid="release-cancel"
                onClick={() => setReleaseTarget(null)}
              >
                Quedarse
              </button>
              <button
                type="button"
                className="btn danger"
                data-testid="release-confirm-yes"
                onClick={() => void confirmRelease()}
              >
                Liberar mesa
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
