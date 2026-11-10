import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { MutationEnvelope } from "@pos/shared";
import { variantCodeSchema } from "@pos/shared";
import * as t from "./schema";
import type { Db } from "./index";
import * as reportsDb from "./reports";
import * as arqueoDb from "./arqueo";

/**
 * scopedRepo — task D1-4 / design §5.
 *
 * This module is the ONLY path from application code to business tables.
 * The ESLint gate (root eslint.config.js) fails any `db.select/insert/...`
 * outside `apps/api/src/db/**`. Routes MUST build their repo with the
 * tenantId resolved from the SESSION (auth/ctx.ts) — never from a payload.
 */

export type TenantId = string;

const now = () => new Date();

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Inserts a variant + initial stockdiary + stockcurrent inside an open tx. */
async function insertVariantWithStock(
  tx: Tx,
  tenantId: TenantId,
  productId: string,
  variant: {
    name: string;
    price: number;
    code?: string | null;
    cost?: number | null;
    stock?: number;
    low_stock_threshold?: number | null;
  },
  clientUuids: { variant?: string; diary?: string } = {},
): Promise<t.ProductVariant> {
  const stock = variant.stock ?? 0;
  const variantId = clientUuids.variant ?? randomUUID();
  const [row] = await tx
    .insert(t.productVariants)
    .values({
      id: variantId,
      tenant_id: tenantId,
      client_uuid: variantId,
      product_id: productId,
      name: variant.name,
      code: variant.code === undefined ? null : variantCodeSchema.parse(variant.code),
      price: variant.price,
      cost: variant.cost ?? null,
      stock,
      low_stock_threshold: variant.low_stock_threshold ?? null,
      active: true,
    })
    .returning();

  if (stock !== 0) {
    const diaryId = clientUuids.diary ?? randomUUID();
    await tx.insert(t.stockdiary).values({
      id: diaryId,
      tenant_id: tenantId,
      client_uuid: diaryId,
      variant_id: variantId,
      delta: stock,
      reason: "initial",
      note: "Stock inicial al crear la variante",
    });
  }

  await tx.insert(t.stockcurrent).values({
    id: randomUUID(),
    tenant_id: tenantId,
    variant_id: variantId,
    stock,
  });

  return row;
}

export function scopedRepo(db: Db, tenantId: TenantId) {
  async function assertCategory(id?: string | null) {
    if (!id) return;
    const [category] = await db.select({ id: t.categories.id }).from(t.categories)
      .where(and(eq(t.categories.tenant_id, tenantId), eq(t.categories.id, id)));
    if (!category) throw Object.assign(new Error("invalid_category"), { statusCode: 404 });
  }
  return {
    categories: {
      list(opts: { active?: boolean; limit?: number } = {}) {
        const conds: SQL[] = [eq(t.categories.tenant_id, tenantId)];
        if (opts.active !== undefined)
          conds.push(eq(t.categories.active, opts.active));
        return db
          .select()
          .from(t.categories)
          .where(and(...conds))
          .orderBy(t.categories.name)
          .limit(opts.limit ?? 200);
      },
      async byUuid(id: string) {
        const rows = await db
          .select()
          .from(t.categories)
          .where(
            and(eq(t.categories.tenant_id, tenantId), eq(t.categories.id, id)),
          );
        return rows[0];
      },
      async create(input: { client_uuid?: string; name: string }) {
        const id = input.client_uuid ?? randomUUID();
        const rows = await db
          .insert(t.categories)
          .values({
            id,
            tenant_id: tenantId,
            client_uuid: id,
            name: input.name,
            active: true,
          })
          .returning();
        return rows[0];
      },
      async update(id: string, patch: { name?: string; active?: boolean }) {
        const set: Record<string, unknown> = { updated_at: now() };
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.active !== undefined) set.active = patch.active;
        const rows = await db
          .update(t.categories)
          .set(set)
          .where(
            and(eq(t.categories.tenant_id, tenantId), eq(t.categories.id, id)),
          )
          .returning({ id: t.categories.id });
        return rows.length;
      },
    },
    products: {
      list(opts: { active?: boolean; limit?: number } = {}) {
        const conds: SQL[] = [eq(t.products.tenant_id, tenantId)];
        if (opts.active !== undefined)
          conds.push(eq(t.products.active, opts.active));
        return db
          .select()
          .from(t.products)
          .where(and(...conds))
          .orderBy(t.products.name)
          .limit(opts.limit ?? 1000);
      },
      async byUuid(id: string) {
        const rows = await db
          .select()
          .from(t.products)
          .where(and(eq(t.products.tenant_id, tenantId), eq(t.products.id, id)));
        return rows[0];
      },
      async upsert(input: {
        client_uuid: string;
        name: string;
        category_id?: string | null;
        photo?: string | null;
        active?: boolean;
      }) {
        await assertCategory(input.category_id);
        const rows = await db
          .insert(t.products)
          .values({
            id: input.client_uuid,
            tenant_id: tenantId,
            client_uuid: input.client_uuid,
            name: input.name,
            category_id: input.category_id ?? null,
            photo: input.photo ?? null,
            active: input.active ?? true,
          })
          .onConflictDoUpdate({
            target: [t.products.tenant_id, t.products.client_uuid],
            set: {
              name: input.name,
              ...(input.category_id !== undefined ? { category_id: input.category_id } : {}),
              ...(input.photo !== undefined ? { photo: input.photo } : {}),
              active: input.active ?? true,
              updated_at: now(),
            },
          })
          .returning();
        return rows[0];
      },
      async update(
        id: string,
        patch: {
          name?: string;
          category_id?: string | null;
          photo?: string | null;
          active?: boolean;
        },
      ) {
        await assertCategory(patch.category_id);
        const set: Record<string, unknown> = { updated_at: now() };
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.category_id !== undefined) set.category_id = patch.category_id;
        if (patch.photo !== undefined) set.photo = patch.photo;
        if (patch.active !== undefined) set.active = patch.active;
        const rows = await db
          .update(t.products)
          .set(set)
          .where(and(eq(t.products.tenant_id, tenantId), eq(t.products.id, id)))
          .returning({ id: t.products.id });
        return rows.length;
      },
    },

    productVariants: {
      list(opts: { active?: boolean; product_id?: string; limit?: number } = {}) {
        const conds: SQL[] = [eq(t.productVariants.tenant_id, tenantId)];
        if (opts.active !== undefined)
          conds.push(eq(t.productVariants.active, opts.active));
        if (opts.product_id !== undefined)
          conds.push(eq(t.productVariants.product_id, opts.product_id));
        return db
          .select()
          .from(t.productVariants)
          .where(and(...conds))
          .orderBy(t.productVariants.name)
          .limit(opts.limit ?? 2000);
      },
      /** Sale flow: only variants of active products, variants active. */
      listForSale() {
        return db
          .select({
            id: t.productVariants.id,
            product_id: t.productVariants.product_id,
            client_uuid: t.productVariants.client_uuid,
            name: t.productVariants.name,
            code: t.productVariants.code,
            price: t.productVariants.price,
            cost: t.productVariants.cost,
            stock: t.productVariants.stock,
            low_stock_threshold: t.productVariants.low_stock_threshold,
            active: t.productVariants.active,
            product_name: t.products.name,
            product_active: t.products.active,
            category_id: t.products.category_id,
            photo: t.products.photo,
          })
          .from(t.productVariants)
          .innerJoin(t.products, and(eq(t.productVariants.product_id, t.products.id), eq(t.products.tenant_id, tenantId)))
          .where(
            and(
              eq(t.productVariants.tenant_id, tenantId),
              eq(t.productVariants.active, true),
              eq(t.products.active, true),
            ),
          )
          .orderBy(t.products.name, t.productVariants.name);
      },
      async byUuid(id: string) {
        const rows = await db
          .select()
          .from(t.productVariants)
          .where(
            and(
              eq(t.productVariants.tenant_id, tenantId),
              eq(t.productVariants.id, id),
            ),
          );
        return rows[0];
      },
      async upsert(input: {
        client_uuid: string;
        product_id: string;
        name: string;
        price: number;
        stock?: number;
        code?: string | null;
        low_stock_threshold?: number | null;
        active?: boolean;
      }) {
        const [product] = await db.select({ id: t.products.id }).from(t.products)
          .where(and(eq(t.products.tenant_id, tenantId), eq(t.products.id, input.product_id)));
        if (!product) throw Object.assign(new Error("invalid_product"), { statusCode: 404 });
        const rows = await db
          .insert(t.productVariants)
          .values({
            id: input.client_uuid,
            tenant_id: tenantId,
            client_uuid: input.client_uuid,
            product_id: input.product_id,
            name: input.name,
            price: input.price,
            code: input.code === undefined ? null : variantCodeSchema.parse(input.code),
            stock: input.stock ?? 0,
            low_stock_threshold: input.low_stock_threshold ?? null,
            active: input.active ?? true,
          })
          .onConflictDoUpdate({
            target: [t.productVariants.tenant_id, t.productVariants.client_uuid],
            set: {
              name: input.name,
              price: input.price,
              ...(input.code !== undefined ? { code: variantCodeSchema.parse(input.code) } : {}),
              stock: input.stock ?? 0,
              low_stock_threshold: input.low_stock_threshold ?? null,
              updated_at: now(),
            },
          })
          .returning();
        return rows[0];
      },
      async update(
        id: string,
        patch: {
          name?: string;
          price?: number;
          cost?: number | null;
          active?: boolean;
          code?: string | null;
          low_stock_threshold?: number | null;
        },
      ) {
        const set: Record<string, unknown> = { updated_at: now() };
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.price !== undefined) set.price = patch.price;
        if (patch.cost !== undefined) set.cost = patch.cost;
        if (patch.code !== undefined) set.code = variantCodeSchema.parse(patch.code);
        if (patch.active !== undefined) set.active = patch.active;
        if (patch.low_stock_threshold !== undefined)
          set.low_stock_threshold = patch.low_stock_threshold;
        const rows = await db
          .update(t.productVariants)
          .set(set)
          .where(
            and(
              eq(t.productVariants.tenant_id, tenantId),
              eq(t.productVariants.id, id),
            ),
          )
          .returning({ id: t.productVariants.id });
        return rows.length;
      },
    },

    /**
     * Stock = variants.stock (current balance) kept in lockstep with
     * stockdiary (append-only truth) and stockcurrent (derived cache),
     * all updated inside ONE transaction. Invariant: sum(stockdiary.delta)
     * == variants.stock == stockcurrent.stock (catalog spec: recount).
     */
    stock: {
      async adjust(input: {
        variant_id: string;
        delta: number;
        reason: string;
        note: string;
        ref_ticket_id?: string | null;
        client_uuid?: string;
      }) {
        return db.transaction(async (tx) => {
          const variantRows = await tx
            .select()
            .from(t.productVariants)
            .where(
              and(
                eq(t.productVariants.tenant_id, tenantId),
                eq(t.productVariants.id, input.variant_id),
              ),
            );
          const variant = variantRows[0];
          if (!variant) return null;

          const diaryId = input.client_uuid ?? randomUUID();
          await tx
            .insert(t.stockdiary)
            .values({
              id: diaryId,
              tenant_id: tenantId,
              client_uuid: diaryId,
              variant_id: input.variant_id,
              delta: input.delta,
              reason: input.reason,
              note: input.note,
              ref_ticket_id: input.ref_ticket_id ?? null,
            })
            .onConflictDoNothing();

          await tx
            .update(t.productVariants)
            .set({
              stock: sql`${t.productVariants.stock} + ${input.delta}`,
              updated_at: now(),
            })
            .where(
              and(
                eq(t.productVariants.tenant_id, tenantId),
                eq(t.productVariants.id, input.variant_id),
              ),
            );

          await tx
            .insert(t.stockcurrent)
            .values({
              id: randomUUID(),
              tenant_id: tenantId,
              variant_id: input.variant_id,
              stock: input.delta,
            })
            .onConflictDoUpdate({
              target: [t.stockcurrent.tenant_id, t.stockcurrent.variant_id],
              set: {
                stock: sql`${t.stockcurrent.stock} + ${input.delta}`,
                updated_at: now(),
              },
            });

          const after = await tx
            .select({ stock: t.productVariants.stock })
            .from(t.productVariants)
            .where(
              and(
                eq(t.productVariants.tenant_id, tenantId),
                eq(t.productVariants.id, input.variant_id),
              ),
            );
          return { variant_id: input.variant_id, stock: after[0]?.stock ?? variant.stock + input.delta };
        });
      },
      async recount(variant_id: string) {
        const rows = await db
          .select({ sum: sql<string>`coalesce(sum(${t.stockdiary.delta}), 0)` })
          .from(t.stockdiary)
          .where(
            and(
              eq(t.stockdiary.tenant_id, tenantId),
              eq(t.stockdiary.variant_id, variant_id),
            ),
          );
        return Number(rows[0]?.sum ?? 0);
      },
      async byVariant(variant_id: string) {
        const rows = await db
          .select()
          .from(t.stockcurrent)
          .where(
            and(
              eq(t.stockcurrent.tenant_id, tenantId),
              eq(t.stockcurrent.variant_id, variant_id),
            ),
          );
        return rows[0];
      },
      /** Rehydrate: the whole derived stock cache (variant carries stock too). */
      async currentAll() {
        return db
          .select()
          .from(t.stockcurrent)
          .where(eq(t.stockcurrent.tenant_id, tenantId));
      },
    },

    /**
     * Catalog vertical slice (task D1-7): product + first variant + stock
     * bookkeeping in ONE local/server transaction. Creation WITH stock emits
     * the initial stockdiary movement so sum(stockdiary) == variants.stock
     * always holds (catalog spec: stock truth survives recount).
     */
    catalog: {
      async createProduct(input: {
        name: string;
        category_id?: string | null;
        photo?: string | null;
        variant: {
          name: string;
          price: number;
          cost?: number | null;
          code?: string | null;
          stock?: number;
          low_stock_threshold?: number | null;
        };
        client_uuids?: { product?: string; variant?: string; diary?: string };
      }) {
        await assertCategory(input.category_id);
        return db.transaction(async (tx) => {
          const productId = input.client_uuids?.product ?? randomUUID();
          const [product] = await tx
            .insert(t.products)
            .values({
              id: productId,
              tenant_id: tenantId,
              client_uuid: productId,
              name: input.name,
              category_id: input.category_id ?? null,
              photo: input.photo ?? null,
              active: true,
            })
            .returning();

          const variant = await insertVariantWithStock(
            tx,
            tenantId,
            productId,
            input.variant,
            input.client_uuids ?? {},
          );

          return { product, variant };
        });
      },
      /** Extra sizes/prices on an existing product (catalog spec §Variants). */
      async addVariant(
        productId: string,
        variant: {
          name: string;
          price: number;
          cost?: number | null;
          code?: string | null;
          stock?: number;
          low_stock_threshold?: number | null;
        },
        clientUuids: { variant?: string; diary?: string } = {},
      ) {
        return db.transaction(async (tx) => {
          const productRows = await tx
            .select({ id: t.products.id })
            .from(t.products)
            .where(
              and(
                eq(t.products.tenant_id, tenantId),
                eq(t.products.id, productId),
              ),
            );
          if (!productRows[0]) return null;
          return insertVariantWithStock(
            tx,
            tenantId,
            productId,
            variant,
            clientUuids,
          );
        });
      },
    },

    shifts: {
      async open() {
        const rows = await db
          .select()
          .from(t.shifts)
          .where(
            and(eq(t.shifts.tenant_id, tenantId), eq(t.shifts.status, "open")),
          )
          .limit(1);
        return rows[0];
      },
      async createOpen(input: { client_uuid?: string } = {}) {
        const id = input.client_uuid ?? randomUUID();
        const rows = await db
          .insert(t.shifts)
          .values({
            id,
            tenant_id: tenantId,
            client_uuid: id,
            status: "open",
          })
          .returning();
        return rows[0];
      },
      async byUuid(id: string) {
        const rows = await db
          .select()
          .from(t.shifts)
          .where(and(eq(t.shifts.tenant_id, tenantId), eq(t.shifts.id, id)));
        return rows[0];
      },
      async upsert(input: {
        client_uuid: string;
        status: string;
        opened_at?: Date;
        closed_at?: Date | null;
      }) {
        const rows = await db
          .insert(t.shifts)
          .values({
            id: input.client_uuid,
            tenant_id: tenantId,
            client_uuid: input.client_uuid,
            status: input.status,
            opened_at: input.opened_at ?? now(),
            closed_at: input.closed_at ?? null,
          })
          .onConflictDoUpdate({
            target: [t.shifts.tenant_id, t.shifts.client_uuid],
            set: { status: input.status, closed_at: input.closed_at ?? null, updated_at: now() },
          })
          .returning();
        return rows[0];
      },
      /**
       * Server-side arqueo close (task D3-2): `expected` is computed from
       * the payments table inside the close transaction — the caller sends
       * ONLY `counted` (cash-close spec §Expected computed from payments).
       */
      async close(input: {
        shiftId: string;
        counted: number;
        closedBy?: string | null;
        clientUuid?: string;
      }) {
        return arqueoDb.closeShift({
          tenantId,
          shiftId: input.shiftId,
          counted: input.counted,
          closedBy: input.closedBy ?? null,
          clientUuid: input.clientUuid,
        });
      },
      /** Expected breakdown for a shift (same SQL as the offline close). */
      async expected(shiftId: string) {
        return arqueoDb.computeExpected(tenantId, shiftId);
      },
    },

    tickets: {
      async list(opts: { limit?: number; offset?: number } = {}) {
        const q = db
          .select()
          .from(t.tickets)
          .where(eq(t.tickets.tenant_id, tenantId))
          .orderBy(desc(t.tickets.created_at))
          .limit(opts.limit ?? 100);
        return opts.offset ? q.offset(opts.offset) : q;
      },
      async byUuid(id: string) {
        const rows = await db
          .select()
          .from(t.tickets)
          .where(and(eq(t.tickets.tenant_id, tenantId), eq(t.tickets.id, id)));
        return rows[0];
      },
      /** Tenant sequence starting at 1 (task D1-2 decision). */
      async nextTicketNo() {
        const rows = await db
          .select({ max: sql<string>`coalesce(max(${t.tickets.ticket_no}), 0)` })
          .from(t.tickets)
          .where(eq(t.tickets.tenant_id, tenantId));
        return Number(rows[0]?.max ?? 0) + 1;
      },
      async upsert(input: {
        client_uuid: string;
        shift_id: string | null;
        ticket_no: number;
        status?: string;
        total: number;
        created_at?: Date;
      }) {
        const rows = await db
          .insert(t.tickets)
          .values({
            id: input.client_uuid,
            tenant_id: tenantId,
            client_uuid: input.client_uuid,
            shift_id: input.shift_id,
            ticket_no: input.ticket_no,
            status: input.status ?? "completed",
            total: input.total,
            created_at: input.created_at ?? now(),
          })
          .onConflictDoUpdate({
            target: [t.tickets.tenant_id, t.tickets.client_uuid],
            set: {
              shift_id: input.shift_id,
              ticket_no: input.ticket_no,
              status: input.status ?? "completed",
              total: input.total,
              updated_at: now(),
            },
          })
          .returning();
        return rows[0];
      },
      async update(id: string, patch: { status?: string; total?: number; shift_id?: string | null }) {
        const set: Record<string, unknown> = { updated_at: now() };
        if (patch.status !== undefined) set.status = patch.status;
        if (patch.total !== undefined) set.total = patch.total;
        if (patch.shift_id !== undefined) set.shift_id = patch.shift_id;
        const rows = await db
          .update(t.tickets)
          .set(set)
          .where(and(eq(t.tickets.tenant_id, tenantId), eq(t.tickets.id, id)))
          .returning({ id: t.tickets.id });
        return rows.length;
      },
    },

    ticketLines: {
      async listByTicket(ticket_id: string) {
        return db
          .select()
          .from(t.ticketLines)
          .where(
            and(
              eq(t.ticketLines.tenant_id, tenantId),
              eq(t.ticketLines.ticket_id, ticket_id),
            ),
          );
      },
      async insertMany(
        lines: Array<{
          client_uuid: string;
          ticket_id: string;
          variant_id: string;
          qty: number;
          unit_price: number;
          subtotal: number;
        }>,
      ) {
        if (lines.length === 0) return [];
        return db
          .insert(t.ticketLines)
          .values(
            lines.map((l) => ({
              id: l.client_uuid,
              tenant_id: tenantId,
              client_uuid: l.client_uuid,
              ticket_id: l.ticket_id,
              variant_id: l.variant_id,
              qty: l.qty,
              unit_price: l.unit_price,
              subtotal: l.subtotal,
            })),
          )
          .onConflictDoNothing()
          .returning();
      },
    },

    payments: {
      async list(opts: { limit?: number } = {}) {
        return db
          .select()
          .from(t.payments)
          .where(eq(t.payments.tenant_id, tenantId))
          .orderBy(desc(t.payments.created_at))
          .limit(opts.limit ?? 100);
      },
      async byUuid(id: string) {
        const rows = await db
          .select()
          .from(t.payments)
          .where(and(eq(t.payments.tenant_id, tenantId), eq(t.payments.id, id)));
        return rows[0];
      },
      async listByTicket(ticket_id: string) {
        return db
          .select()
          .from(t.payments)
          .where(
            and(
              eq(t.payments.tenant_id, tenantId),
              eq(t.payments.ticket_id, ticket_id),
            ),
          );
      },
      /** Rehydrate page helper: every payment of a ticket slice. */
      async listByTickets(ticket_ids: string[]) {
        if (ticket_ids.length === 0) return [];
        return db
          .select()
          .from(t.payments)
          .where(
            and(
              eq(t.payments.tenant_id, tenantId),
              inArray(t.payments.ticket_id, ticket_ids),
            ),
          )
          .orderBy(desc(t.payments.created_at));
      },
      /**
       * Owner-only transfer confirmation (task D2-6, sales spec §Bank-transfer):
       * STRICT transition pending→confirmed + confirmed_at, inside one tx with
       * the ticket flip transfer_pending→completed. Any other transition
       * (including un-confirming) is `invalid_transition` — no silent revert.
       */
      async confirm(
        id: string,
      ): Promise<{ payment: t.Payment } | { error: "not_found" | "invalid_transition" }> {
        return db.transaction(async (tx) => {
          // Same parent lock as void/sync, before touching the payment.
          const [parentPayment] = await tx.select({ ticket_id: t.payments.ticket_id }).from(t.payments)
            .where(and(eq(t.payments.tenant_id, tenantId), eq(t.payments.id, id)));
          if (!parentPayment) return { error: "not_found" as const };
          const [parent] = await tx.select().from(t.tickets)
            .where(and(eq(t.tickets.tenant_id, tenantId), eq(t.tickets.id, parentPayment.ticket_id))).for("update");
          if (parent?.status === "voided") return { error: "invalid_transition" as const };
          const rows = await tx
            .select()
            .from(t.payments)
            .where(and(eq(t.payments.tenant_id, tenantId), eq(t.payments.id, id)))
            .for("update");
          const payment = rows[0];
          if (!payment) return { error: "not_found" as const };
          if (payment.status !== "pending") {
            return { error: "invalid_transition" as const };
          }
          const [updated] = await tx
            .update(t.payments)
            .set({ status: "confirmed", confirmed_at: now(), updated_at: now() })
            .where(
              and(eq(t.payments.tenant_id, tenantId), eq(t.payments.id, id)),
            )
            .returning();
          await tx
            .update(t.tickets)
            .set({ status: "completed", updated_at: now() })
            .where(
              and(
                eq(t.tickets.tenant_id, tenantId),
                eq(t.tickets.id, payment.ticket_id),
                eq(t.tickets.status, "transfer_pending"),
              ),
            );
          return { payment: updated };
        });
      },
      async upsert(input: {
        client_uuid: string;
        ticket_id: string;
        method: string;
        amount: number;
        tendered?: number | null;
        vuelto?: number | null;
        status?: string;
        confirmed_at?: Date | null;
        shift_id?: string | null;
        created_at?: Date;
      }) {
        const rows = await db
          .insert(t.payments)
          .values({
            id: input.client_uuid,
            tenant_id: tenantId,
            client_uuid: input.client_uuid,
            ticket_id: input.ticket_id,
            method: input.method,
            amount: input.amount,
            tendered: input.tendered ?? null,
            vuelto: input.vuelto ?? null,
            status: input.status ?? "pending",
            confirmed_at: input.confirmed_at ?? null,
            shift_id: input.shift_id ?? null,
            created_at: input.created_at ?? now(),
          })
          .onConflictDoUpdate({
            target: [t.payments.tenant_id, t.payments.client_uuid],
            set: {
              method: input.method,
              amount: input.amount,
              tendered: input.tendered ?? null,
              vuelto: input.vuelto ?? null,
              status: input.status ?? "pending",
              confirmed_at: input.confirmed_at ?? null,
              shift_id: input.shift_id ?? null,
              updated_at: now(),
            },
          })
          .returning();
        return rows[0];
      },
      async update(id: string, patch: { status?: string; confirmed_at?: Date | null; shift_id?: string | null }) {
        const set: Record<string, unknown> = { updated_at: now() };
        if (patch.status !== undefined) set.status = patch.status;
        if (patch.confirmed_at !== undefined) set.confirmed_at = patch.confirmed_at;
        if (patch.shift_id !== undefined) set.shift_id = patch.shift_id;
        const rows = await db
          .update(t.payments)
          .set(set)
          .where(and(eq(t.payments.tenant_id, tenantId), eq(t.payments.id, id)))
          .returning({ id: t.payments.id });
        return rows.length;
      },
    },

    /**
     * closedcash is IMMUTABLE by construction (cash-close spec): the repo
     * exposes upsert + read only — there is no update() method.
     */
    closedcash: {
      async byUuid(id: string) {
        const rows = await db
          .select()
          .from(t.closedcash)
          .where(and(eq(t.closedcash.tenant_id, tenantId), eq(t.closedcash.id, id)));
        return rows[0];
      },
      async byShift(shift_id: string) {
        const rows = await db
          .select()
          .from(t.closedcash)
          .where(
            and(
              eq(t.closedcash.tenant_id, tenantId),
              eq(t.closedcash.shift_id, shift_id),
            ),
          );
        return rows[0];
      },
      async list() {
        return db
          .select()
          .from(t.closedcash)
          .where(eq(t.closedcash.tenant_id, tenantId))
          .orderBy(desc(t.closedcash.created_at));
      },
      async upsert(input: {
        client_uuid: string;
        shift_id: string;
        expected: number;
        counted: number;
        diff: number;
        closed_by?: string | null;
      }) {
        const rows = await db
          .insert(t.closedcash)
          .values({
            id: input.client_uuid,
            tenant_id: tenantId,
            client_uuid: input.client_uuid,
            shift_id: input.shift_id,
            expected: input.expected,
            counted: input.counted,
            diff: input.diff,
            closed_by: input.closed_by ?? null,
          })
          .onConflictDoUpdate({
            target: [t.closedcash.tenant_id, t.closedcash.shift_id],
            set: { updated_at: now() },
          })
          .returning();
        return rows[0];
      },
    },

    stockdiary: {
      async listByTicket(ticketId: string) {
        return db.select().from(t.stockdiary).where(and(eq(t.stockdiary.tenant_id, tenantId), eq(t.stockdiary.ref_ticket_id, ticketId), eq(t.stockdiary.reason, "sale_void")));
      },
      async listByVariant(variant_id: string, opts: { limit?: number } = {}) {
        return db
          .select()
          .from(t.stockdiary)
          .where(
            and(
              eq(t.stockdiary.tenant_id, tenantId),
              eq(t.stockdiary.variant_id, variant_id),
            ),
          )
          .orderBy(desc(t.stockdiary.created_at))
          .limit(opts.limit ?? 500);
      },
      /** Rehydrate page: recent movements (append-only audit tail). */
      async listRecent(opts: { limit?: number; offset?: number } = {}) {
        const q = db
          .select()
          .from(t.stockdiary)
          .where(eq(t.stockdiary.tenant_id, tenantId))
          .orderBy(desc(t.stockdiary.created_at))
          .limit(opts.limit ?? 100);
        return opts.offset ? q.offset(opts.offset) : q;
      },
      async insert(input: {
        client_uuid: string;
        variant_id: string;
        delta: number;
        reason: string;
        note?: string | null;
        ref_ticket_id?: string | null;
        created_at?: Date;
      }) {
        const rows = await db
          .insert(t.stockdiary)
          .values({
            id: input.client_uuid,
            tenant_id: tenantId,
            client_uuid: input.client_uuid,
            variant_id: input.variant_id,
            delta: input.delta,
            reason: input.reason,
            note: input.note ?? null,
            ref_ticket_id: input.ref_ticket_id ?? null,
            created_at: input.created_at ?? now(),
          })
          .onConflictDoNothing()
          .returning();
        return rows[0];
      },
    },

    /**
     * The three pilot reports (task D3-4, design §8). SQL text lives in
     * @pos/shared so the local cache runs byte-identical statements; every
     * call is bound to THIS repo's session tenant.
     */
    reports: {
      async salesByDay(range?: { from: string; to: string }) {
        return reportsDb.salesByDay(tenantId, range);
      },
      async topProducts(range?: { from: string; to: string }) {
        return reportsDb.topProducts(tenantId, range);
      },
      async lowStock(defaultThreshold?: number) {
        return reportsDb.lowStock(tenantId, defaultThreshold);
      },
      async dashboardSummary(range: { from: string; to: string }) {
        return reportsDb.dashboardSummary(tenantId, range);
      },
      async inventoryValue(defaultThreshold?: number) {
        return reportsDb.inventoryValue(tenantId, defaultThreshold);
      },
    },

    syncLog: {
      /** Idempotent enqueue: same (tenant, client_uuid) never queues twice. */
      async enqueue(m: MutationEnvelope) {
        const rows = await db
          .insert(t.syncLog)
          .values({
            id: m.client_uuid,
            tenant_id: tenantId,
            client_uuid: m.client_uuid,
            entity: m.entity,
            op: m.op,
            payload: m.payload,
            status: "pending",
            client_ts: m.client_ts,
          })
          .onConflictDoNothing()
          .returning({ id: t.syncLog.id });
        return rows.length;
      },
      async pendingCount() {
        const rows = await db
          .select({ n: sql<string>`count(*)` })
          .from(t.syncLog)
          .where(
            and(
              eq(t.syncLog.tenant_id, tenantId),
              inArray(t.syncLog.status, ["pending", "in_flight", "failed"]),
            ),
          );
        return Number(rows[0]?.n ?? 0);
      },
      async list(opts: { limit?: number } = {}) {
        return db
          .select()
          .from(t.syncLog)
          .where(eq(t.syncLog.tenant_id, tenantId))
          .orderBy(t.syncLog.client_ts)
          .limit(opts.limit ?? 500);
      },
    },

    auditLog: {
      async insert(input: {
        actor: string;
        action: string;
        meta?: Record<string, unknown> | null;
        id?: string;
      }) {
        const rows = await db
          .insert(t.auditLog)
          .values({
            id: input.id ?? randomUUID(),
            tenant_id: tenantId,
            actor: input.actor,
            action: input.action,
            meta: input.meta ?? null,
          })
          .returning({ id: t.auditLog.id });
        return rows[0];
      },
    },
  };
}

export type ScopedRepo = ReturnType<typeof scopedRepo>;
