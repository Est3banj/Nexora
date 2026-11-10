import { randomUUID } from "node:crypto";
import { getAuth } from "../auth/auth";
import { db } from "../db";
import { scopedRepo } from "../db/scope";

/**
 * Tenant + first-user creation (tasks D4-1/D4-2, founder-control spec
 * §Create tenant with first user + §Degradation fallback).
 *
 * ONE shared implementation for BOTH degradation paths:
 *  - CLI `src/cli/tenant-create.ts` (source: "cli")
 *  - Founder HTTP route `routes/founder.ts` (source: "founder-api")
 * so a CLI-created tenant is indistinguishable from a UI-created one
 * (spec §CLI-created tenant is equivalent).
 *
 * Sequence (better-auth organization plugin):
 *  1. sign up the FIRST USER (fails fast on an existing email)
 *  2. create the organization WITH THE FIRST USER'S session → better-auth
 *     grants the creator `owner` membership (creatorRole default "owner",
 *     verified in better-auth 1.7.19 crud-org) → exactly ONE owner row
 *  3. set-active on that session (the creator's browser would land on the
 *     new tenant immediately)
 *  4. audit_log row: actor + action `tenant.create` + created tenant id
 *     (spec §Creation is audited)
 *
 * Returns metadata ONLY — callers never receive business rows (there are
 * none: a fresh tenant has an empty catalog by construction).
 */

export type CreateTenantInput = {
  name: string;
  /** Optional explicit slug; a unique one is derived when omitted. */
  slug?: string;
  email: string;
  password: string;
  userName?: string;
  /** Who triggered it: platform-admin id (route) or "cli:tenant-create". */
  actor: string;
  source: "cli" | "founder-api";
};

export type CreateTenantResult = {
  orgId: string;
  orgName: string;
  orgSlug: string;
  userId: string;
  email: string;
  auditId: string;
};

export class FounderError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "tienda";
}

async function cookieHeaders(res: Response): Promise<Headers> {
  const headers = new Headers();
  for (const cookie of res.headers.getSetCookie()) {
    headers.append("cookie", cookie.split(";")[0]);
  }
  return headers;
}

export async function createTenantWithFirstUser(
  input: CreateTenantInput,
): Promise<CreateTenantResult> {
  const auth = getAuth();

  /* 1 ── first user ------------------------------------------------- */
  const signUp = await auth.api.signUpEmail({
    body: {
      email: input.email,
      password: input.password,
      name: input.userName ?? input.email.split("@")[0],
    },
    asResponse: true,
  });
  if (!signUp.ok) {
    const detail = await signUp.text().catch(() => "");
    const taken = /already|exists|taken/i.test(detail) || signUp.status === 409;
    throw new FounderError(
      taken
        ? `email_taken: ${input.email}`
        : `first_user_failed (${signUp.status}): ${detail || "unknown"}`,
      taken ? 409 : 400,
    );
  }
  const signUpBody = (await signUp.json()) as {
    data?: { user?: { id?: string } };
    user?: { id?: string };
  };
  const userId = signUpBody.data?.user?.id ?? signUpBody.user?.id;
  if (!userId) {
    throw new FounderError("first_user_failed: no user id in response", 500);
  }
  const headers = await cookieHeaders(signUp);

  /* 2 ── organization (+ owner membership for the creator) ----------- */
  const slug = input.slug ?? `${slugify(input.name)}-${randomUUID().slice(0, 8)}`;
  let org: { id: string; name: string; slug: string };
  try {
    org = (await auth.api.createOrganization({
      body: { name: input.name, slug },
      headers,
    })) as { id: string; name: string; slug: string };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new FounderError(`organization_create_failed: ${msg}`, 409);
  }

  /* 3 ── active org on the creator's session ------------------------ */
  try {
    await auth.api.setActiveOrganization({
      body: { organizationId: org.id },
      headers,
    });
  } catch {
    // non-fatal: the web login flow always set-acts after sign-in
  }

  /* 4 ── audit (founder-control §Creation is audited) ---------------- */
  const audit = await scopedRepo(db, org.id).auditLog.insert({
    actor: input.actor,
    action: "tenant.create",
    meta: {
      source: input.source,
      org_name: org.name,
      org_slug: org.slug,
      org_id: org.id,
      first_user_id: userId,
      first_user_email: input.email,
    },
  });

  return {
    orgId: org.id,
    orgName: org.name,
    orgSlug: org.slug,
    userId,
    email: input.email,
    auditId: audit.id,
  };
}
