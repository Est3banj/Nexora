import { and, eq, ne, sql } from "drizzle-orm";
import { canonicalJson, mutationEnvelopeSchema, saleDigest, saleManifestSchema, SALE_STAGE_MIGRATION_SQL, SALE_SYNC_BYTES_MAX, type SaleManifest, type MutationEnvelope, type SyncResult } from "@pos/shared";
import { db, pool, type Db } from "./index";
import * as t from "./schema";
import { applyMutationGroups } from "./sync-apply";

export async function migrateSaleStage() { await pool.query(SALE_STAGE_MIGRATION_SQL); }
function fail(message: string, statusCode = 409): never { throw Object.assign(new Error(message), { statusCode }); }
type Operation = { manifest: SaleManifest; results: SyncResult[] | null };
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
async function lock(tx: Tx, tenant: string) {
  // Tenant-scoped serialization bounds quotas and also serializes operations
  // for the same (possibly not-yet-existing) ticket. No process-local locks.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sale-stage:${tenant}`}, 0))`);
}

export async function uploadSalePart(tenant: string, operation: string, manifest: SaleManifest, index: number, mutations: MutationEnvelope[]) {
  if (index >= manifest.parts.length || await saleDigest(mutations) !== manifest.parts[index]) fail("sale_part_hash", 400);
  if (Buffer.byteLength(canonicalJson(mutations)) > SALE_SYNC_BYTES_MAX / 4) fail("sale_part_too_large", 413);
  return db.transaction(async tx => {
    await lock(tx, tenant);
    // Only uncommitted uploads expire. Applied receipts NEVER expire/reapply.
    await tx.execute(sql`DELETE FROM sync_sale_operations WHERE tenant_id=${tenant} AND results IS NULL AND created_at < now() - interval '7 days'`);
    const old = (await tx.execute(sql`SELECT manifest, results FROM sync_sale_operations WHERE tenant_id=${tenant} AND operation_id=${operation}`)).rows[0] as Operation | undefined;
    if (old && canonicalJson(old.manifest) !== canonicalJson(manifest)) fail("sale_manifest_conflict");
    if (old?.results) return { staged: true, committed: true };
    if (!old) {
      const quota = (await tx.execute(sql`SELECT count(*)::int AS n FROM sync_sale_operations WHERE tenant_id=${tenant} AND results IS NULL`)).rows[0];
      if (Number(quota.n) >= 32) fail("sale_staging_quota", 429);
      await tx.execute(sql`INSERT INTO sync_sale_operations(tenant_id,operation_id,manifest) VALUES(${tenant},${operation},${JSON.stringify(manifest)}::jsonb)`);
    }
    const prior = (await tx.execute(sql`SELECT mutations FROM sync_sale_parts WHERE tenant_id=${tenant} AND operation_id=${operation} AND part_index=${index}`)).rows[0];
    if (prior && canonicalJson(prior.mutations) !== canonicalJson(mutations)) fail("sale_part_conflict");
    if (!prior) await tx.execute(sql`INSERT INTO sync_sale_parts(tenant_id,operation_id,part_index,mutations) VALUES(${tenant},${operation},${index},${JSON.stringify(mutations)}::jsonb)`);
    const size = (await tx.execute(sql`SELECT coalesce(sum(octet_length(mutations::text)),0) AS bytes FROM sync_sale_parts WHERE tenant_id=${tenant} AND operation_id=${operation}`)).rows[0];
    if (Number(size.bytes) > SALE_SYNC_BYTES_MAX) fail("sale_too_large", 413);
    return { staged: true, committed: false };
  });
}

/** Validate a CLOSED sale aggregate, not just a client-declared group key. */
function validateSale(manifest: SaleManifest, items: MutationEnvelope[]) {
  const tickets = items.filter(m => m.entity === "ticket");
  if (tickets.length !== 1 || tickets[0].client_uuid !== manifest.ticket_id) fail("sale_invalid_aggregate", 400);
  const ticket = tickets[0].payload;
  const lines = items.filter(m => m.entity === "ticket_line");
  const payments = items.filter(m => m.entity === "payment");
  if (!lines.length || !payments.length || new Set(items.map(m => m.client_uuid)).size !== items.length) fail("sale_invalid_aggregate", 400);
  if (lines.some(m => m.payload.subtotal !== m.payload.qty * m.payload.unit_price)
    || lines.reduce((n,m) => n + m.payload.subtotal,0) !== ticket.total
    || payments.reduce((n,m) => n + m.payload.amount,0) !== ticket.total
    || payments.some(m => m.payload.shift_id !== ticket.shift_id)) fail("sale_invalid_totals", 400);
  const quantities = new Map<string, number>();
  for (const m of lines) quantities.set(m.payload.variant_id, (quantities.get(m.payload.variant_id) ?? 0) + m.payload.qty);
  const deltas = new Map<string, number>();
  for (const m of items) {
    if (m.entity === "ticket") continue;
    if (m.entity === "ticket_line" || m.entity === "payment") {
      if (m.payload.ticket_id !== manifest.ticket_id) fail("sale_invalid_parent", 400);
    } else if (m.entity === "stockdiary") {
      // Unsynced initial catalog movement is a dependency of the first sale
      // creating this variant. It commits in the SAME outer transaction.
      if (m.payload.reason === "initial" && !m.payload.ref_ticket_id && items.some(v => v.entity === "variant" && v.client_uuid === m.payload.variant_id)) continue;
      if (m.payload.ref_ticket_id !== manifest.ticket_id || m.payload.reason !== "sale" || !quantities.has(m.payload.variant_id)) fail("sale_invalid_movement", 400);
      deltas.set(m.payload.variant_id, (deltas.get(m.payload.variant_id) ?? 0) + m.payload.delta);
    } else if (m.entity === "variant") {
      if (m.payload.ref_ticket_id !== manifest.ticket_id || !quantities.has(m.client_uuid)) fail("sale_invalid_variant", 400);
    } else fail("sale_mixed_entities", 400);
  }
  for (const [id, qty] of quantities) if (deltas.get(id) !== -qty) fail("sale_invalid_movement", 400);
}

export async function finalizeSale(tenant: string, actor: string, operation: string, manifest: SaleManifest) {
  try { return await db.transaction(async tx => {
    await lock(tx, tenant);
    const row = (await tx.execute(sql`SELECT manifest,results FROM sync_sale_operations WHERE tenant_id=${tenant} AND operation_id=${operation} FOR UPDATE`)).rows[0] as Operation | undefined;
    if (!row) fail("not_found", 404);
    if (canonicalJson(row.manifest) !== canonicalJson(manifest)) fail("sale_manifest_conflict");
    if (row.results) {
      const [ticket] = await tx.select({ status: t.tickets.status }).from(t.tickets).where(and(eq(t.tickets.tenant_id,tenant),eq(t.tickets.id,manifest.ticket_id)));
      return { results: ticket?.status === "voided" ? row.results.map(r=>({...r,voided_ticket:manifest.ticket_id})) : row.results };
    }
    const parts = (await tx.execute(sql`SELECT part_index,mutations FROM sync_sale_parts WHERE tenant_id=${tenant} AND operation_id=${operation} ORDER BY part_index`)).rows;
    if (parts.length !== manifest.parts.length || parts.some((p,i) => p.part_index !== i)) fail("sale_incomplete");
    const items: MutationEnvelope[] = [];
    for (let i = 0; i < parts.length; i++) {
      const parsed = mutationEnvelopeSchema.array().parse(parts[i].mutations);
      if (await saleDigest(parsed) !== manifest.parts[i]) fail("sale_part_hash", 400);
      items.push(...parsed);
    }
    if (items.length !== manifest.count || await saleDigest(items) !== manifest.hash) fail("sale_manifest_hash", 400);
    validateSale(manifest, items);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenant}:ticket:${manifest.ticket_id}`}, 0))`);
    await tx.select().from(t.tickets).where(and(eq(t.tickets.tenant_id, tenant), eq(t.tickets.id, manifest.ticket_id))).for("update");
    // All referenced rows must belong to this tenant. UUID FK alone is NOT
    // tenant isolation (business tables use globally unique UUID primary keys).
    for (const m of items) {
      const table = m.entity === "ticket" ? t.tickets : m.entity === "ticket_line" ? t.ticketLines : m.entity === "payment" ? t.payments : m.entity === "variant" ? t.productVariants : t.stockdiary;
      const [foreign] = await tx.select({ id: table.id }).from(table).where(and(eq(table.id,m.client_uuid),ne(table.tenant_id,tenant)));
      if (foreign) fail("not_found",404);
      if (m.entity === "variant") {
        const [product] = await tx.select({ id:t.products.id }).from(t.products).where(and(eq(t.products.id,m.payload.product_id),eq(t.products.tenant_id,tenant)));
        if(!product) fail("not_found",404);
      }
      if (m.entity === "ticket_line" || m.entity === "stockdiary") {
        const [v] = await tx.select({ id: t.productVariants.id }).from(t.productVariants).where(and(eq(t.productVariants.tenant_id, tenant), eq(t.productVariants.id, m.payload.variant_id)));
        if (!v && !items.some(item => item.entity === "variant" && item.client_uuid === m.payload.variant_id)) fail("not_found", 404);
        if (v && m.entity === "stockdiary" && m.payload.reason === "initial") {
          const [ledger] = await tx.select({ payload:t.syncLog.payload }).from(t.syncLog).where(and(eq(t.syncLog.tenant_id,tenant),eq(t.syncLog.client_uuid,m.client_uuid)));
          if(!ledger || canonicalJson(ledger.payload)!==canonicalJson(m.payload)) fail("sale_invalid_initial",400);
        }
      }
    }
    const ticket = items.find(m => m.entity === "ticket")!;
    if (ticket.entity !== "ticket" || !ticket.payload.shift_id) fail("sale_shift_required", 400);
    const [shift] = await tx.select().from(t.shifts).where(and(eq(t.shifts.tenant_id, tenant), eq(t.shifts.id, ticket.payload.shift_id))).for("update");
    if (!shift) fail("not_found", 404);
    // A delivered offline sale remains evidence even after another device
    // closes. applyMutationGroups freezes existing closed-sale rows; new
    // evidence can land, but never recomputes the immutable closed snapshot.
    const results = await applyMutationGroups(tx as unknown as Db, tenant, actor, items, manifest.ticket_id);
    if (results.some(r => r.status === "rejected")) fail(`sale_rejected:${results.find(r => r.status === "rejected")?.reason}`);
    await tx.execute(sql`UPDATE sync_sale_operations SET results=${JSON.stringify(results)}::jsonb WHERE tenant_id=${tenant} AND operation_id=${operation}`);
    await tx.execute(sql`DELETE FROM sync_sale_parts WHERE tenant_id=${tenant} AND operation_id=${operation}`);
    return { results };
  }); } catch (err) {
    const message = err instanceof Error ? err.message : "";
    // Release quota for terminally invalid snapshots; never delete a receipt,
    // an incomplete/retryable upload or an operation with another manifest.
    if (/^sale_(invalid_|mixed_|manifest_hash|part_hash|rejected:(?!db_error))/.test(message) || message === "shift_closed") {
      await db.execute(sql`DELETE FROM sync_sale_operations WHERE tenant_id=${tenant} AND operation_id=${operation} AND manifest=${JSON.stringify(manifest)}::jsonb AND results IS NULL`);
    }
    throw err;
  }
}

export { saleManifestSchema };
