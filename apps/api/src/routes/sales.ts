import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { repoFor } from "../auth/ctx";

const uuidParam = z.object({ id: z.uuid() });

/**
 * Read-only sales endpoints for D1 (task D1-5 needs session-level isolation
 * on tickets/payments). The write path for sales arrives with D2-3 sync —
 * intentionally NOT implemented here.
 */
export async function salesRoutes(app: FastifyInstance): Promise<void> {
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
      return { ticket, lines, payments };
    },
  );
}
