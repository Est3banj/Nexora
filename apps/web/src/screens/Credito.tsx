import { useCallback, useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { paymentMethodLabel, type CustomerAccountRow } from "@pos/shared";
import {
  listCustomerAccounts,
  getLocalCustomer,
  listLocalCustomerAbonos,
  listLocalCustomerTickets,
  listLocalInactiveCustomers,
  updateLocalCustomer,
  type LocalAbonoRow,
  type LocalCustomer,
} from "../db/local";
import { useSync } from "../hooks/useSync";
import { type RoleHint } from "../components/navigation";
import { ClientModal } from "../components/ClientModal";
import { AbonoModal, type AbonoResult } from "../components/AbonoModal";
import { ReceiptPreview, pickReceiptIdentity, type ReceiptData } from "../components/ReceiptPreview";
import type { PublicSettings } from "../lib/settings";

/**
 * M6 ·13.1/13.2 — Clientes & Cuentas por Cobrar (Fiados).
 * Prototype §7 (HTML 592–622) + cards JS (1624–1732), REAL data:
 *
 *  - banner «Total pendiente de cobro» = Σ positive balances of the ACTIVE
 *    view dataset, independent of the text search (reports spec §Search
 *    does not rewrite total debt);
 *  - cards for ALL active accounts incl. zero-balance «Al Día» and the
 *    configured limit (CUSTOMER_ACCOUNTS_SQL, no positive filter — the
 *    Por Cobrar report keeps balance > 0 elsewhere);
 *  - negative balances are surfaced for reconciliation, NEVER clamped to
 *    zero nor labelled Al Día (reports spec §Complete customer accounts);
 *  - Nuevo/Editar via ClientModal (explicit limit, soft delete/reactivate);
 *  - Registrar Abono: ANY verified role — owner, admin AND member
 *    (roles-admin decision #1, supersedes fiado #6 "owner-only"); the
 *    pre-gate is `role !== null` so an UNVERIFIED role keeps hiding it
 *    (server per-item rejection stays authoritative regardless) and
 *    disabled with a reason when the balance is 0 (abonos spec §All paid
 *    customer);
 *  - detail dialog lists the customer's tickets AND their own-table abonos;
 *  - offline-first: reads run on PGlite, staleness banner while the queue
 *    is pending, over-limit state visible locally (and after server sync).
 */

const cop = (n: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(n);

/** Same fold as the Venta picker (NFD + case; phone = digit substring). */
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

type Props = {
  db: PGlite;
  tenantId: string;
  refreshToken: number;
  /** Role hint lifted from App (roles-admin 5.2) — never authority. */
  role: RoleHint;
  /** Cached tenant settings (3.10): default credit limit + receipt identity. */
  settings: PublicSettings;
  tenantName?: string;
  showToast: (msg: string, kind?: "success" | "info" | "warning" | "error") => void;
  onMutated: () => void;
};

type DetailState = {
  account: CustomerAccountRow;
  abonos: LocalAbonoRow[];
  tickets: Awaited<ReturnType<typeof listLocalCustomerTickets>>;
};

export function Credito({
  db,
  tenantId,
  refreshToken,
  role,
  settings,
  tenantName,
  showToast,
  onMutated,
}: Props) {
  const sync = useSync();
  // roles-admin 2.6 · FLIP de abonos (decisión #1 — supersede fiado #6):
  // el form (:335) y el modal (:427) se renderizan IFF `role !== null`
  // (cualquier rol VERIFICADO, member incluido). `null` (rol no verificado)
  // sigue ocultando → e2e "unverified role never exposes collection
  // controls" (count 0) queda verde. Transfer-confirm NO se toca acá
  // (sigue dueño-tier en Tickets.tsx / Sale.tsx). El fetch del rol vive en
  // App (5.2) — este componente sólo consume el hint.
  const canRegisterAbono = role !== null;

  const [rows, setRows] = useState<CustomerAccountRow[]>([]);
  const [inactive, setInactive] = useState<LocalCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const [modal, setModal] = useState<{ open: boolean; customer: LocalCustomer | null }>({
    open: false,
    customer: null,
  });
  const [abonoTarget, setAbonoTarget] = useState<CustomerAccountRow | null>(null);
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const accounts = await listCustomerAccounts(db, tenantId);
      setRows(accounts);
      if (showInactive) setInactive(await listLocalInactiveCustomers(db, tenantId));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [db, tenantId, showInactive]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken, retry]);

  /* Detail = account + own-table abonos + credit-bearing history (one read
   * per open; no auto-polling — refreshToken refreshes it after a write). */
  useEffect(() => {
    if (!detailId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    void (async () => {
      try {
        const account = rows.find((r) => r.customer_id === detailId);
        if (!account) {
          if (alive) setDetail(null);
          return;
        }
        const [abonos, tickets] = await Promise.all([
          listLocalCustomerAbonos(db, tenantId, detailId),
          listLocalCustomerTickets(db, tenantId, detailId),
        ]);
        if (alive) setDetail({ account, abonos, tickets });
      } catch {
        if (alive) setDetail(null);
      } finally {
        if (alive) setDetailLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [detailId, rows, db, tenantId, refreshToken]);

  /* Banner total: positive balances ONLY, over the whole active dataset —
   * the search must never rewrite it (reports spec). */
  const totalDebt = rows.reduce((acc, r) => acc + Math.max(0, r.balance), 0);

  const q = search.trim();
  const qFold = fold(q);
  const qDigits = q.replace(/\D/g, "");
  const visible = rows.filter((r) => {
    if (!q) return true;
    if (fold(r.name).includes(qFold)) return true;
    return qDigits.length > 0 && (r.phone ?? "").replace(/\D/g, "").includes(qDigits);
  });

  function badgeFor(balance: number) {
    if (balance > 0) return { cls: "client-badge debt", label: "Con Deuda" };
    if (balance === 0) return { cls: "client-badge dia", label: "Al Día" };
    /* Negative = ledger inconsistency to reconcile — never «Al Día». */
    return { cls: "client-badge neg", label: "Saldo negativo" };
  }

  async function reactivate(customer: LocalCustomer) {
    try {
      await updateLocalCustomer(db, tenantId, customer.id, { active: true });
      showToast(`${customer.name} reactivado (pendiente de sync)`);
      onMutated();
      setRetry((n) => n + 1);
    } catch {
      showToast("No se pudo reactivar el cliente", "error");
    }
  }

  async function editCustomer(id: string) {
    try {
      const customer = await getLocalCustomer(db, tenantId, id);
      if (!customer) throw new Error("CUSTOMER_NOT_FOUND");
      setModal({ open: true, customer });
    } catch {
      showToast("No se pudo consultar el cliente para editarlo", "error");
    }
  }

  function onAbonoRegistered(result: AbonoResult) {
    const target = abonoTarget;
    setAbonoTarget(null);
    if (target) {
      setReceipt({
        kind: "abono",
        abono: {
          id: result.id,
          amount: result.amount,
          method: result.method,
          created_at: result.created_at,
          note: result.note,
        },
        customerName: target.name,
        balanceAfter: result.balanceAfter,
        tenantName,
      });
      showToast(
        `Abono de ${cop(result.amount)} registrado para ${target.name} (pendiente de sync)`,
      );
    }
    onMutated();
  }

  return (
    <section className="screen credito" data-testid="customer-accounts" aria-busy={loading}>
      {/* Prototype banner (HTML 595–607): gradient + eyebrow + CTA */}
      <div className="credit-banner" data-testid="credit-banner">
        <div>
          <span className="credit-eyebrow">
            <span className="credit-dot" aria-hidden="true" />
            Cuentas por Cobrar (Fiados)
          </span>
          <h2>Gestión de Crédito a Clientes</h2>
          <p className="credit-total">
            Total pendiente de cobro en calle:{" "}
            <strong className="mono" data-testid="total-debt">
              {cop(totalDebt)}
            </strong>
          </p>
        </div>
        <button
          type="button"
          className="btn primary credit-new"
          data-testid="client-new"
          onClick={() => setModal({ open: true, customer: null })}
        >
          Nuevo Cliente Fiado
        </button>
      </div>

      {(!sync.online || sync.pending > 0) && (
        <div className="warn-banner" data-testid="credito-staleness" role="status">
          Saldos posiblemente incompletos — {sync.online ? `${sync.pending} cambio(s) sin sincronizar.` : "sin conexión; datos del dispositivo."}
        </div>
      )}

      <div className="credit-search-row">
        <input
          className="search-input"
          type="search"
          data-testid="clients-search"
          placeholder="Buscar cliente por nombre o teléfono..."
          aria-label="Buscar cliente por nombre o teléfono"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="check-row" htmlFor="clients-inactive">
          <input
            id="clients-inactive"
            data-testid="clients-inactive-toggle"
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          <span>Inactivos</span>
        </label>
      </div>

      {error && (
        <p className="error" role="alert">
          No se pudieron consultar las cuentas.{" "}
          <button className="btn small" onClick={() => setRetry((n) => n + 1)}>
            Reintentar
          </button>
        </p>
      )}

      {loading && rows.length === 0 ? (
        <p role="status">Consultando cuentas…</p>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <p data-testid="empty-clients">Todavía no hay clientes activos.</p>
          <p className="muted">Creá el primer cliente fiado para empezar a vender a crédito.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <p data-testid="no-client-results">No se encontraron clientes registrados</p>
        </div>
      ) : (
        <div className="client-grid" data-testid="clients-grid">
          {visible.map((r) => {
            const badge = badgeFor(r.balance);
            const overLimit = r.credit_limit !== null && r.balance > r.credit_limit;
            const zero = r.balance <= 0;
            return (
              <article className="card client-card" key={r.customer_id} data-testid="client-card">
                <header className="client-head">
                  <div>
                    <h3>{r.name}</h3>
                    <p className="muted mono">Tel: {r.phone ?? "—"}</p>
                  </div>
                  <span className={badge.cls} data-testid="client-badge">
                    {badge.label}
                  </span>
                </header>

                <div className="client-money mono">
                  <div className="row space-between">
                    <span className="muted">Saldo Pendiente:</span>
                    <strong className={r.balance > 0 ? "neg-amount" : ""} data-testid="client-balance">
                      {cop(r.balance)}
                    </strong>
                  </div>
                  <div className="row space-between">
                    <span className="muted">Límite de Crédito:</span>
                    <strong data-testid="client-limit-value">
                      {r.credit_limit === null ? "Sin configurar" : cop(r.credit_limit)}
                    </strong>
                  </div>
                  <div className="row space-between">
                    <span className="muted">Crédito usado / cobrado:</span>
                    <span>
                      {cop(r.credit)} / {cop(r.abonos)}
                    </span>
                  </div>
                </div>

                {overLimit && (
                  <p className="fiado-block" role="status" data-testid="client-over-limit">
                    La cuenta excede su límite de crédito configurado — cobrá
                    o ajustá el límite antes de vender más a crédito.
                  </p>
                )}

                <footer className="client-actions">
                  {canRegisterAbono && (
                    <>
                      <button
                        type="button"
                        className="btn primary client-abono-btn"
                        data-testid="client-abono"
                        disabled={zero}
                        title={zero ? "Sin saldo pendiente — no hay nada por cobrar" : undefined}
                        onClick={() => setAbonoTarget(r)}
                      >
                        Registrar Abono
                      </button>
                      {zero && (
                        <span className="muted client-abono-reason" data-testid="client-abono-reason">
                          Sin saldo pendiente — no hay nada por cobrar.
                        </span>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    className="btn ghost"
                    data-testid="client-edit"
                     onClick={() => void editCustomer(r.customer_id)}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    data-testid="client-detail"
                    onClick={() => setDetailId(r.customer_id)}
                  >
                    Ver detalle
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {showInactive && (
        <div className="card client-inactive" data-testid="inactive-list">
          <h3>Inactivos</h3>
          {inactive.length === 0 ? (
            <p className="muted">Sin clientes inactivos.</p>
          ) : (
            inactive.map((c) => (
              <div className="row space-between client-inactive-row" key={c.id}>
                <span>
                  {c.name} <span className="muted mono">· {c.phone ?? "sin teléfono"}</span>
                </span>
                <button
                  type="button"
                  className="btn small"
                  data-testid="client-reactivate"
                  onClick={() => void reactivate(c)}
                >
                  Reactivar
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── detalle: tickets + abonos (own table) ── */}
      <ClientDetailModal
        detailId={detailId}
        detail={detail}
        loading={detailLoading}
        onClose={() => setDetailId(null)}
      />

      <ClientModal
        open={modal.open}
        db={db}
        tenantId={tenantId}
        customer={modal.customer}
        /* roles-admin 5.10 / D4b — UI pre-fill ONLY: the cached default seeds
         * the field for NEW customers; an explicit value (or an explicit 0)
         * the operator types is never overwritten, and the server still never
         * injects defaults (local.ts CREDIT_LIMIT_REQUIRED untouched). */
        defaultLimit={settings.default_credit_limit}
        onClose={() => setModal({ open: false, customer: null })}
        onSaved={(saved) => {
          setModal({ open: false, customer: null });
          showToast(
            `${saved.name} ${modal.customer ? "actualizado" : "registrado"} (pendiente de sync)`,
          );
          onMutated();
          setRetry((n) => n + 1);
        }}
      />

      <AbonoModal
        open={canRegisterAbono && abonoTarget !== null}
        db={db}
        tenantId={tenantId}
        account={abonoTarget}
        onClose={() => setAbonoTarget(null)}
        onRegistered={onAbonoRegistered}
      />

      <ReceiptPreview
        open={receipt !== null}
        data={receipt}
        identity={pickReceiptIdentity(settings)}
        onClose={() => setReceipt(null)}
      />
    </section>
  );
}

/**
 * Native modal detail (showModal so Escape/focus-return/inert background
 * actually work — an `open` attribute dialog gets none of that).
 */
function ClientDetailModal({
  detailId,
  detail,
  loading,
  onClose,
}: {
  detailId: string | null;
  detail: DetailState | null;
  loading: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (detailId && !dialog.open) dialog.showModal();
    else if (!detailId && dialog.open) dialog.close();
  }, [detailId]);

  return (
    <dialog
      ref={ref}
      className="client-detail-modal"
      data-testid="client-detail-modal"
      aria-labelledby="client-detail-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {detailId && (
        <div className="modal-head">
          <h3 id="client-detail-title">Detalle de cuenta</h3>
          <button
            type="button"
            className="modal-x"
            data-testid="detail-close"
            aria-label="Cerrar detalle"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      )}
      {loading && <p role="status">Consultando…</p>}
      {!loading && detail && (
        <div className="detail-body">
          <div className="detail-summary">
            <strong>{detail.account.name}</strong>
            <span className="muted mono">{detail.account.phone ?? "sin teléfono"}</span>
            <div className="client-money mono">
              <div className="row space-between">
                <span className="muted">Saldo:</span>
                <strong data-testid="detail-balance">{cop(detail.account.balance)}</strong>
              </div>
              <div className="row space-between">
                <span className="muted">Límite:</span>
                <span>
                  {detail.account.credit_limit === null
                    ? "Sin configurar"
                    : cop(detail.account.credit_limit)}
                </span>
              </div>
            </div>
          </div>

          <h4>Abonos registrados</h4>
          {detail.abonos.length === 0 ? (
            <p className="muted" data-testid="detail-abonos-empty">
              Sin abonos todavía.
            </p>
          ) : (
            <ul className="detail-list" data-testid="detail-abonos">
              {detail.abonos.map((a) => (
                <li key={a.id} className="row space-between">
                  <span className="muted mono">
                    {new Date(a.created_at).toLocaleString("es-CO", {
                      dateStyle: "short",
                      timeStyle: "short",
                      timeZone: "America/Bogota",
                    })}{" "}
                    · {paymentMethodLabel(a.method)}
                    {a.ticket_id ? ` · ticket #${detail.tickets.find(t => t.id === a.ticket_id)?.ticket_no ?? a.ticket_id}` : " · cliente (sin aplicar)"}
                  </span>
                  <strong className="mono">{cop(a.amount)}</strong>
                </li>
              ))}
            </ul>
          )}

          <h4>Tickets del cliente</h4>
          {detail.tickets.length === 0 ? (
            <p className="muted" data-testid="detail-tickets-empty">
              Sin tickets todavía.
            </p>
          ) : (
            <ul className="detail-list" data-testid="detail-tickets">
              {detail.tickets.map((t) => (
                <li key={t.id} className="row space-between">
                  <span className="muted mono">
                    #{t.ticket_no} ·{" "}
                    {new Date(t.created_at).toLocaleDateString("es-CO", { timeZone: "America/Bogota" })} ·{" "}
                    {paymentMethodLabel(t.method ?? null)}
                    {t.status === "voided" ? " · anulado" : ""}
                  </span>
                  <span className="mono">Crédito: {cop(t.credit_amount)} · Abonos aplicados: {cop(t.attributed_abonos)} · Total venta: {cop(t.total)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </dialog>
  );
}
