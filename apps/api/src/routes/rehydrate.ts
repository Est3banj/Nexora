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
 * Page 0 carries the one-shot bootstrap set (customers, open shift, stock);
 * EVERY page carries a slice of recent tickets + their lines/payments, a
 * slice of recent stockdiary/abonos/shifts/closedcash/cash movements, a
 * slice of the catalog (categories, products, variants) AND the mesas
 * Fase 2 comanda domain (tables + orders + the lines of THIS page's orders)
 * — P1-1: every collection rides the SAME `next_offset` counter, so a device
 * with >1000 products is rebuilt completely instead of being truncated at
 * the repo caps on page 0. `next_offset` is null when every collection has
 * been fully delivered.
 * Reads are fully tenant-scoped via scopedRepo — a tenant can only ever
 * rehydrate its own rows.
 */
export async function rehydrateRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/rehydrate",
    { preHandler: app.requireAuth },
    // P2-3 · page 0 carries `customers` (name/phone/address) plus the ticket
    // history — user data, so the response must never sit in a cache.
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const { offset, limit } = querySchema.parse(req.query);
      const repo = repoFor(req);

      const tickets = await repo.tickets.list({ limit, offset });
      const shifts = await repo.shifts.listRecent({ limit, offset });
      const closedcash = await repo.closedcash.listRecent({ limit, offset });
      const cash_movements = await repo.cashMovements.listRecent({ limit, offset });
      // mesas Fase 2: the comanda domain rides the SAME page as the catalog,
      // orders first so their lines ride THIS page's order ids (tickets
      // pattern — one inArray query per page, never N+1).
      const orders = await repo.orders.list({ limit, offset });
      const ticketIds = tickets.map((t) => t.id);
      const orderIds = orders.map((o) => o.id);
      // P1-2 · one query for the whole ticket slice (inArray), grouped back
      // in ticket order — the old Promise.all(ticketIds.map(listByTicket))
      // was an N+1 round-trip per page.
      const [lines, payments, stockdiary, credit_abonos, categories, products, variants, tables, order_lines] =
        await Promise.all([
          repo.ticketLines.listByTickets(ticketIds),
          repo.payments.listByTickets(ticketIds),
          repo.stockdiary.listRecent({ limit, offset }),
          repo.creditAbonos.listRecent({ limit, offset }),
          repo.categories.list({ limit, offset }),
          repo.products.list({ limit, offset }),
          repo.productVariants.list({ limit, offset }),
          repo.tables.list({ limit, offset }),
          repo.orderLines.listByOrders(orderIds),
        ]);

      // One-shot collections stay on page 0 only (the client already treats
      // them as a complete set; the paging tests assert their absence later).
      const bootstrap =
        offset === 0
          ? {
              customers: await repo.customers.list(),
              open_shift: (await repo.shifts.open()) ?? null,
              stock: await repo.stock.currentAll(),
            }
          : {};

      const fullPage = [tickets, stockdiary, credit_abonos, shifts, closedcash, cash_movements, categories, products, variants, tables, orders]
        .some(rows => rows.length === limit);
      return {
        ...bootstrap,
        categories, products, variants,
        shifts, closedcash, cash_movements,
        tables, orders, order_lines,
        tickets,
        ticket_lines: lines,
        payments,
        stockdiary,
        credit_abonos,
        next_offset: fullPage ? offset + limit : null,
      };
    },
  );
}
