import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  resetTables,
  type Actor,
} from "./helpers";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";

/**
 * D1-7 · Catalog vertical slice
 * AC (catalog spec):
 *  - §Product management: create, deactivate hides from sale not history
 *  - §Variants: two sizes different prices, price change doesn't rewrite
 *    history, invalid price rejected
 *  - §Stock movements: manual adjustment auditable, recount == balance
 *  - §Empty catalog: no crash
 */

let app: FastifyInstance;
let owner: Actor;
let repo: ReturnType<typeof scopedRepo>;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "cat@tenant.test", orgSlug: "org-cat" });
  repo = scopedRepo(db, owner.orgId);
});

async function createProduct(body: object, actor: Actor = owner) {
  return app.inject({
    method: "POST",
    url: "/api/catalog/products",
    headers: authHeaders(actor),
    payload: body,
  });
}

describe("product management", () => {
  it("create product → listed and selectable in the sale flow", async () => {
    const res = await createProduct({
      name: "Granizado de Fresa",
      variant: { name: "Mediano", price: 3000, stock: 10 },
    });
    expect(res.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: authHeaders(owner),
    });
    expect(list.json().products.map((p: { name: string }) => p.name)).toContain(
      "Granizado de Fresa",
    );

    const sale = await app.inject({
      method: "GET",
      url: "/api/catalog/sale-items",
      headers: authHeaders(owner),
    });
    expect(sale.json().items).toHaveLength(1);
    expect(sale.json().items[0].price).toBe(3000);
  });

  it("deactivate hides from sale flow but not from history", async () => {
    const created = await createProduct({
      name: "Gaseosa",
      variant: { name: "Personal", price: 2500 },
    });
    const productId = created.json().product.id;

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/catalog/products/${productId}`,
      headers: authHeaders(owner),
      payload: { active: false },
    });
    expect(patch.statusCode).toBe(200);

    const sale = await app.inject({
      method: "GET",
      url: "/api/catalog/sale-items",
      headers: authHeaders(owner),
    });
    expect(sale.json().items).toEqual([]);

    const all = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: authHeaders(owner),
    });
    expect(all.json().products).toHaveLength(1);
    expect(all.json().products[0].active).toBe(false);
  });

  it("empty catalog renders an empty list (no crash)", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: authHeaders(owner),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ products: [] });
  });
});

describe("variants with independent prices", () => {
  it("two sizes with different prices", async () => {
    const created = await createProduct({
      name: "Cerveza",
      variant: { name: "330ml", price: 4000, stock: 12 },
    });
    const productId = created.json().product.id;

    const second = await app.inject({
      method: "POST",
      url: `/api/catalog/products/${productId}/variants`,
      headers: authHeaders(owner),
      payload: { name: "600ml", price: 7000, stock: 6 },
    });
    expect(second.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: authHeaders(owner),
    });
    const prices = list
      .json()
      .products[0].variants.map((v: { price: number }) => v.price)
      .sort((a: number, b: number) => a - b);
    expect(prices).toEqual([4000, 7000]);
  });

  it("price change does not rewrite historical ticket lines", async () => {
    const created = await createProduct({
      name: "Cerveza",
      variant: { name: "330ml", price: 4000, stock: 12 },
    });
    const variantId = created.json().variant.id;

    // historical ticket sold at 4000
    const ticketId = randomUUID();
    await repo.tickets.upsert({
      client_uuid: ticketId,
      shift_id: null,
      ticket_no: 1,
      total: 8000,
    });
    await repo.ticketLines.insertMany([
      {
        client_uuid: randomUUID(),
        ticket_id: ticketId,
        variant_id: variantId,
        qty: 2,
        unit_price: 4000,
        subtotal: 8000,
      },
    ]);

    // price change → 4500
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/catalog/variants/${variantId}`,
      headers: authHeaders(owner),
      payload: { price: 4500 },
    });
    expect(patch.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/sales/tickets/${ticketId}`,
      headers: authHeaders(owner),
    });
    expect(detail.json().lines[0].unit_price).toBe(4000);
    expect(detail.json().ticket.total).toBe(8000);
  });

  it("invalid price (negative / non-integer) is rejected and unchanged", async () => {
    const created = await createProduct({
      name: "Agua",
      variant: { name: "600ml", price: 2000 },
    });
    const variantId = created.json().variant.id;

    for (const price of [-100, 2000.5]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/catalog/variants/${variantId}`,
        headers: authHeaders(owner),
        payload: { price },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("validation_error");
    }

    const list = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: authHeaders(owner),
    });
    expect(list.json().products[0].variants[0].price).toBe(2000);
  });

  it("negative price on create is rejected (400)", async () => {
    const res = await createProduct({
      name: "Oferta Rara",
      variant: { name: "Único", price: -50 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("stock movements (stockdiary)", () => {
  it("manual adjustment is auditable: delta + reason + note, balance updates", async () => {
    const created = await createProduct({
      name: "Cerveza",
      variant: { name: "330ml", price: 4000, stock: 8 },
    });
    const variantId = created.json().variant.id;

    const res = await app.inject({
      method: "POST",
      url: `/api/catalog/variants/${variantId}/stock-adjust`,
      headers: authHeaders(owner),
      payload: { delta: 4, reason: "reposition", note: "Caja de 12" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().stock).toBe(12);

    const diary = await repo.stockdiary.listByVariant(variantId);
    expect(diary).toHaveLength(2); // initial 8 + adjustment 4
    expect(diary[0].delta).toBe(4);
    expect(diary[0].reason).toBe("reposition");
    expect(diary[0].note).toBe("Caja de 12");
  });

  it("reason/note are required", async () => {
    const created = await createProduct({
      name: "Cerveza",
      variant: { name: "330ml", price: 4000, stock: 8 },
    });
    const variantId = created.json().variant.id;

    const res = await app.inject({
      method: "POST",
      url: `/api/catalog/variants/${variantId}/stock-adjust`,
      headers: authHeaders(owner),
      payload: { delta: 4, reason: "", note: "" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("stock truth survives recount: +50 −2 −3 +10 = 55", async () => {
    const created = await createProduct({
      name: "Gaseosa",
      variant: { name: "Personal", price: 2500, stock: 50 },
    });
    const variantId = created.json().variant.id;

    for (const delta of [-2, -3, 10]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/catalog/variants/${variantId}/stock-adjust`,
        headers: authHeaders(owner),
        payload: { delta, reason: "movement", note: `delta ${delta}` },
      });
      expect(res.statusCode).toBe(201);
    }

    const variant = await repo.productVariants.byUuid(variantId);
    const current = await repo.stock.byVariant(variantId);
    const recount = await repo.stock.recount(variantId);
    expect(recount).toBe(55);
    expect(variant?.stock).toBe(55);
    expect(current?.stock).toBe(55);
  });

  it("adjusting an unknown variant → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/catalog/variants/${randomUUID()}/stock-adjust`,
      headers: authHeaders(owner),
      payload: { delta: 1, reason: "x", note: "y" },
    });
    expect(res.statusCode).toBe(404);
  });
});
