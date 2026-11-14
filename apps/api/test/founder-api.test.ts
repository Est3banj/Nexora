import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  resetTables,
  signIn,
  type Actor,
} from "./helpers";
import { closeDb, db, pool } from "../src/db";
import { scopedRepo } from "../src/db/scope";

/**
 * D4-2 · Founder HTTP plane (founder-control spec).
 *  - §Platform-admin distinct: tenant owner rejected, unauth rejected
 *  - §Create tenant with first user + empty catalog
 *  - §Creation is audited
 *  - §Sync status view + last sync time
 *  - §No business payloads in founder responses
 *  - §Tenant isolation applies to founder queries (A=7, B=2, never 9)
 */

let app: FastifyInstance;
let owner: Actor;

async function makePlatformAdmin(userId: string): Promise<void> {
  await pool.query(`UPDATE "user" SET "platformAdmin" = true WHERE id = $1`, [
    userId,
  ]);
}

async function platformAdminActor(): Promise<Actor> {
  const actor = await createTenant(app, {
    email: `founder-${randomUUID().slice(0, 8)}@platform.test`,
    orgSlug: `org-founder-${randomUUID().slice(0, 8)}`,
  });
  await makePlatformAdmin(actor.userId);
  // fresh sign-in so getSession reloads platformAdmin from the user row
  const cookie = await signIn(app, actor);
  return { ...actor, cookie };
}

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "owner@tenant.test", orgSlug: "org-owner" });
});

describe("D4-2 · platform-admin gates", () => {
  it("unauthenticated founder request → 401, no tenant created", async () => {
    const before = await countOrgs();
    const res = await app.inject({
      method: "POST",
      url: "/api/founder/tenants",
      payload: {
        name: "Tienda Hack",
        email: "hack@tienda.test",
        password: "secret1234",
      },
    });
    expect(res.statusCode).toBe(401);
    expect(await countOrgs()).toBe(before);

    const status = await app.inject({ method: "GET", url: "/api/founder/sync-status" });
    expect(status.statusCode).toBe(401);
  });

  it("tenant OWNER without platformAdmin → 403, no tenant created", async () => {
    const before = await countOrgs();
    const res = await app.inject({
      method: "POST",
      url: "/api/founder/tenants",
      headers: authHeaders(owner),
      payload: {
        name: "Tienda Owner Hack",
        email: "hack2@tienda.test",
        password: "secret1234",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    expect(await countOrgs()).toBe(before);

    const status = await app.inject({
      method: "GET",
      url: "/api/founder/sync-status",
      headers: authHeaders(owner),
    });
    expect(status.statusCode).toBe(403);
  });

  it("platform admin can create tenant + first user; first user signs into empty catalog", async () => {
    const founder = await platformAdminActor();
    const res = await app.inject({
      method: "POST",
      url: "/api/founder/tenants",
      headers: authHeaders(founder),
      payload: {
        name: "Tienda Granizados",
        email: "shop@granizados.test",
        password: "secret1234",
        slug: "tienda-granizados",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(body).toEqual({
      tenant: { id: expect.any(String), name: "Tienda Granizados", slug: "tienda-granizados" },
      first_user: { id: expect.any(String), email: "shop@granizados.test" },
      audit: { id: expect.any(String) },
    });
    expect(body.tenant.name).toBe("Tienda Granizados");
    expect(body.first_user.email).toBe("shop@granizados.test");
    expect(body.audit.id).toBeTruthy();

    // first user signs in → active org = new tenant → empty catalog
    const cookie = await signIn(app, {
      email: "shop@granizados.test",
      password: "secret1234",
    });
    const orgs = await app.inject({
      method: "GET",
      url: "/api/auth/organization/list",
      headers: { cookie },
    });
    expect(orgs.statusCode).toBe(200);
    const list = orgs.json();
    const arr = list.data ?? list;
    expect(arr).toHaveLength(1);
    expect(arr[0].id).toBe(body.tenant.id);

    await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie },
      payload: { organizationId: body.tenant.id },
    });

    const products = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: { cookie },
    });
    expect(products.json().products).toEqual([]);

    // audit row exists with actor + tenant id
    const auditRows = await pool.query(
      `SELECT actor, action, meta FROM audit_log WHERE tenant_id = $1`,
      [body.tenant.id],
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].action).toBe("tenant.create");
    expect(auditRows.rows[0].actor).toBe(founder.userId);
    expect(auditRows.rows[0].meta.org_id).toBe(body.tenant.id);
  });

  it("duplicate email → 409 and no second org", async () => {
    const founder = await platformAdminActor();
    const payload = {
      name: "Dup Tienda",
      email: "dup@tienda.test",
      password: "secret1234",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/founder/tenants",
      headers: authHeaders(founder),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const afterFirst = await countOrgs();
    const second = await app.inject({
      method: "POST",
      url: "/api/founder/tenants",
      headers: authHeaders(founder),
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(await countOrgs()).toBe(afterFirst); // failed attempt adds no org
  });

  it("platform flag is rechecked on every request, independent of active tenant", async () => {
    const founder = await platformAdminActor();
    await pool.query(`UPDATE session SET "activeOrganizationId" = NULL WHERE "userId" = $1`, [founder.userId]);
    expect((await app.inject({ method: "GET", url: "/api/founder/sync-status", headers: authHeaders(founder) })).statusCode).toBe(200);
    await pool.query(`UPDATE "user" SET "platformAdmin" = false WHERE id = $1`, [founder.userId]);
    const before = await countOrgs();
    for (const method of ["GET", "POST"] as const) {
      const denied = await app.inject({ method, url: method === "GET" ? "/api/founder/sync-status" : "/api/founder/tenants",
        headers: authHeaders(founder), ...(method === "POST" ? { payload: { name: "Revoked", email: "revoked@test.dev", password: "secret1234" } } : {}) });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "forbidden" });
    }
    expect(await countOrgs()).toBe(before);
  });
});

describe("D4-2 · sync-status metadata only + tenant isolation", () => {
  it("A=7, B=2 pending, never 9; no business payloads in response", async () => {
    const founder = await platformAdminActor();
    const tenantA = await createTenant(app, {
      email: "sync-a@tenant.test",
      orgSlug: "org-sync-a",
    });
    const tenantB = await createTenant(app, {
      email: "sync-b@tenant.test",
      orgSlug: "org-sync-b",
    });

    // business rows that must NEVER appear in founder responses
    const repoA = scopedRepo(db, tenantA.orgId);
    await repoA.products.upsert({
      client_uuid: randomUUID(),
      name: "CERVEZA SECRETA A",
    });
    const ticketA = randomUUID();
    await repoA.tickets.upsert({
      client_uuid: ticketA,
      shift_id: null,
      ticket_no: 1,
      total: 999999,
    });
    await repoA.payments.upsert({
      client_uuid: randomUUID(),
      ticket_id: ticketA,
      method: "cash",
      amount: 999999,
      tendered: 1000000,
      vuelto: 1,
      status: "confirmed",
    });

    for (let i = 0; i < 7; i++) {
      await repoA.syncLog.enqueue({
        client_uuid: randomUUID(),
        client_ts: Date.now() + i,
        entity: "product",
        op: "upsert",
        payload: { name: `A${i}`, active: true },
      });
    }
    const repoB = scopedRepo(db, tenantB.orgId);
    for (let i = 0; i < 2; i++) {
      await repoB.syncLog.enqueue({
        client_uuid: randomUUID(),
        client_ts: Date.now() + i,
        entity: "product",
        op: "upsert",
        payload: { name: `B${i}`, active: true },
      });
    }

    const res = await app.inject({
      method: "GET",
      url: "/api/founder/sync-status",
      headers: authHeaders(founder),
    });
    expect(res.statusCode).toBe(200);
    const { tenants } = res.json() as {
      tenants: Array<{
        tenant_id: string;
        name: string;
        slug: string;
        users: number;
        pending: number;
        last_sync: Date | null;
        errors: number;
        last_error: string | null;
      }>;
    };

    const rowA = tenants.find((t) => t.tenant_id === tenantA.orgId)!;
    const rowB = tenants.find((t) => t.tenant_id === tenantB.orgId)!;
    expect(rowA.pending).toBe(7);
    expect(rowA.slug).toBe("org-sync-a");
    expect(rowB.slug).toBe("org-sync-b");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(res.json())).toEqual(["tenants"]);
    expect(rowB.pending).toBe(2);
    // no single row may surface the merged total (spec: never 9 on one row)
    expect(tenants.every((t) => t.pending !== 9)).toBe(true);
    expect(rowA.users).toBeGreaterThanOrEqual(1);
    expect(rowA.last_sync).toBeNull();

    // metadata only — no business-row content anywhere in the payload
    const raw = res.body;
    expect(raw).not.toContain("CERVEZA SECRETA A");
    expect(raw).not.toContain("999999");
    expect(raw).not.toContain("A0"); // payload names from sync_log must not leak
    for (const t of tenants) {
      expect(Object.keys(t).sort()).toEqual(
        ["errors", "last_error", "last_sync", "name", "slug", "pending", "tenant_id", "users"].sort(),
      );
    }
  });

  it("last_sync reflects a synced mutation", async () => {
    const founder = await platformAdminActor();
    const tenant = await createTenant(app, {
      email: "synced@tenant.test",
      orgSlug: "org-synced",
    });
    const repo = scopedRepo(db, tenant.orgId);
    const id = randomUUID();
    await repo.syncLog.enqueue({
      client_uuid: id,
      client_ts: Date.now(),
      entity: "product",
        op: "upsert",
        payload: { name: "x", active: true },
    });
    await pool.query(
      `UPDATE sync_log SET status = 'synced', updated_at = now() WHERE tenant_id = $1 AND client_uuid = $2`,
      [tenant.orgId, id],
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/founder/sync-status",
      headers: authHeaders(founder),
    });
    const row = (res.json().tenants as Array<{ tenant_id: string; last_sync: string | null; pending: number }>).find(
      (t) => t.tenant_id === tenant.orgId,
    )!;
    expect(row.pending).toBe(0);
    expect(row.last_sync).toBeTruthy();
  });
});

async function countOrgs(): Promise<number> {
  const res = await pool.query(`SELECT count(*)::int AS n FROM organization`);
  return Number(res.rows[0].n);
}
