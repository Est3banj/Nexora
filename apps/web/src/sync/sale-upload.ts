import type { PGlite } from "@electric-sql/pglite";
import { scopedFetch } from "./scoped-fetch";
import { canonicalJson, mutationEnvelopeSchema, saleDigest, saleManifestSchema, syncPushResponseSchema, MUTATION_BATCH_MAX, SALE_SYNC_BYTES_MAX, SALE_OUTBOX_MIGRATION_SQL } from "@pos/shared";

export class SaleUploadError extends Error {
  constructor(message: string, readonly deterministic: boolean) { super(message); }
}

/** Snapshot persists BEFORE first network write; never rebuilt from a moving
 * upsert-latest queue after response loss, reload or later catalog edits. */
export async function saveSaleSnapshot<T>(db: PGlite, tenant: string, rows: T[]): Promise<string> {
  await db.exec(SALE_OUTBOX_MIGRATION_SQL);
  const id = globalThis.crypto.randomUUID();
  await db.query("INSERT INTO sync_sale_outbox(tenant_id,operation_id,rows) VALUES($1,$2,$3::jsonb)", [tenant, id, JSON.stringify(rows)]);
  return id;
}

export async function uploadSaleSnapshot(db: PGlite, tenant: string, operation: string) {
  const stored = await db.query<{ rows: unknown[] }>("SELECT rows FROM sync_sale_outbox WHERE tenant_id=$1 AND operation_id=$2", [tenant, operation]);
  const items = mutationEnvelopeSchema.array().parse(stored.rows[0].rows);
  const ticket = items.find(m => m.entity === "ticket");
  if (!ticket || new TextEncoder().encode(canonicalJson(items)).byteLength > SALE_SYNC_BYTES_MAX / 2) throw new SaleUploadError("La venta excede el límite de 2 MiB de sincronización", true);
  const parts = [];
  for (let i = 0; i < items.length; i += MUTATION_BATCH_MAX) parts.push(items.slice(i, i + MUTATION_BATCH_MAX));
  const parsed = saleManifestSchema.safeParse({ ticket_id: ticket.client_uuid, count: items.length, parts: await Promise.all(parts.map(saleDigest)), hash: await saleDigest(items) });
  if (!parsed.success) throw new SaleUploadError("La venta excede el límite de 2000 mutaciones", true);
  const manifest = parsed.data;
  async function post(path: string, body: unknown) {
    const res = await scopedFetch(tenant, `/api/sync/sales/${operation}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      const error = await res.json().catch(() => ({})) as { error?: string };
      const message = error.error ?? `server_${res.status}`;
      // Missing dependencies/expired staging and server errors stay retryable.
      throw new SaleUploadError(message, [400, 413].includes(res.status) || res.status === 409 && !message.includes("db_error") && message !== "sale_incomplete" && message !== "tenant_mismatch");
    }
    return res.json();
  }
  for (let index = 0; index < parts.length; index++) await post("parts", { manifest, index, mutations: parts[index] });
  return syncPushResponseSchema.parse(await post("finalize", manifest)).results;
}
