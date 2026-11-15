import { TICKET_TABLE_NAME_MIGRATION_SQL } from "@pos/shared";
import { pool } from "./index";

/**
 * Mesas (control de comandas) — SERVER side of Fase 1.
 *
 * The comanda domain itself (`tables` / `orders` / `order_lines`) is LOCAL
 * PGlite only until Fase 2 (CONTROL-MESAS.md · opción C): the server has no
 * row to migrate here. What the server DOES need is the additive, nullable
 * `tickets.table_name` column so a synced ticket keeps the table it was
 * charged to (receipt + ticket detail after a rehydrate on another device).
 *
 * Idempotent additive ALTER — same shape as migrate-fiado.ts.
 */
export async function migrateMesas(): Promise<void> {
  await pool.query(TICKET_TABLE_NAME_MIGRATION_SQL);
}
