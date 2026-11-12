import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { FIADO_MIGRATION_SQL, LOCAL_SCHEMA_SQL, PROTOTYPE_MIGRATION_SQL } from "@pos/shared";
import type { Pool } from "pg";

/**
 * D1-2 / D1-6 · schema anti-drift contract.
 *
 * The local PGlite DDL (packages/shared/src/local-schema.ts) and the Drizzle
 * schema (apps/api/src/db/schema.ts) must stay identical table-for-table and
 * column-for-column — the client cache and the server truth are the same
 * Postgres dialect, and drift here silently corrupts sync later (D2).
 *
 * Also asserts the D1-2 AC: drizzle-kit push created every index of
 * design §2 (verified against pg_indexes, not against code).
 */

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

const EXPECTED_INDEXES = [
  "cash_movements_tenant_client_uq",
  "cash_movements_tenant_shift_created_idx",
  "cash_movements_tenant_created_idx",
  "audit_log_tenant_created_idx",
  "categories_tenant_active_idx",
  "categories_tenant_client_uq",
  "categories_tenant_name_uq",
  "closedcash_tenant_client_uq",
  "closedcash_tenant_shift_uq",
  "credit_abonos_tenant_created_idx",
  "credit_abonos_tenant_customer_idx",
  "credit_abonos_tenant_shift_idx",
  "credit_abonos_tenant_ticket_idx",
  "customers_tenant_active_idx",
  "customers_tenant_name_idx",
  "payments_tenant_client_uq",
  "payments_tenant_created_idx",
  "payments_tenant_shift_status_idx",
  "product_variants_tenant_client_uq",
  "product_variants_tenant_code_uq",
  "product_variants_tenant_product_idx",
  "product_variants_tenant_product_name_uq",
  "products_tenant_active_idx",
  "products_tenant_category_idx",
  "products_tenant_client_uq",
  "shifts_open_per_tenant_uq",
  "shifts_tenant_client_uq",
  "stockcurrent_tenant_variant_uq",
  "stockdiary_tenant_client_uq",
  "stockdiary_tenant_variant_created_idx",
  "sync_log_tenant_client_uq",
  "sync_log_tenant_status_client_ts_idx",
  "ticket_lines_tenant_client_uq",
  "ticket_lines_ticket_idx",
  "tickets_tenant_client_uq",
  "tickets_tenant_created_idx",
  "tickets_tenant_customer_idx",
  "tickets_tenant_ticket_no_uq",
];

type Col = { table_name: string; column_name: string; data_type: string };

let local: PGlite;
let serverPool: Pool;

beforeAll(async () => {
  local = new PGlite("memory://");
  await local.exec(LOCAL_SCHEMA_SQL);
  const pg = await import("pg");
  const poolClass = pg.default?.Pool ?? pg.Pool;
  serverPool = new poolClass({
    connectionString: process.env.DATABASE_URL,
  });
});

afterAll(async () => {
  await local.close();
  await serverPool?.end();
});

async function columnsOf(kind: "local" | "server"): Promise<Col[]> {
  const sql = `SELECT table_name, column_name, data_type
               FROM information_schema.columns
               WHERE table_schema = 'public'`;
  if (kind === "local") {
    const res = await local.query<Col>(sql);
    return res.rows;
  }
  const res = await serverPool.query<Col>(sql);
  return res.rows;
}

function group(rows: Col[]) {
  const map = new Map<string, Array<{ name: string; type: string }>>();
  for (const r of rows) {
    if (!(SHARED_TABLES as readonly string[]).includes(r.table_name)) continue;
    if (!map.has(r.table_name)) map.set(r.table_name, []);
    map.get(r.table_name)!.push({
      name: r.column_name,
      type: r.data_type,
    });
  }
  for (const cols of map.values()) {
    cols.sort((a, b) => a.name.localeCompare(b.name));
  }
  return map;
}

describe("local PGlite ↔ server Drizzle parity", () => {
  it("prototype migration twice preserves populated legacy shifts and close money in both engines", async () => {
    const client = await serverPool.connect();
    try {
      for (const store of [local, client]) {
        const exec = (s: string) => store === local ? local.exec(s) : client.query(s);
        const query = (s: string) => store === local ? local.query(s) : client.query(s);
        await exec(`CREATE SCHEMA drawer_upgrade; SET search_path TO drawer_upgrade;
          CREATE TABLE shifts(id uuid PRIMARY KEY, status text);
          CREATE TABLE products(id uuid PRIMARY KEY, name text);
          CREATE TABLE categories(id uuid PRIMARY KEY, name text);
          INSERT INTO products VALUES ('11111111-1111-4111-8111-111111111111','Café ñ');
          INSERT INTO categories VALUES ('11111111-1111-4111-8111-111111111111','Bebidas');
          CREATE TABLE closedcash(id uuid PRIMARY KEY, expected integer, counted integer, diff integer);
          INSERT INTO shifts VALUES ('11111111-1111-4111-8111-111111111111','open');
          INSERT INTO closedcash VALUES ('11111111-1111-4111-8111-111111111111',24000,23000,-1000);`);
        try {
          // pg simple-query and PGlite exec support the multi-statement DDL.
          if (store === local) { await local.exec(PROTOTYPE_MIGRATION_SQL); await local.exec(PROTOTYPE_MIGRATION_SQL); }
          else { await client.query(PROTOTYPE_MIGRATION_SQL); await client.query(PROTOTYPE_MIGRATION_SQL); }
          expect((await query("SELECT name,icon_key FROM products")).rows).toEqual([{ name: "Café ñ", icon_key: null }]);
          expect((await query("SELECT name,icon_key FROM categories")).rows).toEqual([{ name: "Bebidas", icon_key: null }]);
          expect((await query("SELECT opening_cash,opened_by,calculation_version FROM shifts")).rows)
            .toEqual([{ opening_cash: 0, opened_by: null, calculation_version: "legacy_v1" }]);
          expect((await query("SELECT expected,counted,diff,closing_note,calculation_version FROM closedcash")).rows)
            .toEqual([{ expected: 24000, counted: 23000, diff: -1000, closing_note: null, calculation_version: "legacy_v1" }]);
          expect((await query(`SELECT is_nullable,column_default FROM information_schema.columns
            WHERE table_schema='drawer_upgrade' AND table_name='shifts' AND column_name='calculation_version'`)).rows[0])
            .toMatchObject({ is_nullable: "NO", column_default: "'legacy_v1'::text" });
        } finally { await exec("SET search_path TO public; DROP SCHEMA drawer_upgrade CASCADE"); }
      }
    } finally { client.release(); }
  });
  it("additive fiado ALTER upgrades populated pre-limit tables twice without backfill in both stores", async () => {
    // Isolated schemas, so this actually exercises ALTER on an OLD table;
    // drizzle push creating a fresh table would not prove upgrade safety.
    const client = await serverPool.connect();
    const stores = [
      { exec: (sql: string) => local.exec(sql), query: (sql: string) => local.query(sql) },
      { exec: (sql: string) => client.query(sql), query: (sql: string) => client.query(sql) },
    ];
    try { for (const store of stores) {
      await store.exec("CREATE SCHEMA fiado_upgrade_contract");
      try {
        const sql = `SET search_path TO fiado_upgrade_contract;
          CREATE TABLE tickets(id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
          CREATE TABLE customers(id uuid PRIMARY KEY, tenant_id uuid NOT NULL, client_uuid uuid NOT NULL,
            name text NOT NULL, phone text, notes text, active boolean DEFAULT true,
            created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
          INSERT INTO customers(id,tenant_id,client_uuid,name) VALUES
            ('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111','Legacy');
          ${FIADO_MIGRATION_SQL}
          ${FIADO_MIGRATION_SQL}
          SET search_path TO public;`;
        await store.exec(sql);
        const rows = await store.query("SELECT name,credit_limit FROM fiado_upgrade_contract.customers");
        expect(rows.rows).toEqual([{ name: "Legacy", credit_limit: null }]);
      } finally {
        await store.exec("SET search_path TO public");
        await store.exec("DROP SCHEMA fiado_upgrade_contract CASCADE");
      }
    } } finally { client.release(); }
  });
  it("creates every shared table locally", async () => {
    const rows = await columnsOf("local");
    const tables = new Set(rows.map((r) => r.table_name));
    for (const table of SHARED_TABLES) {
      expect(tables.has(table), `missing local table ${table}`).toBe(true);
    }
  });

  it("column names and types match exactly (no drift)", async () => {
    const localMap = group(await columnsOf("local"));
    const serverMap = group(await columnsOf("server"));

    for (const table of SHARED_TABLES) {
      const l = JSON.stringify(localMap.get(table));
      const s = JSON.stringify(serverMap.get(table));
      expect(l, `drift on table ${table}`).toBeDefined();
      expect(l, `drift on table ${table}`).toBe(s);
    }
  });

  it("money columns are integer, ids/tenant/client are uuid", async () => {
    const serverMap = group(await columnsOf("server"));
    const find = (table: string, col: string) =>
      serverMap.get(table)?.find((c) => c.name === col)?.type;

    expect(find("tickets", "total")).toBe("integer");
    expect(find("payments", "amount")).toBe("integer");
    expect(find("cash_movements", "amount")).toBe("integer");
    expect(find("shifts", "opening_cash")).toBe("integer");
    expect(find("credit_abonos", "amount")).toBe("integer");
    expect(find("customers", "credit_limit")).toBe("integer");
    expect(find("product_variants", "price")).toBe("integer");
    expect(find("products", "tenant_id")).toBe("uuid");
    expect(find("products", "client_uuid")).toBe("uuid");
    expect(find("tickets", "ticket_no")).toBe("integer");
    expect(find("sync_log", "client_ts")).toBe("bigint");
  });
});

describe("D1-2: drizzle-kit push created every design §2 index", () => {
  it("all expected indexes exist server-side", async () => {
    const res = await serverPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const names = new Set(res.rows.map((r) => r.indexname));
    for (const expected of EXPECTED_INDEXES) {
      expect(names.has(expected), `missing index ${expected}`).toBe(true);
    }
  });

  it("unique(tenant_id, client_uuid) exists on every upsertable table", async () => {
    const res = await serverPool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%_tenant_client_uq'`,
    );
    const defs = res.rows.map((r) => r.indexdef).join("\n");
    for (const table of [
      "cash_movements",
      "products",
      "product_variants",
      "shifts",
      "tickets",
      "ticket_lines",
      "payments",
      "closedcash",
      "stockdiary",
      "sync_log",
      "customers",
      "credit_abonos",
    ]) {
      expect(defs).toContain(`UNIQUE INDEX ${table}_tenant_client_uq ON public.${table} USING btree (tenant_id, client_uuid)`);
    }
  });

  it("partial unique: one open shift per tenant", async () => {
    const res = await serverPool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'shifts_open_per_tenant_uq'`,
    );
    expect(res.rows[0]?.indexdef).toContain("WHERE (status = 'open'::text)");
  });
});
