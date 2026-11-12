import {
  DASHBOARD_SUMMARY_SQL,
  INVENTORY_VALUE_SQL,
  LOW_STOCK_DEFAULT,
  LOW_STOCK_SQL,
  SALES_BY_DAY_SQL,
  SALES_BY_HOUR_SQL,
  TOP_PRODUCTS_SQL,
  parseDashboardSummary,
  parseInventoryValue,
  parseLowStock,
  parseSalesByDay,
  parseSalesByHour,
  parseTopProducts,
  type DashboardSummaryRow,
  type InventoryValueRow,
  type LowStockRow,
  type SalesByDayRow,
  type SalesByHourRow,
  type TopProductRow,
} from "@pos/shared";
import type { PGlite } from "@electric-sql/pglite";
import type { LocalQueryable } from "./pglite";

/**
 * Local report queries (task D3-5, design §8) — runs the SHARED SQL text
 * against PGlite (identical WASM Postgres) so offline numbers can never
 * drift from the server's. The staleness banner is driven by
 * `sync_log`: while mutations are pending the cache may be incomplete
 * (reports spec §Offline report behavior).
 */

type Q = LocalQueryable | PGlite;

/** One row per actionable payment, not one row per ticket or a fixed badge. */
export async function localPendingTransfers(db: Q, tenantId: string) {
  const result = await db.query<{ id: string; ticket_id: string; ticket_no: number; amount: number }>(
    `SELECT p.id, p.ticket_id, t.ticket_no, p.amount FROM payments p
     JOIN tickets t ON t.id=p.ticket_id AND t.tenant_id=p.tenant_id
     WHERE p.tenant_id=$1 AND p.method='transfer' AND p.status='pending' AND t.status<>'voided'
     ORDER BY p.created_at DESC, p.id`, [tenantId]);
  return result.rows;
}

export async function localSalesByDay(
  db: Q,
  tenantId: string,
  range: { from: string; to: string },
): Promise<SalesByDayRow[]> {
  const res = await db.query<Record<string, unknown>>(SALES_BY_DAY_SQL, [
    tenantId,
    range.from,
    range.to,
  ]);
  return parseSalesByDay(res.rows);
}

export async function localSalesByHour(
  db: Q,
  tenantId: string,
  range: { from: string; to: string },
): Promise<SalesByHourRow[]> {
  const res = await db.query<Record<string, unknown>>(SALES_BY_HOUR_SQL, [
    tenantId,
    range.from,
    range.to,
  ]);
  return parseSalesByHour(res.rows);
}

export async function localTopProducts(
  db: Q,
  tenantId: string,
  range: { from: string; to: string },
): Promise<TopProductRow[]> {
  const res = await db.query<Record<string, unknown>>(TOP_PRODUCTS_SQL, [
    tenantId,
    range.from,
    range.to,
  ]);
  return parseTopProducts(res.rows);
}

export async function localLowStock(
  db: Q,
  tenantId: string,
  defaultThreshold: number = LOW_STOCK_DEFAULT,
): Promise<LowStockRow[]> {
  const res = await db.query<Record<string, unknown>>(LOW_STOCK_SQL, [
    tenantId,
    defaultThreshold,
  ]);
  return parseLowStock(res.rows);
}

/**
 * "Data may be incomplete / as of last sync" — true while the local queue
 * still holds pending work (reports spec §Offline report shows staleness
 * indicator; clears automatically once the queue drains).
 */
export async function hasUnsyncedMutations(
  db: Q,
  tenantId: string,
): Promise<boolean> {
  const res = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM sync_log
     WHERE tenant_id = $1 AND status IN ('pending', 'in_flight', 'failed')`,
    [tenantId],
  );
  return Number(res.rows[0]?.n ?? 0) > 0;
}

export async function localDashboardSummary(
  db: Q,
  tenantId: string,
  range: { from: string; to: string },
): Promise<DashboardSummaryRow> {
  const res = await db.query<Record<string, unknown>>(DASHBOARD_SUMMARY_SQL, [
    tenantId,
    range.from,
    range.to,
  ]);
  return parseDashboardSummary(res.rows);
}

export async function localInventoryValue(
  db: Q,
  tenantId: string,
  defaultThreshold: number = LOW_STOCK_DEFAULT,
): Promise<InventoryValueRow> {
  const res = await db.query<Record<string, unknown>>(INVENTORY_VALUE_SQL, [
    tenantId,
    defaultThreshold,
  ]);
  return parseInventoryValue(res.rows);
}
