import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { getAuth } from "./auth";
import { isDueño, type RequestCtx, type Role } from "./ctx";

/**
 * Auth plugin (task D1-3): resolves `{userId, tenantId, role, platformAdmin}`
 * from the SESSION into `req.ctx`.
 *
 * - 401 when there is no session at all.
 * - 403 `no_active_tenant` when the session has no active organization or no
 *   membership in it (tenancy-auth: user with no membership has no tenant).
 * - Role comes from better-auth's org membership (`owner|admin|member`).
 * - tenantId NEVER comes from body/query/header.
 */
async function authenticate(req: FastifyRequest): Promise<RequestCtx | null> {
  const headers = fromNodeHeaders(req.headers);
  const session = await getAuth().api.getSession({ headers });
  if (!session) return null;

  // NOTE: better-auth 1.7.19 does not surface the organization plugin's
  // `session.activeOrganizationId` in its TS types ($Infer gap), but it IS
  // present at runtime (verified: probe setActive → getSession returns it).
  const tenantId =
    (session.session as { activeOrganizationId?: string | null })
      .activeOrganizationId ?? null;
  let role: Role | null = null;
  if (tenantId) {
    try {
      const active = (await getAuth().api.getActiveMemberRole({ headers })) as {
        role?: string;
      };
      // roles-admin 1.2 · H1 fix: better-auth 1.7.19 org roles are exactly
      // admin|member|owner (crud-members.d.mts:420; defaultRoles in
      // access/statement.mjs:71-74). The old `owner|member, else null` map
      // turned `admin` into null, and `tenantId && role` below then DROPPED
      // the tenant → total lockout (403 no_active_tenant) for admin members.
      // Unknown roles still fail closed to null (spec: unrecognized → no tenant).
      role =
        active?.role === "owner"
          ? "owner"
          : active?.role === "admin"
            ? "admin"
            : active?.role === "member"
              ? "member"
              : null;
    } catch {
      // stale active org / membership revoked → no role (spec: no membership → no tenant)
      role = null;
    }
  }

  return {
    userId: session.user.id,
    tenantId: tenantId && role ? tenantId : null,
    role,
    platformAdmin: Boolean(
      (session.user as unknown as { platformAdmin?: boolean }).platformAdmin,
    ),
  };
}

export const authPlugin = fp(async (app) => {
  app.decorate("requireAuth", async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = await authenticate(req);
    if (!ctx) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    req.ctx = ctx;
    if (!ctx.tenantId || !ctx.role) {
      return reply.code(403).send({ error: "no_active_tenant" });
    }
    if (req.headers["x-nexora-tenant"] && req.headers["x-nexora-tenant"] !== ctx.tenantId) {
      return reply.code(409).send({ error: "tenant_mismatch" });
    }
  });

  app.decorate(
    "requirePlatformAdmin",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ctx = await authenticate(req);
      if (!ctx) {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      req.ctx = ctx;
      // A tenant owner is NOT a platform admin — only the platformAdmin flag
      // on the user passes this gate (design §4).
      if (!ctx.platformAdmin) {
        return reply.code(403).send({ error: "forbidden" });
      }
    },
  );

  // roles-admin 1.4 · Dueño-tier gate for NEW endpoints (batch 2+).
  // Chain it after requireAuth: `preHandler: [app.requireAuth, app.requireDueño]`
  // — requireAuth resolves req.ctx (session, tenant, role). Fails closed if
  // ctx is missing (mis-wired route → no tenant, never a silent pass).
  // The legacy owner_only bodies (sales.ts:12, payments.ts:23) do NOT use
  // this decorator on purpose: they migrate in Batch 2, zero test churn now.
  app.decorate(
    "requireDueño",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.ctx) {
        return reply.code(403).send({ error: "no_active_tenant" });
      }
      if (!isDueño(req.ctx.role)) {
        return reply.code(403).send({ error: "forbidden", detail: "dueño_only" });
      }
    },
  );
});
