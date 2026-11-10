import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { mutationEnvelopeSchema, VARIANT_CODE_MIGRATION_SQL } from "@pos/shared";
import { authHeaders, buildTestApp, createTenant, resetTables, type Actor } from "./helpers";
import { closeDb, db, pool } from "../src/db";
import { applyMutationGroups } from "../src/db/sync-apply";
import { scopedRepo } from "../src/db/scope";
import { migrateCatalog } from "../src/db/migrate-catalog";

let app: FastifyInstance;
let a: Actor;
let b: Actor;
beforeAll(async () => { app = await buildTestApp(); });
beforeEach(async () => {
  await resetTables();
  a = await createTenant(app, { email: "sku-a@test.com", orgSlug: "sku-a" });
  b = await createTenant(app, { email: "sku-b@test.com", orgSlug: "sku-b" });
});
afterAll(async () => { await app.close(); await closeDb(); });

const create = (actor: Actor, code: unknown, name = "Cerveza") => app.inject({
  method: "POST", url: "/api/catalog/products", headers: authHeaders(actor),
  payload: { name, variant: { name: "330 ml", price: 4000, cost: 2000, stock: 10, code } },
});

it("creates, edits, clears and rehydrates string codes; tenant uniqueness is atomic and normalized", async () => {
  const created = await create(a, " 001234 ");
  expect(created.statusCode).toBe(201);
  const { product, variant } = created.json();
  expect(variant.code).toBe("001234");
  const duplicate = await create(a, "001234", "Otra cerveza");
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json().error).toBe("duplicate_code");
  expect((await scopedRepo(db, a.orgId).products.list())).toHaveLength(1);
  expect((await create(b, "001234")).statusCode).toBe(201);
  expect((await create(a, 1234)).statusCode).toBe(400);
  const extra = await app.inject({ method: "POST", url: `/api/catalog/products/${product.id}/variants`,
    headers: authHeaders(a), payload: { name: "600 ml", price: 6000, code: "00600" } });
  expect(extra.statusCode).toBe(201);
  const patch = (code: string | null) => app.inject({ method: "PATCH", url: `/api/catalog/variants/${variant.id}`,
    headers: authHeaders(a), payload: { code } });
  expect((await patch("00600")).statusCode).toBe(409);
  expect((await patch("000330")).statusCode).toBe(200);
  const sale = await app.inject({ method: "GET", url: "/api/catalog/sale-items", headers: authHeaders(a) });
  expect(sale.json().items.find((v: { id: string }) => v.id === variant.id)).toMatchObject({ code: "000330", cost: 2000 });
  const page = await app.inject({ method: "GET", url: "/api/rehydrate", headers: authHeaders(a) });
  expect(page.json().variants.find((v: { id: string }) => v.id === variant.id).code).toBe("000330");
  expect((await patch("  ")).statusCode).toBe(200);
  expect((await scopedRepo(db, a.orgId).productVariants.byUuid(variant.id))?.code).toBeNull();
});

it("legacy sync preserves code/cost/photo/category; duplicate code is deterministic and editable", async () => {
  const repo = scopedRepo(db, a.orgId);
  const category = await repo.categories.create({ name: "Bebidas" });
  const { product, variant } = await repo.catalog.createProduct({ name: "Cerveza", category_id: category.id,
    photo: "data:image/png;base64,AA", variant: { name: "330", price: 4000, cost: 2000, code: "00330" } });
  const envelope = (id: string, payload: object, ts: number) => mutationEnvelopeSchema.parse({ client_uuid: id,
    client_ts: ts, entity: "variant", payload: { product_id: product.id, name: "330", price: 4500,
      stock: 0, low_stock_threshold: null, active: true, ...payload } });
  const legacy = envelope(variant.id, {}, 10);
  expect((await applyMutationGroups(db, a.orgId, a.userId, [legacy]))[0].status).toBe("applied");
  expect((await applyMutationGroups(db, a.orgId, a.userId, [legacy]))[0].status).toBe("duplicate");
  expect(await repo.productVariants.byUuid(variant.id)).toMatchObject({ code: "00330", cost: 2000 });
  const oldProduct = mutationEnvelopeSchema.parse({ client_uuid: product.id, client_ts: 11, entity: "product",
    payload: { name: "Cerveza editada" } });
  await applyMutationGroups(db, a.orgId, a.userId, [oldProduct]);
  expect(await repo.products.byUuid(product.id)).toMatchObject({ category_id: category.id, photo: "data:image/png;base64,AA" });
  const extraId = randomUUID();
  const conflict = envelope(extraId, { name: "600", code: "00330" }, 12);
  expect((await applyMutationGroups(db, a.orgId, a.userId, [conflict]))[0]).toMatchObject({ status: "rejected", reason: "duplicate_code" });
  expect(await repo.productVariants.byUuid(extraId)).toBeUndefined();
  expect((await applyMutationGroups(db, a.orgId, a.userId, [envelope(extraId, { name: "600", code: "00600" }, 13)]))[0].status).toBe("applied");
});

it("rejects cross-tenant category/product references in catalog and sync", async () => {
  const foreign = scopedRepo(db, b.orgId);
  const cat = await foreign.categories.create({ name: "Ajena" });
  const p = await foreign.catalog.createProduct({ name: "Ajeno", variant: { name: "Único", price: 100 } });
  const own = (await create(a, null)).json();
  expect((await app.inject({ method: "PATCH", url: `/api/catalog/products/${own.product.id}`,
    headers: authHeaders(a), payload: { category_id: cat.id } })).statusCode).toBe(404);
  const mutations = [
    mutationEnvelopeSchema.parse({ client_uuid: randomUUID(), client_ts: 1, entity: "product", payload: { name: "Forjado", category_id: cat.id } }),
    mutationEnvelopeSchema.parse({ client_uuid: randomUUID(), client_ts: 2, entity: "variant", payload: { product_id: p.product.id, name: "Forjado", price: 1, stock: 0, low_stock_threshold: null, active: true } }),
  ];
  expect((await applyMutationGroups(db, a.orgId, a.userId, mutations)).map(r => r.reason)).toEqual(["validation", "validation"]);
});

it("additive migration is repeatable and preserves business/auth data", async () => {
  const created = (await create(a, "0001")).json();
  // Test the actual boot migration twice, against existing auth/catalog tables.
  await migrateCatalog();
  await pool.query(VARIANT_CODE_MIGRATION_SQL);
  expect((await scopedRepo(db, a.orgId).productVariants.byUuid(created.variant.id))?.code).toBe("0001");
  expect((await app.inject({ method: "GET", url: "/api/catalog/products", headers: authHeaders(a) })).statusCode).toBe(200);
  const client = await pool.connect();
  try {
    // Isolated pre-code table; no removal or alteration of pilot tables.
    await client.query("BEGIN");
    await client.query("CREATE TEMP TABLE product_variants (id uuid, tenant_id uuid, stock integer)");
    await client.query("INSERT INTO pg_temp.product_variants VALUES($1,$2,9)", [randomUUID(), a.orgId]);
    await client.query(VARIANT_CODE_MIGRATION_SQL);
    await client.query(VARIANT_CODE_MIGRATION_SQL);
    expect((await client.query("SELECT stock,code FROM pg_temp.product_variants")).rows).toEqual([{ stock: 9, code: null }]);
  } finally { await client.query("ROLLBACK"); client.release(); }
});
