import { useCallback, useEffect, useRef, useState } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { paymentMethodLabel, formatTicketNo } from "@pos/shared";
import {
  confirmLocalPayment,
  getLocalTicket,
  listLocalTickets,
  type LocalTicketRow,
} from "../db/local";
import { ReceiptPreview, pickReceiptIdentity } from "../components/ReceiptPreview";
import { annulTicket, AnnulError } from "../db/annul";
import { ticketHasAbonos } from "../db/void-sale";
import { isDueñoHint, type RoleHint } from "../components/navigation";
import { scopedFetch } from "../sync/scoped-fetch";
import type { PublicSettings } from "../lib/settings";
/* D2-7 print template + M5 receipt print rules (58/80mm) — module is
 * statically imported by App, so the sheet is present from first boot. */
import "./ticket-print.css";

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
  /** Role hint lifted from App (roles-admin 5.2) — never authority. */
  role: RoleHint;
  /** Cached tenant settings (3.10): annul-code toggle + receipt identity. */
  settings: PublicSettings;
  refreshToken: number;
  tenantName?: string;
  showToast?: (msg: string) => void;
  onMutated?: () => void;
  /** Set by the command palette / campana → open this ticket's preview. */
  pendingTicketId: string | null;
  onPendingTicketUsed: () => void;
  /** Credit hand-off (tasks 12.4 «navegar cuenta») → Clientes & Fiados. */
  onOpenAccount?: (customerId: string) => void;
};

type TicketDetail = Awaited<ReturnType<typeof getLocalTicket>>;

/* Status and method are SEPARATE filters (tasks 12.4 / 5.10): status
 * governs vigente/anulado, method governs efectivo/transferencia/crédito/
 * mixto — a mixed ticket matches EACH of its methods (credit-sales H3). */
type StatusFilter = "all" | "active" | "voided";
type MethodFilter = "all" | "cash" | "transfer" | "credit" | "mixed";

function methodBadge(t: LocalTicketRow): { label: string; cls: string } {
  const methods = (t.method ?? "").split(",").filter(Boolean);
  if (
    t.status !== "voided" &&
    methods.includes("transfer") &&
    t.pay_status === "pending"
  ) {
    return { label: "Transf. pend.", cls: "b-transfer" };
  }
  return {
    label: paymentMethodLabel(t.method),
    cls: methods.includes("credit")
      ? "b-credit"
      : methods.includes("transfer")
        ? "b-transfer"
        : "b-cash",
  };
}

function estadoBadge(t: LocalTicketRow): { label: string; cls: string } {
  if (t.status === "voided") return { label: "Anulada", cls: "b-void" };
  if (t.pay_status === "pending")
    return { label: "Pendiente", cls: "b-pending" };
  return { label: "Pagada", cls: "b-paid" };
}

export function Tickets({
  db,
  tenantId,
  role,
  settings,
  refreshToken,
  tenantName,
  showToast,
  onMutated,
  pendingTicketId,
  onPendingTicketUsed,
  onOpenAccount,
}: Props) {
  const [tickets, setTickets] = useState<LocalTicketRow[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [methodFilter, setMethodFilter] = useState<MethodFilter>("all");
  const [detail, setDetail] = useState<TicketDetail>(null);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [voiding, setVoiding] = useState(false);
  const [voidTarget, setVoidTarget] = useState<{
    id: string;
    ticket_no: number;
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [hasAbonos, setHasAbonos] = useState(true);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine !== false,
  );
  /* ── roles-admin 5.6 · afforance matrix (design D6) ────────────────
   * void     → Dueño tier, OR member while `require_annul_code` is ON
   *            (decision #2: with the toggle ON any verified role annuls
   *            WITH the code; toggle OFF = dueño tier only). `null` → hidden
   *            (fail-closed: unverified never sees a money action).
   * transfer → Dueño tier ONLY (matrix silent → status quo, D6). */
  const canVoid = isDueñoHint(role) || (role === "member" && settings.require_annul_code);
  const canConfirmTransfer = isDueñoHint(role);
  /* Code field: rendered while the CACHED toggle is ON. `codeForced` is the
   * staleness fallback — the server answered `annul_code_required` while the
   * cache said OFF, so the field is revealed in the error path (never a dead
   * end). Value lives in component state only, cleared on open/close. */
  const [voidCode, setVoidCode] = useState("");
  const [codeForced, setCodeForced] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const codeRequired = settings.require_annul_code || codeForced;
  /* Focus the revealed field AFTER the staleness fallback mounts it (state →
   * commit → effect; a raw rAF could beat the DOM update). */
  useEffect(() => {
    if (codeForced) codeRef.current?.focus();
  }, [codeForced]);

  /* Command palette / campana hand-off: ticket picked → open its preview. */
  useEffect(() => {
    if (!pendingTicketId) return;
    setPreviewId(pendingTicketId);
    onPendingTicketUsed();
  }, [pendingTicketId, onPendingTicketUsed]);

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
    setTickets(await listLocalTickets(db, tenantId));
  }, [db, tenantId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  useEffect(() => {
    if (!previewId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setHasAbonos(true);
    void Promise.all([getLocalTicket(db, tenantId, previewId), ticketHasAbonos(db, tenantId, previewId)]).then(([ticket, blocked]) => {
      if (alive) { setDetail(ticket); setHasAbonos(blocked); }
    });
    return () => { alive = false; };
  }, [db, tenantId, previewId, refreshToken]);

  function openPreview(id: string) {
    setConfirmErr(null);
    setPreviewId(id);
  }

  async function openVoid(t: { id: string; ticket_no: number }) {
    if (!canVoid) return;
    if (await ticketHasAbonos(db, tenantId, t.id)) {
      showToast?.("No se puede anular: este cliente tiene abonos registrados.");
      return;
    }
    setVoidTarget(t);
    setReason("");
    setConfirmErr(null);
    /* Fresh dialog = fresh code state (the code is never remembered across
     * attempts — it is short-lived anyway, TTL 15 min). */
    setVoidCode("");
    setCodeForced(false);
    dialog.current?.showModal();
  }

  /**
   * Owner confirmation goes through the ROLE-CHECKED server endpoint first
   * (D2-6: a member gets 403); the local mirror + queue refresh happen only
   * after the server acked. Offline → explicit refusal (no silent local
   * confirm that would bypass the owner gate on sync).
   */
  async function confirmTransfer(paymentId: string) {
    setConfirmErr(null);
    setConfirming(true);
    try {
      const res = await scopedFetch(tenantId, `/api/payments/${paymentId}/confirm`, {
        method: "POST",
      });
      if (res.status === 403) {
        setConfirmErr("Solo el dueño puede confirmar transferencias");
        return;
      }
      if (res.status === 404) {
        setConfirmErr("La transferencia todavía no sincronizó — esperá a que termine la sync");
        return;
      }
      if (res.status === 409) {
        setConfirmErr("La transferencia ya estaba confirmada");
        return;
      }
      if (!res.ok) {
        setConfirmErr("No se pudo confirmar — revisá la conexión");
        return;
      }
      const data = (await res.json()) as { payment: { confirmed_at: string } };
      await confirmLocalPayment(db, tenantId, paymentId, data.payment.confirmed_at);
      setConfirmErr(null);
      showToast?.("Transferencia confirmada");
      await refresh();
      if (previewId) setDetail(await getLocalTicket(db, tenantId, previewId));
      onMutated?.();
    } catch {
      setConfirmErr("Sin conexión con el servidor — la confirmación necesita internet");
    } finally {
      setConfirming(false);
    }
  }

  async function annul() {
    if (!voidTarget) return;
    setVoiding(true);
    setConfirmErr(null);
    try {
      await annulTicket(
        db,
        tenantId,
        voidTarget.id,
        reason.trim(),
        codeRequired ? voidCode.trim() : undefined,
      );
      dialog.current?.close();
      showToast?.("Venta anulada · stock restituido. Registrá por fuera de NEXORA cualquier reintegro de dinero.");
      await refresh();
      if (previewId === voidTarget.id) {
        setDetail(await getLocalTicket(db, tenantId, voidTarget.id));
      }
      onMutated?.();
    } catch (err) {
      /* Staleness fallback (D3/R4): the cached toggle said OFF but the
       * server demands a code → reveal + focus the field instead of
       * leaving the operator with a message and no way to comply. */
      if (err instanceof AnnulError && err.kind === "code_required") {
        setCodeForced(true);
        setVoidCode("");
      }
      setConfirmErr(err instanceof Error ? err.message : "La anulación necesita conexión; podés seguir vendiendo offline");
    } finally {
      setVoiding(false);
    }
  }

  if (tickets.length === 0) {
    return (
      <div className="screen tickets">
        <h2>Tickets</h2>
        <div className="empty-state" data-testid="empty-tickets">
          <h2>Sin ventas todavía</h2>
          <p className="muted">
            Los tickets aparecen acá después de la primera venta en este dispositivo.
          </p>
        </div>
      </div>
    );
  }

  const q = search.trim().toLowerCase();
  const visible = tickets.filter((t) => {
    if (statusFilter === "active" && t.status === "voided") return false;
    if (statusFilter === "voided" && t.status !== "voided") return false;
    const methods = (t.method ?? "").split(",").filter(Boolean);
    if (methodFilter === "cash" && !methods.includes("cash")) return false;
    if (methodFilter === "transfer" && !methods.includes("transfer")) return false;
    if (methodFilter === "credit" && !methods.includes("credit")) return false;
    if (methodFilter === "mixed" && methods.length < 2) return false;
    if (!q) return true;
    if (String(t.ticket_no).includes(q)) return true;
    if (String(t.total).includes(q.replace(/[.\s]/g, ""))) return true;
    if ((t.items ?? "").toLowerCase().includes(q)) return true;
    if ((t.customer_name ?? "").toLowerCase().includes(q)) return true;
    if (t.status === "voided" && "anulada".includes(q)) return true;
    return when(t.created_at).toLowerCase().includes(q);
  });

  /* Actions live WITH the preview (prototype «Ver Comprobante por fila»):
   * owner confirm, auditable void and the account hand-off all ride the
   * shared ReceiptPreview from task 12.3. */
  const previewActions = detail ? (
    <>
      {canConfirmTransfer && detail.ticket.method === "transfer" &&
        detail.ticket.status !== "voided" &&
        detail.ticket.pay_status === "pending" && (
          <button
            className="btn primary"
            data-testid="confirm-transfer"
            disabled={confirming || !online || !detail.payment_synced}
            title={
              !online
                ? "Se necesita conexión"
                : !detail.payment_synced
                  ? "Esperando sincronización"
                  : undefined
            }
            onClick={() =>
              detail.payment_id && void confirmTransfer(detail.payment_id)
            }
          >
            {confirming ? "Confirmando…" : "Confirmar transferencia"}
          </button>
        )}
      {canVoid && detail.ticket.status !== "voided" && (
        <button
          className="btn danger void-trigger"
          data-testid="void-sale"
          disabled={!online || !detail.payment_synced || confirming || hasAbonos}
          title={!online ? "Se necesita conexión" : undefined}
          onClick={() =>
            openVoid({ id: detail.ticket.id, ticket_no: detail.ticket.ticket_no })
          }
        >
          Anular venta completa
        </button>
      )}
      {hasAbonos && detail.ticket.customer_id && <p role="status" data-testid="void-abonos-note">No se puede anular: este cliente tiene abonos registrados.</p>}
      {detail.ticket.customer_id && (
        <button
          className="btn ghost"
          data-testid="ticket-account"
          onClick={() => onOpenAccount?.(detail.ticket.customer_id!)}
        >
          Ver cuenta del cliente
        </button>
      )}
      {confirmErr && (
        <p className="error" data-testid="confirm-error" role="alert">
          {confirmErr}
        </p>
      )}
      {!online && detail.ticket.status !== "voided" && (
        <p className="muted" data-testid="offline-void-note">
          La anulación necesita conexión. Podés seguir vendiendo offline.
        </p>
      )}
      {/* roles-admin 5.6 · static copy is tier+code-aware: it must describe
       * WHICH rule applies now (toggle OFF = dueño tier; toggle ON = code
       * for any verified role), never a single hard-coded tier. */}
      <p className="muted">
        {settings.require_annul_code
          ? "Anulaciones con código de anulación: cualquier rol verificado puede anular con el código vigente (vence a los 15 minutos). Las cajas cerradas no se modifican."
          : "Solo el dueño o un administrador puede anular ventas sincronizadas de un turno abierto. Las cajas cerradas no se modifican."}
      </p>
    </>
  ) : null;

  return (
    <div className="screen tickets">
      <div className="tickets-toolbar">
        <h2 style={{ margin: 0 }}>Tickets ({visible.length})</h2>
        <input
          className="search-input"
          data-testid="ticket-search"
          type="search"
          placeholder="Buscar por ID, cliente o producto…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Buscar tickets"
        />
        <select
          data-testid="filter-status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          aria-label="Filtrar por estado"
        >
          <option value="all">Todos los Estados</option>
          <option value="active">Solo vigentes</option>
          <option value="voided">Solo anulados</option>
        </select>
        <select
          data-testid="filter-method"
          value={methodFilter}
          onChange={(e) => setMethodFilter(e.target.value as MethodFilter)}
          aria-label="Filtrar por método"
        >
          <option value="all">Todos los Métodos</option>
          <option value="cash">Efectivo</option>
          <option value="transfer">Transferencia</option>
          <option value="credit">Crédito</option>
          <option value="mixed">Mixto</option>
        </select>
      </div>

      {visible.length === 0 && (
        <div className="empty-state" data-testid="no-ticket-results">
          <h2>Sin resultados</h2>
          <p className="muted">Ningún ticket coincide con la búsqueda o el filtro.</p>
        </div>
      )}

      {visible.length > 0 && (
        <div className="table-scroll tickets-table-wrap">
          <table className="tickets-table" data-testid="tickets-table">
            <thead>
              <tr>
                <th>N° Ticket</th>
                <th>Fecha / Hora</th>
                <th>Método Pago</th>
                <th>Ítems</th>
                <th>Total</th>
                <th>Estado</th>
                <th className="th-action">Acción</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => {
                const method = methodBadge(t);
                const estado = estadoBadge(t);
                return (
                  <tr
                    key={t.id}
                    data-testid="ticket-item"
                    className={t.status === "voided" ? "voided" : ""}
                    onClick={() => openPreview(t.id)}
                  >
                    {/* Display-only prefix (5.7): the stored integer
                     * sequence never changes — formatTicketNo composes the
                     * label with the cached `ticket_prefix`. */}
                    <td data-testid="ticket-no">#{formatTicketNo(settings.ticket_prefix, t.ticket_no)}</td>
                    <td className="mono">{when(t.created_at)}</td>
                    <td>
                      <span className={`ticket-badge ${method.cls}`}>
                        {method.label}
                      </span>
                    </td>
                    <td className="ticket-items-cell">{t.items ?? "—"}</td>
                    <td className="mono strong">{cop(t.total)}</td>
                    <td>
                      <span className={`ticket-badge ${estado.cls}`}>
                        {estado.label}
                      </span>
                    </td>
                    <td className="th-action ticket-row-actions">
                      <button
                        type="button"
                        className="icon-button row-preview"
                        data-testid="ticket-preview"
                        aria-label={`Ver comprobante #${t.ticket_no}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          openPreview(t.id);
                        }}
                      >
                        Ver
                      </button>
                      {canVoid && t.status !== "voided" && (
                        <button
                          type="button"
                          className="icon-button row-void"
                          data-testid="ticket-void-row"
                          aria-label={`Anular ticket #${t.ticket_no}`}
                          disabled={!online}
                          title={!online ? "Se necesita conexión" : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            openVoid({ id: t.id, ticket_no: t.ticket_no });
                          }}
                        >
                          Anular
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ReceiptPreview
        open={previewId !== null && detail !== null}
        data={detail ? { kind: "sale", detail, tenantName } : null}
        identity={pickReceiptIdentity(settings)}
        onClose={() => setPreviewId(null)}
      >
        {previewActions}
      </ReceiptPreview>

      {/* Void dialog: always mounted (openVoid sets the target THEN calls
          showModal — mounting on demand would leave dialog.current null).
          Lives OUTSIDE the preview: the receipt is portaled to <body>. */}
      <dialog
        ref={dialog}
        aria-labelledby="void-title"
        aria-describedby="void-description"
        onCancel={(e) => {
          if (voiding) e.preventDefault();
        }}
        onClose={() => {
          /* Code never survives the dialog (state-only, D3/H4). */
          setVoidCode("");
          setCodeForced(false);
        }}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void annul();
          }}
        >
          <h3 id="void-title">
            Anular venta {voidTarget ? `#${voidTarget.ticket_no}` : ""}
          </h3>
          <p id="void-description">
            Se anula toda la venta y se restituye el stock una sola vez. El
            historial se conserva. No realiza un reintegro bancario ni de
            efectivo.
          </p>
          <label htmlFor="void-reason">Motivo obligatorio</label>
          <textarea
            id="void-reason"
            data-testid="void-reason"
            autoFocus
            required
            minLength={3}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={voiding}
          />
          {codeRequired && (
            <div>
              <label htmlFor="void-code">Código de anulación</label>
              <input
                id="void-code"
                ref={codeRef}
                data-testid="void-code"
                className="mono"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="Código de 8 caracteres"
                maxLength={64}
                value={voidCode}
                onChange={(e) => setVoidCode(e.target.value)}
                disabled={voiding}
              />
            </div>
          )}
          {confirmErr && (
            <p role="alert" data-testid="void-error">
              {confirmErr}
            </p>
          )}
          <div className="row gap">
            <button
              type="button"
              className="btn ghost"
              disabled={voiding}
              onClick={() => dialog.current?.close()}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="btn danger"
              data-testid="void-confirm"
              disabled={
                voiding ||
                !online ||
                reason.trim().length < 3 ||
                (codeRequired && voidCode.trim().length === 0)
              }
            >
              {voiding ? "Anulando…" : "Confirmar anulación total"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
