import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { LOW_STOCK_DEFAULT, defaultReportRange, reportDateSchema } from "@pos/shared";
import { repoFor } from "../auth/ctx";

const rangeQuerySchema = z.object({
  from: reportDateSchema.optional(),
  to: reportDateSchema.optional(),
});

function resolveRange(q: z.infer<typeof rangeQuerySchema>): {
  from: string;
  to: string;
} {
  const defaults = defaultReportRange();
  return { from: q.from ?? defaults.from, to: q.to ?? defaults.to };
}

/**
 * Reports API (task D3-4, design §8) — 3 read-only queries behind
 * scopedRepo: sales-by-day (local-day buckets, confirmed vs pending),
 * top products (qty/revenue/name tiebreak), low stock (threshold or
 * system default). Tenant scoping is structural: repoFor(req) binds $1 to
 * the session tenant, so cross-tenant figures can never appear.
 */
export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/reports/sales-by-day",
    { preHandler: app.requireAuth },
    async (req) => {
      const range = resolveRange(rangeQuerySchema.parse(req.query));
      return { range, rows: await repoFor(req).reports.salesByDay(range) };
    },
  );

  app.get(
    "/api/reports/top-products",
    { preHandler: app.requireAuth },
    async (req) => {
      const range = resolveRange(rangeQuerySchema.parse(req.query));
      return { range, rows: await repoFor(req).reports.topProducts(range) };
    },
  );

  app.get(
    "/api/reports/low-stock",
    { preHandler: app.requireAuth },
    async (req) => ({
      default_threshold: LOW_STOCK_DEFAULT,
      rows: await repoFor(req).reports.lowStock(),
    }),
  );

  app.get(
    "/api/reports/dashboard",
    { preHandler: app.requireAuth },
    async (req) => {
      const range = resolveRange(rangeQuerySchema.parse(req.query));
      const repo = repoFor(req);
      const [summary, inventory, top, low] = await Promise.all([
        repo.reports.dashboardSummary(range),
        repo.reports.inventoryValue(),
        repo.reports.topProducts(range),
        repo.reports.lowStock(),
      ]);
      const gross = summary.revenue - summary.cogs;
      const avgTicket = summary.tickets > 0 ? Math.round(summary.revenue / summary.tickets) : 0;
      return {
        range,
        summary: {
          ...summary,
          gross,
          avg_ticket: avgTicket,
        },
        inventory,
        top,
        low_count: low.length,
      };
    },
  );
}
