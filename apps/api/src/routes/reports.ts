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
 *
 * roles-admin 2.2 · FINANCIAL datasets (dashboard, sales-by-day,
 * top-products) are Dueño-tier. UNTOUCHED any-auth reads: low-stock,
 * customer-balances, customer-accounts (+ routes/rehydrate.ts) — the
 * cashier's operational/offline workflow must never brick (reports spec
 * §Operational reads stay open to any member).
 */
export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/reports/sales-by-day",
    { preHandler: [app.requireAuth, app.requireDueño] },
    async (req) => {
      const range = resolveRange(rangeQuerySchema.parse(req.query));
      return { range, rows: await repoFor(req).reports.salesByDay(range) };
    },
  );

  app.get(
    "/api/reports/top-products",
    { preHandler: [app.requireAuth, app.requireDueño] },
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

  /**
   * Por Cobrar (fiado) — server parity for the balance query the Crédito
   * screen runs locally (same shared SQL, fixture parity both stores).
   * Any authed role: balances are visible to members (reports spec §
   * Operational reads); abonos open to any verified role since roles-admin
   * decision #1 (supersedes fiado #6 — sync/route.ts no longer role-gates
   * credit_abono).
   */
  app.get(
    "/api/reports/customer-balances",
    { preHandler: app.requireAuth },
    async (req) => ({ rows: await repoFor(req).reports.customerBalances() }),
  );

  app.get(
    "/api/reports/customer-accounts",
    { preHandler: app.requireAuth },
    async (req) => ({ rows: await repoFor(req).reports.customerAccounts() }),
  );

  app.get(
    "/api/reports/dashboard",
    { preHandler: [app.requireAuth, app.requireDueño] },
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
