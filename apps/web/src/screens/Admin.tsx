import { useEffect, useRef, useState, type FormEvent } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { formatTicketNo } from "@pos/shared";
import { getOpenShiftLocal, listCustomerBalances, listLocalCashMovements, listLocalClosedCash, listLocalTickets } from "../db/local";
import { localDashboardSummary, localLowStock, localPendingTransfers, localTopProducts } from "../db/local-reports";
import { dashboardRanges, type DashboardPeriod } from "../lib/analytical-periods";
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
const tabs = { resumen: "Resumen", cajas: "Cajas", empleados: "Empleados", configuracion: "Configuración" } as const;

async function api<T>(tenantId: string, url: string, method = "GET", body?: unknown): Promise<T> {
  const res = await scopedFetch(tenantId, url, { method, ...(body === undefined ? {} : {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
  if (!res.ok) {
    const error = await res.json().catch(() => ({})) as { error?: string; account_created?: boolean };
    throw new Error(res.status === 403 || res.status === 401 ? "Tu sesión ya no tiene permiso. Volvé a ingresar."
      : error.error === "email_taken" ? "Ese correo ya tiene una cuenta."
        : error.error === "membership_create_failed" ? (error.account_created
          ? "La cuenta se creó, pero no se pudo asignar a la tienda. Contactá al administrador antes de reintentar."
          : "No se pudo asignar el empleado; la cuenta nueva fue descartada. Podés reintentar.")
          : "No se pudo completar la operación. Reintentá.");
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
  const [data, setData] = useState<Awaited<ReturnType<typeof loadSummary>> | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const { from, to } = dashboardRanges(period).current;
  useEffect(() => {
    let alive = true; setData(null); setError(false);
    void loadSummary(db, tenantId, from, to).then(d => { if (alive) setData(d); }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [db, tenantId, refreshToken, sync.lastSync, from, to, retry]);
  return <div className="admin-stack">
    <div className="admin-toolbar"><div><h3>Resumen gerencial</h3><p className="muted">{from} — {to} · Bogotá</p></div>
      <label>Período<select value={period} data-testid="admin-period" onChange={e => setPeriod(e.target.value as DashboardPeriod)}>
        <option value="today">Hoy</option><option value="7d">Últimos 7 días</option><option value="month">Este mes</option><option value="30d">Últimos 30 días</option>
      </select></label></div>
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
      <article className="card"><h3>Historial de cierres · últimos 20</h3>{data.history.length === 0 ? <p className="muted">Sin cierres registrados.</p> : <div className="table-scroll"><table><thead><tr><th>Fecha / versión</th><th>Esperado</th><th>Contado</th><th>Diferencia</th><th>Nota</th></tr></thead><tbody>{data.history.map(h => <tr key={h.id}><td>{date(h.created_at)}<small>{h.calculation_version}{h.sync_pending ? " · pendiente de sync" : ""}</small></td><td>{cop(h.expected)}</td><td>{cop(h.counted)}</td><td>{cop(h.diff)}</td><td>{h.closing_note || "—"}</td></tr>)}</tbody></table></div>}</article>
      <article className="card"><h3>Movimientos de efectivo</h3>{data.movements.every(m => m.rows.length === 0) ? <p className="muted">Sin movimientos en los turnos consultados.</p> : data.movements.filter(m => m.rows.length > 0).map(m => <div key={m.id}><h4>{m.label}</h4><ul className="admin-list">{m.rows.map(r => <li key={r.id}><span>{date(r.created_at)} · {r.reason}{r.note ? ` · ${r.note}` : ""}</span><strong>{r.direction === "in" ? "+" : "−"}{cop(r.amount)}</strong></li>)}</ul></div>)}</article>
    </>}
  </div>;
}

type Member = { id: string; userId: string; role: string; createdAt: string; user: { id: string; name: string; email: string } };
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
  const [modal, setModal] = useState<"create" | Member | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [modalError, setModalError] = useState("");
  useEffect(() => {
    if (!online) { setModal(null); setPassword(null); return; }
    let alive = true; setLoading(true); setError("");
    void api<{ members: Member[] }>(tenantId, "/api/admin/members").then(d => { if (alive) setMembers(d.members); })
      .catch(e => { if (alive) setError((e as Error).message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, online, reload]);
  useEffect(() => { if (modal) dialog.current?.showModal(); else dialog.current?.close(); }, [modal]);
  const close = () => { if (!lock.current) { setModal(null); setPassword(null); setModalError(""); } };
  async function changeRole(member: Member, role: string) {
    if (lock.current || !online || !isOwner || !canManage(member) || !["member", "admin"].includes(role)) return;
    lock.current = true; setBusy(true);
    try { await api(tenantId, `/api/admin/members/${member.id}`, "PATCH", { role }); setReload(n => n + 1); showToast("Rol actualizado"); }
    catch (e) { showToast((e as Error).message, "error"); }
    finally { lock.current = false; setBusy(false); }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (lock.current || !online || !modal || (modal !== "create" && !canManage(modal))) return;
    const form = new FormData(e.currentTarget); lock.current = true; setBusy(true); setModalError("");
    try {
      if (modal === "create") {
        const result = await api<{ generated_password: string }>(tenantId, "/api/admin/users", "POST", { name: form.get("name"), email: form.get("email"), role: isOwner ? form.get("role") : "member" });
        setPassword(result.generated_password); showToast("Empleado creado");
      } else { await api(tenantId, `/api/admin/members/${modal.id}`, "DELETE"); setModal(null); showToast("Acceso a la tienda eliminado"); }
      setReload(n => n + 1);
    } catch (err) { setModalError((err as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!online) return <p className="warn-banner" data-testid="admin-employees-offline" role="status">La gestión de empleados requiere conexión.</p>;
  return <div className="admin-stack">
    <div className="admin-toolbar"><h3>Empleados y roles</h3><button className="btn primary" data-testid="admin-user-new" disabled={busy} onClick={() => { setModalError(""); setPassword(null); setModal("create"); }}>Crear usuario</button></div>
    {loading && <p role="status">Cargando empleados…</p>}
    {error ? <p role="alert">{error} <button className="btn" onClick={() => setReload(n => n + 1)}>Reintentar</button></p> : <div className="card table-scroll"><table data-testid="admin-members"><thead><tr><th>Empleado</th><th>Rol</th><th>Acciones</th></tr></thead><tbody>{members.map(m => <tr key={m.id} data-testid="admin-member"><td><strong>{m.user.name}</strong><small>{m.user.email}</small></td><td>{isOwner && canManage(m) ? <select aria-label={`Rol de ${m.user.name}`} value={m.role} disabled={busy || loading} onChange={e => void changeRole(m, e.target.value)}><option value="member">Cajero</option><option value="admin">Administrador</option></select> : m.role === "owner" ? "Dueño" : m.role === "admin" ? "Administrador" : m.role === "member" ? "Cajero" : "Rol sin verificar"}</td><td>{canManage(m) && <button className="btn danger" disabled={busy || loading} onClick={() => { setModalError(""); setModal(m); }}>Quitar acceso</button>}</td></tr>)}</tbody></table>{!loading && members.length === 0 && <p className="muted">No se encontraron empleados.</p>}</div>}
    <dialog ref={dialog} className="admin-dialog" aria-labelledby="admin-user-title" onCancel={e => { e.preventDefault(); close(); }} onClose={close}>
      <h3 id="admin-user-title">{modal === "create" ? password ? "Empleado creado" : "Crear usuario" : "Quitar acceso a la tienda"}</h3>
      {password ? <div className="admin-stack"><p>Contraseña inicial. Se muestra una sola vez; guardala antes de cerrar.</p><output className="admin-secret" data-testid="admin-generated-password">{password}</output><button className="btn primary" onClick={close}>Ya la guardé</button></div> : <form onSubmit={e => void submit(e)} className="admin-stack">
        {modal === "create" ? <><label>Nombre completo<input name="name" data-testid="admin-user-name" required maxLength={120} autoFocus autoComplete="off" /></label><label>Correo de acceso<input name="email" data-testid="admin-user-email" type="email" required maxLength={254} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label><label>Rol<select name="role" data-testid="admin-user-role"><option value="member">Cajero</option>{isOwner && <option value="admin">Administrador</option>}</select></label></> : <p>¿Quitar el acceso de <strong>{modal?.user.name}</strong>? Su cuenta sigue existiendo, pero ya no podrá acceder a esta tienda.</p>}
        {modalError && <p role="alert" className="error">{modalError}</p>}
        <div className="admin-actions"><button type="button" className="btn" disabled={busy} onClick={close}>Cancelar</button><button className={`btn ${modal === "create" ? "primary" : "danger"}`} data-testid="admin-user-submit" disabled={busy} aria-busy={busy}>{busy ? "Guardando…" : modal === "create" ? "Crear usuario" : "Confirmar eliminación"}</button></div>
      </form>}
    </dialog>
  </div>;
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
      <fieldset className="card" disabled={!online || busy}><legend>Identidad fiscal y encabezado</legend><p className="muted">Solo se imprime la información que configurás.</p><div className="admin-grid">{textFields.map(([key, label, max]) => <label key={key}>{label}<input data-testid={`admin-setting-${key}`} maxLength={max} type={key === "phone" ? "tel" : "text"} value={draft[key] ?? ""} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value || null }))} /></label>)}</div></fieldset>
      <fieldset className="card" disabled={!online || busy}><legend>Ticket y crédito</legend><div className="admin-grid">
        <label>Prefijo del ticket<input data-testid="admin-setting-ticket_prefix" maxLength={8} value={draft.ticket_prefix ?? ""} onChange={e => setDraft(d => ({ ...d, ticket_prefix: e.target.value || null }))} /><small>Ejemplo: <output data-testid="admin-prefix-example">{formatTicketNo(draft.ticket_prefix, 123)}</output> · no cambia la secuencia.</small></label>
        <label>IVA (%)<input data-testid="admin-setting-iva_pct" type="number" min={0} max={100} step={1} value={draft.iva_pct ?? ""} onChange={e => setDraft(d => ({ ...d, iva_pct: e.target.value === "" ? null : Number(e.target.value) }))} /><small>Guardado para uso futuro — no se calcula aún.</small></label>
        <label>Cupo de crédito por defecto (COP)<input data-testid="admin-setting-default_credit_limit" type="number" min={0} max={2147483647} step={1} value={draft.default_credit_limit ?? ""} onChange={e => setDraft(d => ({ ...d, default_credit_limit: e.target.value === "" ? null : Number(e.target.value) }))} /><small>Precarga el alta de clientes; no modifica cupos existentes.</small></label>
      </div></fieldset>
      <fieldset className="card admin-stack" disabled={!online || busy}><legend>Reglas de operación</legend>{toggles.map(([key, label, hint]) => <label key={key} className="admin-toggle"><input type="checkbox" data-testid={`admin-setting-${key}`} checked={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.checked }))} /><span>{label}<small>{hint}</small><small>Guardado actualmente: {settings[key] ? "activado" : "desactivado"}.</small></span></label>)}</fieldset>
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
