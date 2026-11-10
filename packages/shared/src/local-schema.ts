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

CREATE TABLE IF NOT EXISTS ticket_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  client_uuid uuid NOT NULL,
  ticket_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  qty integer NOT NULL,
  unit_price integer NOT NULL,
  subtotal integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_lines_tenant_client_uq ON ticket_lines (tenant_id, client_uuid);
CREATE INDEX IF NOT EXISTS ticket_lines_ticket_idx ON ticket_lines (ticket_id);

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
