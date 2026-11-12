import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authHeaders, buildTestApp, createTenant, resetTables, type Actor } from "./helpers";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";
import { migratePrototype } from "../src/db/migrate-prototype";

let app: FastifyInstance;
let actor: Actor;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => { await resetTables(); actor = await createTenant(app, { email: "icons@test.co", orgSlug: "icons" }); });

it("sync/repo/rehydrate preserve product/category icons across legacy edits and idempotent migrations", async () => {
  const repo = scopedRepo(db, actor.orgId);
  for (const entity of ["category", "product"] as const) {
    const id = randomUUID();
    for (const [ts, fields] of [[1, { icon_key: "coffee" }], [2, {}]] as const) {
      const result = await app.inject({ method: "POST", url: "/api/sync/mutations", headers: authHeaders(actor), payload: { mutations: [{ client_uuid: id, client_ts: ts, entity, payload: { name: "Café ñ", ...fields } }] } });
      expect(result.json().results[0].status).toBe("applied");
    }
    await migratePrototype(); await migratePrototype();
    const collection = entity === "category" ? repo.categories : repo.products;
    expect((await collection.byUuid(id))?.icon_key).toBe("coffee");
    if (entity === "category") await repo.categories.update(id, { name: "Bebidas" });
    else await repo.products.upsert({ client_uuid: id, name: "Café" });
    expect((await collection.byUuid(id))?.icon_key).toBe("coffee");
    const response = await app.inject({ method: "GET", url: "/api/rehydrate", headers: authHeaders(actor) });
    expect(response.json()[entity === "category" ? "categories" : "products"]).toEqual(expect.arrayContaining([expect.objectContaining({ id, icon_key: "coffee" })]));
  }
});
