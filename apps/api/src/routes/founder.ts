import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { founderSyncStatus } from "../db/founder";
import { createTenantWithFirstUser, FounderError } from "../founder/service";

/**
 * Founder web plane (task D4-2, founder-control spec) — the MINIMAL
 * control surface, metadata only:
 *
 *  POST /api/founder/tenants        create tenant + first user (+ audit)
 *  GET  /api/founder/sync-status    per-tenant sync health (metadata rows)
 *
 * Gates:
 *  - `requirePlatformAdmin` (auth/plugin.ts): unauthenticated → 401, a
 *    tenant OWNER without the platformAdmin flag → 403 and NO tenant is
 *    created (spec §Platform-admin role distinct from tenant roles).
 *  - Responses carry tenant identity + sync metrics ONLY — never product
 *    names, ticket contents or payment amounts (spec §Founder plane
 *    exposes no tenant business data). The create flow returns the org +
 *    first-user metadata; a fresh tenant has an empty catalog anyway.
 *  - Creation goes through the SAME service the CLI uses (D4-1), so both
 *    paths produce identical org/owner/audit records (§Degradation).
 */

const createBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, digits and dashes")
    .optional(),
  email: z.email(),
  password: z.string().min(8).max(100),
});

export async function founderRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/founder/tenants",
    { preHandler: app.requirePlatformAdmin },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const input = createBodySchema.parse(req.body);
      try {
        const result = await createTenantWithFirstUser({
          name: input.name,
          slug: input.slug,
          email: input.email,
          password: input.password,
          actor: req.ctx.userId,
          source: "founder-api",
        });
        return reply.code(201).send({
          tenant: {
            id: result.orgId,
            name: result.orgName,
            slug: result.orgSlug,
          },
          first_user: { id: result.userId, email: result.email },
          audit: { id: result.auditId },
        });
      } catch (err) {
        if (err instanceof FounderError) {
          return reply
            .code(err.statusCode)
            .send({ error: err.message.split(":")[0], detail: err.message });
        }
        throw err;
      }
    },
  );

  app.get(
    "/api/founder/sync-status",
    { preHandler: app.requirePlatformAdmin },
    async (_req, reply) => {
      reply.header("Cache-Control", "no-store");
      return { tenants: await founderSyncStatus() };
    },
  );
}
