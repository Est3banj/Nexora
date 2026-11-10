import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { repoFor } from "../auth/ctx";

const uuidParam = z.object({ id: z.uuid() });

/**
 * POST /api/payments/:id/confirm — owner-only transfer confirmation
 * (task D2-6, sales spec §Bank-transfer + tenancy §Owner confirms).
 *
 * Role check happens HERE (server-side): a member gets 403 even though
 * members may push ordinary sale mutations through /sync/mutations.
 * Strict transition pending→confirmed enforced by repo.payments.confirm;
 * anything else (already confirmed, cash, unknown) → 404/409, never a
 * silent revert.
 */
export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/payments/:id/confirm",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = uuidParam.parse(req.params);
      if (req.ctx.role !== "owner") {
        return reply.code(403).send({ error: "forbidden", detail: "owner_only" });
      }
      const result = await repoFor(req).payments.confirm(id);
      if ("error" in result) {
        if (result.error === "not_found") {
          return reply.code(404).send({ error: "not_found" });
        }
        return reply
          .code(409)
          .send({ error: "invalid_transition", detail: "only_pending_can_confirm" });
      }
      return { payment: result.payment };
    },
  );
}
