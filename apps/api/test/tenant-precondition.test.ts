import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { authHeaders, buildTestApp, createTenant, resetTables, type Actor } from "./helpers";
import { closeDb } from "../src/db";

let app: FastifyInstance;
let a: Actor;
let b: Actor;
beforeAll(async () => {
  app = await buildTestApp();
  await resetTables();
  a = await createTenant(app, { email: "pre-a@test.test", orgSlug: "pre-a" });
  b = await createTenant(app, { email: "pre-b@test.test", orgSlug: "pre-b" });
});
afterAll(async () => { await app.close(); await closeDb(); });

it.each([
  ["GET", "/api/rehydrate"],
  ["POST", "/api/sync/mutations"],
  ["POST", "/api/sync/sales/11111111-1111-4111-8111-111111111111/parts"],
  ["POST", "/api/sync/sales/11111111-1111-4111-8111-111111111111/finalize"],
] as const)("stale A client under B session: %s %s rejects before data access", async (method, url) => {
  const response = await app.inject({ method, url, headers: { ...authHeaders(b), "x-nexora-tenant": a.orgId } });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({ error: "tenant_mismatch" });
});

it("matching precondition permits hydration; header alone never authenticates", async () => {
  const response = await app.inject({ method: "GET", url: "/api/rehydrate", headers: { ...authHeaders(a), "x-nexora-tenant": a.orgId } });
  expect(response.statusCode).toBe(200);
  const unauthenticated = await app.inject({ method: "GET", url: "/api/rehydrate", headers: { "x-nexora-tenant": a.orgId } });
  expect(unauthenticated.statusCode).toBe(401);
});
