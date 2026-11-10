import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { countedSchema } from "@pos/shared";
import { repoFor } from "../auth/ctx";

const uuidParam = z.object({ id: z.uuid() });
const openBodySchema = z
  .object({ client_uuid: z.uuid().optional() })
  .nullish();
const closeBodySchema = z.object({
  /** The ONLY figure the client sends — expected/diff are server-derived. */
  counted: countedSchema,
  /** Optional row uuid so the client can mirror the exact server row. */
  client_uuid: z.uuid().optional(),
});

/**
 * Shifts + arqueo (task D3-2, cash-close spec):
 *  - at most ONE open shift (partial unique index + explicit 409)
 *  - close computes `expected` FROM PAYMENTS server-side; the client sends
 *    only `counted` (≥0 int) — never an expected/total figure
 *  - closedcash is written once and never updated (spec §immutable)
 *  - every lookup is tenant-scoped through scopedRepo (session tenant only)
 */
export async function shiftRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/shifts/open",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const body = openBodySchema.parse(req.body ?? {});
      const repo = repoFor(req);
      const existing = await repo.shifts.open();
      if (existing) {
        return reply
          .code(409)
          .send({ error: "shift_already_open", shift: existing });
      }
      try {
        const shift = await repo.shifts.createOpen({
          ...(body?.client_uuid ? { client_uuid: body.client_uuid } : {}),
        });
        return reply.code(201).send({ shift });
      } catch (err) {
        // lost the race against a concurrent open → same rejection
        if ((err as { code?: string }).code === "23505") {
          const raced = await repo.shifts.open();
          return reply
            .code(409)
            .send({ error: "shift_already_open", shift: raced ?? null });
        }
        throw err;
      }
    },
  );

  app.get(
    "/api/shifts/open",
    { preHandler: app.requireAuth },
    async (req) => ({ shift: (await repoFor(req).shifts.open()) ?? null }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/shifts/:id/close",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = uuidParam.parse(req.params);
      const body = closeBodySchema.parse(req.body);
      const result = await repoFor(req).shifts.close({
        shiftId: id,
        counted: body.counted,
        closedBy: req.ctx.userId,
        clientUuid: body.client_uuid,
      });
      if ("error" in result) {
        if (result.error === "not_found") {
          return reply.code(404).send({ error: "not_found" });
        }
        if (result.error === "not_open") {
          return reply
            .code(409)
            .send({ error: "shift_not_open", detail: "no_open_shift_to_close" });
        }
        return reply
          .code(409)
          .send({ error: "already_closed", detail: "closedcash_is_immutable" });
      }
      return reply.code(200).send(result);
    },
  );
}
