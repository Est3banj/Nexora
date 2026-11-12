import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { authHeaders, buildTestApp, createTenant, resetTables, type Actor } from "./helpers";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";
import { migrateFiado } from "../src/db/migrate-fiado";

let app: FastifyInstance;
let a: Actor;
let b: Actor;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  await resetTables();
  a = await createTenant(app, { email: "limit-a@test.co", orgSlug: "limit-a" });
  b = await createTenant(app, { email: "limit-b@test.co", orgSlug: "limit-b" });
});

async function push(actor: Actor, id: string, ts: number, fields: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/api/sync/mutations", headers: authHeaders(actor),
    payload: { mutations: [{ client_uuid: id, client_ts: ts, entity: "customer", payload: { name: "María", ...fields } }] } });
  expect(res.statusCode).toBe(200);
  return res.json().results[0];
}

it("sync create/edit, legacy edit, zero and explicit null preserve their distinct meanings through runner/repo", async () => {
  const id = randomUUID();
  const repo = scopedRepo(db, a.orgId);
  expect((await push(a, id, 1000, {})).status).toBe("applied");
  expect((await repo.customers.byUuid(id))?.credit_limit).toBeNull();
  expect((await push(a, id, 2000, { credit_limit: 150000 })).status).toBe("applied");
  expect((await push(a, id, 3000, { phone: "3001112233" })).status).toBe("applied");
  await migrateFiado(); await migrateFiado();
  expect(await repo.customers.byUuid(id)).toMatchObject({ credit_limit: 150000, phone: "3001112233" });
  await repo.customers.upsert({ client_uuid: id, name: "Editada" });
  expect((await repo.customers.byUuid(id))?.credit_limit).toBe(150000);
  await repo.customers.upsert({ client_uuid: id, name: "Editada", credit_limit: 2147483647 });
  expect((await repo.customers.byUuid(id))?.credit_limit).toBe(2147483647);
  expect((await push(a, id, 4000, { credit_limit: 0 })).status).toBe("applied");
  expect((await repo.customers.byUuid(id))?.credit_limit).toBe(0);
  expect((await push(a, id, 5000, { credit_limit: null })).status).toBe("applied");
  expect((await repo.customers.byUuid(id))?.credit_limit).toBeNull();
  expect(await repo.customers.list()).toHaveLength(1);
});

it("known UUID cannot be read or overwritten from another tenant, even with forged tenant_id", async () => {
  const id = randomUUID();
  await push(a, id, 1000, { credit_limit: 150000 });
  const before = await scopedRepo(db, a.orgId).customers.byUuid(id);
  expect(await scopedRepo(db, b.orgId).customers.byUuid(id)).toBeUndefined();
  expect((await push(b, id, 2000, { credit_limit: 1, tenant_id: a.orgId })).status).toBe("rejected");
  expect(await scopedRepo(db, a.orgId).customers.byUuid(id)).toEqual(before);
  expect(await scopedRepo(db, b.orgId).customers.list()).toEqual([]);
  const res = await app.inject({ method: "GET", url: "/api/reports/customer-accounts", headers: authHeaders(b) });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ rows: [] });
});
