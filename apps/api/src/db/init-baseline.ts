import { LOCAL_SCHEMA_SQL } from "@pos/shared";
import { pool } from "./index";

/**
 * FIRST-BOOT BASELINE (Partition B · deploy prep).
 *
 * The audit proved the gap: `server.ts` boots better-auth tables
 * (db/bootstrap.ts) and a chain of ADDITIVE migrations (ALTER … IF NOT
 * EXISTS / CREATE TABLE IF NOT EXISTS for `customers`, `cash_movements`,
 * `sync_sale_*`, `tenant_settings`), but NOTHING creates the BASE business
 * tables (`categories`, `products`, `product_variants`, `shifts`, `tickets`,
 * `ticket_lines`, `payments`, `closedcash`, `stockcurrent`, `stockdiary`,
 * `sync_log`). Tests and dev hide it because `apps/api/test/setup-global.ts`
 * pre-runs `drizzle-kit push`; a fresh production database therefore booted
 * into a chain of ALTERs against tables that do not exist.
 *
 * This module closes that hole, once:
 *
 *  1. `BASELINE_SQL` is the reviewed baseline: the drift-tested local DDL
 *     (`packages/shared/src/local-schema.ts` → LOCAL_SCHEMA_SQL, the exact
 *     artifact the schema-contract test proves column-identical to the
 *     Drizzle schema) plus the server-only `audit_log` table. Everything is
 *     `IF NOT EXISTS`, so running it against an EXISTING pilot database is a
 *     no-op — never destructive, never a data migration.
 *  2. It runs ONLY when the `schema_baseline` marker row is absent. The
 *     marker is written in the SAME transaction as the DDL, under an
 *     advisory lock, so two API replicas booting at once cannot double-apply
 *     or race the catalog (`CREATE TABLE IF NOT EXISTS` still races on
 *     pg_type).
 *  3. Existing additive migrations run AFTER this (server.ts order) and
 *     simply find their objects already there.
 *
 * Never run this by hand against a database you care about without reading
 * BASELINE_SQL first — it is plain DDL, but it is still DDL.
 */

/** Marker row: presence == baseline already applied. */
export const BASELINE_MARKER = "business-schema-v1";

/** Advisory lock: serializes concurrent API boots. */
const BASELINE_LOCK_KEY = "nexora:baseline:v1";

/**
 * Server-only audit trail (apps/api/src/db/schema.ts → auditLog). Deliberately
 * NOT in LOCAL_SCHEMA_SQL (that file is the CLIENT mirror: "no auth tables,
 * no audit_log") and not covered by any additive boot migration — so it belongs
 * to the baseline.
 *
 * `tenant_id` is nullable on purpose: platform-level audit rows (founder
 * tenant creation) carry no tenant.
 */
export const AUDIT_LOG_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  tenant_id uuid,
  actor text NOT NULL,
  action text NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_tenant_created_idx ON audit_log (tenant_id, created_at);
`;

/** The reviewed first-boot DDL. Idempotent, transactional, marker-gated. */
export const BASELINE_SQL = `${LOCAL_SCHEMA_SQL}
${AUDIT_LOG_SQL}`;

/** Marker table (created before the gate is evaluated). */
export const BASELINE_MARKER_TABLE_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_baseline (
  marker text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text,
  details jsonb
)
`;

/**
 * Applies BASELINE_SQL exactly once per database.
 *
 * Safe to call from every entry point (server boot, CLI, tests): the fast
 * path is a single indexed SELECT when the marker is already there.
 */
export async function initBaseline(): Promise<void> {
  await pool.query(BASELINE_MARKER_TABLE_SQL);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      BASELINE_LOCK_KEY,
    ]);

    const applied = await client.query(
      "SELECT 1 FROM schema_baseline WHERE marker = $1",
      [BASELINE_MARKER],
    );
    if ((applied.rowCount ?? 0) > 0) {
      await client.query("COMMIT");
      return;
    }

    await client.query(BASELINE_SQL);
    await client.query(
      `INSERT INTO schema_baseline (marker, applied_at, applied_by, details)
       VALUES ($1, now(), $2, $3::jsonb)
       ON CONFLICT (marker) DO NOTHING`,
      [
        BASELINE_MARKER,
        `server:${process.pid}`,
        JSON.stringify({
          source: "packages/shared/src/local-schema.ts (LOCAL_SCHEMA_SQL) + audit_log",
          nodeEnv: process.env.NODE_ENV ?? "development",
        }),
      ],
    );
    await client.query("COMMIT");
    console.log(
      `[baseline] first boot: business schema baseline applied (${BASELINE_MARKER})`,
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
