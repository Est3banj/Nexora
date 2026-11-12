import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  contentHash,
  CUSTOMER_ACCOUNT_BY_ID_SQL,
  EXPECTED_FROM_PAYMENTS_SQL,
  parseExpectedRow,
  type MutationEnvelope,
  type SyncResult,
} from "@pos/shared";
import * as t from "./schema";
import type { Db } from "./index";

/**
 * Idempotent mutation apply (task D2-3, design §3) — lives inside src/db/
 * because it opens transactions and touches business tables: the ESLint
 * gate (D1-4) forbids raw db access anywhere else.
 *
 * Protocol per mutation (server sync_log acts as the APPLIED LEDGER —
 * it carries payload + client_ts, the LWW comparator design §3 needs;
 * business tables have no client_ts column):
 *
 *   ledger missing        → apply business upsert + write ledger → `applied`
 *   ledger, same content  → ack without touching business rows  → `duplicate`
 *   ledger, content differs, incoming client_ts NEWER            → LWW apply
 *   ledger, content differs, incoming client_ts ≤ stored         →
 *        `rejected: conflict_hash_mismatch` + audit_log (never a 2nd row)
 *
 * Entity-group transactions: ticket + lines + payment (+ stockdiary) that
 * belong to one sale share ONE db tx — a mid-group failure rolls the whole
 * group back (no partial sale on server) while the rest of the batch
 * continues (one poison entry never fails the batch).
 *
 * Stock balance rules (single-device LWW, design §3 + D3-1):
 *   - `stockdiary` is append-only audit: apply inserts/updates THE ROW ONLY,
 *     never does balance math (re-applying a delta would double count).
 *   - `variant` carries the ABSOLUTE stock (client refreshes its sync_log
 *     entry alongside every stock change — upsert-latest) and syncs the
 *     derived `stockcurrent`. Every sale's stockdiary + variant refresh
 *     carry `ref_ticket_id` → they join the SALE GROUP (atomicity), and at
 *     the end of each group every variant touched by a stockdiary is
 *     RECOMPUTED from sum(stockdiary): the movement log is the truth, so
 *     sum(stockdiary) == variants.stock == stockcurrent.stock holds on the
 *     server after every applied group (D3-1 stock invariant).
 *   - `closedcash` is IMMUTABLE (cash-close spec): ON CONFLICT DO NOTHING —
 *     a replayed/tampered close can never rewrite expected/counted/diff.
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
class InvalidSync extends Error {}

function duplicateCode(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; cause?: unknown };
  return e?.code === "23505" && e.constraint === "product_variants_tenant_code_uq"
    || !!e?.cause && duplicateCode(e.cause);
}

/**
 * Sale-group key: everything that belongs to one ticket shares a tx.
 * Everything else (product/variant/stockdiary/shift/closedcash) is its own
 * singleton group.
 */
function groupKeyOf(m: MutationEnvelope): string {
  const p = m.payload as Record<string, unknown>;
  if (m.entity === "ticket") return `ticket:${m.client_uuid}`;
  if (m.entity === "ticket_line" || m.entity === "payment") {
    const ticketId = typeof p.ticket_id === "string" ? p.ticket_id : m.client_uuid;
    return `ticket:${ticketId}`;
  }
  if (m.entity === "stockdiary" && typeof p.ref_ticket_id === "string") {
    return `ticket:${p.ref_ticket_id}`;
  }
  // D3-1: the sale-driven ABSOLUTE stock refresh travels with its sale so
  // ticket+lines+payment+stockdiary+stock refresh commit as ONE unit.
  if (m.entity === "variant" && typeof p.ref_ticket_id === "string") {
    return `ticket:${p.ref_ticket_id}`;
  }
  return `solo:${m.client_uuid}`;
}

/**
 * Stock invariant after a group (catalog spec §Stock truth survives recount):
 * for every variant a stockdiary in this group touched, both
 * `product_variants.stock` and the derived `stockcurrent` are recomputed
 * from sum(stockdiary) — the append-only movement log is the truth.
 */
async function recomputeStock(
  tx: Tx,
  tenantId: string,
  variants: Set<string>,
): Promise<void> {
  for (const variantId of [...variants].sort()) {
    await tx.select({ id: t.productVariants.id }).from(t.productVariants)
      .where(and(eq(t.productVariants.tenant_id, tenantId), eq(t.productVariants.id, variantId))).for("update");
    const rows = await tx
      .select({ sum: sql<string>`coalesce(sum(${t.stockdiary.delta}), 0)` })
      .from(t.stockdiary)
      .where(
        and(
          eq(t.stockdiary.tenant_id, tenantId),
          eq(t.stockdiary.variant_id, variantId),
        ),
      );
    const stock = Number(rows[0]?.sum ?? 0);
    const ts = new Date();
    await tx
      .update(t.productVariants)
      .set({ stock, updated_at: ts })
      .where(
        and(
          eq(t.productVariants.tenant_id, tenantId),
          eq(t.productVariants.id, variantId),
        ),
      );
    await tx
      .insert(t.stockcurrent)
      .values({ id: randomUUID(), tenant_id: tenantId, variant_id: variantId, stock })
      .onConflictDoUpdate({
        target: [t.stockcurrent.tenant_id, t.stockcurrent.variant_id],
        set: { stock, updated_at: ts },
      });
  }
}

/**
 * Applies a batch: ordered by client_ts (design §3 rule 4), grouped per
 * sale, one transaction per group. Returns results aligned to the INPUT
 * array order (the route maps them back to request positions).
 */
export async function applyMutationGroups(
  db: Db,
  tenantId: string,
  actor: string,
  envelopes: MutationEnvelope[],
  atomicSale?: string,
): Promise<SyncResult[]> {
  const ordered = envelopes
    .map((m, index) => ({ m, index }))
    .sort((a, b) => a.m.client_ts - b.m.client_ts || a.index - b.index);

  const groups = new Map<string, Array<{ m: MutationEnvelope; index: number }>>();
  for (const item of ordered) {
    const key = atomicSale ? `ticket:${atomicSale}` : groupKeyOf(item.m);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const byIndex = new Map<number, SyncResult>();
  for (const group of groups.values()) {
    try {
      const results = await db.transaction(async (tx) => {
        // Existing-row locks cannot serialize two first inserts of a ticket.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${groupKeyOf(group[0].m)}`}, 0))`);
        // Lock both claimed and stored parents. A forged parent must not let an
        // existing payment/line/movement of a voided sale escape the freeze.
        const ticketIds = new Set<string>();
        const customerIds = new Set<string>();
        for (const { m } of group) {
          const p = m.payload as Record<string, unknown>;
          if (m.entity === "ticket") ticketIds.add(m.client_uuid);
          if (typeof p.ticket_id === "string") ticketIds.add(p.ticket_id);
          if (typeof p.ref_ticket_id === "string") ticketIds.add(p.ref_ticket_id);
          if (m.entity === "stockdiary" && p.reason === "sale_void") throw new InvalidSync();
          const table = m.entity === "payment" ? t.payments : m.entity === "ticket_line" ? t.ticketLines : null;
          if (table) {
            const [old] = await tx.select({ ticket_id: table.ticket_id }).from(table)
              .where(and(eq(table.tenant_id, tenantId), eq(table.id, m.client_uuid)));
            if (old) ticketIds.add(old.ticket_id);
          }
          if (m.entity === "stockdiary") {
            const [old] = await tx.select().from(t.stockdiary).where(and(eq(t.stockdiary.tenant_id, tenantId), eq(t.stockdiary.id, m.client_uuid)));
            if (old?.ref_ticket_id) ticketIds.add(old.ref_ticket_id);
            if (old?.reason === "sale_void") throw new InvalidSync();
          }
        }
        let voidedId: string | undefined;
        for (const id of [...ticketIds].sort()) {
          const [ticket] = await tx.select().from(t.tickets)
            .where(and(eq(t.tickets.tenant_id, tenantId), eq(t.tickets.id, id))).for("update");
          if (ticket?.status === "voided") voidedId = id;
          if (ticket?.customer_id) customerIds.add(ticket.customer_id);
        }
        // Ticket locks FIRST, matching staging and void. Never acquire this
        // lock for shift/close groups: staging already holds its shift lock.
        // The tenant key also serializes two unlinked first-insert abonos.
        if (group.some(({ m }) => ["ticket", "payment", "credit_abono", "customer"].includes(m.entity)))
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`credit:${tenantId}`}, 0))`);
        if (voidedId) {
          // ACK identical old envelopes without applying ANY member of the group.
          // Include canonical state so a stale cache cannot report a live sale.
          const duplicates: boolean[] = [];
          for (const { m } of group) {
            const [ledger] = await tx.select().from(t.syncLog).where(and(eq(t.syncLog.tenant_id, tenantId), eq(t.syncLog.client_uuid, m.client_uuid)));
            duplicates.push(ledger?.entity === m.entity && contentHash(ledger.payload) === contentHash(m.payload));
          }
          const duplicate = duplicates.every(Boolean);
          return group.map(({ m }): SyncResult => {
            return { client_uuid: m.client_uuid, status: duplicate ? "duplicate" : "rejected", ...(duplicate ? {} : { reason: "validation" as const }), voided_ticket: voidedId };
          });
        }
        const inner: SyncResult[] = [];
        const dirtyVariants = new Set<string>();
        // Dependencies, not timestamp ties: a newly-created variant can travel
        // with its first sale. Preserve result alignment with the input group.
        const rank = (m: MutationEnvelope) => m.entity === "ticket" ? 0 : m.entity === "variant" ? 1 : 2;
        const execution = group.map((item, i) => ({ ...item, i })).sort((a,b) => rank(a.m) - rank(b.m));
        for (const { m, i } of execution)
          inner[i] = await applyOne(tx, tenantId, actor, m, dirtyVariants);
        for (const id of ticketIds) {
          const [ticket] = await tx.select().from(t.tickets).where(and(eq(t.tickets.tenant_id, tenantId), eq(t.tickets.id, id)));
          if (ticket?.customer_id) customerIds.add(ticket.customer_id);
        }
        // A later payment/ticket LWW edit cannot remove debt already collected.
        // Limits are deliberately local-only; nonnegative ledger is universal.
        for (const id of customerIds) {
          const query = sql.join(CUSTOMER_ACCOUNT_BY_ID_SQL.split(/(\$[12])/).map(part =>
            part === "$1" ? sql`${tenantId}` : part === "$2" ? sql`${id}` : sql.raw(part)), sql.raw(""));
          if (Number((await tx.execute(query)).rows[0]?.balance ?? 0) < 0) throw new InvalidSync();
        }
        // last step of the group: movement log → balance (D3-1 invariant)
        await recomputeStock(tx, tenantId, dirtyVariants);
        for (let i = 0; i < group.length; i++) {
          const m = group[i].m;
          if (m.entity !== "closedcash" || inner[i].status === "rejected") continue;
          const [closed] = await tx.select().from(t.closedcash)
            .where(and(eq(t.closedcash.tenant_id, tenantId), eq(t.closedcash.shift_id, m.payload.shift_id)));
          if (closed) inner[i].closedcash = { shift_id: closed.shift_id, expected: closed.expected, counted: closed.counted, diff: closed.diff,
            calculation_version: closed.calculation_version as "legacy_v1" | "drawer_cash_v2", closing_note: closed.closing_note };
        }
        return inner;
      });
      group.forEach((item, i) => byIndex.set(item.index, results[i]));
    } catch (err) {
      // Whole group rolled back: report db_error for its members only —
      // the rest of the batch is unaffected (design §3 rule 3).
      for (const item of group) {
        byIndex.set(item.index, {
          client_uuid: item.m.client_uuid,
          status: "rejected",
          reason: duplicateCode(err) ? "duplicate_code" : err instanceof InvalidSync ? "validation" : "db_error",
        });
      }
    }
  }

  return envelopes.map((_, i) => byIndex.get(i)!);
}

async function applyOne(
  tx: Tx,
  tenantId: string,
  actor: string,
  m: MutationEnvelope,
  dirtyVariants: Set<string>,
): Promise<SyncResult> {
  const ledgerRows = await tx
    .select()
    .from(t.syncLog)
    .where(
      and(eq(t.syncLog.tenant_id, tenantId), eq(t.syncLog.client_uuid, m.client_uuid)),
    )
    .limit(1)
    .for("update");
  const stored = ledgerRows[0];
  if (stored && stored.entity !== m.entity) throw new InvalidSync();
  if (m.entity === "cash_movement") {
    const [row] = await tx.select().from(t.cashMovements)
      .where(and(eq(t.cashMovements.tenant_id, tenantId), eq(t.cashMovements.client_uuid, m.client_uuid)));
    if (row) {
      const p = m.payload;
      if (row.shift_id !== p.shift_id || row.amount !== p.amount || row.direction !== p.direction
        || row.reason !== p.reason || row.note !== (p.note ?? null)
        || (p.created_at && row.created_at.getTime() !== new Date(p.created_at).getTime())
        || (stored && contentHash(stored.payload) !== contentHash(p))) throw new InvalidSync();
      return { client_uuid: m.client_uuid, status: "duplicate" };
    }
    if (stored) throw new InvalidSync();
  }

  if (m.entity === "credit_abono") {
    const [row] = await tx.select().from(t.creditAbonos)
      .where(and(eq(t.creditAbonos.tenant_id, tenantId), eq(t.creditAbonos.client_uuid, m.client_uuid)));
    if (row) {
      const p = m.payload;
      const identical = row.customer_id === p.customer_id && row.amount === p.amount
        && row.method === p.method && row.shift_id === p.shift_id
        && row.ticket_id === (p.ticket_id ?? null) && row.note === (p.note ?? null)
        && (!p.created_at || row.created_at.getTime() === new Date(p.created_at).getTime());
      // Do not advance ledger/hash/timestamps, including a missing ledger.
      if (!identical || (stored && contentHash(stored.payload) !== contentHash(p))) throw new InvalidSync();
      return { client_uuid: m.client_uuid, status: "duplicate" };
    }
    if (stored) throw new InvalidSync();
  }

  if (stored) {
    if (contentHash(stored.payload) === contentHash(m.payload)) {
      // N pushes → 1 row, duplicate acknowledged (sync §Idempotent push)
      return { client_uuid: m.client_uuid, status: "duplicate" };
    }
    if (m.client_ts > stored.client_ts) {
      // LWW: the later single-device write wins (sync §LWW)
      await upsertEntity(tx, tenantId, m, dirtyVariants);
      await tx
        .update(t.syncLog)
        .set({
          payload: m.payload,
          client_ts: m.client_ts,
          status: "synced",
          attempts: 0,
          last_error: null,
          updated_at: new Date(),
        })
        .where(
          and(eq(t.syncLog.tenant_id, tenantId), eq(t.syncLog.client_uuid, m.client_uuid)),
        );
      return { client_uuid: m.client_uuid, status: "applied" };
    }
    // same uuid, different content, not newer → replay-as-different-content
    await tx.insert(t.auditLog).values({
      id: randomUUID(),
      tenant_id: tenantId,
      actor,
      action: "sync.conflict_hash_mismatch",
      meta: {
        client_uuid: m.client_uuid,
        entity: m.entity,
        stored_client_ts: stored.client_ts,
        incoming_client_ts: m.client_ts,
      },
    });
    return {
      client_uuid: m.client_uuid,
      status: "rejected",
      reason: "conflict_hash_mismatch",
    };
  }

  await upsertEntity(tx, tenantId, m, dirtyVariants);
  await tx
    .insert(t.syncLog)
    .values({
      id: m.client_uuid,
      tenant_id: tenantId,
      client_uuid: m.client_uuid,
      entity: m.entity,
      op: m.op,
      payload: m.payload,
      status: "synced",
      attempts: 0,
      last_error: null,
      client_ts: m.client_ts,
    })
    .onConflictDoUpdate({
      target: [t.syncLog.tenant_id, t.syncLog.client_uuid],
      set: {
        payload: m.payload,
        client_ts: m.client_ts,
        status: "synced",
        attempts: 0,
        last_error: null,
        updated_at: new Date(),
      },
    });
  return { client_uuid: m.client_uuid, status: "applied" };
}

/** Business-row upsert keyed on unique(tenant_id, client_uuid) — never a 2nd row. */
async function upsertEntity(
  tx: Tx,
  tenantId: string,
  m: MutationEnvelope,
  dirtyVariants: Set<string>,
): Promise<void> {
  const now = new Date();
  const cu = m.client_uuid;

  // Freeze previously stored sale evidence of closed shifts. New rows from
  // disconnected devices remain admissible; bank confirmation has its own endpoint.
  if (["ticket", "payment", "ticket_line"].includes(m.entity)) {
    const table = m.entity === "ticket" ? t.tickets : m.entity === "payment" ? t.payments : t.ticketLines;
    const [old] = await tx.select().from(table).where(and(eq(table.tenant_id, tenantId), eq(table.id, cu)));
    if (old) {
      const ticketId = "ticket_id" in old ? old.ticket_id : old.id;
      const [ticket] = await tx.select().from(t.tickets).where(and(eq(t.tickets.tenant_id, tenantId), eq(t.tickets.id, ticketId)));
      if (ticket?.shift_id) {
        const [closed] = await tx.select().from(t.closedcash).where(and(eq(t.closedcash.tenant_id, tenantId), eq(t.closedcash.shift_id, ticket.shift_id)));
        if (closed) throw new InvalidSync();
      }
    }
  }

  switch (m.entity) {
    case "ticket": {
      const p = m.payload;
      // H7 backstop (fiado D3): the sale must reference a customer that
      // already exists IN THIS TENANT — same pattern as product→category
      // (`:473` below). Absent customer ⇒ whole sale group rejected:validation
      // → client retries until the solo customer group has drained.
      // Legacy queued tickets carry NO customer_id (undefined) or an explicit
      // null (cash/transfer) — neither is a credit claim, so neither checks.
      if (p.customer_id) {
        const [customer] = await tx.select({ id: t.customers.id }).from(t.customers)
          .where(and(eq(t.customers.tenant_id, tenantId), eq(t.customers.id, p.customer_id)));
        if (!customer) throw new InvalidSync();
      }
      await tx
        .insert(t.tickets)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          shift_id: p.shift_id,
          ticket_no: p.ticket_no,
          status: p.status,
          total: p.total,
          // legacy payloads omit customer_id — never wipe a stored link
          ...(p.customer_id !== undefined ? { customer_id: p.customer_id } : {}),
          ...(p.created_at ? { created_at: new Date(p.created_at) } : {}),
        })
        .onConflictDoUpdate({
          target: [t.tickets.tenant_id, t.tickets.client_uuid],
          set: {
            shift_id: p.shift_id,
            ticket_no: p.ticket_no,
            status: p.status,
            total: p.total,
            ...(p.customer_id !== undefined ? { customer_id: p.customer_id } : {}),
            updated_at: now,
          },
        });
      return;
    }
    case "ticket_line": {
      const p = m.payload;
      await tx
        .insert(t.ticketLines)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          ticket_id: p.ticket_id,
          variant_id: p.variant_id,
          qty: p.qty,
          unit_price: p.unit_price,
          subtotal: p.subtotal,
          unit_cost: p.unit_cost ?? null,
          ...(p.created_at ? { created_at: new Date(p.created_at) } : {}),
        })
        .onConflictDoUpdate({
          target: [t.ticketLines.tenant_id, t.ticketLines.client_uuid],
          set: {
            ticket_id: p.ticket_id,
            variant_id: p.variant_id,
            qty: p.qty,
            unit_price: p.unit_price,
            subtotal: p.subtotal,
            // legacy payloads omit unit_cost — never wipe a stored historical cost
            unit_cost: sql`COALESCE(${t.ticketLines.unit_cost}, EXCLUDED.unit_cost)`,
            updated_at: now,
          },
        });
      return;
    }
    case "payment": {
      const p = m.payload;
      const [existing] = await tx.select().from(t.payments).where(and(eq(t.payments.tenant_id, tenantId), eq(t.payments.id, cu)));
      if (p.method === "transfer" && p.status === "confirmed" && existing?.status !== "confirmed") throw new InvalidSync();
      if (existing?.status === "confirmed" && p.status !== "confirmed") throw new InvalidSync();
      // D1 hard rule: credit is CONFIRMED AT CREATION. A pending credit would
      // leak into arqueo's pending line and dashboard pending_count, poisoning
      // the cash close — there is no pending→confirmed flip for credit.
      if (p.method === "credit" && p.status !== "confirmed") throw new InvalidSync();
      // No orphan credit claims (credit-sales §Customer required): a credit
      // payment needs a parent ticket that exists in-tenant AND carries a
      // customer. Cash/transfer never pay a customer — skip the lookup.
      // The ticket ranks before payments in-group (`rank()`), so a same-batch
      // ticket is already written when this runs.
      if (p.method === "credit") {
        const [parent] = await tx.select({ customer_id: t.tickets.customer_id }).from(t.tickets)
          .where(and(eq(t.tickets.tenant_id, tenantId), eq(t.tickets.id, p.ticket_id)));
        if (!parent?.customer_id) throw new InvalidSync();
      }
      await tx
        .insert(t.payments)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          ticket_id: p.ticket_id,
          method: p.method,
          amount: p.amount,
          tendered: p.tendered,
          vuelto: p.vuelto,
          status: p.status,
          confirmed_at: p.confirmed_at ? new Date(p.confirmed_at) : null,
          shift_id: p.shift_id,
          ...(p.created_at ? { created_at: new Date(p.created_at) } : {}),
        })
        .onConflictDoUpdate({
          target: [t.payments.tenant_id, t.payments.client_uuid],
          set: {
            method: p.method,
            amount: p.amount,
            tendered: p.tendered,
            vuelto: p.vuelto,
            status: p.status,
            shift_id: p.shift_id,
            // never un-confirm: a null incoming confirmed_at keeps the stored one
            confirmed_at: sql`coalesce(excluded.confirmed_at, ${t.payments.confirmed_at})`,
            updated_at: now,
          },
        });
      return;
    }
    case "stockdiary": {
      const p = m.payload;
      await tx
        .insert(t.stockdiary)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          variant_id: p.variant_id,
          delta: p.delta,
          reason: p.reason,
          note: p.note ?? null,
          ref_ticket_id: p.ref_ticket_id ?? null,
          ...(p.created_at ? { created_at: new Date(p.created_at) } : {}),
        })
        .onConflictDoUpdate({
          target: [t.stockdiary.tenant_id, t.stockdiary.client_uuid],
          set: {
            delta: p.delta,
            reason: p.reason,
            note: p.note ?? null,
            ref_ticket_id: p.ref_ticket_id ?? null,
            updated_at: now,
          },
        });
      // movement applied → this variant's balance is recomputed at group end
      dirtyVariants.add(p.variant_id);
      return;
    }
    case "category": {
      const p = m.payload;
      await tx
        .insert(t.categories)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          name: p.name,
          icon_key: p.icon_key ?? null,
          active: p.active,
        })
        .onConflictDoUpdate({
          target: [t.categories.tenant_id, t.categories.client_uuid],
          set: { name: p.name, ...(p.icon_key !== undefined ? { icon_key: p.icon_key } : {}), active: p.active, updated_at: now },
        });
      return;
    }
    case "product": {
      const p = m.payload;
      if (p.category_id) {
        const [category] = await tx.select({ id: t.categories.id }).from(t.categories)
          .where(and(eq(t.categories.tenant_id, tenantId), eq(t.categories.id, p.category_id)));
        if (!category) throw new InvalidSync();
      }
      await tx
        .insert(t.products)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          name: p.name,
          icon_key: p.icon_key ?? null,
          category_id: p.category_id ?? null,
          photo: p.photo ?? null,
          active: p.active,
        })
        .onConflictDoUpdate({
          target: [t.products.tenant_id, t.products.client_uuid],
          set: {
            name: p.name,
            ...(p.icon_key !== undefined ? { icon_key: p.icon_key } : {}),
            ...(p.category_id !== undefined ? { category_id: p.category_id } : {}),
            ...(p.photo !== undefined ? { photo: p.photo } : {}),
            active: p.active,
            updated_at: now,
          },
        });
      return;
    }
    case "variant": {
      const p = m.payload;
      const [product] = await tx.select({ id: t.products.id }).from(t.products)
        .where(and(eq(t.products.tenant_id, tenantId), eq(t.products.id, p.product_id)));
      if (!product) throw new InvalidSync();
      const [existing] = await tx.select({ product_id: t.productVariants.product_id }).from(t.productVariants)
        .where(and(eq(t.productVariants.tenant_id, tenantId), eq(t.productVariants.id, cu)));
      if (existing && existing.product_id !== p.product_id) throw new InvalidSync();
      await tx
        .insert(t.productVariants)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          product_id: p.product_id,
          name: p.name,
          price: p.price,
          cost: p.cost ?? null,
          code: p.code ?? null,
          stock: p.stock,
          low_stock_threshold: p.low_stock_threshold,
          active: p.active,
        })
        .onConflictDoUpdate({
          target: [t.productVariants.tenant_id, t.productVariants.client_uuid],
          set: {
            name: p.name,
            price: p.price,
            ...(p.cost !== undefined ? { cost: p.cost } : {}),
            ...(p.code !== undefined ? { code: p.code } : {}),
            stock: p.stock,
            low_stock_threshold: p.low_stock_threshold,
            active: p.active,
            updated_at: now,
          },
        });
      // derived cache follows the absolute stock the client pushed
      dirtyVariants.add(cu);
      await tx
        .insert(t.stockcurrent)
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          variant_id: cu,
          stock: p.stock,
        })
        .onConflictDoUpdate({
          target: [t.stockcurrent.tenant_id, t.stockcurrent.variant_id],
          set: { stock: p.stock, updated_at: now },
        });
      return;
    }
    case "closedcash": {
      const p = m.payload;
      const [original] = await tx.select().from(t.closedcash)
        .where(and(eq(t.closedcash.tenant_id, tenantId), eq(t.closedcash.client_uuid, cu)));
      if (original && original.shift_id !== p.shift_id) throw new InvalidSync();
      const [shift] = await tx.select().from(t.shifts).where(and(eq(t.shifts.tenant_id, tenantId), eq(t.shifts.id, p.shift_id))).for("update");
      if (!shift) throw new InvalidSync();
      // Offline counted is user input; expected and diff remain server-owned.
      const query = sql.join(EXPECTED_FROM_PAYMENTS_SQL.split(/(\$[12])/).map(part =>
        part === "$1" ? sql`${tenantId}` : part === "$2" ? sql`${p.shift_id}` : sql.raw(part)), sql.raw(""));
      const expected = parseExpectedRow((await tx.execute(query)).rows[0]).expected;
      // IMMUTABLE row (cash-close spec §Closed shifts are immutable): the
      // first write wins forever — a replay or tampered close can never
      // rewrite expected/counted/diff (ON CONFLICT DO NOTHING on either
      // the shift or the client_uuid unique target).
      await tx
        .insert(t.closedcash)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          shift_id: p.shift_id,
          expected,
          counted: p.counted,
          diff: p.counted - expected,
          closed_by: p.closed_by ?? null,
          closing_note: p.closing_note ?? null,
          calculation_version: shift.calculation_version,
        })
        .onConflictDoNothing();
      await tx.update(t.shifts).set({ status: "closed", closed_at: now, updated_at: now })
        .where(and(eq(t.shifts.tenant_id, tenantId), eq(t.shifts.id, p.shift_id), eq(t.shifts.status, "open")));
      return;
    }
    case "shift": {
      const p = m.payload;
      const [existing] = await tx.select().from(t.shifts).where(and(eq(t.shifts.tenant_id, tenantId), eq(t.shifts.id, cu)));
      if (existing && ((p.opening_cash !== undefined && p.opening_cash !== existing.opening_cash)
        || (p.calculation_version !== undefined && p.calculation_version !== existing.calculation_version)
        || (p.opened_by !== undefined && p.opened_by !== existing.opened_by))) throw new InvalidSync();
      if (existing?.status === "closed") return;
      const [closed] = await tx.select().from(t.closedcash).where(and(eq(t.closedcash.tenant_id, tenantId), eq(t.closedcash.shift_id, cu)));
      if (closed && p.status === "open") return;
      await tx
        .insert(t.shifts)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          status: p.status,
          opening_cash: p.opening_cash ?? 0,
          opened_by: p.opened_by ?? null,
          calculation_version: p.calculation_version ?? "legacy_v1",
          ...(p.opened_at ? { opened_at: new Date(p.opened_at) } : {}),
          closed_at: p.closed_at ? new Date(p.closed_at) : null,
        })
        .onConflictDoUpdate({
          target: [t.shifts.tenant_id, t.shifts.client_uuid],
          set: { status: p.status, closed_at: p.closed_at ? new Date(p.closed_at) : null, updated_at: now },
        });
      return;
    }
    case "cash_movement": {
      const p = m.payload;
      const [shift] = await tx.select().from(t.shifts)
        .where(and(eq(t.shifts.tenant_id, tenantId), eq(t.shifts.id, p.shift_id))).for("update");
      if (!shift) throw new InvalidSync();
      // Legitimate late offline evidence is retained without touching snapshots.
      await tx.insert(t.cashMovements).values({ id: cu, client_uuid: cu, tenant_id: tenantId,
        shift_id: p.shift_id, direction: p.direction, amount: p.amount, reason: p.reason, note: p.note ?? null,
        ...(p.created_at ? { created_at: new Date(p.created_at) } : {}) });
      return;
    }
    case "customer": {
      // Catalog-ish upsert (pattern of `category`): unique(tenant_id,
      // client_uuid) only — names may repeat (D7). Members may create/edit
      // customers (D4): the money-touching action is the abono, not the row.
      const p = m.payload;
      await tx
        .insert(t.customers)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          name: p.name,
          credit_limit: p.credit_limit ?? null,
          phone: p.phone ?? null,
          notes: p.notes ?? null,
          active: p.active,
          ...(p.created_at ? { created_at: new Date(p.created_at) } : {}),
        })
        .onConflictDoUpdate({
          target: [t.customers.tenant_id, t.customers.client_uuid],
          set: {
            name: p.name,
            ...(p.credit_limit !== undefined ? { credit_limit: p.credit_limit } : {}),
            // legacy payloads may omit phone/notes — never wipe stored data
            ...(p.phone !== undefined ? { phone: p.phone } : {}),
            ...(p.notes !== undefined ? { notes: p.notes } : {}),
            active: p.active,
            updated_at: now,
          },
        });
      return;
    }
    case "credit_abono": {
      const p = m.payload;
      // (1) the customer must exist IN THIS TENANT (product→category pattern
      // `:473`) — cross-tenant abonos die here with the same validation
      // rejection as any other dependency failure.
      const [customer] = await tx.select({ id: t.customers.id }).from(t.customers)
        .where(and(eq(t.customers.tenant_id, tenantId), eq(t.customers.id, p.customer_id)));
      if (!customer) throw new InvalidSync();
      if (!p.shift_id) throw new InvalidSync();
      // Late offline evidence may belong to an already-closed shift; never
      // re-open it or mutate its snapshot. Attribution must still be in-tenant.
      const [shift] = await tx.select().from(t.shifts)
        .where(and(eq(t.shifts.tenant_id, tenantId), eq(t.shifts.id, p.shift_id)));
      if (!shift) throw new InvalidSync();
      const query = sql.join(CUSTOMER_ACCOUNT_BY_ID_SQL.split(/(\$[12])/).map(part =>
        part === "$1" ? sql`${tenantId}` : part === "$2" ? sql`${p.customer_id}` : sql.raw(part)), sql.raw(""));
      const balance = Number((await tx.execute(query)).rows[0]?.balance ?? 0);
      if (p.amount > balance) throw new InvalidSync();
      // (2) optional linkage (D2): the ticket must exist in-tenant AND either
      // carry no customer (legacy/unattributed) or carry the SAME customer —
      // an abono can never pay down someone else's debt.
      if (p.ticket_id) {
        const [ticket] = await tx.select({ customer_id: t.tickets.customer_id }).from(t.tickets)
          .where(and(eq(t.tickets.tenant_id, tenantId), eq(t.tickets.id, p.ticket_id)));
        if (!ticket || (ticket.customer_id !== null && ticket.customer_id !== p.customer_id)) throw new InvalidSync();
      }
      // (3) Append-only: replay checks precede LWW in applyOne.
      await tx
        .insert(t.creditAbonos)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          customer_id: p.customer_id,
          amount: p.amount,
          method: p.method,
          shift_id: p.shift_id,
          ticket_id: p.ticket_id ?? null,
          note: p.note ?? null,
          ...(p.created_at ? { created_at: new Date(p.created_at) } : {}),
        })
        .onConflictDoNothing();
      return;
    }
  }
}
