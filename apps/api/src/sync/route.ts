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
import { isDueño } from "../auth/ctx";
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
    return finalizeSale(req.ctx.tenantId!, req.ctx.userId, operation, manifest, req.ctx.role);
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
          // roles-admin 2.5 (D2) · member per-item pre-scan — NEVER HTTP 403:
          // one poison catalog entry must not nuke the member's legitimate
          // sale mutations riding the same batch ("one poison entry never
          // fails the batch", `:22-25`). Same `rejected/validation` shape an
          // old server would produce, so the response contract stays
          // byte-compatible and member batches stay 2xx.
          //
          // The OLD `credit_abono` owner-only gate (former :54-67, D4) is
          // DELETED — roles-admin decision #1 supersedes fiado decision #6:
          // any verified role (member included) may register abonos.
          //
          // This is only an early shape filter. ref_ticket_id is an untrusted
          // grouping hint, NEVER authority. sync-apply validates tenant-owned
          // sale evidence and treats member variant snapshots as read-only hints.
          if (!isDueño(req.ctx.role)) {
            const p = parsed.data.payload as Record<string, unknown>;
            const inSale = typeof p.ref_ticket_id === "string";
            const forbidden =
              parsed.data.entity === "category" ||
              parsed.data.entity === "product" ||
              ((parsed.data.entity === "variant" ||
                parsed.data.entity === "stockdiary") &&
                !inSale);
            if (forbidden) {
              preResults.set(index, {
                client_uuid: parsed.data.client_uuid,
                status: "rejected",
                reason: "validation",
              });
              return;
            }
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
            undefined,
            req.ctx.role,
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
