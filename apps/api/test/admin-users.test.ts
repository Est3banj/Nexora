import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { closeDb, db } from "../src/db";
import { authHeaders, buildTestApp, createTenant, joinOrg, resetTables, signIn, type Actor } from "./helpers";

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
  name: "Ana Pérez", email: "ana@test.dev", role: "member", ...payload,
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
    expect((await db.execute(sql`SELECT id FROM "user" WHERE email='ana@test.dev'`)).rows).toHaveLength(0);
  });

  it("creates a cashier → real login → correct tenant + role, without switching the manager session", async () => {
    const res = await create(); expect(res.statusCode).toBe(201);
    const body = res.json(); expect(body.generated_password.length).toBeGreaterThanOrEqual(12);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(Object.keys(body.user).sort()).toEqual(["email", "id", "name"]);
    expect(body).not.toHaveProperty("token");
    const cookie = await signIn(app, { email: "ana@test.dev", password: body.generated_password });
    const active = await app.inject({ method: "POST", url: "/api/auth/organization/set-active", headers: { cookie }, payload: { organizationId: owner.orgId } });
    expect(active.statusCode).toBe(200);
    const role = await app.inject({ method: "GET", url: "/api/auth/organization/get-active-member-role", headers: { cookie } });
    expect(role.json()).toEqual({ role: "member" });
    expect((await app.inject({ method: "GET", url: "/api/catalog/products", headers: { cookie } })).statusCode).toBe(200);
    const session = await app.inject({ method: "GET", url: "/api/auth/get-session", headers: authHeaders(owner) });
    expect(session.json().user.id).toBe(owner.userId);
    expect((await list()).json().members.some((m: { userId: string }) => m.userId === body.user.id)).toBe(true);
    const listing = (await list()).json();
    expect(Object.keys(listing)).toEqual(["members"]);
    for (const m of listing.members) {
      expect(Object.keys(m).sort()).toEqual(["createdAt", "id", "role", "user", "userId"]);
      expect(Object.keys(m.user).sort()).toEqual(["email", "id", "name"]);
    }
    const audit = (await db.execute(sql`SELECT action,meta FROM audit_log WHERE action='member.create'`)).rows;
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/password|code|hash/i);
    expect(JSON.stringify(audit)).not.toContain(body.generated_password);
    expect(JSON.stringify(listing)).not.toContain(body.generated_password);
  });

  it("admin can create a cashier; only owner can promote/demote; access changes on the next request", async () => {
    const res = await create({ password: "test-only-password-123" }, admin);
    expect(res.statusCode).toBe(201); expect(res.json()).not.toHaveProperty("generated_password");
    const id = res.json().member.id;
    const cookie = await signIn(app, { email: "ana@test.dev", password: "test-only-password-123" });
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
    const audit = (await db.execute(sql`SELECT action,meta FROM audit_log ORDER BY created_at`)).rows;
    expect(audit.map(a => a.action)).toEqual(["member.create", "member.role_change", "member.role_change", "member.remove"]);
    expect(JSON.stringify(audit)).not.toMatch(/password|hash|code|test-only-password/i);
  });

  it("admin cannot create administrators or manage self/other admins, without signup or audit side effects", async () => {
    expect((await create({ role: "admin" }, admin)).statusCode).toBe(403);
    expect((await db.execute(sql`SELECT id FROM "user" WHERE email='ana@test.dev'`)).rows).toHaveLength(0);
    const id = await memberId(admin.userId);
    expect((await patch(id, "member", admin)).statusCode).toBe(403);
    expect((await remove(id, admin)).statusCode).toBe(403);
    expect((await db.execute(sql`SELECT id FROM audit_log`)).rows).toHaveLength(0);
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
    expect((await db.execute(sql`SELECT id FROM audit_log`)).rows).toHaveLength(0);
  });

  it("email_taken is 409; invalid owner role/body/password is 400, not an escalation", async () => {
    expect((await create({ email: owner.email })).statusCode).toBe(409);
    expect((await create({ email: owner.email })).json()).toEqual({ error: "email_taken" });
    expect((await create({ role: "owner" })).statusCode).toBe(400);
    expect((await create({ role: "Supervisor" })).statusCode).toBe(400);
    expect((await create({ password: "short" })).statusCode).toBe(400);
    expect((await create({ organizationId: "foreign" })).statusCode).toBe(400);
    expect((await patch(await memberId(cashier.userId), "owner")).statusCode).toBe(400);
  });

  it("membership failure is honest and compensates the new account (real SDK membership-limit failure)", async () => {
    await db.execute(sql`INSERT INTO member (id,"userId","organizationId",role,"createdAt")
      SELECT gen_random_uuid()::text, ${cashier.userId}, ${owner.orgId}, 'member', now() FROM generate_series(1,98)`);
    const res = await create();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "membership_create_failed", account_created: false });
    expect((await db.execute(sql`SELECT id FROM "user" WHERE email='ana@test.dev'`)).rows).toHaveLength(0);
    expect((await db.execute(sql`SELECT id FROM audit_log`)).rows).toHaveLength(0);
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
