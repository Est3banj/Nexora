/**
 * Local PGlite DDL — mirrors apps/api/src/db/schema.ts table-for-table.
 *
 * PGlite is WASM Postgres, so this is real Postgres DDL. The drift test
 * (apps/api/test/schema-contract.test.ts) asserts the column sets of this
 * file and the Drizzle schema stay identical — if you change one, change
 * the other (this is the D1-6/D1-2 anti-drift contract).
 *
 * Local cache only: no auth tables, no audit_log (server-only concerns).
 */
export const VARIANT_CODE_MIGRATION_SQL = /* sql */ `
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS code text;
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_tenant_code_uq ON product_variants (tenant_id, code);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_code_normalized' AND conrelid = 'product_variants'::regclass) THEN
    ALTER TABLE product_variants ADD CONSTRAINT product_variants_code_normalized
      CHECK (code IS NULL OR (code = btrim(code) AND length(code) BETWEEN 1 AND 120));
  END IF;
END $$;
`;

/**
 * Historical cost per sale line (additive). Backfills existing lines from
 * the variant's current cost once; new sales write cost at commit time.
 * Changing a product's cost later never rewrites past COGS.
 */
export const TICKET_LINE_COST_MIGRATION_SQL = /* sql */ `
ALTER TABLE ticket_lines ADD COLUMN IF NOT EXISTS unit_cost integer;
UPDATE ticket_lines l
SET unit_cost = v.cost
FROM product_variants v
WHERE v.id = l.variant_id
  AND v.tenant_id = l.tenant_id
  AND l.unit_cost IS NULL
  AND v.cost IS NOT NULL;
`;

/**
 * Fiado (credit) schema — additive, design §2. One source of truth: the
 * local PGlite open path interpolates this into LOCAL_SCHEMA_SQL and the
 * server runs it from apps/api/src/db/migrate-fiado.ts, so both stores
 * grow the same objects (schema parity test enforces it).
 *
 * Idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`) like the
 * VARIANT_CODE precedent: re-running on every open is safe, so no datadir
 * bump and no forced rehydrate. Plain DDL only — no `$n` params.
 */
export const FIADO_MIGRATION_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  name text NOT NULL,
  phone text,
  notes text,
  active boolean NOT NULL DEFAULT true,          -- soft-delete, mirrors products
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_tenant_client_uq ON customers (tenant_id, client_uuid);
CREATE INDEX IF NOT EXISTS customers_tenant_active_idx ON customers (tenant_id, active);
CREATE INDEX IF NOT EXISTS customers_tenant_name_idx ON customers (tenant_id, name);   -- picker search (NON-unique)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit integer;

CREATE TABLE IF NOT EXISTS credit_abonos (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  customer_id uuid NOT NULL,
  amount integer NOT NULL,                        -- >0 enforced zod-only (payments precedent: no CHECK)
  method text NOT NULL,                           -- 'cash' | 'transfer' — NEVER 'credit', NEVER a payment
  shift_id uuid,                                  -- cash abono enters THIS shift's arqueo; null = no open shift
  ticket_id uuid,                                 -- nullable — optional linkage (D2)
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_abonos_tenant_client_uq ON credit_abonos (tenant_id, client_uuid);
CREATE INDEX IF NOT EXISTS credit_abonos_tenant_customer_idx ON credit_abonos (tenant_id, customer_id);
CREATE INDEX IF NOT EXISTS credit_abonos_tenant_shift_idx ON credit_abonos (tenant_id, shift_id);
CREATE INDEX IF NOT EXISTS credit_abonos_tenant_ticket_idx ON credit_abonos (tenant_id, ticket_id);
CREATE INDEX IF NOT EXISTS credit_abonos_tenant_created_idx ON credit_abonos (tenant_id, created_at);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_id uuid;   -- nullable, NO DB FK (business-table precedent)
CREATE INDEX IF NOT EXISTS tickets_tenant_customer_idx ON tickets (tenant_id, customer_id);
`;

/**
 * Mesas (control de comandas) — the ONLY server-visible piece of the module
 * in Fase 1: an additive, nullable `table_name` stamped on the ticket at
 * cobro time so the receipt and the ticket detail can name the table.
 *
 * Same additive pattern as `customer_id` above: `ADD COLUMN IF NOT EXISTS`,
 * no datadir bump, no forced rehydrate. Applied by the local open path
 * (inside LOCAL_SCHEMA_SQL) AND by the server boot chain
 * (apps/api/src/db/migrate-mesas.ts) so both stores stay column-identical
 * (schema-contract test covers `tickets`).
 */
export const TICKET_TABLE_NAME_MIGRATION_SQL = /* sql */ `
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS table_name text;
`;

/**
 * Mesas (control de comandas) — Fase 2 · sync entities (CONTROL-MESAS.md ·
 * opción B). ONE idempotent string runs on BOTH stores:
 *  - local PGlite open path (`pglite.ts`, after LOCAL_SCHEMA_SQL), and
 *  - server boot (`apps/api/src/db/migrate-mesas.ts`) — the first-boot
 *    BASELINE also embeds it via LOCAL_SCHEMA_SQL below, so a fresh server
 *    gets the three tables with zero extra steps.
 *
 * Fase 1 created `tables`/`orders`/`order_lines` WITHOUT `client_uuid` and
 * with occupancy columns on the table. Fase 2 (additive, no datadir bump):
 *  - `client_uuid` added to all three + backfill `client_uuid = id` — the
 *    byte-for-byte upsert contract of every sync entity
 *    (unique(tenant_id, client_uuid) + ON CONFLICT target).
 *  - `orders.billing_at` — «Pedir cuenta» moves from `tables.status` to the
 *    ORDER, so occupancy/billing derive from the comanda itself and the
 *    table row only ever conflicts on catalog edits (decision 8).
 *  - `tickets.order_id` + PARTIAL UNIQUE (where not null) — the double-cobro
 *    backstop: the second ticket of the same comanda is rejected server-side.
 *  - PARTIAL UNIQUE one `open` order per (tenant, table) — a second device
 *    cannot silently fork a comanda for a table the server already has open.
 *
 * Legacy columns `tables.status/current_order_id/opened_at` are KEPT (schema
 * parity + old data) but NO LONGER READ NOR WRITTEN by the app: every read
 * derives occupancy from `orders` (listBoardTables/listTables/getTable).
 */
export const MESAS_MIGRATION_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS tables (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  name text NOT NULL,
  zone text,
  capacity integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'available',        -- LEGACY (Fase 1): derived from orders now
  current_order_id uuid,                           -- LEGACY (Fase 1): derived from orders now
  opened_at timestamptz,                           -- LEGACY (Fase 1): derived from orders now
  active boolean NOT NULL DEFAULT true,            -- soft-hide, mirrors products
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tables_tenant_active_idx ON tables (tenant_id, active);
CREATE UNIQUE INDEX IF NOT EXISTS tables_tenant_name_uq ON tables (tenant_id, name) WHERE active;

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  table_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'open',              -- 'open' | 'cancelled' | 'closed'
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  billing_at timestamptz,                          -- «Pedir cuenta» flag (Fase 2)
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_tenant_table_idx ON orders (tenant_id, table_id);
CREATE INDEX IF NOT EXISTS orders_tenant_state_idx ON orders (tenant_id, state);

CREATE TABLE IF NOT EXISTS order_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  order_id uuid NOT NULL,
  variant_id uuid NOT NULL,                        -- price/stock live on the variant (see note above)
  name text NOT NULL,                              -- denormalized label: the comanda must read without joins
  price integer NOT NULL,
  qty integer NOT NULL,
  notes text,
  deleted_at timestamptz,                          -- soft-delete: removals are a state, not a delete
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS order_lines_order_idx ON order_lines (order_id);

-- Fase 1 → Fase 2 upgrade of EXISTING local rows (fresh installs get the
-- columns straight from CREATE above; these ALTERs are no-ops there).
ALTER TABLE tables ADD COLUMN IF NOT EXISTS client_uuid uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_uuid uuid;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS billing_at timestamptz;
ALTER TABLE order_lines ADD COLUMN IF NOT EXISTS client_uuid uuid;
UPDATE tables SET client_uuid = id WHERE client_uuid IS NULL;
UPDATE orders SET client_uuid = id WHERE client_uuid IS NULL;
UPDATE order_lines SET client_uuid = id WHERE client_uuid IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute a
             WHERE a.attname = 'client_uuid' AND NOT a.attnotnull AND NOT a.attisdropped
               AND a.attrelid IN ('tables'::regclass, 'orders'::regclass, 'order_lines'::regclass)) THEN
    ALTER TABLE tables ALTER COLUMN client_uuid SET NOT NULL;
    ALTER TABLE orders ALTER COLUMN client_uuid SET NOT NULL;
    ALTER TABLE order_lines ALTER COLUMN client_uuid SET NOT NULL;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS tables_tenant_client_uq ON tables (tenant_id, client_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS orders_tenant_client_uq ON orders (tenant_id, client_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS order_lines_tenant_client_uq ON order_lines (tenant_id, client_uuid);
-- one OPEN comanda per table (concurrent-open backstop; state='open' only so
-- closed/cancelled history never conflicts)
CREATE UNIQUE INDEX IF NOT EXISTS orders_tenant_table_open_uq ON orders (tenant_id, table_id) WHERE state = 'open';

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS order_id uuid;
-- DOUBLE-COBRO BACKSTOP: at most ONE ticket may ever settle a comanda.
CREATE UNIQUE INDEX IF NOT EXISTS tickets_tenant_order_id_uq ON tickets (tenant_id, order_id) WHERE order_id IS NOT NULL;
`;

export const PROTOTYPE_MIGRATION_SQL = /* sql */ `
ALTER TABLE products ADD COLUMN IF NOT EXISTS icon_key text;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon_key text;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS opening_cash integer NOT NULL DEFAULT 0;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS opened_by uuid;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS calculation_version text NOT NULL DEFAULT 'legacy_v1';
ALTER TABLE closedcash ADD COLUMN IF NOT EXISTS closing_note text;
ALTER TABLE closedcash ADD COLUMN IF NOT EXISTS calculation_version text NOT NULL DEFAULT 'legacy_v1';
CREATE TABLE IF NOT EXISTS cash_movements (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, client_uuid uuid NOT NULL,
  shift_id uuid NOT NULL, direction text NOT NULL, amount integer NOT NULL,
  reason text NOT NULL, note text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cash_movements_tenant_client_uq ON cash_movements (tenant_id, client_uuid);
CREATE INDEX IF NOT EXISTS cash_movements_tenant_shift_created_idx ON cash_movements (tenant_id, shift_id, created_at);
CREATE INDEX IF NOT EXISTS cash_movements_tenant_created_idx ON cash_movements (tenant_id, created_at);
`;

export const LOCAL_SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS categories_tenant_client_uq ON categories (tenant_id, client_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS categories_tenant_name_uq ON categories (tenant_id, name);
CREATE INDEX IF NOT EXISTS categories_tenant_active_idx ON categories (tenant_id, active);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  name text NOT NULL,
  category_id uuid,
  photo text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS products_tenant_client_uq ON products (tenant_id, client_uuid);
CREATE INDEX IF NOT EXISTS products_tenant_active_idx ON products (tenant_id, active);
CREATE INDEX IF NOT EXISTS products_tenant_category_idx ON products (tenant_id, category_id);

CREATE TABLE IF NOT EXISTS product_variants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  product_id uuid NOT NULL,
  name text NOT NULL,
  price integer NOT NULL,
  cost integer,
  stock integer NOT NULL DEFAULT 0,
  low_stock_threshold integer,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_tenant_client_uq ON product_variants (tenant_id, client_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_tenant_product_name_uq ON product_variants (tenant_id, product_id, name);
CREATE INDEX IF NOT EXISTS product_variants_tenant_product_idx ON product_variants (tenant_id, product_id);

-- Additive in-place migration: keep pos_v3 and all pending sales.
${VARIANT_CODE_MIGRATION_SQL}

CREATE TABLE IF NOT EXISTS shifts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  status text NOT NULL DEFAULT 'open',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_tenant_client_uq ON shifts (tenant_id, client_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_open_per_tenant_uq ON shifts (tenant_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  shift_id uuid,
  ticket_no integer NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  total integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_tenant_client_uq ON tickets (tenant_id, client_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_tenant_ticket_no_uq ON tickets (tenant_id, ticket_no);
CREATE INDEX IF NOT EXISTS tickets_tenant_created_idx ON tickets (tenant_id, created_at);

-- Fiado: additive credit schema (needs the tickets table for the ALTER) — design §2.
${FIADO_MIGRATION_SQL}

-- Mesas: additive ticket column (needs the tickets table for the ALTER).
${TICKET_TABLE_NAME_MIGRATION_SQL}

-- Mesas Fase 2: tables/orders/order_lines as SYNC entities (needs the
-- tickets table for the order_id backstop ALTER). Inside LOCAL_SCHEMA_SQL on
-- purpose: this string is ALSO the server first-boot BASELINE, and Fase 2
-- wants the comanda domain server-side. The PGlite open path re-runs
-- MESAS_MIGRATION_SQL after this (idempotent) so legacy Fase 1 datadirs
-- upgrade the same way.
${MESAS_MIGRATION_SQL}

CREATE TABLE IF NOT EXISTS ticket_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  ticket_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty integer NOT NULL,
  unit_price integer NOT NULL,
  subtotal integer NOT NULL,
  unit_cost integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_lines_tenant_client_uq ON ticket_lines (tenant_id, client_uuid);
CREATE INDEX IF NOT EXISTS ticket_lines_ticket_idx ON ticket_lines (ticket_id);

-- Historical cost: additive, after ticket_lines exists; backfill once.
${TICKET_LINE_COST_MIGRATION_SQL}

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  ticket_id uuid NOT NULL,
  method text NOT NULL,
  amount integer NOT NULL,
  tendered integer,
  vuelto integer,
  status text NOT NULL DEFAULT 'pending',
  confirmed_at timestamptz,
  shift_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_tenant_client_uq ON payments (tenant_id, client_uuid);
CREATE INDEX IF NOT EXISTS payments_tenant_shift_status_idx ON payments (tenant_id, shift_id, status);
CREATE INDEX IF NOT EXISTS payments_tenant_created_idx ON payments (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS closedcash (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  shift_id uuid NOT NULL,
  expected integer NOT NULL,
  counted integer NOT NULL,
  diff integer NOT NULL,
  closed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS closedcash_tenant_shift_uq ON closedcash (tenant_id, shift_id);
CREATE UNIQUE INDEX IF NOT EXISTS closedcash_tenant_client_uq ON closedcash (tenant_id, client_uuid);
${PROTOTYPE_MIGRATION_SQL}

CREATE TABLE IF NOT EXISTS stockcurrent (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  stock integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stockcurrent_tenant_variant_uq ON stockcurrent (tenant_id, variant_id);

CREATE TABLE IF NOT EXISTS stockdiary (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  variant_id uuid NOT NULL,
  delta integer NOT NULL,
  reason text NOT NULL,
  note text,
  ref_ticket_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS stockdiary_tenant_client_uq ON stockdiary (tenant_id, client_uuid);
CREATE INDEX IF NOT EXISTS stockdiary_tenant_variant_created_idx ON stockdiary (tenant_id, variant_id, created_at);

CREATE TABLE IF NOT EXISTS sync_log (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  entity text NOT NULL,
  op text NOT NULL DEFAULT 'upsert',
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  client_ts bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_log_tenant_client_uq ON sync_log (tenant_id, client_uuid);
CREATE INDEX IF NOT EXISTS sync_log_tenant_status_client_ts_idx ON sync_log (tenant_id, status, client_ts);
`;
