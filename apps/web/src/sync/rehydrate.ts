import type { PGlite } from "@electric-sql/pglite";
import { localTx, type LocalQueryable } from "../db/pglite";

/**
 * Local cache rehydration (task D2-8, design §3 rule 5).
 *
 * Pulls paged server state through GET /api/rehydrate and inserts it into
 * the (new) local datadir with ON CONFLICT DO NOTHING — idempotent across
 * retries, and it NEVER enqueues sync_log entries: server rows are already
 * truth, pushing them back would be a no-op loop.
 */

export type RehydrateFetch = (
  path: string,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

type Row = Record<string, unknown>;

export type RehydratePage = {
  categories?: Row[];
  products?: Row[];
  variants?: Row[];
  open_shift?: Row | null;
  stock?: Row[];
  tickets?: Row[];
  ticket_lines?: Row[];
  payments?: Row[];
  stockdiary?: Row[];
  next_offset: number | null;
};

const iso = (v: unknown): string | null =>
  typeof v === "string" ? v : v instanceof Date ? v.toISOString() : null;

async function insertIgnore(
  tx: LocalQueryable,
  table: string,
  cols: string[],
  values: unknown[],
): Promise<void> {
  const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
  await tx.query(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})
     ON CONFLICT DO NOTHING`,
    values,
  );
}

/** Inserts one page. Returns how many rows were actually inserted. */
export async function applyRehydratePage(
  db: PGlite,
  tenantId: string,
  page: RehydratePage,
): Promise<number> {
  return localTx(db, async (tx) => {
    let inserted = 0;

    for (const c of page.categories ?? []) {
      await insertIgnore(
        tx,
        "categories",
        ["id", "tenant_id", "client_uuid", "name", "active", "created_at", "updated_at"],
        [
          c.id,
          tenantId,
          c.client_uuid ?? c.id,
          c.name,
          c.active,
          iso(c.created_at),
          iso(c.updated_at),
        ],
      );
      inserted += 1;
    }

    for (const p of page.products ?? []) {
      await insertIgnore(
        tx,
        "products",
        ["id", "tenant_id", "client_uuid", "name", "category_id", "photo", "active", "created_at", "updated_at"],
        [
          p.id,
          tenantId,
          p.client_uuid ?? p.id,
          p.name,
          p.category_id ?? null,
          p.photo ?? null,
          p.active,
          iso(p.created_at),
          iso(p.updated_at),
        ],
      );
      inserted += 1;
    }

    for (const v of page.variants ?? []) {
      await insertIgnore(
        tx,
        "product_variants",
        [
          "id",
          "tenant_id",
          "client_uuid",
          "product_id",
          "name",
          "price",
          "cost",
          "stock",
          "low_stock_threshold",
          "active",
          "created_at",
          "updated_at",
        ],
        [
          v.id,
          tenantId,
          v.client_uuid ?? v.id,
          v.product_id,
          v.name,
          v.price,
          v.cost ?? null,
          v.stock,
          v.low_stock_threshold ?? null,
          v.active,
          iso(v.created_at),
          iso(v.updated_at),
        ],
      );
      inserted += 1;
    }

    const shift = page.open_shift;
    if (shift && shift.id) {
      await insertIgnore(
        tx,
        "shifts",
        ["id", "tenant_id", "client_uuid", "status", "opened_at", "closed_at"],
        [shift.id, tenantId, shift.client_uuid ?? shift.id, shift.status, iso(shift.opened_at), iso(shift.closed_at)],
      );
      inserted += 1;
    }

    for (const s of page.stock ?? []) {
      await insertIgnore(
        tx,
        "stockcurrent",
        ["id", "tenant_id", "variant_id", "stock", "created_at"],
        [s.id, tenantId, s.variant_id, s.stock, iso(s.created_at)],
      );
      inserted += 1;
    }

    for (const t of page.tickets ?? []) {
      await insertIgnore(
        tx,
        "tickets",
        [
          "id",
          "tenant_id",
          "client_uuid",
          "shift_id",
          "ticket_no",
          "status",
          "total",
          "created_at",
        ],
        [t.id, tenantId, t.client_uuid ?? t.id, t.shift_id ?? null, t.ticket_no, t.status, t.total, iso(t.created_at)],
      );
      inserted += 1;
    }

    for (const l of page.ticket_lines ?? []) {
      await insertIgnore(
        tx,
        "ticket_lines",
        [
          "id",
          "tenant_id",
          "client_uuid",
          "ticket_id",
          "variant_id",
          "qty",
          "unit_price",
          "subtotal",
          "created_at",
        ],
        [
          l.id,
          tenantId,
          l.client_uuid ?? l.id,
          l.ticket_id,
          l.variant_id,
          l.qty,
          l.unit_price,
          l.subtotal,
          iso(l.created_at),
        ],
      );
      inserted += 1;
    }

    for (const p of page.payments ?? []) {
      await insertIgnore(
        tx,
        "payments",
        [
          "id",
          "tenant_id",
          "client_uuid",
          "ticket_id",
          "method",
          "amount",
          "tendered",
          "vuelto",
          "status",
          "confirmed_at",
          "shift_id",
          "created_at",
        ],
        [
          p.id,
          tenantId,
          p.client_uuid ?? p.id,
          p.ticket_id,
          p.method,
          p.amount,
          p.tendered ?? null,
          p.vuelto ?? null,
          p.status,
          iso(p.confirmed_at),
          p.shift_id ?? null,
          iso(p.created_at),
        ],
      );
      inserted += 1;
    }

    for (const d of page.stockdiary ?? []) {
      await insertIgnore(
        tx,
        "stockdiary",
        [
          "id",
          "tenant_id",
          "client_uuid",
          "variant_id",
          "delta",
          "reason",
          "note",
          "ref_ticket_id",
          "created_at",
        ],
        [
          d.id,
          tenantId,
          d.client_uuid ?? d.id,
          d.variant_id,
          d.delta,
          d.reason,
          d.note ?? null,
          d.ref_ticket_id ?? null,
          iso(d.created_at),
        ],
      );
      inserted += 1;
    }

    return inserted;
  });
}

export async function fetchRehydratePage(
  offset: number,
  limit: number,
  fetchFn?: RehydrateFetch,
): Promise<RehydratePage> {
  const doFetch: RehydrateFetch =
    fetchFn ?? ((path) => fetch(path) as unknown as ReturnType<RehydrateFetch>);
  const res = await doFetch(`/api/rehydrate?offset=${offset}&limit=${limit}`);
  if (!res.ok) throw new Error(`rehydrate_${res.status}`);
  return (await res.json()) as RehydratePage;
}

/**
 * Pages through the server until `next_offset` is null (safety-capped at
 * MAX_PAGES so a bad server can never spin forever).
 */
export async function rehydrateFromServer(
  db: PGlite,
  tenantId: string,
  opts: { pageSize?: number; fetchFn?: RehydrateFetch; maxPages?: number } = {},
): Promise<{ inserted: number; pages: number }> {
  const pageSize = opts.pageSize ?? 100;
  const maxPages = opts.maxPages ?? 100;
  let offset = 0;
  let inserted = 0;
  let pages = 0;
  for (;;) {
    const page = await fetchRehydratePage(offset, pageSize, opts.fetchFn);
    inserted += await applyRehydratePage(db, tenantId, page);
    pages += 1;
    if (page.next_offset === null || pages >= maxPages) break;
    offset = page.next_offset;
  }
  return { inserted, pages };
}
