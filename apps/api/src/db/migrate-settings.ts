import { pool } from "./index";

/**
 * roles-admin 3.2 / design D4 · additive boot DDL for `tenant_settings`.
 *
 * Drizzle declares the table (schema.ts) so tests/dev/e2e get it from
 * `drizzle-kit push`, but production must never depend on a manual push —
 * same stronger-than-audit_log precedent as the `sync_sale_*` staging
 * tables: `CREATE TABLE IF NOT EXISTS` at boot, deploy-order neutral and
 * idempotent (two restarts = no error, no drift). Pattern: migrate-cost.ts.
 */
export const SETTINGS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id uuid PRIMARY KEY,
  store_name text,
  nit text,
  address text,
  phone text,
  ticket_footer text,
  ticket_prefix text,
  iva_pct integer,
  default_credit_limit integer,
  allow_negative_stock boolean NOT NULL DEFAULT true,
  require_annul_code boolean NOT NULL DEFAULT false,
  enable_fiado boolean NOT NULL DEFAULT true,
  annul_code_hash text,
  annul_code_expires_at timestamptz,
  annul_code_created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT tenant_settings_iva_pct_ck CHECK (iva_pct IS NULL OR (iva_pct BETWEEN 0 AND 100))
)`;

export async function migrateSettings(): Promise<void> {
  await pool.query(SETTINGS_MIGRATION_SQL);
}
