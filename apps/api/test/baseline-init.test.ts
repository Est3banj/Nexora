import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { pool } from "../src/db";
import {
  BASELINE_MARKER,
  BASELINE_SQL,
  initBaseline,
} from "../src/db/init-baseline";
import { resetTables } from "./helpers";

/**
 * FIRST-BOOT BASELINE (Partition B · deploy prep).
 *
 * The production gap this covers: tests pre-run `drizzle-kit push`
 * (test/setup-global.ts) and dev has a hand-pushed schema, so nothing in CI
 * ever proved that a EMPTY database can be brought to a servable state by
 * boot code alone. These tests prove exactly that, without touching any
 * real database:
 *
 *  1. BASELINE_SQL on a brand-new PGlite (in-memory Postgres) creates the
 *     full business schema, column-identical to the Drizzle-pushed server
 *     schema, with the indexes the sync upserts depend on.
 *  2. initBaseline() is marker-gated (runs once) and non-destructive (it
 *     never touches rows that are already there).
 */

/** Tables that must exist after the baseline (local-schema ↔ schema.ts). */
const SHARED_TABLES = [
  "cash_movements",
  "categories",
  "products",
  "product_variants",
  "shifts",
  "tickets",
  "ticket_lines",
  "payments",
  "closedcash",
  "stockcurrent",
  "stockdiary",
  "sync_log",
  "customers",
  "credit_abonos",
] as const;

/** Server-only table that belongs to the baseline, not to the client mirror. */
const SERVER_ONLY_TABLES = ["audit_log"] as const;

/** Indexes the runtime depends on (ON CONFLICT upserts + audit + partial unique). */
const REQUIRED_INDEXES = [
  "audit_log_tenant_created_idx",
  "cash_movements_tenant_client_uq",
  "categories_tenant_client_uq",
  "closedcash_tenant_client_uq",
  "credit_abonos_tenant_client_uq",
  "customers_tenant_client_uq",
  "payments_tenant_client_uq",
  "product_variants_tenant_client_uq",
  "product_variants_tenant_code_uq",
  "products_tenant_client_uq",
  "shifts_open_per_tenant_uq",
  "shifts_tenant_client_uq",
  "stockcurrent_tenant_variant_uq",
  "stockdiary_tenant_client_uq",
  "sync_log_tenant_client_uq",
  "ticket_lines_tenant_client_uq",
  "tickets_tenant_client_uq",
  "tickets_tenant_ticket_no_uq",
] as const;

type Col = { table_name: string; column_name: string; data_type: string };

let local: PGlite;

const COLUMNS_SQL = `SELECT table_name, column_name, data_type
   FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = $1
  ORDER BY column_name`;

function normalize(rows: Col[]): Array<{ name: string; type: string }> {
  return rows
    .map((r) => ({ name: r.column_name, type: r.data_type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

beforeAll(async () => {
  local = new PGlite("memory://");
  await local.exec(BASELINE_SQL);
});

afterAll(async () => {
  await local?.close();
});

describe("first-boot baseline DDL (BASELINE_SQL)", () => {
  it("creates every business table on an EMPTY database", async () => {
    const rows = await local.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(rows.rows.map((r) => r.table_name));
    for (const table of [...SHARED_TABLES, ...SERVER_ONLY_TABLES]) {
      expect(tables.has(table), `missing baseline table ${table}`).toBe(true);
    }
  });

  it("is column-identical to the drizzle-pushed server schema", async () => {
    for (const table of [...SHARED_TABLES, ...SERVER_ONLY_TABLES]) {
      const server = normalize((await pool.query<Col>(COLUMNS_SQL, [table])).rows);
      const baseline = normalize((await local.query<Col>(COLUMNS_SQL, [table])).rows);
      expect(server.length, `table ${table} missing on the server`).toBeGreaterThan(0);
      expect(baseline, `column drift on ${table}`).toEqual(server);
    }
  });

  it("creates the indexes the sync upserts and audit trail depend on", async () => {
    const res = await local.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = new Set(res.rows.map((r) => r.indexname));
    for (const expected of REQUIRED_INDEXES) {
      expect(names.has(expected), `missing baseline index ${expected}`).toBe(true);
    }
    const uniqueUpserts = await local.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname LIKE '%_tenant_client_uq'`,
    );
    for (const table of ["products", "tickets", "ticket_lines", "payments", "sync_log"]) {
      expect(uniqueUpserts.rows.map((r) => r.indexdef).join("\n")).toContain(
        `UNIQUE INDEX ${table}_tenant_client_uq ON public.${table} USING btree (tenant_id, client_uuid)`,
      );
    }
  });

  it("does NOT create the tables that belong to later additive migrations", async () => {
    // Deliberate split: baseline = base business schema; boot migrations own
    // the rest (migrate-sale-stage, migrate-settings, db/bootstrap).
    const rows = await local.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const tables = new Set(rows.rows.map((r) => r.table_name));
    for (const later of ["sync_sale_operations", "sync_sale_parts", "tenant_settings", "user"]) {
      expect(tables.has(later), `${later} must come from its own migration`).toBe(false);
    }
  });
});

describe("initBaseline() marker gate", () => {
  it("applies once, is idempotent, and never destroys existing rows", async () => {
    await resetTables();

    const id = "11111111-1111-4111-8111-111111111111";
    const tenant = "22222222-2222-4222-8222-222222222222";
    const client = "33333333-3333-4333-8333-333333333333";
    await pool.query(
      `INSERT INTO categories (id, tenant_id, client_uuid, name)
       VALUES ($1, $2, $3, 'antes del baseline')`,
      [id, tenant, client],
    );

    await initBaseline();
    const first = await pool.query<{ marker: string }>(
      `SELECT marker FROM schema_baseline ORDER BY marker`,
    );
    expect(first.rows).toEqual([{ marker: BASELINE_MARKER }]);

    // Second run: marker present → no second row, no error.
    await initBaseline();
    const second = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_baseline`,
    );
    expect(second.rows[0]?.n).toBe("1");

    // The pre-existing row survived untouched.
    const kept = await pool.query<{ name: string }>(
      `SELECT name FROM categories WHERE id = $1`,
      [id],
    );
    expect(kept.rows).toEqual([{ name: "antes del baseline" }]);

    await pool.query(`DELETE FROM categories WHERE id = $1`, [id]);
    await pool.query(`DELETE FROM schema_baseline`);
  });
});
