import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  contentHash,
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
  for (const variantId of variants) {
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
): Promise<SyncResult[]> {
  const ordered = envelopes
    .map((m, index) => ({ m, index }))
    .sort((a, b) => a.m.client_ts - b.m.client_ts || a.index - b.index);

  const groups = new Map<string, Array<{ m: MutationEnvelope; index: number }>>();
  for (const item of ordered) {
    const key = groupKeyOf(item.m);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const byIndex = new Map<number, SyncResult>();
  for (const group of groups.values()) {
    try {
      const results = await db.transaction(async (tx) => {
        const inner: SyncResult[] = [];
        const dirtyVariants = new Set<string>();
        for (const { m } of group)
          inner.push(await applyOne(tx, tenantId, actor, m, dirtyVariants));
        // last step of the group: movement log → balance (D3-1 invariant)
        await recomputeStock(tx, tenantId, dirtyVariants);
        return inner;
      });
      group.forEach((item, i) => byIndex.set(item.index, results[i]));
    } catch {
      // Whole group rolled back: report db_error for its members only —
      // the rest of the batch is unaffected (design §3 rule 3).
      for (const item of group) {
        byIndex.set(item.index, {
          client_uuid: item.m.client_uuid,
          status: "rejected",
          reason: "db_error",
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

  switch (m.entity) {
    case "ticket": {
      const p = m.payload;
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
          ...(p.created_at ? { created_at: new Date(p.created_at) } : {}),
        })
        .onConflictDoUpdate({
          target: [t.tickets.tenant_id, t.tickets.client_uuid],
          set: {
            shift_id: p.shift_id,
            ticket_no: p.ticket_no,
            status: p.status,
            total: p.total,
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
            updated_at: now,
          },
        });
      return;
    }
    case "payment": {
      const p = m.payload;
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
          active: p.active,
        })
        .onConflictDoUpdate({
          target: [t.categories.tenant_id, t.categories.client_uuid],
          set: { name: p.name, active: p.active, updated_at: now },
        });
      return;
    }
    case "product": {
      const p = m.payload;
      await tx
        .insert(t.products)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          name: p.name,
          category_id: p.category_id ?? null,
          photo: p.photo ?? null,
          active: p.active,
        })
        .onConflictDoUpdate({
          target: [t.products.tenant_id, t.products.client_uuid],
          set: {
            name: p.name,
            category_id: p.category_id ?? null,
            photo: p.photo ?? null,
            active: p.active,
            updated_at: now,
          },
        });
      return;
    }
    case "variant": {
      const p = m.payload;
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
          stock: p.stock,
          low_stock_threshold: p.low_stock_threshold,
          active: p.active,
        })
        .onConflictDoUpdate({
          target: [t.productVariants.tenant_id, t.productVariants.client_uuid],
          set: {
            name: p.name,
            price: p.price,
            cost: p.cost ?? null,
            stock: p.stock,
            low_stock_threshold: p.low_stock_threshold,
            active: p.active,
            updated_at: now,
          },
        });
      // derived cache follows the absolute stock the client pushed
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
          expected: p.expected,
          counted: p.counted,
          diff: p.diff,
          closed_by: p.closed_by ?? null,
        })
        .onConflictDoNothing();
      return;
    }
    case "shift": {
      const p = m.payload;
      await tx
        .insert(t.shifts)
        .values({
          id: cu,
          tenant_id: tenantId,
          client_uuid: cu,
          status: p.status,
          ...(p.opened_at ? { opened_at: new Date(p.opened_at) } : {}),
          closed_at: p.closed_at ? new Date(p.closed_at) : null,
        })
        .onConflictDoUpdate({
          target: [t.shifts.tenant_id, t.shifts.client_uuid],
          set: { status: p.status, closed_at: p.closed_at ? new Date(p.closed_at) : null, updated_at: now },
        });
      return;
    }
  }
}
