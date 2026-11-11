import { pool } from "./index";
import { TICKET_LINE_COST_MIGRATION_SQL } from "@pos/shared";

/** Additive: unit_cost on ticket_lines + one-time backfill from variant.cost. */
export async function migrateCost(): Promise<void> {
  await pool.query(TICKET_LINE_COST_MIGRATION_SQL);
}
