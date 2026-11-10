import { z } from "zod";

/**
 * Mutation envelope — THE shared client/server sync contract (task D2-1,
 * design §3 + §10). Imported by BOTH the web queue (apps/web/src/sync) and
 * the server push route (apps/api/src/sync): drift is impossible by
 * construction because both sides parse with the same schemas.
 *
 * Rules encoded here:
 *  - entity union (pilot: upsert only)
 *  - `client_ts` epoch ms = LWW comparator (design §3)
 *  - per-entity payload validation: money is integer COP (`int()`, ≥0),
 *    qty ≥ 1, stock/delta may be negative (oversell is allowed + flagged)
 *  - NO `tenant_id` is ever part of an envelope payload — zod strips
 *    unknown keys, so a forged tenant_id in a payload cannot survive
 *    parsing (tenancy-auth spec §Forged tenant_id ignored)
 */

export const MUTATION_ENTITIES = [
  "ticket",
  "ticket_line",
  "payment",
  "stockdiary",
  "category",
  "product",
  "variant",
  "closedcash",
  "shift",
] as const;

export const mutationEntitySchema = z.enum(MUTATION_ENTITIES);
export type MutationEntity = z.infer<typeof mutationEntitySchema>;

/** Batch size cap — client drains ≤50 per push, server enforces the same. */
export const MUTATION_BATCH_MAX = 50;

const money = z.number().int().nonnegative();
const uuid = z.uuid();
const isoDate = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: "invalid ISO date" });

/* ------------------------------------------------------------------ */
/* Per-entity payload schemas                                          */
/* ------------------------------------------------------------------ */

const ticketPayloadSchema = z.object({
  shift_id: uuid.nullable(),
  ticket_no: z.number().int().positive(),
  status: z.enum(["completed", "transfer_pending"]),
  total: money,
  created_at: isoDate.optional(),
});

const ticketLinePayloadSchema = z.object({
  ticket_id: uuid,
  variant_id: uuid,
  qty: z.number().int().positive(),
  unit_price: money,
  subtotal: money,
  created_at: isoDate.optional(),
});

const paymentPayloadSchema = z.object({
  ticket_id: uuid,
  method: z.enum(["cash", "transfer"]),
  amount: money,
  tendered: money.nullable(),
  vuelto: money.nullable(),
  status: z.enum(["pending", "confirmed"]),
  shift_id: uuid.nullable(),
  confirmed_at: isoDate.nullable().optional(),
  created_at: isoDate.optional(),
});

const stockdiaryPayloadSchema = z.object({
  variant_id: uuid,
  delta: z.number().int(),
  reason: z.string().min(1),
  note: z.string().min(1).nullable().optional(),
  ref_ticket_id: uuid.nullable().optional(),
  created_at: isoDate.optional(),
});

const categoryPayloadSchema = z.object({
  name: z.string().min(1).max(60),
  active: z.boolean().default(true),
});

const productPayloadSchema = z.object({
  name: z.string().min(1),
  category_id: uuid.nullable().optional(),
  /** compressed data-URL; optional so old queue rows stay valid */
  photo: z.string().max(220_000).nullable().optional(),
  active: z.boolean().default(true),
});

const variantPayloadSchema = z.object({
  product_id: uuid,
  name: z.string().min(1),
  price: money,
  cost: money.nullable().optional(),
  // negative stock is legal (oversell spec: warn, allow, balance −2)
  stock: z.number().int(),
  low_stock_threshold: money.nullable(),
  active: z.boolean(),
  /**
   * D3-1: a stock REFRESH emitted by a sale carries the ticket that caused
   * it, so the server groups it into the same sale transaction as the
   * ticket/lines/payment/stockdiary (no partial stock on a mid-group
   * failure). Catalog-only refreshes omit it (solo group).
   */
  ref_ticket_id: uuid.nullable().optional(),
});

const closedcashPayloadSchema = z.object({
  shift_id: uuid,
  expected: money,
  counted: money,
  diff: z.number().int(),
  closed_by: uuid.nullable().optional(),
});

const shiftPayloadSchema = z.object({
  status: z.enum(["open", "closed"]),
  opened_at: isoDate.optional(),
  closed_at: isoDate.nullable().optional(),
});

export const mutationPayloadSchemas = {
  ticket: ticketPayloadSchema,
  ticket_line: ticketLinePayloadSchema,
  payment: paymentPayloadSchema,
  stockdiary: stockdiaryPayloadSchema,
  category: categoryPayloadSchema,
  product: productPayloadSchema,
  variant: variantPayloadSchema,
  closedcash: closedcashPayloadSchema,
  shift: shiftPayloadSchema,
} as const;

/* ------------------------------------------------------------------ */
/* Envelope (discriminated on entity → payload typed per entity)       */
/* ------------------------------------------------------------------ */

function envelopeFor<E extends MutationEntity, P extends z.ZodType>(
  entity: E,
  payload: P,
) {
  return z.object({
    client_uuid: uuid,
    /** epoch ms — LWW comparator (design §3) */
    client_ts: z.number().int().nonnegative(),
    entity: z.literal(entity),
    op: z.literal("upsert").default("upsert"),
    payload,
  });
}

export const mutationEnvelopeSchema = z.discriminatedUnion("entity", [
  envelopeFor("ticket", ticketPayloadSchema),
  envelopeFor("ticket_line", ticketLinePayloadSchema),
  envelopeFor("payment", paymentPayloadSchema),
  envelopeFor("stockdiary", stockdiaryPayloadSchema),
  envelopeFor("category", categoryPayloadSchema),
  envelopeFor("product", productPayloadSchema),
  envelopeFor("variant", variantPayloadSchema),
  envelopeFor("closedcash", closedcashPayloadSchema),
  envelopeFor("shift", shiftPayloadSchema),
]);

export type MutationEnvelope = z.infer<typeof mutationEnvelopeSchema>;

/* ------------------------------------------------------------------ */
/* Push request / response (design §3 wire format)                     */
/* ------------------------------------------------------------------ */

/** Request wrapper: the server validates the envelope PER ITEM (a single
 *  invalid entry becomes a `rejected` result — it never fails the batch). */
export const syncPushBodySchema = z.object({
  mutations: z.array(z.unknown()).min(1).max(MUTATION_BATCH_MAX),
});

export const syncResultStatusSchema = z.enum([
  "applied",
  "duplicate",
  "rejected",
]);

export const syncRejectReasonSchema = z.enum([
  "conflict_hash_mismatch",
  "validation",
  "db_error",
]);

export const syncResultSchema = z.object({
  client_uuid: z.string().nullable(),
  status: syncResultStatusSchema,
  reason: syncRejectReasonSchema.optional(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

export const syncPushResponseSchema = z.object({
  results: z.array(syncResultSchema),
});
export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;

/* ------------------------------------------------------------------ */
/* Content hash (design §3 rule 2: replay-as-different-content)        */
/* ------------------------------------------------------------------ */

/**
 * Deterministic canonical JSON: object keys sorted recursively, arrays keep
 * order, `undefined` keys dropped. Both the stored (jsonb round-tripped)
 * payload and the incoming payload are canonicalized BEFORE hashing, so
 * Postgres jsonb key reordering can never produce a false mismatch.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/**
 * FNV-1a 64-bit over the canonical JSON — synchronous and identical in
 * Node and the browser (no crypto.subtle async, no node:crypto). This is a
 * content FINGERPRINT for divergence detection, not a security primitive:
 * both sides of the sync are the same trusted client.
 */
export function contentHash(payload: unknown): string {
  const str = canonicalJson(payload);
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

/* ------------------------------------------------------------------ */
/* Queue status (design §2 sync_log.status)                            */
/* ------------------------------------------------------------------ */

export const syncStatusSchema = z.enum([
  "pending",
  "in_flight",
  "synced",
  "failed",
  "poison",
]);
export type SyncStatus = z.infer<typeof syncStatusSchema>;
