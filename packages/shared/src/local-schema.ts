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
