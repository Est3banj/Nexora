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
      const shifts = await repo.shifts.listRecent({ limit, offset });
      const closedcash = await repo.closedcash.listRecent({ limit, offset });
      const cash_movements = await repo.cashMovements.listRecent({ limit, offset });
      const ticketIds = tickets.map((t) => t.id);
      const [lines, payments, stockdiary, credit_abonos] = await Promise.all([
        Promise.all(ticketIds.map((id) => repo.ticketLines.listByTicket(id))),
        repo.payments.listByTickets(ticketIds),
        repo.stockdiary.listRecent({ limit, offset }),
        repo.creditAbonos.listRecent({ limit, offset }),
      ]);

      const bootstrap =
        offset === 0
          ? {
              categories: await repo.categories.list(),
              customers: await repo.customers.list(),
              products: await repo.products.list(),
              variants: await repo.productVariants.list(),
              open_shift: (await repo.shifts.open()) ?? null,
              stock: await repo.stock.currentAll(),
            }
          : {};

      const fullPage = [tickets, stockdiary, credit_abonos, shifts, closedcash, cash_movements].some(rows => rows.length === limit);
      return {
        ...bootstrap,
        shifts, closedcash, cash_movements,
        tickets,
        ticket_lines: lines.flat(),
        payments,
        stockdiary,
        credit_abonos,
        next_offset: fullPage ? offset + limit : null,
      };
    },
  );
}
