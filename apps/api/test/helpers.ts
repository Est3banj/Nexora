import { Client } from "pg";
import { TEST_DATABASE_URL } from "./setup-global";
import { buildApp } from "../src/app";
import { ensureAuthTables } from "../src/db/bootstrap";
import type { FastifyInstance } from "fastify";

export async function buildTestApp(): Promise<FastifyInstance> {
  await ensureAuthTables();
  return buildApp({ logger: false });
}

/** Truncate every table (business + auth) — test files start clean. */
export async function resetTables(): Promise<void> {
  const client = new Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  for (const { tablename } of rows) {
    await client.query(`TRUNCATE TABLE public."${tablename}" CASCADE`);
  }
  await client.end();
}

function cookieHeader(res: {
  cookies: Array<{ name: string; value: string }>;
}): string {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export type Actor = {
  email: string;
  password: string;
  userId: string;
  orgId: string;
  cookie: string;
};

/**
 * Signs up a user, creates their tenant organization and sets it active —
 * all over real HTTP (app.inject on the better-auth routes), so the session
 * cookie we get back is exactly what a browser would hold.
 */
export async function createTenant(
  app: FastifyInstance,
  opts: { email: string; password?: string; orgSlug: string; orgName?: string },
): Promise<Actor> {
  const password = opts.password ?? "password1234";

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email: opts.email, password, name: opts.email.split("@")[0] },
  });
  if (signUp.statusCode !== 200) {
    throw new Error(`sign-up failed: ${signUp.statusCode} ${signUp.body}`);
  }
  const cookie = cookieHeader(signUp);
  const userId = signUp.json().data?.user?.id ?? signUp.json().user?.id;

  const orgRes = await app.inject({
    method: "POST",
    url: "/api/auth/organization/create",
    headers: { cookie },
    payload: { name: opts.orgName ?? opts.orgSlug, slug: opts.orgSlug },
  });
  if (orgRes.statusCode !== 200) {
    throw new Error(`org create failed: ${orgRes.statusCode} ${orgRes.body}`);
  }
  const org = orgRes.json().data ?? orgRes.json();

  const activeRes = await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie },
    payload: { organizationId: org.id },
  });
  if (activeRes.statusCode !== 200) {
    throw new Error(`set-active failed: ${activeRes.statusCode} ${activeRes.body}`);
  }

  return { email: opts.email, password, userId, orgId: org.id, cookie };
}

/** Fresh sign-in of an existing user (stale-active-org scenarios). */
export async function signIn(
  app: FastifyInstance,
  actor: Pick<Actor, "email" | "password">,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email: actor.email, password: actor.password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`);
  }
  return cookieHeader(res);
}

export function authHeaders(actor: { cookie: string }) {
  return { cookie: actor.cookie };
}
