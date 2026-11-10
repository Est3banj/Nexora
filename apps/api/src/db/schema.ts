import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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

export const categories = pgTable(
  "categories",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    name: text("name").notNull(),
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
  ],
);

export const shifts = pgTable(
  "shifts",
  {
    id: idCol(),
    tenant_id: tenantCol(),
    client_uuid: clientUuidCol(),
    status: text("status").notNull().default("open"),
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
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (t) => [
    uniqueIndex("tickets_tenant_client_uq").on(t.tenant_id, t.client_uuid),
    uniqueIndex("tickets_tenant_ticket_no_uq").on(t.tenant_id, t.ticket_no),
    index("tickets_tenant_created_idx").on(t.tenant_id, t.created_at),
  ],
);

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

export type Product = typeof products.$inferSelect;
export type ProductVariant = typeof productVariants.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type TicketLine = typeof ticketLines.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type StockDiary = typeof stockdiary.$inferSelect;
export type SyncLogEntry = typeof syncLog.$inferSelect;
