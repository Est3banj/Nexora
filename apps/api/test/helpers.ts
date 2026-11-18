import { Client } from "pg";
import { TEST_DATABASE_URL } from "./setup-global";
import { buildApp } from "../src/app";
import { ensureAuthTables } from "../src/db/bootstrap";
import type { FastifyInstance } from "fastify";
import { migrateSaleStage } from "../src/db/sale-stage";
import { randomUUID } from "node:crypto";
import { mutationEnvelopeSchema, type MutationEnvelope } from "@pos/shared";
import { getAuth } from "../src/auth/auth";
import { pool } from "../src/db";

// `id: string` (not the randomUUID template literal) so callers can pass an
// EXISTING row id as the replay key (e.g. variant refreshes keyed by
// variant.id) — the envelope schema still validates it as a uuid at parse.
export function creditMutation(entity: string, payload: unknown, id: string = randomUUID(), ts = Date.now()): MutationEnvelope {
  return mutationEnvelopeSchema.parse({ entity, payload, client_uuid: id, client_ts: ts });
}
let creditTicketNo = 1000;
export async function pushMutations(app: FastifyInstance, actor: Actor, mutations: MutationEnvelope[]) {
  const res = await app.inject({ method: "POST", url: "/api/sync/mutations", headers: authHeaders(actor), payload: { mutations } });
  if (res.statusCode !== 200) throw new Error(res.body);
  return res.json().results as Array<{ client_uuid: string; status: string; reason?: string }>;
}
export async function seedCustomer(app: FastifyInstance, actor: Actor, fields: Record<string, unknown> = {}) {
  const mutation = creditMutation("customer", { name: "Doña María", credit_limit: 100000, ...fields });
  const results = await pushMutations(app, actor, [mutation]);
  if (results[0].status !== "applied") throw new Error(JSON.stringify(results));
  return mutation.client_uuid;
}
export async function pushMixedSale(app: FastifyInstance, actor: Actor, opts: {
  customer: string; cash: number; credit: number; shift: string; created_at?: string; variant?: string;
}) {
  const ticket = randomUUID(), variant = opts.variant ?? randomUUID(), total = opts.cash + opts.credit;
  const common = { created_at: opts.created_at ?? new Date().toISOString() };
  const mutations = [
    creditMutation("ticket", { shift_id: opts.shift, customer_id: opts.customer, ticket_no: creditTicketNo++, total, status: "completed", ...common }, ticket),
    creditMutation("ticket_line", { ticket_id: ticket, variant_id: variant, qty: 1, unit_price: total, subtotal: total, unit_cost: 4000, ...common }),
    creditMutation("stockdiary", { variant_id: variant, delta: -1, reason: "sale", ref_ticket_id: ticket, ...common }),
    ...(opts.cash ? [creditMutation("payment", { ticket_id: ticket, shift_id: opts.shift, method: "cash", amount: opts.cash, tendered: opts.cash, vuelto: 0, status: "confirmed", ...common })] : []),
    creditMutation("payment", { ticket_id: ticket, shift_id: opts.shift, method: "credit", amount: opts.credit, tendered: null, vuelto: null, status: "confirmed", ...common }),
  ];
  return { ticket, mutations, results: await pushMutations(app, actor, mutations) };
}
export function pushCreditSale(app: FastifyInstance, actor: Actor, opts: { customer: string; amount: number; shift: string; created_at?: string; variant?: string }) {
  return pushMixedSale(app, actor, { ...opts, cash: 0, credit: opts.amount });
}
export async function pushAbono(app: FastifyInstance, actor: Actor, opts: {
  customer: string; amount: number; method: "cash" | "transfer"; shift: string; ticket?: string | null; created_at?: string;
}) {
  const mutation = creditMutation("credit_abono", { customer_id: opts.customer, amount: opts.amount, method: opts.method,
    shift_id: opts.shift, ticket_id: opts.ticket ?? null, created_at: opts.created_at ?? new Date().toISOString() });
  return { mutation, results: await pushMutations(app, actor, [mutation]) };
}

export async function buildTestApp(): Promise<FastifyInstance> {
  await ensureAuthTables();
  await migrateSaleStage();
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
 * P0-1 · bootstrap platform-admin FACTORY.
 *
 * `POST /api/auth/organization/create` is closed (app.ts membershipWriters):
 * tenant creation is the founder plane's job and it demands the
 * `platformAdmin` flag. Every test tenant therefore goes through ONE
 * disposable admin that owns NO tenant of its own — `createTenant` signs it
 * in, flags it and re-signs it so `getSession` reads the fresh row (same
 * pattern as founder-api.test.ts).
 */
const BOOTSTRAP_ADMIN = {
  email: "bootstrap-admin@platform.test",
  password: "bootstrap-admin-123",
};

async function bootstrapAdminCookie(app: FastifyInstance): Promise<string> {
  const { email, password } = BOOTSTRAP_ADMIN;
  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password, name: "Founder Test" },
  });
  if (signUp.statusCode !== 200) {
    const signInRes = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
    });
    if (signInRes.statusCode !== 200) {
      throw new Error(`bootstrap admin sign-in failed: ${signInRes.statusCode} ${signInRes.body}`);
    }
  }
  await pool.query(`UPDATE "user" SET "platformAdmin" = true WHERE email = $1`, [email]);
  // fresh sign-in so getSession reloads platformAdmin from the user row
  const fresh = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password },
  });
  if (fresh.statusCode !== 200) {
    throw new Error(`bootstrap admin re-sign-in failed: ${fresh.statusCode} ${fresh.body}`);
  }
  return cookieHeader(fresh);
}

/**
 * Signs up a user, creates their tenant organization and sets it active —
 * all over real HTTP (app.inject on the better-auth routes), so the session
 * cookie we get back is exactly what a browser would hold.
 *
 * P0-1 · the org is created through the FOUNDER plane
 * (POST /api/founder/tenants → createTenantWithFirstUser), the sanctioned
 * production path: the bootstrap platform-admin creates the tenant and the
 * FIRST USER is `opts.email`, who then owns it. The HTTP shortcut
 * `/api/auth/organization/create` is closed to everybody.
 */
export async function createTenant(
  app: FastifyInstance,
  opts: { email: string; password?: string; orgSlug: string; orgName?: string },
): Promise<Actor> {
  const password = opts.password ?? "password1234";
  const adminCookie = await bootstrapAdminCookie(app);

  const created = await app.inject({
    method: "POST",
    url: "/api/founder/tenants",
    headers: { cookie: adminCookie },
    payload: {
      name: opts.orgName ?? opts.orgSlug,
      slug: opts.orgSlug,
      email: opts.email,
      password,
    },
  });
  if (created.statusCode !== 201) {
    throw new Error(`founder tenant create failed: ${created.statusCode} ${created.body}`);
  }
  const body = created.json() as {
    tenant: { id: string };
    first_user: { id: string };
  };
  const orgId = body.tenant.id;
  const userId = body.first_user.id;

  const cookie = await signIn(app, { email: opts.email, password });
  const activeRes = await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie },
    payload: { organizationId: orgId },
  });
  if (activeRes.statusCode !== 200) {
    throw new Error(`set-active failed: ${activeRes.statusCode} ${activeRes.body}`);
  }

  return { email: opts.email, password, userId, orgId, cookie };
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

/**
 * Fresh sign-in with a MEMBER username (better-auth `/sign-in/username`).
 * Owners and superadmins never take this path — they sign in with email.
 */
export async function signInUsername(
  app: FastifyInstance,
  actor: { username: string; password: string },
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/username",
    payload: { username: actor.username, password: actor.password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`username sign-in failed: ${res.statusCode} ${res.body}`);
  }
  return cookieHeader(res);
}

export function authHeaders(actor: { cookie: string }) {
  return { cookie: actor.cookie };
}

/**
 * roles-admin batch 2 · signs up a NEW user, adds them to `owner`'s org
 * with `role` ("admin" | "member") via better-auth and activates that org —
 * the pattern existing tests seeded inline (payments/void/credit-sync), now
 * shared so the role matrix reads the same everywhere. The returned
 * Actor's `orgId` IS `owner.orgId` (tenant comes ONLY from the session).
 */
export async function joinOrg(
  app: FastifyInstance,
  owner: Actor,
  role: "admin" | "member",
  email: string,
): Promise<Actor> {
  const password = "password1234";
  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password, name: email.split("@")[0] },
  });
  if (signUp.statusCode !== 200) {
    throw new Error(`joinOrg sign-up failed: ${signUp.statusCode} ${signUp.body}`);
  }
  const userId = signUp.json().data?.user?.id ?? signUp.json().user?.id;
  try {
    await getAuth().api.addMember({
      body: { organizationId: owner.orgId, userId, role },
      headers: new Headers({ cookie: owner.cookie }),
    });
  } catch (err) {
    throw new Error(`joinOrg addMember(${role}) failed: ${String(err)}`);
  }
  const cookie = await signIn(app, { email, password });
  const setActive = await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie },
    payload: { organizationId: owner.orgId },
  });
  if (setActive.statusCode !== 200) {
    throw new Error(`joinOrg set-active failed: ${setActive.statusCode} ${setActive.body}`);
  }
  return { email, password, userId, orgId: owner.orgId, cookie };
}
