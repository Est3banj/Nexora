import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db";
import { scopedRepo, type ScopedRepo, type TenantId } from "../db/scope";

// roles-admin 1.1 · better-auth 1.7.19 org roles are exactly
// "owner" | "admin" | "member" (crud-members.d.mts:420; defaultRoles in
// access/statement.mjs:71-74). `admin` used to be missing here, which forced
// plugin.ts to map it to null → total lockout for admin members.
export type Role = "owner" | "admin" | "member";

/**
 * Dueño tier (roles-admin D1): owner + admin share full tier power.
 * NEW gates use this; the pre-existing `owner_only` bodies
 * (sales.ts / payments.ts) migrate to it in Batch 2 — untouched in Batch 1.
 * `null` (unverified/lonely) fails closed → not dueño.
 */
export function isDueño(role: Role | null): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Session-derived request context (task D1-3, design §4).
 * `tenantId` comes ONLY from the better-auth session's active organization —
 * never from body/query/header (tenancy-auth spec §Tenant resolution).
 */
export type RequestCtx = {
  userId: string;
  tenantId: TenantId | null;
  role: Role | null;
  platformAdmin: boolean;
};

declare module "fastify" {
  interface FastifyRequest {
    ctx: RequestCtx;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePlatformAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    // roles-admin 1.4 · tier preHandler for NEW gates only (chained AFTER
    // requireAuth, which sets req.ctx). Existing owner_only bodies
    // (sales.ts / payments.ts) must NOT go through this — zero test churn.
    requireDueño: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Every business route builds its ONLY database handle through this helper —
 * `repo = scopedRepo(db, req.ctx.tenantId)` (task D1-4 AC / design §5).
 * requireAuth guarantees ctx.tenantId is set, otherwise 403.
 */
export function repoFor(req: FastifyRequest): ScopedRepo {
  if (!req.ctx?.tenantId) {
    throw Object.assign(new Error("no_active_tenant"), { statusCode: 403 });
  }
  return scopedRepo(db, req.ctx.tenantId);
}
