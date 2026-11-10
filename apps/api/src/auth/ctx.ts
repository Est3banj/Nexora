import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../db";
import { scopedRepo, type ScopedRepo, type TenantId } from "../db/scope";

export type Role = "owner" | "member";

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
