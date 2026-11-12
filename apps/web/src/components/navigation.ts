/* Nav order/labels come from design-rules.json layout.navOrder/navLabels.
 * `title` mirrors the prototype's switchTab() titles map (HTML 933–940) so the
 * topbar heading matches the reference instead of reusing the short nav label. */
export const NAVIGATION = [
  { tab: "sale", label: "Venta / POS", title: "Venta Rápida (POS)" },
  { tab: "arqueo", label: "Caja & Arqueo", title: "Arqueo & Turnos de Caja" },
  { tab: "tickets", label: "Tickets & Historial", title: "Historial de Comprobantes" },
  { tab: "catalog", label: "Catálogo", title: "Gestión de Inventario y Catálogo" },
  { tab: "dashboard", label: "Panel / Dashboard", title: "Panel de Control Principal" },
  { tab: "reports", label: "Reportes", title: "Reportes y Analítica" },
  { tab: "credito", label: "Clientes & Fiados", title: "Clientes & Cuentas por Cobrar (Fiados)" },
] as const;
export type AppTab = typeof NAVIGATION[number]["tab"];
