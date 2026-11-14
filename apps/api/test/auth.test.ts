import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getAuth } from "../src/auth/auth";
import { authHeaders, buildTestApp, createTenant, resetTables, signIn, type Actor } from "./helpers";
import { closeDb } from "../src/db";

/**
 * D1-3 · Better-auth org wiring + session ctx
 * AC (tenancy-auth spec):
 *  - §Authentication: sign-in ok, wrong password rejected,
 *    unauthenticated business request → auth error
 *  - §Tenant resolution: session-derived
 *  - §Org membership: role owner|member, no-membership → no tenant
 */

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
  owner = await createTenant(app, { email: "owner@tenant.test", orgSlug: "org-owner" });
});

describe("authentication", () => {
  it("successful sign-in creates a session that unlocks business endpoints", async () => {
    const cookie = await signIn(app, owner);
    // Design §4 stale-active-org guard: a fresh sign-in starts WITHOUT an
    // active organization — the client must call set-active (the web login
    // flow does this). Until then business data is refused.
    const beforeActive = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: { cookie },
    });
    expect(beforeActive.statusCode).toBe(403);

    const setActive = await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie },
      payload: { organizationId: owner.orgId },
    });
    expect(setActive.statusCode).toBe(200);

    const res = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("wrong password is rejected and no session is created", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: owner.email, password: "totally-wrong-1" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.cookies.find((c) => c.name.includes("session"))).toBeUndefined();
  });

  it("unauthenticated business request → auth error, no data", async () => {
    for (const url of [
      "/api/catalog/products",
      "/api/catalog/sale-items",
      "/api/sales/tickets",
    ]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain("Cerveza");
    }
    const post = await app.inject({
      method: "POST",
      url: "/api/catalog/products",
      payload: { name: "x", variant: { name: "y", price: 1 } },
    });
    expect(post.statusCode).toBe(401);
  });
});

describe("tenant resolution from session", () => {
  it("tenant is derived from the session (create lands in active org)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: authHeaders(owner),
      payload: { name: "Agua", variant: { name: "600ml", price: 2000 } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().product.tenant_id).toBe(owner.orgId);
    expect(res.json().variant.tenant_id).toBe(owner.orgId);
  });
});

describe("organization membership and roles", () => {
  it("creator membership is owner", async () => {
    const role = await getAuth().api.getActiveMemberRole({
      headers: new Headers({ cookie: owner.cookie }),
    });
    expect(role.role).toBe("owner");
  });

  // roles-admin 1.3 · H1 bug regression: plugin.ts used to map org `admin` →
  // null, so `tenantId && role` dropped the tenant → admin members got
  // 403 no_active_tenant on EVERY business route (total lockout).
  it("admin member resolves role admin WITH tenantId (bug regression)", async () => {
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "admin@tenant.test", password: "password1234", name: "Admin" },
    });
    expect(signUp.statusCode).toBe(200);
    const userId = signUp.json().data?.user?.id ?? signUp.json().user?.id;
    const add = await getAuth().api.addMember({
      body: { organizationId: owner.orgId, userId, role: "admin" },
      headers: new Headers({ cookie: owner.cookie }),
    });
    expect(add).toBeTruthy();

    const cookie = await signIn(app, { email: "admin@tenant.test", password: "password1234" });
    const setActive = await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie },
      payload: { organizationId: owner.orgId },
    });
    expect(setActive.statusCode).toBe(200);

    // better-auth surfaces the raw org role as-is (admin is a first-class
    // better-auth 1.7.19 org role — crud-members.d.mts:420).
    const role = await getAuth().api.getActiveMemberRole({ headers: new Headers({ cookie }) });
    expect(role.role).toBe("admin");

    // Session ctx keeps role + tenantId → business routes open (was 403).
    const res = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    // tenantId concretely: the admin's write lands in THEIR org.
    const post = await app.inject({
      method: "POST",
      url: "/api/catalog/products",
      headers: { cookie },
      payload: { name: "Gaseosa", variant: { name: "400ml", price: 3500 } },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().product.tenant_id).toBe(owner.orgId);
  });

  it("user with no membership has no tenant → business data refused", async () => {
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email: "lonely@tenant.test", password: "password1234", name: "Lonely" },
    });
    expect(signUp.statusCode).toBe(200);
    const cookie = signUp.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const res = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "no_active_tenant" });
  });
});
