import { z } from "zod";

/**
 * Report queries — THE shared SQL for server AND local cache (tasks D3-4 /
 * D3-5, design §8). PGlite is WASM Postgres, so the exact same statement
 * runs against both stores: drift is impossible by construction, and the
 * fixture tests (D3-6) assert identical exact numbers on both sides.
 *
 * All date params are `YYYY-MM-DD` and bucket on the LOCAL calendar day
 * (`AT TIME ZONE 'America/Bogota'`), never the UTC day (reports spec
 * §Day boundary uses local calendar day).
 */

export const REPORT_TIMEZONE = "America/Bogota";

/** System default low-stock threshold when a variant has none (task D3-4 decision). */
export const LOW_STOCK_DEFAULT = 5;

/**
 * $1 = tenant_id · $2 = from (YYYY-MM-DD) · $3 = to (YYYY-MM-DD, inclusive).
 *
 * Two CTEs + FULL OUTER JOIN (fiado design §4.2): `p` buckets payments
 * (revenue keeps INCLUDING credit — accrual — reported in its own `credit`
 * column, never folded into cash/transfer), `a` buckets abonos as COBROS
 * (collections, never revenue). FULL OUTER so a day with only abonos — a
 * customer pays down debt, zero sales — still shows up; a plain LEFT JOIN
 * from payments would drop it. Existing days keep identical numbers.
 */
export const SALES_BY_DAY_SQL = /* sql */ `
WITH p AS (
  SELECT (p.created_at AT TIME ZONE 'America/Bogota')::date AS day,
         COUNT(DISTINCT p.ticket_id) FILTER (WHERE p.status = 'confirmed') AS tickets,
         COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed'), 0) AS revenue,
         COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'pending'), 0) AS pending,
         COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed' AND p.method = 'cash'), 0) AS cash,
         COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed' AND p.method = 'transfer'), 0) AS transfer,
         COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed' AND p.method = 'credit'), 0) AS credit
  FROM payments p
  WHERE p.tenant_id = $1
    AND NOT EXISTS (SELECT 1 FROM tickets tk WHERE tk.tenant_id=p.tenant_id AND tk.id=p.ticket_id AND tk.status='voided')
    AND (p.created_at AT TIME ZONE 'America/Bogota')::date >= $2::date
    AND (p.created_at AT TIME ZONE 'America/Bogota')::date <= $3::date
  GROUP BY 1
),
a AS (
  SELECT (a.created_at AT TIME ZONE 'America/Bogota')::date AS day,
         COALESCE(SUM(a.amount), 0) AS abonos
  FROM credit_abonos a
  WHERE a.tenant_id = $1
    AND (a.created_at AT TIME ZONE 'America/Bogota')::date >= $2::date
    AND (a.created_at AT TIME ZONE 'America/Bogota')::date <= $3::date
  GROUP BY 1
)
SELECT COALESCE(p.day, a.day) AS day,
       COALESCE(p.tickets, 0) AS tickets,
       COALESCE(p.revenue, 0) AS revenue,
       COALESCE(p.pending, 0) AS pending,
       COALESCE(p.cash, 0) AS cash,
       COALESCE(p.transfer, 0) AS transfer,
       COALESCE(p.credit, 0) AS credit,
       COALESCE(a.abonos, 0) AS abonos
FROM p FULL OUTER JOIN a ON a.day = p.day
ORDER BY 1`;

/**
 * Hour-of-day profile for the Panel "Horas pico" card — $1 tenant · $2 from · $3 to.
 * Buckets by LOCAL hour (America/Bogota) across the whole range, so a 7-day
 * window shows the shop's typical day shape (which hours are busy).
 */
export const SALES_BY_HOUR_SQL = /* sql */ `
SELECT EXTRACT(HOUR FROM (p.created_at AT TIME ZONE 'America/Bogota'))::int AS hour,
       COUNT(DISTINCT p.ticket_id) FILTER (WHERE p.status = 'confirmed') AS tickets,
       COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed'), 0) AS revenue
FROM payments p
WHERE p.tenant_id = $1
  AND NOT EXISTS (SELECT 1 FROM tickets tk WHERE tk.tenant_id=p.tenant_id AND tk.id=p.ticket_id AND tk.status='voided')
  AND (p.created_at AT TIME ZONE 'America/Bogota')::date >= $2::date
  AND (p.created_at AT TIME ZONE 'America/Bogota')::date <= $3::date
GROUP BY 1
ORDER BY 1`;

/** $1 = tenant_id · $2 = from · $3 = to (both inclusive, local day). */
export const TOP_PRODUCTS_SQL = /* sql */ `
SELECT l.variant_id AS variant_id,
       v.name AS variant_name,
       pr.name AS product_name,
       SUM(l.qty) AS qty,
       SUM(l.subtotal) AS revenue
FROM ticket_lines l
JOIN tickets tk ON tk.id = l.ticket_id AND tk.tenant_id = l.tenant_id
JOIN product_variants v ON v.id = l.variant_id AND v.tenant_id = l.tenant_id
JOIN products pr ON pr.id = v.product_id AND pr.tenant_id = l.tenant_id
WHERE l.tenant_id = $1
  AND tk.status <> 'voided'
  AND (tk.created_at AT TIME ZONE 'America/Bogota')::date >= $2::date
  AND (tk.created_at AT TIME ZONE 'America/Bogota')::date <= $3::date
GROUP BY l.variant_id, v.name, pr.name
ORDER BY qty DESC, revenue DESC, v.name ASC, pr.name ASC
LIMIT 10`;

/** $1 = tenant_id · $2 = system default threshold. */
export const LOW_STOCK_SQL = /* sql */ `
SELECT v.id AS variant_id,
       v.name AS variant_name,
       pr.name AS product_name,
       v.stock AS stock,
       COALESCE(v.low_stock_threshold, $2::int) AS threshold
FROM product_variants v
JOIN products pr ON pr.id = v.product_id AND pr.tenant_id = v.tenant_id
WHERE v.tenant_id = $1
  AND v.active = TRUE
  AND pr.active = TRUE
  AND v.stock <= COALESCE(v.low_stock_threshold, $2::int)
ORDER BY v.stock ASC, pr.name ASC, v.name ASC`;

/* ------------------------------------------------------------------ */
/* Row types + coercion (identical on pg and PGlite drivers)           */
/* ------------------------------------------------------------------ */

export type SalesByDayRow = {
  day: string;
  tickets: number;
  revenue: number;
  pending: number;
  cash: number;
  transfer: number;
  /** confirmed credit payments (accrual) — part of revenue, own column */
  credit: number;
  /** abonos registered that day (cobros) — never part of revenue */
  abonos: number;
};

export type SalesByHourRow = {
  hour: number;
  tickets: number;
  revenue: number;
};

export type TopProductRow = {
  variant_id: string;
  variant_name: string;
  product_name: string;
  qty: number;
  revenue: number;
};

export type LowStockRow = {
  variant_id: string;
  variant_name: string;
  product_name: string;
  stock: number;
  threshold: number;
};

type RawRow = Record<string, unknown>;

const num = (v: unknown): number =>
  typeof v === "number" ? v : Number(v ?? 0);

/** `date` arrives as 'YYYY-MM-DD' (pg) or a Date at UTC midnight (PGlite). */
const day = (v: unknown): string =>
  v instanceof Date
    ? v.toISOString().slice(0, 10)
    : String(v ?? "").slice(0, 10);

export function parseSalesByDay(rows: RawRow[]): SalesByDayRow[] {
  return rows.map((r) => ({
    day: day(r.day),
    tickets: num(r.tickets),
    revenue: num(r.revenue),
    pending: num(r.pending),
    cash: num(r.cash),
    transfer: num(r.transfer),
    credit: num(r.credit),
    abonos: num(r.abonos),
  }));
}

export function parseSalesByHour(rows: RawRow[]): SalesByHourRow[] {
  return rows.map((r) => ({
    hour: num(r.hour),
    tickets: num(r.tickets),
    revenue: num(r.revenue),
  }));
}

export function parseTopProducts(rows: RawRow[]): TopProductRow[] {
  return rows.map((r) => ({
    variant_id: String(r.variant_id),
    variant_name: String(r.variant_name ?? ""),
    product_name: String(r.product_name ?? ""),
    qty: num(r.qty),
    revenue: num(r.revenue),
  }));
}

export function parseLowStock(rows: RawRow[]): LowStockRow[] {
  return rows.map((r) => ({
    variant_id: String(r.variant_id),
    variant_name: String(r.variant_name ?? ""),
    product_name: String(r.product_name ?? ""),
    stock: num(r.stock),
    threshold: num(r.threshold),
  }));
}

/* ------------------------------------------------------------------ */
/* Date range (server + UI defaults)                                   */
/* ------------------------------------------------------------------ */

export const reportDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Today (and N days back) in the tenant's local calendar day. */
export function localDate(daysOffset = 0, now: Date = new Date()): string {
  // en-CA yields ISO format YYYY-MM-DD
  return new Date(now.getTime() + daysOffset * 86_400_000).toLocaleDateString(
    "en-CA",
    { timeZone: REPORT_TIMEZONE },
  );
}

/** Default range: last 7 local days, inclusive (D3 cut rule: default = last 7 days). */
export function defaultReportRange(now: Date = new Date()): {
  from: string;
  to: string;
} {
  return { from: localDate(-6, now), to: localDate(0, now) };
}

/* ------------------------------------------------------------------ */
/* Dashboard (Tanda B — accounting overview)                           */
/* ------------------------------------------------------------------ */

/**
 * $1 = tenant_id · $2 = from · $3 = to.
 * Revenue/tickets/cash/transfer/credit from confirmed payments — identity
 * `revenue = cash + transfer + credit` holds by construction (credit is
 * accrual, its own column, never folded into cash/transfer). `abonos` is
 * the cobros scalar (collections, never revenue).
 * COGS uses ticket_lines.unit_cost (historical cost captured at sale) —
 * changing a product's current cost NEVER rewrites past margins.
 * costed_lines counts lines that carry a known cost (for honest margin UI).
 */
export const DASHBOARD_SUMMARY_SQL = /* sql */ `
SELECT
  COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed'), 0) AS revenue,
  COUNT(DISTINCT p.ticket_id) FILTER (WHERE p.status = 'confirmed') AS tickets,
  COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed' AND p.method = 'cash'), 0) AS cash,
  COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed' AND p.method = 'transfer'), 0) AS transfer,
  COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'confirmed' AND p.method = 'credit'), 0) AS credit,
  COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'pending'), 0) AS pending,
  COUNT(*) FILTER (WHERE p.status = 'pending') AS pending_count,
  COALESCE((
    SELECT SUM(l.qty * COALESCE(l.unit_cost, 0))
    FROM ticket_lines l
    JOIN tickets tk ON tk.id = l.ticket_id AND tk.tenant_id = l.tenant_id
    WHERE l.tenant_id = $1
      AND (tk.created_at AT TIME ZONE 'America/Bogota')::date >= $2::date
      AND (tk.created_at AT TIME ZONE 'America/Bogota')::date <= $3::date
      AND tk.status IN ('completed', 'transfer_pending')
  ), 0) AS cogs,
  COALESCE((
    SELECT COUNT(*)
    FROM ticket_lines l
    JOIN tickets tk ON tk.id = l.ticket_id AND tk.tenant_id = l.tenant_id
    WHERE l.tenant_id = $1
      AND l.unit_cost IS NOT NULL
      AND (tk.created_at AT TIME ZONE 'America/Bogota')::date >= $2::date
      AND (tk.created_at AT TIME ZONE 'America/Bogota')::date <= $3::date
      AND tk.status IN ('completed', 'transfer_pending')
  ), 0) AS costed_lines,
  COALESCE((
    SELECT SUM(a.amount) FROM credit_abonos a
    WHERE a.tenant_id = $1
      AND (a.created_at AT TIME ZONE 'America/Bogota')::date >= $2::date
      AND (a.created_at AT TIME ZONE 'America/Bogota')::date <= $3::date
  ), 0) AS abonos
FROM payments p
WHERE p.tenant_id = $1
  AND NOT EXISTS (SELECT 1 FROM tickets tk WHERE tk.tenant_id=p.tenant_id AND tk.id=p.ticket_id AND tk.status='voided')
  AND (p.created_at AT TIME ZONE 'America/Bogota')::date >= $2::date
  AND (p.created_at AT TIME ZONE 'America/Bogota')::date <= $3::date`;

/** $1 = tenant_id · $2 = system default low-stock threshold. */
export const INVENTORY_VALUE_SQL = /* sql */ `
SELECT
  COALESCE(SUM(v.stock * COALESCE(v.cost, 0)), 0) AS inventory_cost,
  COALESCE(SUM(v.stock * v.price), 0) AS inventory_retail,
  COUNT(*) FILTER (WHERE v.cost IS NOT NULL) AS variants_with_cost,
  COUNT(*) FILTER (
    WHERE v.active AND pr.active
      AND v.stock <= COALESCE(v.low_stock_threshold, $2::int)
  ) AS low_stock_count
FROM product_variants v
JOIN products pr ON pr.id = v.product_id AND pr.tenant_id = v.tenant_id
WHERE v.tenant_id = $1`;

export type DashboardSummaryRow = {
  revenue: number;
  tickets: number;
  cash: number;
  transfer: number;
  /** confirmed credit payments (accrual) — own column, inside revenue */
  credit: number;
  pending: number;
  /** Count of pending payments (usually transfers awaiting owner confirmation). */
  pending_count: number;
  cogs: number;
  /** Lines with a known historical cost — gates honest margin display. */
  costed_lines: number;
  /** abonos registered in the period (cobros) — never part of revenue */
  abonos: number;
};

export type InventoryValueRow = {
  inventory_cost: number;
  inventory_retail: number;
  variants_with_cost: number;
  low_stock_count: number;
};

export function parseDashboardSummary(rows: RawRow[]): DashboardSummaryRow {
  const r = rows[0] ?? {};
  return {
    revenue: num(r.revenue),
    tickets: num(r.tickets),
    cash: num(r.cash),
    transfer: num(r.transfer),
    credit: num(r.credit),
    pending: num(r.pending),
    pending_count: num(r.pending_count),
    cogs: num(r.cogs),
    costed_lines: num(r.costed_lines),
    abonos: num(r.abonos),
  };
}

export function parseInventoryValue(rows: RawRow[]): InventoryValueRow {
  const r = rows[0] ?? {};
  return {
    inventory_cost: num(r.inventory_cost),
    inventory_retail: num(r.inventory_retail),
    variants_with_cost: num(r.variants_with_cost),
    low_stock_count: num(r.low_stock_count),
  };
}

/* ------------------------------------------------------------------ */
/* Por cobrar (receivables) — fiado design §4.4                        */
/* ------------------------------------------------------------------ */

/**
 * $1 = tenant_id.
 *
 * balance = Σ confirmed credit payments on non-voided tickets − Σ abonos,
 * active customers only. Voided credit drops out (`tk.status <> 'voided'`);
 * abonos always count (they are append-only, never voided).
 *
 * `balance > 0` filter is REQUIRED (reconciliation 2026-11-11, conflict #4 —
 * spec wins over design's unfiltered SQL): a Por Cobrar list of zero/negative
 * balance customers is noise, and filtering SQL-side keeps the Credito screen
 * dumb (no client-side filtering). ORDER BY balance DESC, name ASC.
 */
export const CUSTOMER_BALANCES_SQL = /* sql */ `
SELECT c.id AS customer_id,
       c.name AS name,
       c.phone AS phone,
       COALESCE(cr.credit, 0) AS credit,
       COALESCE(ab.abonos, 0) AS abonos,
       COALESCE(cr.credit, 0) - COALESCE(ab.abonos, 0) AS balance
FROM customers c
LEFT JOIN (
  SELECT tk.customer_id AS customer_id, SUM(p.amount) AS credit
  FROM payments p
  JOIN tickets tk ON tk.id = p.ticket_id AND tk.tenant_id = p.tenant_id
  WHERE p.tenant_id = $1
    AND p.method = 'credit' AND p.status = 'confirmed'
    AND tk.status <> 'voided'
    AND tk.customer_id IS NOT NULL
  GROUP BY 1
) cr ON cr.customer_id = c.id
LEFT JOIN (
  SELECT customer_id, SUM(amount) AS abonos
  FROM credit_abonos
  WHERE tenant_id = $1
  GROUP BY 1
) ab ON ab.customer_id = c.id
WHERE c.tenant_id = $1 AND c.active = TRUE
  AND COALESCE(cr.credit, 0) - COALESCE(ab.abonos, 0) > 0
ORDER BY balance DESC, c.name ASC`;

export type CustomerBalanceRow = {
  customer_id: string;
  name: string;
  phone: string | null;
  credit: number;
  abonos: number;
  balance: number;
};

export function parseCustomerBalances(rows: RawRow[]): CustomerBalanceRow[] {
  return rows.map((r) => ({
    customer_id: String(r.customer_id),
    name: String(r.name ?? ""),
    phone: r.phone == null ? null : String(r.phone),
    credit: num(r.credit),
    abonos: num(r.abonos),
    balance: num(r.balance),
  }));
}
