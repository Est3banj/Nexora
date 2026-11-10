import { z } from "zod";
import { canonicalJson, mutationEnvelopeSchema, MUTATION_BATCH_MAX } from "./mutations";

export const SALE_SYNC_MAX = 2000;
export const SALE_SYNC_BYTES_MAX = 4 * 1024 * 1024;
export const SALE_SYNC_PARTS_MAX = Math.ceil(SALE_SYNC_MAX / MUTATION_BATCH_MAX);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const saleManifestSchema = z.object({
  ticket_id: z.uuid(),
  count: z.number().int().min(1).max(SALE_SYNC_MAX),
  parts: z.array(hash).min(1).max(SALE_SYNC_PARTS_MAX),
  hash,
}).strict();
export type SaleManifest = z.infer<typeof saleManifestSchema>;
export const salePartSchema = z.object({
  manifest: saleManifestSchema,
  index: z.number().int().min(0).max(SALE_SYNC_PARTS_MAX - 1),
  mutations: z.array(mutationEnvelopeSchema).min(1).max(MUTATION_BATCH_MAX),
}).strict();

/** SHA-256 of canonical, schema-parsed envelopes (including UUID/version). */
export async function saleDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Additive on Postgres; receipts deliberately survive payload TTL cleanup. */
export const SALE_STAGE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS sync_sale_operations (
  tenant_id uuid NOT NULL, operation_id uuid NOT NULL,
  manifest jsonb NOT NULL, results jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
CREATE TABLE IF NOT EXISTS sync_sale_parts (
  tenant_id uuid NOT NULL, operation_id uuid NOT NULL, part_index integer NOT NULL,
  mutations jsonb NOT NULL,
  PRIMARY KEY (tenant_id, operation_id, part_index),
  FOREIGN KEY (tenant_id, operation_id) REFERENCES sync_sale_operations(tenant_id, operation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS sync_sale_operations_expiry ON sync_sale_operations(tenant_id, created_at) WHERE results IS NULL;
`;

/** Same datadir, no reset/version bump; immutable upload snapshot. */
export const SALE_OUTBOX_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS sync_sale_outbox (
  tenant_id uuid NOT NULL, operation_id uuid NOT NULL,
  rows jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation_id)
);
ALTER TABLE sync_sale_outbox ADD COLUMN IF NOT EXISTS last_attempt timestamptz;
`;
