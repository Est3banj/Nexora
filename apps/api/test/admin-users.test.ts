import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { closeDb, db } from "../src/db";
import { authHeaders, buildTestApp, createTenant, joinOrg, resetTables, signIn, signInUsername, type Actor } from "./helpers";

let app: FastifyInstance;
let owner: Actor, admin: Actor, cashier: Actor;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "manager@test.dev", orgSlug: "admin-users" });
  admin = await joinOrg(app, owner, "admin", "admin@test.dev");
  cashier = await joinOrg(app, owner, "member", "cashier@test.dev");
});
const list = (actor = owner) => app.inject({ method: "GET", url: "/api/admin/members", headers: authHeaders(actor) });
const create = (payload: Record<string, unknown> = {}, actor = owner) => app.inject({ method: "POST", url: "/api/admin/users", headers: authHeaders(actor), payload: {
  name: "Ana Pérez", username: "ana.perez", password: "test-only-password-123", role: "member", ...payload,
} });
const patch = (id: string, role: string, actor = owner) => app.inject({ method: "PATCH", url: `/api/admin/members/${id}`, headers: authHeaders(actor), payload: { role } });
const remove = (id: string, actor = owner) => app.inject({ method: "DELETE", url: `/api/admin/members/${id}`, headers: authHeaders(actor) });
async function memberId(userId: string) {
  return (await list()).json().members.find((m: { userId: string }) => m.userId === userId).id as string;
}

describe("tenant-scoped employee BFF", () => {
  it("member cannot list/create/change/remove; no side effects", async () => {
    const id = await memberId(admin.userId);
    const before = (await db.execute(sql`SELECT id, role FROM member ORDER BY id`)).rows;
    for (const res of [await list(cashier), await create({}, cashier), await patch(id, "member", cashier), await remove(id, cashier)]) {
      expect(res.statusCode).toBe(403); expect(res.json()).toEqual({ error: "forbidden", detail: "dueño_only" });
    }
    expect((await db.execute(sql`SELECT id, role FROM member ORDER BY id`)).rows).toEqual(before);
    expect((await db.execute(sql`SELECT id FROM "user" WHERE username='ana.perez'`)).rows).toHaveLength(0);
  });

  it("creates a cashier → real USERNAME login → correct tenant + role, without switching the manager session", async () => {
    const res = await create(); expect(res.statusCode).toBe(201);
    const body = res.json();
    // Members are identified by username; the email column holds the
    // synthetic internal address better-auth still requires (no mail is sent).
    expect(body.user.username).toBe("ana.perez");
    expect(body.user.email).toBe("ana.perez@nexora.local");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(Object.keys(body.user).sort()).toEqual(["email", "id", "name", "username"]);
    expect(body).not.toHaveProperty("token");
    expect(body).not.toHaveProperty("generated_password");
    const cookie = await signInUsername(app, { username: "ana.perez", password: "test-only-password-123" });
    const active = await app.inject({ method: "POST", url: "/api/auth/organization/set-active", headers: { cookie }, payload: { organizationId: owner.orgId } });
    expect(active.statusCode).toBe(200);
    const role = await app.inject({ method: "GET", url: "/api/auth/organization/get-active-member-role", headers: { cookie } });
    expect(role.json()).toEqual({ role: "member" });
    expect((await app.inject({ method: "GET", url: "/api/catalog/products", headers: { cookie } })).statusCode).toBe(200);
    // The synthetic address is an internal alias of the SAME credential: it is
    // never displayed, never mailed and never used by the UI. Members sign in
    // through /sign-in/username (asserted above); the alias exists only
    // because better-auth's base user schema requires a unique email.
    // The owner keeps the email path, untouched.
    expect((await signIn(app, owner)).length).toBeGreaterThan(0);
    const session = await app.inject({ method: "GET", url: "/api/auth/get-session", headers: authHeaders(owner) });
    expect(session.json().user.id).toBe(owner.userId);
    expect((await list()).json().members.some((m: { userId: string }) => m.userId === body.user.id)).toBe(true);
    const listing = (await list()).json();
    expect(Object.keys(listing)).toEqual(["members"]);
    for (const m of listing.members) {
      expect(Object.keys(m).sort()).toEqual(["createdAt", "id", "role", "user", "userId"]);
      expect(Object.keys(m.user).sort()).toEqual(["email", "id", "name", "username"]);
      if (m.userId === owner.userId) {
        // Owner row: no username, real email — untouched by the change.
        expect(m.user.username).toBeNull();
        expect(m.user.email).toBe(owner.email);
      }
    }
    const createdRow = listing.members.find((m: { userId: string }) => m.userId === body.user.id);
    expect(createdRow.user.username).toBe("ana.perez");
    expect(createdRow.user.email).toBe("ana.perez@nexora.local");
    // P2-3 · member listing carries name/e-mail/username → never cacheable.
    expect((await list()).headers["cache-control"]).toBe("no-store");
    const audit = (await db.execute(sql`SELECT action,meta FROM audit_log WHERE action='member.create'`)).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/password|code|hash/i);
    expect(JSON.stringify(audit)).not.toContain("test-only-password-123");
    expect(JSON.stringify(listing)).not.toContain("test-only-password-123");
  });

  it("admin can create a cashier; only owner can promote/demote; access changes on the next request", async () => {
    const res = await create({}, admin);
    expect(res.statusCode).toBe(201); expect(res.json()).not.toHaveProperty("generated_password");
    const id = res.json().member.id;
    const cookie = await signInUsername(app, { username: "ana.perez", password: "test-only-password-123" });
    await app.inject({ method: "POST", url: "/api/auth/organization/set-active", headers: { cookie }, payload: { organizationId: owner.orgId } });
    const financial = () => app.inject({ method: "GET", url: "/api/admin/members", headers: { cookie } });
    expect((await financial()).statusCode).toBe(403);
    expect((await patch(id, "admin", admin)).statusCode).toBe(403);
    expect((await patch(id, "admin", owner)).statusCode).toBe(200);
    expect((await financial()).statusCode).toBe(200);
    expect((await patch(id, "member", admin)).statusCode).toBe(403);
    expect((await remove(id, admin)).statusCode).toBe(403);
    expect((await patch(id, "member", owner)).statusCode).toBe(200);
    expect((await financial()).statusCode).toBe(403);
    expect((await remove(id, admin)).json()).toEqual({ ok: true });
    const revoked = await app.inject({ method: "GET", url: "/api/catalog/products", headers: { cookie } });
    expect(revoked.statusCode).toBe(403); expect(revoked.json()).toEqual({ error: "no_active_tenant" });
    // P0-1 · setup mints tenants through the founder plane, which audits
    // `tenant.create` (spec §Creation is audited). Every assertion here is
    // about the operation under test → setup rows are excluded.
    const audit = (await db.execute(sql`SELECT action,meta FROM audit_log WHERE action <> 'tenant.create' ORDER BY created_at`)).rows;
    expect(audit.map(a => a.action)).toEqual(["member.create", "member.role_change", "member.role_change", "member.remove"]);
    expect(JSON.stringify(audit)).not.toMatch(/password|hash|code|test-only-password/i);
  });

  it("admin cannot create administrators or manage self/other admins, without signup or audit side effects", async () => {
    expect((await create({ role: "admin" }, admin)).statusCode).toBe(403);
    expect((await db.execute(sql`SELECT id FROM "user" WHERE username='ana.perez'`)).rows).toHaveLength(0);
    const id = await memberId(admin.userId);
    expect((await patch(id, "member", admin)).statusCode).toBe(403);
    expect((await remove(id, admin)).statusCode).toBe(403);
    expect((await db.execute(sql`SELECT id FROM audit_log WHERE action <> 'tenant.create'`)).rows).toHaveLength(0);
  });

  it("owner rows are read-only for BOTH owner and admin", async () => {
    const id = await memberId(owner.userId);
    // Also add a second owner: SDK's last-owner guard alone is insufficient.
    await db.execute(sql`UPDATE member SET role='owner' WHERE "userId"=${cashier.userId}`);
    for (const actor of [owner, admin]) {
      expect((await patch(id, "member", actor)).json()).toEqual({ error: "owner_readonly" });
      expect((await remove(id, actor)).statusCode).toBe(403);
    }
    expect((await db.execute(sql`SELECT role FROM member WHERE id=${id}`)).rows[0].role).toBe("owner");
  });

  it("foreign member IDs cannot be modified or removed by a different tenant owner/admin; no write or audit", async () => {
    const foreign = await createTenant(app, { email: "foreign@test.dev", orgSlug: "foreign" });
    const employee = await joinOrg(app, foreign, "member", "foreign-employee@test.dev");
    const target = (await list(foreign)).json().members.find((m: { userId: string }) => m.userId === employee.userId);
    const before = (await db.execute(sql`SELECT * FROM member WHERE id=${target.id}`)).rows;
    for (const actor of [owner, admin]) {
      expect((await patch(target.id, "admin", actor)).statusCode).toBe(404);
      expect((await remove(target.id, actor)).statusCode).toBe(404);
    }
    expect((await db.execute(sql`SELECT * FROM member WHERE id=${target.id}`)).rows).toEqual(before);
    expect((await db.execute(sql`SELECT id FROM audit_log WHERE action <> 'tenant.create'`)).rows).toHaveLength(0);
  });

  it("duplicate username is 409; invalid role/body/username/password is 400, not an escalation", async () => {
    expect((await create()).statusCode).toBe(201);
    const dup = await create();
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: "username_taken" });
    expect((await create({ role: "owner" })).statusCode).toBe(400);
    expect((await create({ role: "Supervisor" })).statusCode).toBe(400);
    expect((await create({ password: "short" })).statusCode).toBe(400);
    expect((await create({ username: "AB" })).statusCode).toBe(400);
    expect((await create({ username: "ana@x" })).statusCode).toBe(400);
    expect((await create({ username: "ana perez" })).statusCode).toBe(400);
    expect((await create({ username: "Ana.Perez" })).statusCode).toBe(400);
    expect((await create({ email: owner.email })).statusCode).toBe(400);
    expect((await create({ organizationId: "foreign" })).statusCode).toBe(400);
    expect((await patch(await memberId(cashier.userId), "owner")).statusCode).toBe(400);
  });

  it("membership failure is honest and compensates the new account (real SDK membership-limit failure)", async () => {
    await db.execute(sql`INSERT INTO member (id,"userId","organizationId",role,"createdAt")
      SELECT gen_random_uuid()::text, ${cashier.userId}, ${owner.orgId}, 'member', now() FROM generate_series(1,98)`);
    const res = await create();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "membership_create_failed", account_created: false });
    expect((await db.execute(sql`SELECT id FROM "user" WHERE username='ana.perez'`)).rows).toHaveLength(0);
    expect((await db.execute(sql`SELECT id FROM audit_log WHERE action <> 'tenant.create'`)).rows).toHaveLength(0);
  });
});

it("raw SDK role/remove/invitation writers cannot bypass app policy, including owner assignment", async () => {
  const id = await memberId(cashier.userId);
  const before = (await db.execute(sql`SELECT id,role FROM member ORDER BY id`)).rows;
  for (const actor of [owner, admin, cashier]) {
    for (const endpoint of ["update-member-role", "remove-member", "invite-member", "accept-invitation", "reject-invitation", "cancel-invitation", "leave"]) {
      const res = await app.inject({ method: "POST", url: `/api/auth/organization/${endpoint}`, headers: authHeaders(actor), payload: {
        organizationId: owner.orgId, memberId: id, memberIdOrEmail: id, role: "owner", email: cashier.email, invitationId: randomInvitation,
      } });
      expect(res.statusCode, `${actor.email}:${endpoint}`).toBe(403);
      expect(res.json()).toEqual({ error: "use_admin_users_api" });
    }
  }
  expect((await db.execute(sql`SELECT id,role FROM member ORDER BY id`)).rows).toEqual(before);
  expect((await db.execute(sql`SELECT id FROM invitation`)).rows).toHaveLength(0);
});
const randomInvitation = "00000000-0000-4000-8000-000000000001";

it("blocks raw unauthenticated add-member including query/case/trailing/encoded path variants", async () => {
  const before = (await db.execute(sql`SELECT count(*)::int AS n FROM member`)).rows;
  for (const path of ["organization/add-member", "organization/add-member/", "organization/add-member?organizationId=ignored", "ORGANIZATION/ADD-MEMBER", "organization/%61dd-member", "organization%2fadd-member", "organization//add-member"]) {
    const res = await app.inject({ method: "POST", url: `/api/auth/${path}`, payload: { userId: cashier.userId, organizationId: owner.orgId, role: "owner" } });
    expect(res.statusCode, path).toBe(403); expect(res.json()).toEqual({ error: "use_admin_users_api" });
  }
  expect((await db.execute(sql`SELECT count(*)::int AS n FROM member`)).rows).toEqual(before);
  expect((await list()).statusCode).toBe(200); // legitimate auth/session endpoints still work
});

/**
 * A2 · restablecer la contraseña de un empleado (perdió el acceso).
 * Route: POST /api/admin/members/:memberId/password
 */
describe("A2 · employee password reset", () => {
  const reset = (id: string, newPassword: string, actor = owner) =>
    app.inject({ method: "POST", url: `/api/admin/members/${id}/password`, headers: authHeaders(actor), payload: { newPassword } });
  const attempt = (username: string, password: string) =>
    app.inject({ method: "POST", url: "/api/auth/sign-in/username", payload: { username, password } });
  const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) =>
    res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  it("happy path: NEW password signs in, OLD password and OLD session die, audit carries ids only", async () => {
    const created = await create();
    expect(created.statusCode).toBe(201);
    const { user, member } = created.json() as { user: { id: string }; member: { id: string } };

    const before = await attempt("ana.perez", "test-only-password-123");
    expect(before.statusCode).toBe(200);
    const oldCookie = cookieOf(before);
    // A fresh member has no active org yet — claim it, exactly like the web login does.
    expect((await app.inject({
      method: "POST", url: "/api/auth/organization/set-active", headers: { cookie: oldCookie },
      payload: { organizationId: owner.orgId },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/catalog/products", headers: { cookie: oldCookie } })).statusCode).toBe(200);

    const res = await reset(member.id, "nueva-clave-del-cajero-1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers["cache-control"]).toBe("no-store");

    // The credential really changed…
    expect((await attempt("ana.perez", "test-only-password-123")).statusCode).toBe(401);
    expect((await attempt("ana.perez", "nueva-clave-del-cajero-1")).statusCode).toBe(200);
    // …and every session opened with the old credential was revoked.
    expect((await app.inject({ method: "GET", url: "/api/catalog/products", headers: { cookie: oldCookie } })).statusCode).toBe(401);

    const audit = (await db.execute(sql`SELECT action, meta FROM audit_log WHERE action='member.password_reset'`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].meta).toMatchObject({ member_id: member.id, user_id: user.id });
    expect(JSON.stringify(audit)).not.toContain("nueva-clave-del-cajero-1");
    expect(JSON.stringify(audit)).not.toContain("test-only-password-123");
  });

  it("a member (cashier tier) is forbidden: 403 dueño_only, password untouched, no audit", async () => {
    const created = await create();
    const { member } = created.json() as { member: { id: string } };
    const res = await reset(member.id, "password-robada-12345", cashier);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden", detail: "dueño_only" });
    expect((await attempt("ana.perez", "test-only-password-123")).statusCode).toBe(200);
    expect((await attempt("ana.perez", "password-robada-12345")).statusCode).toBe(401);
    // `create()` wrote member.create; the RESET must not have written anything.
    expect((await db.execute(sql`SELECT id FROM audit_log WHERE action='member.password_reset'`)).rows).toHaveLength(0);
  });

  it("a foreign memberId is 404 (tenant scope), never a write and never a leak", async () => {
    const foreign = await createTenant(app, { email: "foreign-reset@test.dev", orgSlug: "foreign-reset" });
    const employee = await joinOrg(app, foreign, "member", "foreign-employee-reset@test.dev");
    const target = (await list(foreign)).json().members.find((m: { userId: string }) => m.userId === employee.userId);
    const before = (await db.execute(sql`SELECT * FROM member WHERE id=${target.id}`)).rows;
    for (const actor of [owner, admin]) {
      expect((await reset(target.id, "clave-ajena-12345", actor)).statusCode).toBe(404);
    }
    expect((await signIn(app, employee)).length).toBeGreaterThan(0);
    expect((await db.execute(sql`SELECT * FROM member WHERE id=${target.id}`)).rows).toEqual(before);
    expect((await db.execute(sql`SELECT id FROM audit_log WHERE action <> 'tenant.create'`)).rows).toHaveLength(0);
  });

  it("cannot_reset_self: an actor never resets their own password through this route", async () => {
    expect((await reset(await memberId(owner.userId), "clave-propia-12345")).json())
      .toEqual({ error: "cannot_reset_self" });
    expect((await reset(await memberId(admin.userId), "clave-propia-12345", admin)).json())
      .toEqual({ error: "cannot_reset_self" });
    expect((await signIn(app, owner)).length).toBeGreaterThan(0);
    expect((await signIn(app, admin)).length).toBeGreaterThan(0);
  });

  it("owner_readonly: an admin cannot take over the owner account by resetting it", async () => {
    const res = await reset(await memberId(owner.userId), "clave-de-ataque-123", admin);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "owner_readonly" });
    expect((await signIn(app, owner)).length).toBeGreaterThan(0);
    expect((await db.execute(sql`SELECT id FROM audit_log WHERE action <> 'tenant.create'`)).rows).toHaveLength(0);
  });

  it("password below the shared floor is 400 validation_error and nothing changes", async () => {
    const created = await create();
    const { member } = created.json() as { member: { id: string } };
    const res = await reset(member.id, "corta");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
    expect(res.json().issues[0]).toEqual({ path: "newPassword", message: "La contraseña debe tener al menos 12 caracteres." });
    expect((await attempt("ana.perez", "test-only-password-123")).statusCode).toBe(200);
    expect((await db.execute(sql`SELECT id FROM audit_log WHERE action='member.password_reset'`)).rows).toHaveLength(0);
  });

  it("the body is strict: an unknown key is 400, not silently stripped", async () => {
    const created = await create();
    const { member } = created.json() as { member: { id: string } };
    const res = await app.inject({
      method: "POST", url: `/api/admin/members/${member.id}/password`, headers: authHeaders(owner),
      payload: { newPassword: "clave-valida-12345", actor: owner.userId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation_error");
    expect((await attempt("ana.perez", "test-only-password-123")).statusCode).toBe(200);
  });
});
