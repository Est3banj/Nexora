import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { BarChart3, Check, Clock3, ContactRound, LayoutDashboard, LayoutGrid, LogOut, MoreHorizontal, Receipt, RefreshCw, Settings, ShoppingCart, TriangleAlert, Utensils, Wallet, Wifi, WifiOff } from "lucide-react";
import { getOpenShiftLocal, type LocalShift } from "../db/local";
import { localLowStock, localPendingTransfers } from "../db/local-reports";
import { useSync } from "../hooks/useSync";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { pushNow, retryPoison } from "../sync/queue";
import { NotificationPopover, type ShellAlert } from "./NotificationPopover";
import { compactNavigation, type AppTab, type NavItem, type RoleHint } from "./navigation";

const icons = { sale: ShoppingCart, mesas: Utensils, arqueo: Wallet, tickets: Receipt, catalog: LayoutGrid, dashboard: LayoutDashboard, reports: BarChart3, credito: ContactRound, admin: Settings };
const cop = (n: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);

function BogotaClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  return <time className="shell-clock" dateTime={now.toISOString()} aria-label="Hora de Bogotá"><Clock3 size={14} aria-hidden="true" />{now.toLocaleTimeString("es-CO", { timeZone: "America/Bogota" })}</time>;
}

export function AppShell({ db, tenantId, user, tenantName, tab, nav, role, refreshToken, onNavigate, onTicket, onVariant, onSignOut, onConsola, children }: {
  db: PGlite; tenantId: string; user: { id: string; name: string; email: string }; tenantName?: string;
  tab: AppTab; nav: NavItem[]; role: RoleHint; refreshToken: number; onNavigate: (tab: AppTab) => void; onTicket: (id: string) => void;
  onVariant: (id: string) => void; onSignOut: () => Promise<void>; onConsola: () => void; children: ReactNode;
}) {
  const sync = useSync();
  // Connectivity and queue health are independent: online never implies synced.
  const connectionLabel = sync.online ? "en línea" : "sin conexión";
  const syncProblem = Boolean(sync.error || sync.failed || sync.poison);
  const syncActive = sync.syncing || sync.inFlight > 0;
  const syncLabel = sync.poison > 0 ? `${sync.poison} en revisión` : sync.error || sync.failed > 0 ? "Error de sinc." : syncActive ? "Sincronizando" : sync.pending > 0 ? `${sync.pending} pendientes` : "Sin pendientes de sinc.";
  const syncDetail = `${syncLabel}. ${sync.pending} cambios pendientes, ${sync.failed} fallidos, ${sync.poison} requieren revisión, ${sync.inFlight} en envío${sync.error ? `. ${sync.error}` : ""}`;
  const SyncIcon = syncProblem ? TriangleAlert : syncActive || sync.pending > 0 ? RefreshCw : Check;
  const ConnectionIcon = sync.online ? Wifi : WifiOff;
  const desktop = useMediaQuery("(min-width: 1024px)");
  const mobile = useMediaQuery("(max-width: 639px)");
  const moreDialog = useRef<HTMLDialogElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const { primary, secondary } = compactNavigation(nav);
  const secondaryActive = secondary.some(item => item.tab === tab);
  function closeMore() { moreDialog.current?.close(); setMoreOpen(false); }
  useEffect(() => { moreDialog.current?.close(); setMoreOpen(false); }, [mobile, tab, nav.map(item => item.tab).join(",")]);
  function destination(item: NavItem, fullLabel = false) {
    const Icon = icons[item.tab];
    return <button key={item.tab} className={tab === item.tab ? "active" : ""}
      aria-label={item.label} title={item.label} aria-current={tab === item.tab ? "page" : undefined}
      data-testid={`tab-${item.tab}`} onClick={() => { closeMore(); onNavigate(item.tab); }}>
      <Icon size={20} aria-hidden="true" /><span>{fullLabel || desktop ? item.label : item.shortLabel}</span>
    </button>;
  }
  /* roles-admin 5.2/5.3 — the private `useActiveMemberRole` call is GONE:
   * App fetches the hint ONCE and passes `nav` + `role` down (no duplicate
   * get-active-member-role request, and the tabbar/header/palette all read
   * the same filtered matrix). */
  const [shift, setShift] = useState<LocalShift | null>(null);
  const [data, setData] = useState<{ transfers: Awaited<ReturnType<typeof localPendingTransfers>>; stock: Awaited<ReturnType<typeof localLowStock>> }>({ transfers: [], stock: [] });
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const loadedRef = useRef(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    // Pending state only until the FIRST resolve (or an explicit retry):
    // background refreshes after each sync keep the last known shift on
    // screen instead of flashing "Consultando caja…" under the operator.
    if (!loadedRef.current) setLoading(true);
    void Promise.all([getOpenShiftLocal(db, tenantId), localPendingTransfers(db, tenantId), localLowStock(db, tenantId)]).then(([current, transfers, stock]) => {
      if (!alive) return;
      setShift(current); setData({ transfers, stock }); setError(false);
    }).catch(() => { if (alive) setError(true); }).finally(() => { if (alive) { loadedRef.current = true; setLoading(false); } });
    return () => { alive = false; };
  }, [db, tenantId, refreshToken, sync.lastSync, reload]);
  const alerts: ShellAlert[] = [
    ...data.transfers.map(p => ({ id: `transfer:${p.id}`, label: `Transferencia pendiente · #${p.ticket_no} · ${cop(p.amount)}`, action: () => onTicket(p.ticket_id) })),
    ...data.stock.map(v => ({ id: `stock:${v.variant_id}`, label: `Stock bajo · ${v.product_name} · ${v.variant_name}: ${v.stock} (umbral ${v.threshold})`, action: () => onVariant(v.variant_id) })),
    ...(sync.error ? [{ id: "sync-error", label: `Error de sync · ${sync.error} · Reintentar`, action: () => pushNow(db, tenantId, { force: true }) }] : []),
    ...(sync.poison > 0 ? [{ id: "sync-poison", label: `${sync.poison} cambios requieren revisión · Reintentar tras corregir`, action: () => retryPoison(db, tenantId) }] : []),
  ];
  const name = user.name || user.email;
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join("").toLocaleUpperCase("es-CO");
  const account = <div className="shell-account" data-testid="shell-account">
    <div className="shell-identity"><span className="avatar" aria-hidden="true">{initials}</span><div><strong>{name}</strong><span data-testid="member-role">{role === "owner" ? "Dueño" : role === "member" ? "Cajero" : role === "admin" ? "Administrador" : "Rol sin verificar"}</span></div></div>
    <div className="shell-shift" data-testid="shell-shift"><span>{error ? "Caja no disponible" : loading ? "Consultando caja…" : shift ? "Turno abierto" : "Sin caja abierta"}</span>{!error && shift && <strong>Base {cop(shift.opening_cash)}</strong>}</div>
    {tenantName && <p className="shell-tenant">{tenantName}</p>}
    {(user as { platformAdmin?: boolean }).platformAdmin === true && <button className="account-sign-out" data-testid="consola-entry" onClick={onConsola}>Consola</button>}
    <button className="account-sign-out" data-testid="sign-out" onClick={() => void onSignOut()}><LogOut size={14} aria-hidden="true" />Salir</button>
  </div>;
  return <div className="app nexora-shell">
    <aside className="shell-sidebar">
      <div className="shell-brand"><img src="/icon-192.png" alt="" className="shell-mark" /><div><strong>NEXORA</strong><span>POS</span></div></div>
      <nav className="tabbar" aria-label="Navegación principal">
        {desktop ? ["Operación", "Gestión"].map(group => <div className="nav-group" key={group}>
          <span className="nav-group-title">{group}</span>{nav.filter(item => item.group === group).map(item => destination(item))}
        </div>) : (mobile ? primary : nav).map(item => destination(item))}
        {mobile && secondary.length > 0 && <button ref={moreTrigger} data-testid="nav-more" title="Más secciones"
          aria-label={secondaryActive ? `Más secciones: ${nav.find(item => item.tab === tab)?.label}` : "Más secciones"}
          aria-haspopup="dialog" aria-expanded={moreOpen} aria-controls="more-navigation" aria-current={secondaryActive ? "page" : undefined}
          className={secondaryActive ? "active" : ""} onClick={() => { moreDialog.current?.showModal(); setMoreOpen(true); }}>
          <MoreHorizontal size={20} aria-hidden="true" /><span>Más</span>
        </button>}
      </nav>
      {mobile && secondary.length > 0 && <dialog ref={moreDialog} id="more-navigation" className="more-navigation" aria-labelledby="more-navigation-title"
        onClose={() => { setMoreOpen(false); moreTrigger.current?.focus(); }} onCancel={() => setMoreOpen(false)}>
        <div className="modal-head"><h2 id="more-navigation-title">Más secciones</h2><button className="icon-button" aria-label="Cerrar más secciones" onClick={closeMore}>✕</button></div>
        <nav aria-label="Más secciones">{secondary.map(item => destination(item, true))}</nav>
      </dialog>}
      {desktop && <div className="desktop-account">{account}</div>}
    </aside>
    <div className="app-frame">
      {/* Title comes from the FILTERED nav (roles-admin 5.3): a tab the
       * matrix hides has no title here — the guard in App renders the
       * access-denied fallback instead of a protected heading. */}
      <header className="app-header"><img src="/icon-192.png" alt="" className="header-logo" /><h1 title={nav.find(item => item.tab === tab)?.title}>{nav.find(item => item.tab === tab)?.title}</h1>
        <div className="shell-status" role="status" aria-live="polite" aria-atomic="true" aria-label={`${connectionLabel}. ${syncDetail}`} data-testid="shell-status" title={`${connectionLabel}. ${syncDetail}`}>
          <span className={`shell-status-connection ${sync.online ? "is-online" : "is-offline"}`} data-testid="net-status"><ConnectionIcon size={14} aria-hidden="true" /><span>{connectionLabel}</span></span>
          <span className={`shell-status-sync ${syncProblem ? "is-error" : syncActive || sync.pending > 0 ? "is-pending" : "is-online"}`} data-testid="pending-badge" title={syncDetail}>
            <SyncIcon size={14} aria-hidden="true" /><span className="shell-status-label">{syncLabel}</span>
          </span>
        </div>
        <div className="shell-header-tools">
        <BogotaClock />
        <NotificationPopover alerts={alerts} error={error} loading={loading} onRetry={() => { setLoading(true); setError(false); setReload(n => n + 1); }} />
        {!desktop && <details className="mobile-account"><summary aria-label="Cuenta y caja">{initials}</summary>{account}</details>}
      </div></header>
      {children}
    </div>
  </div>;
}
