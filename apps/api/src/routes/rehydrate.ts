import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { repoFor } from "../auth/ctx";

const querySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * GET /api/rehydrate — paged pull used to rebuild the local cache after a
 * datadir version bump (task D2-8, design §3 rule 5).
 *
 * Page 0 carries the bootstrap set (products, variants, open shift, stock);
 * every page carries a slice of recent tickets + their lines/payments and a
 * slice of recent stockdiary. `next_offset` is null when the caller has
 * reached the end. Reads are fully tenant-scoped via scopedRepo — a tenant
 * can only ever rehydrate its own rows.
 */
export async function rehydrateRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/rehydrate",
    { preHandler: app.requireAuth },
    async (req) => {
      const { offset, limit } = querySchema.parse(req.query);
      const repo = repoFor(req);

      const tickets = await repo.tickets.list({ limit, offset });
      const ticketIds = tickets.map((t) => t.id);
      const [lines, payments, stockdiary] = await Promise.all([
        Promise.all(ticketIds.map((id) => repo.ticketLines.listByTicket(id))),
        repo.payments.listByTickets(ticketIds),
        repo.stockdiary.listRecent({ limit, offset }),
      ]);

      const bootstrap =
        offset === 0
          ? {
              categories: await repo.categories.list(),
              products: await repo.products.list(),
              variants: await repo.productVariants.list(),
              open_shift: (await repo.shifts.open()) ?? null,
              stock: await repo.stock.currentAll(),
            }
          : {};

      const fullPage = tickets.length === limit || stockdiary.length === limit;
      return {
        ...bootstrap,
        tickets,
        ticket_lines: lines.flat(),
        payments,
        stockdiary,
        next_offset: fullPage ? offset + limit : null,
      };
    },
  );
}
