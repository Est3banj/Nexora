import { MESAS_MIGRATION_SQL, TICKET_TABLE_NAME_MIGRATION_SQL } from "@pos/shared";
import { pool } from "./index";

/**
 * Mesas (control de comandas) — SERVER side.
 *
 * Fase 1 shipped only the additive `tickets.table_name` column: the comanda
 * domain (`tables` / `orders` / `order_lines`) was local-only. Fase 2
 * (CONTROL-MESAS.md · opción B) turns those three into sync entities, so the
 * server needs the same DDL the client runs — ONE shared idempotent string
 * (`MESAS_MIGRATION_SQL` in packages/shared/src/local-schema.ts) on both
 * stores, which is what makes the schema-contract parity test trivially true.
 *
 * Why this module still exists when the first-boot BASELINE (BASELINE_SQL =
 * LOCAL_SCHEMA_SQL + audit_log, and MESAS now lives in LOCAL_SCHEMA_SQL):
 * the baseline is MARKER-GATED and already applied on existing pilot
 * databases — those boots never re-run it. This chain runs on EVERY boot, so
 * `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` bring a pre-Fase 2
 * server up to date. Idempotent ⇒ no destructive migration, no marker bump.
 *
 * Fresh databases get the tables from drizzle-kit push (tests/e2e) or from
 * the baseline itself (production) — this is a no-op there.
 */
export async function migrateMesas(): Promise<void> {
  await pool.query(TICKET_TABLE_NAME_MIGRATION_SQL);
  await pool.query(MESAS_MIGRATION_SQL);
}
