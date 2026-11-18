import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { formatTicketNo, USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, PASSWORD_MIN, isValidUsername, localDate } from "@pos/shared";
import { getOpenShiftLocal, listCustomerBalances, listLocalCashMovements, listLocalClosedCash, listLocalTickets } from "../db/local";
import { listTables, type LocalTable } from "../db/local-orders";
import { TableModal } from "../components/TableModal";
import { PasswordInput } from "../components/PasswordInput";
import { localDashboardSummary, localLowStock, localPendingTransfers, localTopProducts } from "../db/local-reports";
import { CUSTOM_RANGE_ERROR, dashboardRanges, defaultCustomRange, validCustomRange, type DashboardPeriod, type DateRange } from "../lib/analytical-periods";
import type { PublicSettings } from "../lib/settings";
import { useSync } from "../hooks/useSync";
import { scopedFetch } from "../sync/scoped-fetch";
import type { ToastKind } from "../components/Toast";
import "./admin.css";
import type { RoleHint } from "../components/navigation";

const cop = (n: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);
const date = (s: string) => new Date(s).toLocaleString("es-CO", { timeZone: "America/Bogota" });
type LocalProps = { db: PGlite; tenantId: string; refreshToken: number };
type Feedback = { showToast: (message: string, kind?: ToastKind) => void };
type SettingsProps = { settings: PublicSettings; onSettingsChanged: (settings: PublicSettings) => void };
const tabs = { resumen: "Resumen", cajas: "Cajas", empleados: "Empleados", configuracion: "Configuración", mesas: "Mesas" } as const;

async function api<T>(tenantId: string, url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await scopedFetch(tenantId, url, { method, ...(body === undefined ? {} : {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
  if (!res.ok) {
    const error = await res.json().catch(() => ({})) as {
      error?: string; account_created?: boolean; issues?: Array<{ message?: string }>;
    };
    // Specific codes FIRST: they are 4xx too, but the generic 403 copy
    // ("tu sesión ya no tiene permiso") would hide what actually happened.
    throw new Error(
      error.error === "not_found" ? "Ese empleado ya no está en esta tienda."
        : error.error === "cannot_reset_self" ? "No podés restablecer tu propia contraseña desde esta pantalla."
          : error.error === "owner_readonly" ? "La cuenta del dueño no se modifica desde esta pantalla."
            : error.error === "policy" ? "El servidor rechazó la operación por política de seguridad. Revisá la contraseña e intentá de nuevo."
              : res.status === 403 || res.status === 401 ? "Tu sesión ya no tiene permiso. Volvé a ingresar."
                : error.error === "username_taken" ? "Ese usuario ya está en uso. Elegí otro."
                  : error.error === "email_taken" ? "No se pudo crear la cuenta por un conflicto de identificador. Elegí otro usuario."
                    : error.error === "validation_error" && error.issues?.[0]?.message
                      ? `Revisá los datos: ${error.issues[0].message}`
                      : error.error === "membership_create_failed" ? (error.account_created
                        ? "La cuenta se creó, pero no se pudo asignar a la tienda. Contactá al administrador antes de reintentar."
                        : "No se pudo asignar el empleado; la cuenta nueva fue descartada. Podés reintentar.")
                        : "No se pudo completar la operación. Reintentá.",
    );
  }
  return res.json() as Promise<T>;
}

export function Admin(props: LocalProps & Feedback & SettingsProps & { role: RoleHint }) {
  const [tab, setTab] = useState<keyof typeof tabs>("resumen");
  return <div className="screen admin-screen" data-testid="admin-screen">
    <div className="admin-heading"><h2>Administración de la tienda</h2><p className="muted">Control operativo y configuración del negocio.</p></div>
    <div className="seg admin-tabs" role="tablist" aria-label="Administración">
      {Object.entries(tabs).map(([key, label]) => <button key={key} role="tab" id={`admin-tab-${key}`}
        aria-controls={`admin-panel-${key}`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1}
        className={tab === key ? "active" : ""} data-testid={`admin-tab-${key}`}
        onKeyDown={e => {
          const keys = Object.keys(tabs) as Array<keyof typeof tabs>;
          const i = keys.indexOf(tab);
          const next = e.key === "ArrowRight" ? keys[(i + 1) % keys.length] : e.key === "ArrowLeft" ? keys[(i + keys.length - 1) % keys.length]
            : e.key === "Home" ? keys[0] : e.key === "End" ? keys[keys.length - 1] : null;
          if (next) { e.preventDefault(); setTab(next); document.getElementById(`admin-tab-${next}`)?.focus(); }
        }} onClick={() => setTab(key as keyof typeof tabs)}>{label}</button>)}
    </div>
    <section role="tabpanel" id={`admin-panel-${tab}`} aria-labelledby={`admin-tab-${tab}`}>
      {tab === "resumen" && <Resumen {...props} />}
      {tab === "cajas" && <Cajas {...props} />}
      {tab === "empleados" && <Empleados {...props} />}
      {tab === "configuracion" && <Configuracion {...props} />}
      {tab === "mesas" && <MesasAdmin {...props} />}
    </section>
  </div>;
}

async function loadSummary(db: PGlite, tenantId: string, from: string, to: string) {
  const [summary, low, pending, balances, voids, top] = await Promise.all([
    localDashboardSummary(db, tenantId, { from, to }), localLowStock(db, tenantId),
    localPendingTransfers(db, tenantId), listCustomerBalances(db, tenantId),
    listLocalTickets(db, tenantId, 8, "voided"), localTopProducts(db, tenantId, { from, to }),
  ]);
  return { summary, low, pending, balances, voids, top };
}
function Resumen({ db, tenantId, refreshToken, settings }: LocalProps & SettingsProps) {
  const sync = useSync();
  const [period, setPeriod] = useState<DashboardPeriod>("today");
  const [customDraft, setCustomDraft] = useState<DateRange>(defaultCustomRange);
  const [customApplied, setCustomApplied] = useState<DateRange>(defaultCustomRange);
  const [data, setData] = useState<Awaited<ReturnType<typeof loadSummary>> | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const customError =
    period === "custom" && !validCustomRange(customDraft) ? CUSTOM_RANGE_ERROR : null;
  const { from, to } = period === "custom" ? customApplied : dashboardRanges(period).current;
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
  function updateCustom(patch: Partial<DateRange>) {
    const next = { ...customDraft, ...patch };
    setCustomDraft(next);
    if (validCustomRange(next)) setCustomApplied(next);
  }
  useEffect(() => {
    let alive = true; setData(null); setError(false);
    void loadSummary(db, tenantId, from, to).then(d => { if (alive) setData(d); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [db, tenantId, refreshToken, sync.lastSync, from, to, retry]);
  return <div className="admin-stack">
    <div className="admin-toolbar"><div><h3>Resumen gerencial</h3><p className="muted">{from} — {to} · Bogotá</p></div>
      <div className="period-controls">
        <label htmlFor="admin-period">Período<select id="admin-period" value={period} data-testid="admin-period" onChange={e => choosePeriod(e.target.value as DashboardPeriod)}>
          <option value="today">Hoy</option><option value="7d">Últimos 7 días</option><option value="30d">Últimos 30 días</option>
          <option value="90d">Últimos 3 meses</option><option value="180d">Últimos 6 meses</option><option value="365d">Último año</option>
          <option value="custom">Personalizado</option>
        </select></label>
        {period === "custom" && (
          <div className="period-range">
            <label htmlFor="admin-custom-from">Desde<input id="admin-custom-from" data-testid="admin-custom-from" type="date" value={customDraft.from} max={localDate(0)}
              aria-invalid={customError !== null} aria-describedby={customError ? "admin-custom-error" : undefined}
              onChange={e => updateCustom({ from: e.target.value })} /></label>
            <label htmlFor="admin-custom-to">Hasta<input id="admin-custom-to" data-testid="admin-custom-to" type="date" value={customDraft.to} max={localDate(0)}
              aria-invalid={customError !== null} aria-describedby={customError ? "admin-custom-error" : undefined}
              onChange={e => updateCustom({ to: e.target.value })} /></label>
          </div>
        )}
      </div>
    </div>
    {customError && <p className="error" id="admin-custom-error" data-testid="admin-custom-error" role="alert">{customError}</p>}
    {(!sync.online || sync.pending > 0) && <p className="warn-banner" role="status">Datos locales posiblemente incompletos · {sync.pending} cambios sin sincronizar.</p>}
    {error ? <div role="alert">No se pudieron cargar los indicadores. <button className="btn" onClick={() => setRetry(n => n + 1)}>Reintentar</button></div> : !data ? <p role="status">Calculando indicadores…</p> : <>
      <div className="admin-metrics">
        <article className="card kpi"><span>Ingresos confirmados</span><strong className="kpi-value" data-testid="admin-revenue">{cop(data.summary.revenue)}</strong><span>{data.summary.tickets} ventas del período</span></article>
        <article className="card kpi"><span>Ganancia bruta</span><strong className="kpi-value">{data.summary.costed_lines ? cop(data.summary.revenue - data.summary.cogs) : "—"}</strong><span className="muted">{data.summary.costed_lines ? `Costo registrado: ${cop(data.summary.cogs)}; puede haber líneas sin costo.` : "Sin costos registrados en las ventas."}</span></article>
        <article className="card kpi"><span>Cartera por cobrar · saldo actual</span><strong className="kpi-value" data-testid="admin-balances">{cop(data.balances.reduce((sum, b) => sum + b.balance, 0))}</strong><span>{data.balances.length} clientes con saldo</span></article>
        <article className="card kpi"><span>Transferencias pendientes · actual</span><strong className="kpi-value" data-testid="admin-pending">{cop(data.pending.reduce((sum, p) => sum + p.amount, 0))}</strong><span>{data.pending.length} pagos por confirmar</span></article>
      </div>
      {data.summary.tickets === 0 && <p className="muted" data-testid="admin-empty-sales">Sin ventas en este período.</p>}
      <div className="admin-grid">
        <article className="card"><h3>Stock bajo · actual</h3>{data.low.length === 0 ? <p className="muted">Sin alertas de stock.</p> : <ul className="admin-list">{data.low.map(v => <li key={v.variant_id}><span>{v.product_name} · {v.variant_name}</span><strong>{v.stock} / {v.threshold}</strong></li>)}</ul>}</article>
        <article className="card"><h3>Anulaciones recientes</h3>{data.voids.length === 0 ? <p className="muted">Sin anulaciones registradas.</p> : <ul className="admin-list">{data.voids.map(t => <li key={t.id}><span>#{formatTicketNo(settings.ticket_prefix, t.ticket_no)} · venta del {date(t.created_at)}</span><strong>{cop(t.total)}</strong></li>)}</ul>}</article>
        <article className="card"><h3>Top productos del período</h3>{data.top.length === 0 ? <p className="muted">Sin productos vendidos.</p> : <ul className="admin-list">{data.top.slice(0, 5).map(t => <li key={t.variant_id}><span>{t.product_name} · {t.variant_name} · {t.qty} ud</span><strong>{cop(t.revenue)}</strong></li>)}</ul>}</article>
      </div>
    </>}
  </div>;
}

async function loadCash(db: PGlite, tenantId: string) {
  const [shift, history] = await Promise.all([getOpenShiftLocal(db, tenantId), listLocalClosedCash(db, tenantId)]);
  const shifts = [...(shift ? [{ id: shift.id, label: "Turno abierto" }] : []), ...history.map(h => ({ id: h.shift_id, label: `Cierre del ${date(h.created_at)}` }))];
  const movements = await Promise.all(shifts.map(async s => ({ ...s, rows: await listLocalCashMovements(db, tenantId, s.id) })));
  return { shift, history, movements };
}
function Cajas({ db, tenantId, refreshToken }: LocalProps) {
  const sync = useSync();
  const [data, setData] = useState<Awaited<ReturnType<typeof loadCash>> | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let alive = true; setError(false);
    void loadCash(db, tenantId).then(d => { if (alive) setData(d); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [db, tenantId, refreshToken, sync.lastSync, retry]);
  return <div className="admin-stack" data-testid="admin-cajas">
    <h3>Auditoría de cajas</h3><p className="muted">Solo lectura. La apertura y el cierre se realizan en Caja & Arqueo.</p>
    {(!sync.online || sync.pending > 0) && <p className="warn-banner">Datos locales posiblemente incompletos.</p>}
    {error ? <p role="alert">No se pudieron cargar las cajas. <button className="btn" onClick={() => setRetry(n => n + 1)}>Reintentar</button></p> : !data ? <p role="status">Cargando cajas…</p> : <>
      <article className="card"><h3>Turno abierto</h3>{data.shift ? <dl><dt>Apertura</dt><dd>{date(data.shift.opened_at)}</dd><dt>Base inicial</dt><dd>{cop(data.shift.opening_cash)}</dd></dl> : <p className="muted">Sin caja abierta.</p>}</article>
      <article className="card"><h3>Historial de cierres · últimos 20</h3>{data.history.length === 0 ? <p className="muted">Sin cierres registrados.</p> : <div className="table-scroll" role="region" aria-label="Auditoría de cierres, desplazamiento horizontal" tabIndex={0}><table><thead><tr><th>Fecha / versión</th><th>Esperado</th><th>Contado</th><th>Diferencia</th><th>Nota</th></tr></thead><tbody>{data.history.map(h => <tr key={h.id}><td>{date(h.created_at)}<small>{h.calculation_version}{h.sync_pending ? " · pendiente de sync" : ""}</small></td><td>{cop(h.expected)}</td><td>{cop(h.counted)}</td><td>{cop(h.diff)}</td><td>{h.closing_note || "—"}</td></tr>)}</tbody></table></div>}</article>
      <article className="card"><h3>Movimientos de efectivo</h3>{data.movements.every(m => m.rows.length === 0) ? <p className="muted">Sin movimientos en los turnos consultados.</p> : data.movements.filter(m => m.rows.length > 0).map(m => <div key={m.id}><h4>{m.label}</h4><ul className="admin-list">{m.rows.map(r => <li key={r.id}><span>{date(r.created_at)} · {r.reason}{r.note ? ` · ${r.note}` : ""}</span><strong>{r.direction === "in" ? "+" : "−"}{cop(r.amount)}</strong></li>)}</ul></div>)}</article>
    </>}
  </div>;
}

type Member = { id: string; userId: string; role: string; createdAt: string; user: { id: string; name: string; email: string; username: string | null } };
/** Owner rows have no username — they still identify themselves by email. */
const memberHandle = (user: Member["user"]) => user.username ?? user.email;
/** Empleados dialog: one discriminated union so each branch has a member in scope. */
type MembersModal = { kind: "create" } | { kind: "remove"; member: Member } | { kind: "reset"; member: Member };
function Empleados({ tenantId, showToast, role }: LocalProps & Feedback & { role: RoleHint }) {
  const isOwner = role === "owner";
  const canManage = (member: Member) => member.role === "member" || (isOwner && member.role === "admin");
  const { online } = useSync();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [modal, setModal] = useState<MembersModal | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [modalError, setModalError] = useState("");
  useEffect(() => {
    if (!online) { setModal(null); setCreated(null); return; }
    let alive = true; setLoading(true); setError("");
    void api<{ members: Member[] }>(tenantId, "/api/admin/members").then(d => { if (alive) setMembers(d.members); })
      .catch(e => { if (alive) setError((e as Error).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, online, reload]);
  useEffect(() => { if (modal) dialog.current?.showModal(); else dialog.current?.close(); }, [modal]);
  const close = () => { if (!lock.current) { setModal(null); setCreated(null); setModalError(""); } };
  async function changeRole(member: Member, role: string) {
    if (lock.current || !online || !isOwner || !canManage(member) || !["member", "admin"].includes(role)) return;
    lock.current = true; setBusy(true);
    try { await api(tenantId, `/api/admin/members/${member.id}`, "PATCH", { role }); setReload(n => n + 1); showToast("Rol actualizado"); }
    catch (e) { showToast((e as Error).message, "error"); }
    finally { lock.current = false; setBusy(false); }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (lock.current || !online || !modal) return;
    const form = new FormData(e.currentTarget);
    if (modal.kind === "create") {
      // Same rules as the server (packages/shared/username.ts + zod) so the
      // owner gets a clear Spanish message instead of a generic 400.
      const username = String(form.get("username") ?? "").trim();
      const password = String(form.get("password") ?? "");
      if (!isValidUsername(username)) {
        setModalError(`El usuario debe tener entre ${USERNAME_MIN_LENGTH} y ${USERNAME_MAX_LENGTH} caracteres: solo minúsculas, números y . _ - (sin arroba ni espacios).`);
        return;
      }
      if (password.length < PASSWORD_MIN || password.length > 128) {
        setModalError(`La contraseña debe tener entre ${PASSWORD_MIN} y 128 caracteres.`);
        return;
      }
      lock.current = true; setBusy(true); setModalError("");
      try {
        const result = await api<{ user: { username: string } }>(tenantId, "/api/admin/users", "POST", {
          name: String(form.get("name") ?? "").trim(), username, password,
          role: isOwner ? form.get("role") : "member",
        });
        setCreated(result.user.username); showToast("Usuario creado");
        setReload(n => n + 1);
      } catch (err) { setModalError((err as Error).message); }
      finally { lock.current = false; setBusy(false); }
      return;
    }
    if (!canManage(modal.member)) return;
    if (modal.kind === "reset") {
      const newPassword = String(form.get("newPassword") ?? "");
      // Validated here too: the server answer (validation_error) would be a
      // generic "Revisá los datos" instead of a precise rule.
      if (newPassword.length < PASSWORD_MIN || newPassword.length > 128) {
        setModalError(`La contraseña debe tener entre ${PASSWORD_MIN} y 128 caracteres.`);
        return;
      }
      lock.current = true; setBusy(true); setModalError("");
      try {
        await api(tenantId, `/api/admin/members/${modal.member.id}/password`, "POST", { newPassword });
        setModal(null); setReload(n => n + 1);
        showToast("Contraseña restablecida. La sesión del empleado quedó cerrada.");
      } catch (err) { setModalError((err as Error).message); }
      finally { lock.current = false; setBusy(false); }
      return;
    }
    lock.current = true; setBusy(true); setModalError("");
    try {
      await api(tenantId, `/api/admin/members/${modal.member.id}`, "DELETE"); setModal(null); showToast("Acceso a la tienda eliminado");
      setReload(n => n + 1);
    } catch (err) { setModalError((err as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!online) return <p className="warn-banner" data-testid="admin-employees-offline" role="status">La gestión de empleados requiere conexión.</p>;
  return <div className="admin-stack">
    <div className="admin-toolbar"><h3>Empleados y roles</h3><button className="btn primary" data-testid="admin-user-new" disabled={busy} onClick={() => { setModalError(""); setCreated(null); setModal({ kind: "create" }); }}>Crear usuario</button></div>
    {loading && <p role="status">Cargando empleados…</p>}
    {error ? <p role="alert">{error} <button className="btn" onClick={() => setReload(n => n + 1)}>Reintentar</button></p> : <div className="card table-scroll" role="region" aria-label="Empleados y roles, desplazamiento horizontal" tabIndex={0}><table data-testid="admin-members"><thead><tr><th>Empleado</th><th>Rol</th><th>Acciones</th></tr></thead><tbody>{members.map(m => <tr key={m.id} data-testid="admin-member"><td><strong>{m.user.name}</strong><small>{memberHandle(m.user)}</small></td><td>{isOwner && canManage(m) ? <select aria-label={`Rol de ${m.user.name}`} value={m.role} disabled={busy || loading} onChange={e => void changeRole(m, e.target.value)}><option value="member">Cajero</option><option value="admin">Administrador</option></select> : m.role === "owner" ? "Dueño" : m.role === "admin" ? "Administrador" : m.role === "member" ? "Cajero" : "Rol sin verificar"}</td><td>{canManage(m) && <span className="admin-row-actions"><button className="btn small" data-testid="admin-member-reset" disabled={busy || loading} onClick={() => { setModalError(""); setModal({ kind: "reset", member: m }); }}>Restablecer contraseña</button><button className="btn danger" disabled={busy || loading} onClick={() => { setModalError(""); setModal({ kind: "remove", member: m }); }}>Quitar acceso</button></span>}</td></tr>)}</tbody></table>{!loading && members.length === 0 && <p className="muted">No se encontraron empleados.</p>}</div>}
    <dialog ref={dialog} className="admin-dialog" aria-labelledby="admin-user-title" onCancel={e => { e.preventDefault(); close(); }} onClose={close}>
      <h3 id="admin-user-title">{modal?.kind === "create" ? created ? "Usuario creado" : "Crear usuario" : modal?.kind === "reset" ? "Restablecer contraseña" : "Quitar acceso a la tienda"}</h3>
      {created ? <div className="admin-stack"><p>Ya puede ingresar con este usuario y la contraseña que elegiste.</p><output className="admin-secret" data-testid="admin-created-username">{created}</output><button className="btn primary" onClick={close}>Listo</button></div> : <form onSubmit={e => void submit(e)} className="admin-stack">
        {modal?.kind === "create" ? <>
          <label htmlFor="admin-user-name">Nombre completo<input id="admin-user-name" name="name" data-testid="admin-user-name" required maxLength={120} autoFocus autoComplete="off" /></label>
          <label htmlFor="admin-user-username">Usuario<input id="admin-user-username" name="username" data-testid="admin-user-username" type="text" required maxLength={USERNAME_MAX_LENGTH} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
          <small>Solo minúsculas, números y . _ - · {USERNAME_MIN_LENGTH} a {USERNAME_MAX_LENGTH} caracteres. Sin arroba ni espacios.</small>
          <PasswordInput id="admin-user-password" label="Contraseña" name="password" data-testid="admin-user-password" required minLength={PASSWORD_MIN} maxLength={128} autoComplete="new-password" />
          <label htmlFor="admin-user-role">Rol<select id="admin-user-role" name="role" data-testid="admin-user-role"><option value="member">Cajero</option>{isOwner && <option value="admin">Administrador</option>}</select></label>
        </> : modal?.kind === "reset" ? <>
          <p>Restablecé la contraseña de <strong>{modal.member.user.name}</strong> ({memberHandle(modal.member.user)}). Su cuenta sigue existiendo.</p>
          <PasswordInput id="admin-reset-password" label="Nueva contraseña" name="newPassword" data-testid="admin-reset-password" required minLength={PASSWORD_MIN} maxLength={128} autoComplete="new-password" autoFocus hint={`Mínimo ${PASSWORD_MIN} caracteres. Al guardar se cierra la sesión que el empleado tenga abierta.`} />
        </> : <p>¿Quitar el acceso de <strong>{modal?.member.user.name}</strong>? Su cuenta sigue existiendo, pero ya no podrá acceder a esta tienda.</p>}
        {modalError && <p role="alert" className="error">{modalError}</p>}
        <div className="admin-actions"><button type="button" className="btn" disabled={busy} onClick={close}>Cancelar</button><button className={`btn ${modal?.kind === "remove" ? "danger" : "primary"}`} data-testid="admin-user-submit" disabled={busy} aria-busy={busy}>{busy ? "Guardando…" : modal?.kind === "create" ? "Crear usuario" : modal?.kind === "reset" ? "Guardar contraseña" : "Confirmar eliminación"}</button></div>
      </form>}
    </dialog>
  </div>;
}

/**
 * Sección «Mesas» (patrón Cajas/Empleados): lista + modal crear/editar.
 * Tenant-scoped LOCAL — same TableModal the board's «+ Agregar Mesa» opens.
 * Admin is already Dueño-tier (nav matrix), so every visitor can manage.
 */
function MesasAdmin({ db, tenantId, refreshToken, showToast }: LocalProps & Feedback) {
  const [tables, setTables] = useState<LocalTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [target, setTarget] = useState<LocalTable | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    listTables(db, tenantId)
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

  return (
    <div className="admin-stack" data-testid="admin-mesas">
      <div className="admin-toolbar">
        <div>
          <h3>Mesas del salón</h3>
          <p className="muted">
            Las comandas abiertas se gestionan en la pestaña Mesas; acá se dan de alta.
          </p>
        </div>
        <button
          className="btn primary"
          data-testid="admin-table-new"
          onClick={() => {
            setTarget(null);
            setModalOpen(true);
          }}
        >
          Agregar Mesa
        </button>
      </div>
      {loading && <p role="status">Cargando mesas…</p>}
      {error ? (
        <p role="alert">
          No se pudieron cargar las mesas.{" "}
          <button className="btn" onClick={() => setReload((n) => n + 1)}>
            Reintentar
          </button>
        </p>
      ) : (
        !loading && (
          <div className="card table-scroll" role="region" aria-label="Mesas, desplazamiento horizontal" tabIndex={0}>
            <table data-testid="admin-tables">
              <thead>
                <tr>
                  <th>Mesa</th>
                  <th>Zona</th>
                  <th>Capacidad</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((t) => (
                  <tr key={t.id} data-testid="admin-table-row">
                    <td>
                      <strong>{t.name}</strong>
                    </td>
                    <td>{t.zone ?? "—"}</td>
                    <td className="mono">{t.capacity}</td>
                    <td>
                      <span className={`ticket-badge ${t.active ? "b-paid" : "b-pending"}`}>
                        {t.active ? "Activa" : "Inactiva"}
                      </span>
                    </td>
                    <td>
                      <button
                        className="btn small"
                        data-testid="admin-table-edit"
                        onClick={() => {
                          setTarget(t);
                          setModalOpen(true);
                        }}
                      >
                        Editar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tables.length === 0 && (
              <p className="muted" data-testid="admin-tables-empty">
                Todavía no hay mesas cargadas.
              </p>
            )}
          </div>
        )
      )}
      <TableModal
        open={modalOpen}
        db={db}
        tenantId={tenantId}
        table={target}
        onClose={() => setModalOpen(false)}
        onSaved={(saved) => {
          setModalOpen(false);
          setTarget(null);
          setReload((n) => n + 1);
          showToast(target ? `Mesa «${saved.name}» actualizada` : `Mesa «${saved.name}» creada`);
        }}
      />
    </div>
  );
}

const textFields = [
  ["store_name", "Nombre comercial", 120], ["nit", "NIT / identificación tributaria", 30],
  ["address", "Dirección", 160], ["phone", "Teléfono", 40], ["ticket_footer", "Pie del ticket", 240],
] as const;
const toggles = [
  ["allow_negative_stock", "Permitir ventas sin stock", "Activado por defecto: permite inventario negativo. Desactivado: bloquea ventas que excedan el stock."],
  ["require_annul_code", "Exigir código de anulación", "Desactivado por defecto: anula el dueño o administrador. Activado: todos necesitan un código válido, incluso el dueño."],
  ["enable_fiado", "Habilitar ventas fiadas", "Activado por defecto. Desactivado: oculta el módulo y rechaza nuevas ventas fiadas y abonos."],
] as const;
const writableKeys = [...textFields.map(([key]) => key), "ticket_prefix", "iva_pct", "default_credit_limit", ...toggles.map(([key]) => key)] as const;
function Configuracion({ tenantId, settings, onSettingsChanged, showToast }: LocalProps & SettingsProps & Feedback) {
  const { online } = useSync();
  const [draft, setDraft] = useState(settings);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [code, setCode] = useState<{ code: string; expires_at: string } | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const previous = useRef(settings);
  useEffect(() => {
    // Code metadata changes must not discard an unsaved settings draft.
    if (writableKeys.some(key => previous.current[key] !== settings[key])) setDraft(settings);
    previous.current = settings;
  }, [settings]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { if (!online) { setCode(null); setDraft(settings); } }, [online, settings]);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (lock.current || !online) return;
    lock.current = true; setBusy(true); setError("");
    const { store_name, nit, address, phone, ticket_footer, ticket_prefix, iva_pct, default_credit_limit, allow_negative_stock, require_annul_code, enable_fiado } = draft;
    try {
      const result = await api<{ settings: PublicSettings }>(tenantId, "/api/settings", "PUT", { store_name, nit, address, phone, ticket_footer, ticket_prefix, iva_pct, default_credit_limit, allow_negative_stock, require_annul_code, enable_fiado });
      onSettingsChanged(result.settings); showToast("Configuración guardada");
    } catch (err) { setError((err as Error).message); showToast("No se pudo guardar la configuración", "error"); }
    finally { lock.current = false; setBusy(false); }
  }
  async function generate() {
    if (lock.current || !online) return;
    lock.current = true; setBusy(true); setError(""); setCode(null);
    try {
      const result = await api<{ code: string; expires_at: string }>(tenantId, "/api/settings/annul-code", "POST");
      setCode(result); onSettingsChanged({ ...settings, annul_code_set: true, annul_code_expires_at: result.expires_at });
      showToast("Código generado. El anterior dejó de funcionar.");
    } catch (err) { setError((err as Error).message); showToast("No se pudo generar el código", "error"); }
    finally { lock.current = false; setBusy(false); }
  }
  const expiry = settings.annul_code_expires_at;
  const expired = expiry !== null && new Date(expiry).getTime() <= now;
  const expiring = expiry !== null && new Date(expiry).getTime() - now <= 60000;
  return <div className="admin-stack" data-testid="admin-settings">
    {!online && <p className="warn-banner" data-testid="admin-settings-offline" role="status">Sin conexión: configuración cacheada de solo lectura. Los cambios requieren conexión.</p>}
    <form className="admin-stack" onSubmit={e => void save(e)}>
      <fieldset className="card" disabled={!online || busy}><legend>Identidad fiscal y encabezado</legend><p className="muted">Solo se imprime la información que configurás.</p><div className="admin-grid">{textFields.map(([key, label, max]) => <label key={key} htmlFor={`admin-setting-${key}`}>{label}<input id={`admin-setting-${key}`} data-testid={`admin-setting-${key}`} maxLength={max} type={key === "phone" ? "tel" : "text"} value={draft[key] ?? ""} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value || null }))} /></label>)}</div></fieldset>
      <fieldset className="card" disabled={!online || busy}><legend>Ticket y crédito</legend><div className="admin-grid">
        <label>Prefijo del ticket<input data-testid="admin-setting-ticket_prefix" maxLength={8} value={draft.ticket_prefix ?? ""} onChange={e => setDraft(d => ({ ...d, ticket_prefix: e.target.value || null }))} /><small>Ejemplo: <output data-testid="admin-prefix-example">{formatTicketNo(draft.ticket_prefix, 123)}</output> · no cambia la secuencia.</small></label>
        <label>IVA (%)<input data-testid="admin-setting-iva_pct" type="number" min={0} max={100} step={1} value={draft.iva_pct ?? ""} onChange={e => setDraft(d => ({ ...d, iva_pct: e.target.value === "" ? null : Number(e.target.value) }))} /><small>Guardado para uso futuro — no se calcula aún.</small></label>
        <label>Cupo de crédito por defecto (COP)<input data-testid="admin-setting-default_credit_limit" type="number" min={0} max={2147483647} step={1} value={draft.default_credit_limit ?? ""} onChange={e => setDraft(d => ({ ...d, default_credit_limit: e.target.value === "" ? null : Number(e.target.value) }))} /><small>Precarga el alta de clientes; no modifica cupos existentes.</small></label>
      </div></fieldset>
      <fieldset className="card admin-stack" disabled={!online || busy}><legend>Reglas de operación</legend>{toggles.map(([key, label, hint]) => <label key={key} className="admin-toggle" htmlFor={`admin-setting-${key}`}><input id={`admin-setting-${key}`} type="checkbox" data-testid={`admin-setting-${key}`} checked={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.checked }))} /><span>{label}<small>{hint}</small><small>Guardado actualmente: {settings[key] ? "activado" : "desactivado"}.</small></span></label>)}</fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="admin-actions"><button className="btn primary" data-testid="admin-settings-save" disabled={!online || busy} aria-busy={busy}>{busy ? "Guardando…" : "Guardar configuración"}</button></div>
    </form>
    <article className="card admin-stack"><h3>Código de anulación</h3><p data-testid="admin-code-status">{!settings.annul_code_set ? "Sin código generado." : expired ? "Código vencido." : expiring ? "Código por vencer." : "Código generado."}{expiry && ` Vence: ${date(expiry)} (Bogotá).`}</p>
      <p className="muted">Se muestra una sola vez. Rotar invalida el anterior al instante. Al salir de esta pestaña se oculta; no se recupera al recargar.</p>
      {code && online && <div className="admin-stack"><output className="admin-secret" data-testid="admin-generated-code">{code.code}</output><span>Vence: {date(code.expires_at)}</span><button className="btn" onClick={() => void navigator.clipboard.writeText(code.code).then(() => showToast("Código copiado")).catch(() => showToast("No se pudo copiar; seleccioná el código", "error"))}>Copiar código</button></div>}
      <button className="btn" data-testid="admin-code-generate" disabled={!online || busy} onClick={() => void generate()}>{settings.annul_code_set ? "Rotar código" : "Generar código"}</button>
    </article>
  </div>;
}
