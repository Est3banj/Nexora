import { expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { dbOne } from "./helpers-db";

/** Real sessions/memberships only. SQL values are generated IDs or quoted email. */
export async function createOrgUser(request: APIRequestContext, org: string, role: "member" | "admin", tag: string) {
  const email = `${tag}-${randomUUID()}@test.dev`, password = "roles-test-only-123";
  const signup = await request.post("/api/auth/sign-up/email", { data: { name: `Personal ${tag}`, email, password } });
  expect(signup.ok()).toBe(true);
  const userId = (await signup.json()).user.id as string;
  if (!/^[a-f0-9-]{36}$/.test(org) || !/^[a-f0-9-]{36}$/.test(userId)) throw new Error("Invalid fixture UUID");
  dbOne(`INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES('${randomUUID()}','${org}','${userId}','${role}',now())`);
  expect((await request.post("/api/auth/organization/set-active", { data: { organizationId: org } })).ok()).toBe(true);
  return { email, password, userId };
}
export function makePlatformAdmin(email: string) {
  dbOne(`UPDATE "user" SET "platformAdmin"=true WHERE email='${email.replaceAll("'", "''")}'`);
}

/**
 * P0-1 · tenant creation through the FOUNDER plane (the sanctioned path).
 *
 * `POST /api/auth/organization/create` is closed for everybody (app.ts
 * membershipWriters): only a platform admin may mint a tenant, through
 * `POST /api/founder/tenants` — exactly what Consola's «Crear tienda» and
 * the `tenant-create` CLI call. This helper reproduces the old
 * sign-up + organization/create + set-active sequence:
 *
 *   1. a disposable platform-admin account (flag seeded with SQL, the same
 *      way founder-api.test.ts does it) signs in on the shared cookie jar;
 *   2. the founder route creates the tenant AND its first user
 *      (`opts.email` / `opts.password`);
 *   3. the jar is switched to that owner and the org is activated, so every
 *      later `page.request` in the spec runs as the tenant owner.
 *
 * Returns the organization id.
 */
export async function createTenantViaFounder(
  request: APIRequestContext,
  opts: { name: string; slug: string; email: string; password: string },
): Promise<string> {
  const tag = randomUUID();
  const adminEmail = `pa-${tag}@test.dev`;
  const adminPassword = "roles-test-only-123";
  expect(
    (await request.post("/api/auth/sign-up/email", {
      data: { name: `Plataforma ${tag}`, email: adminEmail, password: adminPassword },
    })).ok(),
  ).toBe(true);
  makePlatformAdmin(adminEmail);

  const created = await request.post("/api/founder/tenants", { data: opts });
  const createdBody = await created.text();
  expect(created.ok(), `founder create failed: ${created.status()} ${createdBody}`).toBe(true);
  const org = (JSON.parse(createdBody) as { tenant: { id: string } }).tenant.id;

  expect(
    (await request.post("/api/auth/sign-in/email", {
      data: { email: opts.email, password: opts.password },
    })).ok(),
  ).toBe(true);
  expect(
    (await request.post("/api/auth/organization/set-active", {
      data: { organizationId: org },
    })).ok(),
  ).toBe(true);
  return org;
}
