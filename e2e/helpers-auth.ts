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
