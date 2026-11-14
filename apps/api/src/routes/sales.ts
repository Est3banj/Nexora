import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isDueño, repoFor } from "../auth/ctx";
import { voidSale } from "../db/void-sale";

const uuidParam = z.object({ id: z.uuid() });

/** `code` joins `reason` (roles-admin 4.4): `.strict()` still rejects any
 * other key (`total`/`status`/etc. never strip — see void-sale.test). */
const voidBodySchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
    code: z.string().optional(),
  })
  .strict();

/** Tenant-scoped history plus the online total-void command.
 * Ordinary sale creation continues through the offline sync path.
 * roles-admin 4.4 / D3 EXACT order: requireAuth → settings (absent row →
 * defaults) → toggle OFF: `!isDueño` → 403 `{error:"owner_only"}` (batch2
 * body byte-identical, checked BEFORE any parsing so a non-dueño always
 * gets it) / toggle ON: `checkAnnulCode` → 403 `{error:
 * "annul_code_required"}` or `{error:"annul_code_invalid", detail:
 * "mismatch"|"expired"}` → `voidSale` with the EXISTING precedence
 * (not_found 404 → shift_closed/abonos_exist/incomplete_sale 409)
 * untouched. The code check runs BEFORE voidSale: a code-less caller must
 * not learn whether the ticket exists (D3 "Authorization precedes evidence
 * probing"). Annul stays online-only (H4). */
export async function salesRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/sales/tickets/:id/void", { preHandler: app.requireAuth }, async (req, reply) => {
    // 2. settings = repo.settings.get() — row null → defaults
    //    (require_annul_code=false → today's behavior for every tenant).
    const settings = await repoFor(req).settings.get();
    // 3. TOGGLE OFF = batch2 byte-identical: role gate BEFORE parsing.
    if (!settings.require_annul_code && !isDueño(req.ctx.role)) {
      return reply.code(403).send({ error: "owner_only" });
    }
    const { id } = uuidParam.parse(req.params);
    const { reason, code } = voidBodySchema.parse(req.body);
    // 3. TOGGLE ON = the code replaces the tier gate (any verified role
    //    with the current code annuls; NOBODY — owner/admin included —
    //    annuls without it). Checked before voidSale, never after.
    if (settings.require_annul_code) {
      const check = await repoFor(req).settings.checkAnnulCode(code);
      if ("error" in check) {
        return reply.code(403).send(
          check.error === "required"
            ? { error: "annul_code_required" }
            : { error: "annul_code_invalid", detail: check.error },
        );
      }
    }
    // 4. voidSale — precedence unchanged.
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
