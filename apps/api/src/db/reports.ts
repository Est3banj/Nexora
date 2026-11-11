import {
  CUSTOMER_BALANCES_SQL,
  DASHBOARD_SUMMARY_SQL,
  INVENTORY_VALUE_SQL,
  LOW_STOCK_DEFAULT,
  LOW_STOCK_SQL,
  SALES_BY_DAY_SQL,
  TOP_PRODUCTS_SQL,
  defaultReportRange,
  parseCustomerBalances,
  parseDashboardSummary,
  parseInventoryValue,
  parseLowStock,
  parseSalesByDay,
  parseTopProducts,
  type CustomerBalanceRow,
  type DashboardSummaryRow,
  type InventoryValueRow,
  type LowStockRow,
  type SalesByDayRow,
  type TopProductRow,
} from "@pos/shared";import { pool } from "./index";

/**
 * Report queries (task D3-4, design §8) — lives in src/db/ because it is
 * raw SQL against business tables (the D1-4 lint gate allows exactly this
 * directory). The SQL TEXT comes from @pos/shared so the local PGlite cache
 * executes byte-identical statements (D3-5 offline path).
 *
 * Every query is tenant-bound through $1 — the caller passes the SESSION
 * tenant (scopedRepo), never a value from the request body.
 */

type RawRow = Record<string, unknown>;

async function run(sqlText: string, params: unknown[]): Promise<RawRow[]> {
  const res = await pool.query(sqlText, params);
  return res.rows as RawRow[];
}

export async function salesByDay(
  tenantId: string,
  range: { from: string; to: string } = defaultReportRange(),
): Promise<SalesByDayRow[]> {
  return parseSalesByDay(await run(SALES_BY_DAY_SQL, [tenantId, range.from, range.to]));
}

export async function topProducts(
  tenantId: string,
  range: { from: string; to: string } = defaultReportRange(),
): Promise<TopProductRow[]> {
  return parseTopProducts(await run(TOP_PRODUCTS_SQL, [tenantId, range.from, range.to]));
}

export async function lowStock(
  tenantId: string,
  defaultThreshold: number = LOW_STOCK_DEFAULT,
): Promise<LowStockRow[]> {
  return parseLowStock(await run(LOW_STOCK_SQL, [tenantId, defaultThreshold]));
}

export async function dashboardSummary(
  tenantId: string,
  range: { from: string; to: string },
): Promise<DashboardSummaryRow> {
  return parseDashboardSummary(
    await run(DASHBOARD_SUMMARY_SQL, [tenantId, range.from, range.to]),
  );
}

export async function inventoryValue(
  tenantId: string,
  defaultThreshold: number = LOW_STOCK_DEFAULT,
): Promise<InventoryValueRow> {
  return parseInventoryValue(
    await run(INVENTORY_VALUE_SQL, [tenantId, defaultThreshold]),
  );
}

/**
 * Por Cobrar (fiado) — balance per customer, derived from stored rows
 * (never stored on the customer row). Same SQL text the local PGlite cache
 * runs, so fixture parity holds across both stores. $1 = session tenant.
 */
export async function customerBalances(tenantId: string): Promise<CustomerBalanceRow[]> {
  return parseCustomerBalances(await run(CUSTOMER_BALANCES_SQL, [tenantId]));
}
