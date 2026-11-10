import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { repoFor } from "../auth/ctx";
import { voidSale } from "../db/void-sale";

const uuidParam = z.object({ id: z.uuid() });

/** Tenant-scoped history plus the owner-only, online total-void command.
 * Ordinary sale creation continues through the offline sync path. */
export async function salesRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/sales/tickets/:id/void", { preHandler: app.requireAuth }, async (req, reply) => {
    if (req.ctx.role !== "owner") return reply.code(403).send({ error: "owner_only" });
    const { id } = uuidParam.parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).strict().parse(req.body);
    const result = await voidSale(req.ctx.tenantId!, req.ctx.userId, id, reason);
    if ("error" in result) return reply.code(result.error === "not_found" ? 404 : 409).send(result);
    return result;
  });
  app.get(
    "/api/sales/tickets",
    { preHandler: app.requireAuth },
    async (req) => ({ tickets: await repoFor(req).tickets.list() }),
  );

  app.get(
    "/api/sales/tickets/:id",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = uuidParam.parse(req.params);
      const repo = repoFor(req);
      const ticket = await repo.tickets.byUuid(id);
      if (!ticket) return reply.code(404).send({ error: "not_found" });
      const [lines, payments] = await Promise.all([
        repo.ticketLines.listByTicket(ticket.id),
        repo.payments.listByTicket(ticket.id),
      ]);
      return { ticket, lines, payments, stockdiary: await repo.stockdiary.listByTicket(ticket.id) };
    },
  );
}
