import type { FastifyInstance } from "fastify";
import {
  mutationEnvelopeSchema,
  syncPushBodySchema,
  type MutationEnvelope,
  type SyncResult,
  salePartSchema,
  saleManifestSchema,
} from "@pos/shared";
import { z } from "zod";
import { uploadSalePart, finalizeSale } from "../db/sale-stage";
import { db } from "../db";
import { applyMutationGroups } from "../db/sync-apply";

/**
 * POST /api/sync/mutations — idempotent push endpoint (task D2-3,
 * design §3).
 *
 * - tenant comes ONLY from the session (requireAuth → req.ctx); a payload
 *   tenant_id cannot survive zod parsing (stripped) and would be ignored
 *   anyway — trust rule §1.
 * - The wrapper is validated as a whole (batch ≤50 → 400), but each
 *   envelope is validated PER ITEM: one invalid entry becomes a
 *   `rejected: validation` result while the rest of the batch applies —
 *   a poison entry never fails the batch (design §3 rule 3).
 * - Every mutation produces a result in ONE 200 response, aligned to the
 *   request order.
 */
export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/sync/sales/:operation/parts", { preHandler: app.requireAuth, bodyLimit: 1024 * 1024 }, async (req) => {
    const { operation } = z.object({ operation: z.uuid() }).parse(req.params);
    const body = salePartSchema.parse(req.body);
    return uploadSalePart(req.ctx.tenantId!, operation, body.manifest, body.index, body.mutations);
  });
  app.post("/api/sync/sales/:operation/finalize", { preHandler: app.requireAuth }, async (req) => {
    const { operation } = z.object({ operation: z.uuid() }).parse(req.params);
    const manifest = saleManifestSchema.parse(req.body);
    return finalizeSale(req.ctx.tenantId!, req.ctx.userId, operation, manifest);
  });
  app.post(
    "/api/sync/mutations",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = syncPushBodySchema.parse(req.body);
      const tenantId = req.ctx.tenantId!;
      const actor = req.ctx.userId;

      const valid: Array<{ index: number; envelope: MutationEnvelope }> = [];
      const preResults = new Map<number, SyncResult>();

      body.mutations.forEach((raw, index) => {
        const parsed = mutationEnvelopeSchema.safeParse(raw);
        if (parsed.success) {
          // D4 owner gate: abonos are owner-only money (same trust level as
          // transfer confirm), but enforcement is PER-ITEM here — NOT HTTP 403.
          // A 403 would nuke the member's legitimate sale mutations riding the
          // same batch ("one poison entry never fails the batch", `:22-25`).
          // Same `rejected/validation` shape an old server would produce for an
          // unknown entity, so the response contract stays byte-compatible.
          if (req.ctx.role !== "owner" && parsed.data.entity === "credit_abono") {
            preResults.set(index, {
              client_uuid: parsed.data.client_uuid,
              status: "rejected",
              reason: "validation",
            });
            return;
          }
          valid.push({ index, envelope: parsed.data });
          return;
        }
        const rawUuid = (raw as { client_uuid?: unknown } | null)?.client_uuid;
        preResults.set(index, {
          client_uuid: typeof rawUuid === "string" ? rawUuid : null,
          status: "rejected",
          reason: "validation",
        });
      });

      const applied = valid.length
        ? await applyMutationGroups(
            db,
            tenantId,
            actor,
            valid.map((v) => v.envelope),
          )
        : [];

      const byIndex = new Map<number, SyncResult>(preResults);
      valid.forEach((item, i) => byIndex.set(item.index, applied[i]));

      const results: SyncResult[] = body.mutations.map(
        (_, i) => byIndex.get(i)!,
      );
      return reply.code(200).send({ results });
    },
  );
}
