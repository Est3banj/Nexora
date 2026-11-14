/* Nav order/labels come from design-rules.json layout.navOrder/navLabels.
 * `title` mirrors the prototype's switchTab() titles map (HTML 933–940) so the
 * topbar heading matches the reference instead of reusing the short nav label.
 *
 * roles-admin 5.1 / design D6 — ONE visibility matrix: every item carries its
 * `tier`, and `visibleNav()` is the single selector consumed by AppShell, the
 * command palette AND the App screen guard. Changing a tier here changes all
 * three together (menu-visibility §Single role-visibility matrix). Consola is
 * deliberately ABSENT — it is an account-menu entry outside the tenant shell
 * (D7), never a tab (batch 6/7 territory). */
export const NAVIGATION = [
  { tab: "sale", label: "Venta / POS", title: "Venta Rápida (POS)", tier: "all" },
  { tab: "arqueo", label: "Caja & Arqueo", title: "Arqueo & Turnos de Caja", tier: "all" },
  { tab: "tickets", label: "Tickets & Historial", title: "Historial de Comprobantes", tier: "all" },
  { tab: "catalog", label: "Catálogo", title: "Gestión de Inventario y Catálogo", tier: "all" },
  { tab: "dashboard", label: "Panel / Dashboard", title: "Panel de Control Principal", tier: "dueno" },
  { tab: "reports", label: "Reportes", title: "Reportes y Analítica", tier: "dueno" },
  { tab: "credito", label: "Clientes & Fiados", title: "Clientes & Cuentas por Cobrar (Fiados)", tier: "all", requiresFiado: true },
  { tab: "admin", label: "Administración", title: "Administración", tier: "dueno" },
] as const;
export type AppTab = (typeof NAVIGATION)[number]["tab"];
export type NavItem = (typeof NAVIGATION)[number];

/** Display hint of the active org role — `null` = unknown / not yet verified. */
export type RoleHint = "owner" | "admin" | "member" | null;

/** Dueño tier client-side: `admin` ≡ `owner` everywhere (decision #3). */
export function isDueñoHint(r: RoleHint): boolean {
  return r === "owner" || r === "admin";
}

/**
 * roles-admin 5.1 / design D6 — the settled matrix, fail-closed:
 *
 *  - `null` (unknown or unverified role) → ONLY the 5 member-safe tabs
 *    (venta, caja, tickets, catálogo, fiado). PROTECTED surfaces — Panel,
 *    Reportes, Administración — never render for a role we could not verify
 *    (decision #10: the UI must not be the thing that lies; the server 403s
 *    are the authority either way).
 *  - `member` → the same 5 tabs; `owner`/`admin` → those 5 + Panel + Reportes + Administración.
 *  - `enable_fiado === false` → `credito` dropped for EVERY role (the module
 *    is off, not tier-scoped). Anything other than an explicit `false` keeps
 *    it (absent/true = current behavior).
 *  - Consola never appears (D7: account menu, outside the shell).
 */
export function visibleNav(
  r: RoleHint,
  o?: { enableFiado?: boolean },
): NavItem[] {
  const visible = NAVIGATION.filter(
    (item) => item.tier === "all" || isDueñoHint(r),
  );
  if (o?.enableFiado !== false) return [...visible];
  return visible.filter(
    (item) => !("requiresFiado" in item && item.requiresFiado),
  );
}
