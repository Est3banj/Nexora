import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PGlite } from "@electric-sql/pglite";
import { BarChart3, Clock3, ContactRound, LayoutDashboard, LayoutGrid, LogOut, Receipt, ShoppingCart, Wallet } from "lucide-react";
import { getOpenShiftLocal, type LocalShift } from "../db/local";
import { localLowStock, localPendingTransfers } from "../db/local-reports";
import { useSync } from "../hooks/useSync";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useActiveMemberRole } from "../hooks/useActiveMemberRole";
import { pushNow, retryPoison } from "../sync/queue";
import { NotificationPopover, type ShellAlert } from "./NotificationPopover";
import { NAVIGATION, type AppTab } from "./navigation";

const icons = { sale: ShoppingCart, arqueo: Wallet, tickets: Receipt, catalog: LayoutGrid, dashboard: LayoutDashboard, reports: BarChart3, credito: ContactRound };
const cop = (n: number) => new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(n);

function BogotaClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  return <time className="shell-clock" dateTime={now.toISOString()} aria-label="Hora de Bogotá"><Clock3 size={14} aria-hidden="true" />{now.toLocaleTimeString("es-CO", { timeZone: "America/Bogota" })}</time>;
}

export function AppShell({ db, tenantId, user, tenantName, tab, refreshToken, onNavigate, onTicket, onVariant, onSignOut, children }: {
  db: PGlite; tenantId: string; user: { id: string; name: string; email: string }; tenantName?: string;
  tab: AppTab; refreshToken: number; onNavigate: (tab: AppTab) => void; onTicket: (id: string) => void;
  onVariant: (id: string) => void; onSignOut: () => Promise<void>; children: ReactNode;
}) {
  const sync = useSync();
  const desktop = useMediaQuery("(min-width: 768px)");
  const role = useActiveMemberRole(tenantId, user.id, sync.online);
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
    <div className="shell-identity"><span className="avatar" aria-hidden="true">{initials}</span><div><strong>{name}</strong><span data-testid="member-role">{role === "owner" ? "Dueño" : role === "member" ? "Miembro" : role === "admin" ? "Administrador" : "Rol sin verificar"}</span></div></div>
    <div className="shell-shift" data-testid="shell-shift"><span>{error ? "Caja no disponible" : loading ? "Consultando caja…" : shift ? "Turno abierto" : "Sin caja abierta"}</span>{!error && shift && <strong>Base {cop(shift.opening_cash)}</strong>}</div>
    {tenantName && <p className="shell-tenant">{tenantName}</p>}
    <button className="account-sign-out" data-testid="sign-out" onClick={() => void onSignOut()}><LogOut size={14} aria-hidden="true" />Salir</button>
  </div>;
  return <div className="app nexora-shell">
    <aside className="shell-sidebar">
      <div className="shell-brand"><span className="shell-mark" aria-hidden="true">N</span><div><strong>NEXORA</strong><span>POS</span></div></div>
      <nav className="tabbar" aria-label="Navegación principal">{NAVIGATION.map(item => {
        const Icon = icons[item.tab];
        return <button key={item.tab} className={tab === item.tab ? "active" : ""} aria-current={tab === item.tab ? "page" : undefined} data-testid={`tab-${item.tab}`} onClick={() => onNavigate(item.tab)}><Icon size={20} aria-hidden="true" /><span>{item.label}</span></button>;
      })}</nav>
      {desktop && <div className="desktop-account">{account}</div>}
    </aside>
    <div className="app-frame">
      <header className="app-header"><h1>{NAVIGATION.find(item => item.tab === tab)?.title}</h1><div className="shell-header-tools">
        <BogotaClock />
        <span className={`net-status ${sync.online ? "net-online" : "net-offline"}`} data-testid="net-status">{sync.online ? "en línea" : "sin conexión"}</span>
        <span className={`badge ${sync.pending ? "badge-pending" : "badge-ok"}`} data-testid="pending-badge" title="Mutaciones pendientes de sincronizar">{sync.pending ? `${sync.pending} pendientes` : "sinc."}</span>
        <NotificationPopover alerts={alerts} error={error} loading={loading} onRetry={() => { setLoading(true); setError(false); setReload(n => n + 1); }} />
        {!desktop && <details className="mobile-account"><summary aria-label="Cuenta y caja">{initials}</summary>{account}</details>}
      </div></header>
      {children}
    </div>
  </div>;
}
