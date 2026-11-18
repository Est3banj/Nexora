import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { authOptions, getAuth } from "../src/auth/auth";
import { authLogger, scrubPII } from "../src/auth/logger";
import { setUserPassword } from "../src/auth/password";
import { authHeaders, buildTestApp, createTenant, resetTables, signIn, signInUsername, type Actor } from "./helpers";
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

/**
 * Username identity for members (better-auth 1.7.19 `username` plugin).
 * Owners/superadmins are untouched: they keep signing in with email.
 */
describe("username sign-in", () => {
  async function signUpWithUsername(username: string, email: string, password = "password1234") {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: username, email, password, username },
    });
    expect(res.statusCode).toBe(200);
    return (res.json().data?.user?.id ?? res.json().user?.id) as string;
  }

  it("username + password opens the tenant; email path still works for the owner", async () => {
    const userId = await signUpWithUsername("cajero.rapido", "cajero-rapido@nexora.local");
    await getAuth().api.addMember({
      body: { organizationId: owner.orgId, userId, role: "member" },
      headers: new Headers({ cookie: owner.cookie }),
    });

    const cookie = await signInUsername(app, { username: "cajero.rapido", password: "password1234" });
    const active = await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie },
      payload: { organizationId: owner.orgId },
    });
    expect(active.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/catalog/products", headers: { cookie } })).statusCode).toBe(200);

    // Case-insensitive: the stored value is normalised to lowercase.
    expect((await signInUsername(app, { username: "CAJERO.RAPIDO", password: "password1234" })).length).toBeGreaterThan(0);

    // Owner has no username → only the email path works for them.
    const ownerByEmail = await signIn(app, owner);
    expect(ownerByEmail.length).toBeGreaterThan(0);
    const ownerByUsername = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/username",
      payload: { username: "manager", password: owner.password },
    });
    expect(ownerByUsername.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("bad credentials and malformed usernames return explicit codes, not a generic 500", async () => {
    await signUpWithUsername("ana.breve", "ana-breve@nexora.local");

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/username",
      payload: { username: "ana.breve", password: "not-the-password" },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json().code).toBe("INVALID_USERNAME_OR_PASSWORD");

    const tooShort = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/username",
      payload: { username: "ab", password: "password1234" },
    });
    expect(tooShort.statusCode).toBe(422);
    expect(tooShort.json().code).toBe("USERNAME_TOO_SHORT");

    const badCharset = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/username",
      payload: { username: "ana rapido", password: "password1234" },
    });
    expect(badCharset.statusCode).toBe(422);
    expect(badCharset.json().code).toBe("INVALID_USERNAME");

    const unknownUser = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/username",
      payload: { username: "no.existe", password: "password1234" },
    });
    expect(unknownUser.statusCode).toBe(401);
    expect(unknownUser.json().code).toBe("INVALID_USERNAME_OR_PASSWORD");
    expect(unknownUser.cookies.find((c) => c.name.includes("session"))).toBeUndefined();
  });

  it("sign-up without a username leaves it null (owner accounts are unaffected)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: "Sin usuario", email: "sin-usuario@tenant.test", password: "password1234" },
    });
    expect(res.statusCode).toBe(200);
    const user = res.json().data?.user ?? res.json().user;
    expect(user.username ?? null).toBeNull();
  });
});

/**
 * P2-5 · PASSWORD_MIN is a CREATION floor, never a login gate.
 * Evidence in better-auth 1.7.19: `assertPasswordNotTooShort` is called from
 * `sign-up.mjs:153` and `password.mjs:152` (reset) — `sign-in.mjs:316` only
 * asserts the MAX. Raising the floor must not lock existing accounts out.
 */
describe("P2-5 · password floor applies to creation only", () => {
  it("sign-up below PASSWORD_MIN is rejected before any row exists", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: "Corta", email: "corta@tenant.test", password: "corta12" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("PASSWORD_TOO_SHORT");
    const again = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "corta@tenant.test", password: "corta12" },
    });
    expect(again.statusCode).toBe(401);
  });

  it("sign-in does NOT validate the floor: a sub-floor credential still opens a session", async () => {
    // Written through the reset helper (the same code path the admin reset
    // uses), so this also proves `updatePassword` really rotates an existing
    // credential account.
    await setUserPassword(owner.userId, "corta");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: owner.email, password: "corta" },
    });
    expect(res.statusCode).toBe(200);
  });
});

/**
 * P1-5 · better-auth logs to its own console logger, not to pino, so the only
 * levers are `level` (drops the flagged `sign-up.mjs:194` info line) and the
 * `log` sink (scrubs e-mail tokens from anything that still gets printed).
 */
describe("P1-5 · better-auth logger policy", () => {
  it("level is pinned at warn and the sink scrubs e-mail tokens", () => {
    expect(authLogger.level).toBe("warn");
    expect(authOptions.logger).toBe(authLogger);
    const flagged = "Sign-up attempt for existing email: ana.perez@nexora.local";
    expect(scrubPII(flagged)).toBe("Sign-up attempt for existing email: [email]");
    expect(scrubPII(flagged)).not.toContain("ana.perez");
    // No false positives on ordinary copy.
    expect(scrubPII("Password is too short")).toBe("Password is too short");
  });

  /**
   * Integration proof against better-auth's OWN logger factory: the flagged
   * `sign-up.mjs:194` line is an `info`, so at level `warn` it must never
   * reach the sink; anything that does reach it (warn/error) must come out
   * with the address replaced.
   */
  it("the live better-auth logger drops info and scrubs the e-mail from what still prints", async () => {
    const ctx = await getAuth().$context;
    expect(ctx.logger.level).toBe("warn");
    const printed: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...args: unknown[]) => { printed.push(String(args[0])); };
    console.warn = (...args: unknown[]) => { printed.push(String(args[0])); };
    console.error = (...args: unknown[]) => { printed.push(String(args[0])); };
    try {
      // The real level of sign-up.mjs:194 → suppressed before the sink.
      ctx.logger.info("Sign-up attempt for existing email: ana.perez@nexora.local");
      // Hypothetical level raise → the sink must scrub instead.
      ctx.logger.warn("Sign-up attempt for existing email: ana.perez@nexora.local");
      ctx.logger.error("failure for ana.perez@nexora.local");
    } finally {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    }
    expect(printed).toHaveLength(2);
    const output = printed.join("\n");
    expect(output).toContain("[email]");
    expect(output).not.toContain("ana.perez@nexora.local");
    expect(output).not.toContain("ana.perez");
  });
});
