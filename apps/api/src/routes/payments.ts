import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isDueño, repoFor } from "../auth/ctx";

const uuidParam = z.object({ id: z.uuid() });

/**
 * POST /api/payments/:id/confirm — Dueño-tier transfer confirmation
 * (task D2-6, sales spec §Bank-transfer + tenancy §Owner confirms).
 *
 * Role check happens HERE (server-side): a member gets 403 even though
 * members may push ordinary sale mutations through /sync/mutations.
 * roles-admin 2.3 · `!== "owner"` → `!isDueño(...)` (admin = owner-tier
 * parity, auth-roles §Owner and admin confirm transfers, member cannot).
 * Response bodies UNCHANGED (`detail:"owner_only"`) — zero test churn.
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
      if (!isDueño(req.ctx.role)) {
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
