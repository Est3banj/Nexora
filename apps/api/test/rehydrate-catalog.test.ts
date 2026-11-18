import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  resetTables,
  type Actor,
} from "./helpers";
import { closeDb, db } from "../src/db";

/**
 * P1-1 · rehydrate must deliver the WHOLE catalog to a rebuilt device.
 *
 * The repo caps (200 categories / 1000 products / 2000 variants) used to
 * apply on page 0 only, with `next_offset` driven by tickets/stockdiary —
 * so a tenant beyond a cap was silently truncated and the local cache came
 * back incomplete. Categories/products/variants now ride the SAME
 * `next_offset` counter, and this suite proves it with fixtures past the
 * old caps (1050 products + 1050 variants + 250 categories).
 *
 * P1-2 · the ticket-lines page helper must keep the old grouping order
 * (one group per ticket, groups in the page's ticket order) now that it is
 * a single inArray query instead of one query per ticket.
 */

const CATEGORY_COUNT = 250;
const PRODUCT_COUNT = 1050;
const PAGE_LIMIT = 100;
const MAX_PAGES = 50;

let app: FastifyInstance;
let owner: Actor;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, {
    email: "rehydrate-catalog@test.dev",
    orgSlug: "rehydrate-catalog",
  });
});

/** Bulk fixtures (generate_series) — 1000+ rows, too many for the repo API. */
async function seedBigCatalog(orgId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO categories (id, tenant_id, client_uuid, name, active, created_at, updated_at)
    SELECT gen_random_uuid(), ${orgId}::uuid, gen_random_uuid(),
           'Categoria ' || lpad(n::text, 4, '0'), true, now(), now()
    FROM generate_series(1, ${CATEGORY_COUNT}::int) n`);
  await db.execute(sql`
    INSERT INTO products (id, tenant_id, client_uuid, name, category_id, active, created_at, updated_at)
    SELECT gen_random_uuid(), ${orgId}::uuid, gen_random_uuid(),
           'Producto ' || lpad(n::text, 5, '0'),
           (SELECT c.id FROM categories c WHERE c.tenant_id = ${orgId}::uuid
             ORDER BY c.name LIMIT 1 OFFSET ((n - 1) % ${CATEGORY_COUNT}::int)),
           true, now(), now()
    FROM generate_series(1, ${PRODUCT_COUNT}::int) n`);
  await db.execute(sql`
    INSERT INTO product_variants (id, tenant_id, client_uuid, product_id, name, price, stock, active, created_at, updated_at)
    SELECT gen_random_uuid(), ${orgId}::uuid, gen_random_uuid(), p.id, 'Unidad', 1500, 7, true, now(), now()
    FROM products p WHERE p.tenant_id = ${orgId}::uuid`);
}

type Pull = {
  products: Array<{ id: string; category_id: string | null }>;
  variants: Array<{ id: string }>;
  categories: Array<{ id: string }>;
  pages: number;
  firstPageProducts: number;
  seenProducts: string[];
};

/** Walk `next_offset` until it is null, collecting every catalog row. */
async function pullCatalog(actor: Actor): Promise<Pull> {
  const products: Pull["products"] = [];
  const variants: Pull["variants"] = [];
  const categories: Pull["categories"] = [];
  const seenProducts: string[] = [];
  let offset = 0;
  let pages = 0;
  let firstPageProducts = -1;
  for (;;) {
    const res = await app.inject({
      method: "GET",
      url: `/api/rehydrate?limit=${PAGE_LIMIT}&offset=${offset}`,
      headers: authHeaders(actor),
    });
    expect(res.statusCode).toBe(200);
    const page = res.json() as {
      products?: Pull["products"];
      variants?: Pull["variants"];
      categories?: Pull["categories"];
      next_offset: number | null;
    };
    if (pages === 0) firstPageProducts = (page.products ?? []).length;
    for (const row of page.categories ?? []) categories.push(row);
    for (const row of page.products ?? []) {
      products.push(row);
      seenProducts.push(row.id);
    }
    for (const row of page.variants ?? []) variants.push(row);
    pages += 1;
    if (page.next_offset === null) break;
    expect(pages).toBeLessThan(MAX_PAGES);
    offset = page.next_offset;
  }
  return { products, variants, categories, pages, firstPageProducts, seenProducts };
}

describe("P1-1 · rehydrate catalog is never truncated", () => {
  it("a rebuilt device receives all 1050 products / 1050 variants / 250 categories across pages", async () => {
    await seedBigCatalog(owner.orgId);

    const pulled = await pullCatalog(owner);

    // Paging is actually exercised: page 0 alone cannot hold the catalog.
    expect(pulled.firstPageProducts).toBe(PAGE_LIMIT);
    expect(pulled.pages).toBeGreaterThan(1);
    expect(pulled.products).toHaveLength(PRODUCT_COUNT);
    expect(pulled.variants).toHaveLength(PRODUCT_COUNT);
    expect(pulled.categories).toHaveLength(CATEGORY_COUNT);

    // No row is skipped or delivered twice by the offset walk.
    expect(new Set(pulled.seenProducts).size).toBe(PRODUCT_COUNT);

    // Cross-page integrity: every product still points at a category that
    // arrived somewhere in the walk (categories and products page together).
    const categoryIds = new Set(pulled.categories.map((c) => c.id));
    expect(pulled.products.filter((p) => p.category_id === null)).toHaveLength(0);
    for (const product of pulled.products) {
      expect(categoryIds.has(product.category_id as string)).toBe(true);
    }

    // The server-side truth the walk must mirror.
    const counts = await db.execute<{ products: string; variants: string; categories: string }>(sql`
      SELECT (SELECT count(*) FROM products WHERE tenant_id = ${owner.orgId}::uuid)::text AS products,
             (SELECT count(*) FROM product_variants WHERE tenant_id = ${owner.orgId}::uuid)::text AS variants,
             (SELECT count(*) FROM categories WHERE tenant_id = ${owner.orgId}::uuid)::text AS categories`);
    expect(Number(counts.rows[0].products)).toBe(PRODUCT_COUNT);
    expect(Number(counts.rows[0].variants)).toBe(PRODUCT_COUNT);
    expect(Number(counts.rows[0].categories)).toBe(CATEGORY_COUNT);
  });

  it("page 0 keeps the one-shot bootstrap (customers/open shift/stock) and later pages do not", async () => {
    const first = (
      await app.inject({ method: "GET", url: "/api/rehydrate", headers: authHeaders(owner) })
    ).json();
    expect(first).toHaveProperty("customers");
    expect(first).toHaveProperty("open_shift");
    expect(first).toHaveProperty("stock");
    expect(first).toHaveProperty("products");
    const second = (
      await app.inject({
        method: "GET",
        url: "/api/rehydrate?limit=100&offset=100",
        headers: authHeaders(owner),
      })
    ).json();
    expect(second.customers).toBeUndefined();
    expect(second.open_shift).toBeUndefined();
    expect(second.stock).toBeUndefined();
    // The catalog keeps riding the page loop beyond page 0 (P1-1).
    expect(second).toHaveProperty("products");
    expect(second).toHaveProperty("variants");
    expect(second).toHaveProperty("categories");
  });
});

describe("P1-2 · one query per page for ticket lines", () => {
  it("keeps the old grouping: one contiguous group per ticket, groups in the page's ticket order", async () => {
    // Three tickets, newest first (tickets.list orders by created_at DESC),
    // two lines each — a page big enough to hold all three.
    const ticketIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ticketId = randomUUID();
      const createdAt = new Date(Date.now() - i * 60_000);
      await db.execute(sql`
        INSERT INTO tickets (id, tenant_id, client_uuid, ticket_no, status, total, created_at, updated_at)
        VALUES (${ticketId}::uuid, ${owner.orgId}::uuid, ${ticketId}::uuid, ${100 + i}, 'completed', 5000, ${createdAt}, ${createdAt})`);
      ticketIds.push(ticketId);
      for (let line = 0; line < 2; line++) {
        const lineId = randomUUID();
        await db.execute(sql`
          INSERT INTO ticket_lines (id, tenant_id, client_uuid, ticket_id, variant_id, qty, unit_price, subtotal, created_at, updated_at)
          VALUES (${lineId}::uuid, ${owner.orgId}::uuid, ${lineId}::uuid, ${ticketId}::uuid,
                  ${randomUUID()}::uuid, 1, 2500, 2500, ${createdAt}, ${createdAt})`);
      }
    }

    const page = (
      await app.inject({
        method: "GET",
        url: "/api/rehydrate?limit=3",
        headers: authHeaders(owner),
      })
    ).json() as {
      tickets: Array<{ id: string }>;
      ticket_lines: Array<{ id: string; ticket_id: string }>;
    };

    expect(page.tickets.map((t) => t.id)).toEqual(ticketIds);
    expect(page.ticket_lines).toHaveLength(6);

    // Contiguous groups, following the ticket order of the page.
    const groups: string[] = [];
    for (const line of page.ticket_lines) {
      if (groups[groups.length - 1] !== line.ticket_id) groups.push(line.ticket_id);
    }
    expect(groups).toEqual(ticketIds);
    for (const id of ticketIds) {
      expect(page.ticket_lines.filter((l) => l.ticket_id === id)).toHaveLength(2);
    }
    // No line is delivered twice by the inArray query.
    expect(new Set(page.ticket_lines.map((l) => l.id)).size).toBe(6);
  });
});
