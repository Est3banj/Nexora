import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  primaryKey,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Drizzle schema — design §2. Decisions locked for D1 (task D1-2):
 *
 * - `tenant_id` on EVERY business table. Plain uuid, deliberately WITHOUT an
 *   FK to better-auth `organization`: auth tables are bootstrapped by
 *   better-auth itself (getMigrations), not by drizzle-kit, and PGlite's
 *   local mirror has no auth tables — an FK would break schema parity
 *   (see test/schema-contract.test.ts). Tenancy integrity is enforced by
 *   the auth session layer + scopedRepo, not by the DB.
 * - Money = integer COP. PK = client-generated uuid.
 * - `unique(tenant_id, client_uuid)` on every upsertable table → idempotent
 *   `ON CONFLICT` upserts (never-cut list).
 * - `ticket_no`: tenant sequence starting at 1, assigned as MAX+1 inside the
 *   committing transaction (single-device pilot; server assigns the same way
 *   when replaying a client payload — replay is deduped by client_uuid, so
 *   no renumbering happens).
 * - `stockcurrent` is the derived stock cache maintained alongside
 *   `product_variants.stock` from D1-7 stock adjustments (both updated in
 *   the same transaction); `stockdiary` is the append-only truth.
 */

const idCol = () => uuid("id").primaryKey();
const tenantCol = () => uuid("tenant_id").notNull();
const clientUuidCol = () => uuid("client_uuid").notNull();
const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// Server-only staging/receipts. Production uses the additive migration;
// declarations also keep disposable-test schema tooling aware of these tables.
export const syncSaleOperations = pgTable("sync_sale_operations", {
  tenant_id: tenantCol(),
  operation_id: uuid("operation_id").notNull(),
  manifest: jsonb("manifest").notNull(),
  results: jsonb("results"),
  created_at: createdAt(),
}, t => [
  primaryKey({ columns: [t.tenant_id,t.operation_id] }),
  index("sync_sale_operations_expiry").on(t.tenant_id,t.created_at).where(sql`${t.results} IS NULL`),
]);

export const syncSaleParts = pgTable("sync_sale_parts", {
  tenant_id: tenantCol(),
  operation_id: uuid("operation_id").notNull(),
  part_index: integer("part_index").notNull(),
  mutations: jsonb("mutations").notNull(),
}, t => [
  primaryKey({ columns: [t.tenant_id,t.operation_id,t.part_index] }),
  foreignKey({ columns:[t.tenant_id,t.operation_id],foreignColumns:[syncSaleOperations.tenant_id,syncSaleOperations.operation_id] }).onDelete("cascade"),
]);

export const categories = pgTable(
  "categories",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    name: text("name").notNull(),
    icon_key: text("icon_key"),
    active: boolean("active").notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("categories_tenant_client_uq").on(t.tenant_id, t.client_uuid),
    uniqueIndex("categories_tenant_name_uq").on(t.tenant_id, t.name),
    index("categories_tenant_active_idx").on(t.tenant_id, t.active),
  ],
);

export const products = pgTable(
  "products",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    name: text("name").notNull(),
    icon_key: text("icon_key"),
    category_id: uuid("category_id"),
    /** data-URL image, client-compressed ≤ ~150KB before enqueue */
    photo: text("photo"),
    active: boolean("active").notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_tenant_client_uq").on(t.tenant_id, t.client_uuid),
    index("products_tenant_active_idx").on(t.tenant_id, t.active),
    index("products_tenant_category_idx").on(t.tenant_id, t.category_id),
  ],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    product_id: uuid("product_id").notNull(),
    code: text("code"),
    name: text("name").notNull(),
    price: integer("price").notNull(),
    /** unit cost COP — null when unknown; margin = price − cost */
    cost: integer("cost"),
    stock: integer("stock").notNull().default(0),
    low_stock_threshold: integer("low_stock_threshold"),
    active: boolean("active").notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("product_variants_tenant_client_uq").on(
      t.tenant_id,
      t.client_uuid,
    ),
    uniqueIndex("product_variants_tenant_product_name_uq").on(
      t.tenant_id,
      t.product_id,
      t.name,
    ),
    index("product_variants_tenant_product_idx").on(t.tenant_id, t.product_id),
    uniqueIndex("product_variants_tenant_code_uq").on(t.tenant_id, t.code),
    check("product_variants_code_normalized", sql`${t.code} IS NULL OR (${t.code} = btrim(${t.code}) AND length(${t.code}) BETWEEN 1 AND 120)`),
  ],
);

export const shifts = pgTable(
  "shifts",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    status: text("status").notNull().default("open"),
    opening_cash: integer("opening_cash").notNull().default(0),
    opened_by: uuid("opened_by"),
    calculation_version: text("calculation_version").notNull().default("legacy_v1"),
    opened_at: timestamp("opened_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    closed_at: timestamp("closed_at", { withTimezone: true }),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("shifts_tenant_client_uq").on(t.tenant_id, t.client_uuid),
    // partial unique: at most ONE open shift per tenant (design §2)
    uniqueIndex("shifts_open_per_tenant_uq")
      .on(t.tenant_id)
      .where(sql`status = 'open'`),
  ],
);

export const tickets = pgTable(
  "tickets",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    shift_id: uuid("shift_id"),
    ticket_no: integer("ticket_no").notNull(),
    status: text("status").notNull().default("completed"),
    total: integer("total").notNull(),
    /** credit attribution — nullable, NO FK (business-table precedent) */
    customer_id: uuid("customer_id"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("tickets_tenant_client_uq").on(t.tenant_id, t.client_uuid),
    uniqueIndex("tickets_tenant_ticket_no_uq").on(t.tenant_id, t.ticket_no),
    index("tickets_tenant_created_idx").on(t.tenant_id, t.created_at),
    index("tickets_tenant_customer_idx").on(t.tenant_id, t.customer_id),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    name: text("name").notNull(),
    credit_limit: integer("credit_limit"),
    phone: text("phone"),
    notes: text("notes"),
    /** soft-delete, mirrors products */
    active: boolean("active").notNull().default(true),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    // D7: unique(tenant_id, client_uuid) ONLY — two customers can share a
    // name; duplicate prevention is a picker UX concern, not a DB constraint.
    uniqueIndex("customers_tenant_client_uq").on(t.tenant_id, t.client_uuid),
    index("customers_tenant_active_idx").on(t.tenant_id, t.active),
    index("customers_tenant_name_idx").on(t.tenant_id, t.name),
  ],
);

export const creditAbonos = pgTable(
  "credit_abonos",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    customer_id: uuid("customer_id").notNull(),
    /** integer COP, >0 — enforced zod-only (payments precedent: no CHECK) */
    amount: integer("amount").notNull(),
    /** 'cash' | 'transfer' — never 'credit'; abonos are NEVER payments */
    method: text("method").notNull(),
    /** cash abono enters THIS shift's arqueo; null = no open shift */
    shift_id: uuid("shift_id"),
    /** optional attribution (D2) — never the void-rule input */
    ticket_id: uuid("ticket_id"),
    note: text("note"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("credit_abonos_tenant_client_uq").on(t.tenant_id, t.client_uuid),
    index("credit_abonos_tenant_customer_idx").on(t.tenant_id, t.customer_id),
    index("credit_abonos_tenant_shift_idx").on(t.tenant_id, t.shift_id),
    index("credit_abonos_tenant_ticket_idx").on(t.tenant_id, t.ticket_id),
    index("credit_abonos_tenant_created_idx").on(t.tenant_id, t.created_at),
  ],
);

export const cashMovements = pgTable("cash_movements", {
  id: idCol(), tenant_id: tenantCol(), client_uuid: clientUuidCol(),
  shift_id: uuid("shift_id").notNull(), direction: text("direction").notNull(),
  amount: integer("amount").notNull(), reason: text("reason").notNull(), note: text("note"),
  created_at: createdAt(), updated_at: updatedAt(),
}, (t) => [
  uniqueIndex("cash_movements_tenant_client_uq").on(t.tenant_id, t.client_uuid),
  index("cash_movements_tenant_shift_created_idx").on(t.tenant_id, t.shift_id, t.created_at),
  index("cash_movements_tenant_created_idx").on(t.tenant_id, t.created_at),
]);

export const ticketLines = pgTable(
  "ticket_lines",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    ticket_id: uuid("ticket_id").notNull(),
    variant_id: uuid("variant_id").notNull(),
    qty: integer("qty").notNull(),
    unit_price: integer("unit_price").notNull(),
    subtotal: integer("subtotal").notNull(),
    /** Cost captured at sale time — historical COGS, never rewritten. */
    unit_cost: integer("unit_cost"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("ticket_lines_tenant_client_uq").on(
      t.tenant_id,
      t.client_uuid,
    ),
    index("ticket_lines_ticket_idx").on(t.ticket_id),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    ticket_id: uuid("ticket_id").notNull(),
    method: text("method").notNull(), // 'cash' | 'transfer'
    amount: integer("amount").notNull(),
    tendered: integer("tendered"),
    vuelto: integer("vuelto"),
    status: text("status").notNull().default("pending"), // 'pending' | 'confirmed'
    confirmed_at: timestamp("confirmed_at", { withTimezone: true }),
    shift_id: uuid("shift_id"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("payments_tenant_client_uq").on(t.tenant_id, t.client_uuid),
    index("payments_tenant_shift_status_idx").on(
      t.tenant_id,
      t.shift_id,
      t.status,
    ),
    index("payments_tenant_created_idx").on(t.tenant_id, t.created_at),
  ],
);

export const closedcash = pgTable(
  "closedcash",
  {
    closing_note: text("closing_note"),
    calculation_version: text("calculation_version").notNull().default("legacy_v1"),
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    shift_id: uuid("shift_id").notNull(),
    expected: integer("expected").notNull(),
    counted: integer("counted").notNull(),
    diff: integer("diff").notNull(),
    closed_by: uuid("closed_by"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("closedcash_tenant_shift_uq").on(t.tenant_id, t.shift_id),
    uniqueIndex("closedcash_tenant_client_uq").on(t.tenant_id, t.client_uuid),
  ],
);

export const stockcurrent = pgTable(
  "stockcurrent",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    variant_id: uuid("variant_id").notNull(),
    stock: integer("stock").notNull().default(0),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("stockcurrent_tenant_variant_uq").on(
      t.tenant_id,
      t.variant_id,
    ),
  ],
);

export const stockdiary = pgTable(
  "stockdiary",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    variant_id: uuid("variant_id").notNull(),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    ref_ticket_id: uuid("ref_ticket_id"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("stockdiary_tenant_client_uq").on(t.tenant_id, t.client_uuid),
    index("stockdiary_tenant_variant_created_idx").on(
      t.tenant_id,
      t.variant_id,
      t.created_at,
    ),
  ],
);

export const syncLog = pgTable(
  "sync_log",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    entity: text("entity").notNull(),
    op: text("op").notNull().default("upsert"),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    last_error: text("last_error"),
    // epoch ms — LWW comparator (design §3), number mode for JS ergonomics
    client_ts: bigint("client_ts", { mode: "number" }).notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("sync_log_tenant_client_uq").on(t.tenant_id, t.client_uuid),
    index("sync_log_tenant_status_client_ts_idx").on(
      t.tenant_id,
      t.status,
      t.client_ts,
    ),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: idCol(),
    tenant_id: uuid("tenant_id"),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    meta: jsonb("meta"),
    created_at: createdAt(),
  },
  (t) => [index("audit_log_tenant_created_idx").on(t.tenant_id, t.created_at)],
);

// Server-only per-tenant settings (roles-admin 3.1 / design D4). Same
// "server-only" lineage as `syncSaleOperations` above: NOT in
// `local-schema.ts`, NOT in `SHARED_TABLES`/`EXPECTED_INDEXES`, NOT in
// `BUSINESS_TABLES`, no rehydrate key, no sync entity — its absence from
// the parity contract is deliberate and pinned by negative assertions
// (test/schema-contract.test.ts, task 3.11). One row per tenant, PK point
// lookup only — NO secondary indexes.
export const tenantSettings = pgTable(
  "tenant_settings",
  {
    // PK = tenant_id (no surrogate id): one settings row per tenant by
    // construction, so upsert is a plain ON CONFLICT on the PK.
    tenant_id: uuid("tenant_id").primaryKey(),
    store_name: text("store_name"),
    nit: text("nit"),
    address: text("address"),
    phone: text("phone"),
    ticket_footer: text("ticket_footer"),
    /** display-only prefix (e.g. "NX") — never touches ticket_no sequence */
    ticket_prefix: text("ticket_prefix"),
    /** STORED ONLY, 0..100; no math anywhere (B1/IVA deferred) */
    iva_pct: integer("iva_pct"),
    /** UI pre-fill only — the server never injects it (design D4b) */
    default_credit_limit: integer("default_credit_limit"),
    // Defaults = CURRENT behavior: absent row → oversell allowed, fiado on,
    // annul code off (spec settings §Absent row = current behavior).
    allow_negative_stock: boolean("allow_negative_stock").notNull().default(true),
    require_annul_code: boolean("require_annul_code").notNull().default(false),
    enable_fiado: boolean("enable_fiado").notNull().default(true),
    /** HMAC hex of the annul code — NEVER leaves the server (D3/D4) */
    annul_code_hash: text("annul_code_hash"),
    annul_code_expires_at: timestamp("annul_code_expires_at", { withTimezone: true }),
    annul_code_created_by: uuid("annul_code_created_by"),
    updated_at: updatedAt(),
    updated_by: uuid("updated_by"),
  },
  (t) => [
    check(
      "tenant_settings_iva_pct_ck",
      sql`${t.iva_pct} IS NULL OR (${t.iva_pct} BETWEEN 0 AND 100)`,
    ),
  ],
);

export type Product = typeof products.$inferSelect;
export type ProductVariant = typeof productVariants.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type TicketLine = typeof ticketLines.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type StockDiary = typeof stockdiary.$inferSelect;
export type SyncLogEntry = typeof syncLog.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type CreditAbono = typeof creditAbonos.$inferSelect;
export type TenantSettings = typeof tenantSettings.$inferSelect;
