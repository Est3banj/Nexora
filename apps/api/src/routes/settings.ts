import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { repoFor } from "../auth/ctx";

/**
 * roles-admin 3.5 + 4.3 / design D4 · GET/PUT /api/settings +
 * POST /api/settings/annul-code.
 *
 * - GET: ANY verified tenant role, hash-free `PublicSettings`. REGISTRO
 *   (R5 resolved in design, not re-opened): members structurally need
 *   `require_annul_code` (void flow), `enable_fiado` (nav), the local
 *   `allow_negative_stock` guard and the fiscal identity (a cashier's
 *   printed receipt must equal the owner's). The response is built by the
 *   explicit mapper in db/settings.ts — `annul_code_hash` never leaves.
 * - PUT: Dueño tier via `app.requireDueño` (403 forbidden/dueño_only) +
 *   zod `.strict()` partial of the 11 writable fields. `.strict()` is a
 *   security boundary too: `annul_code_hash`/`tenant_id`/unknown keys are
 *   rejected with 400 instead of silently stripped.
 */
const settingsPatchSchema = z
  .object({
    store_name: z.string().max(120).nullable().optional(),
    nit: z.string().max(30).nullable().optional(),
    address: z.string().max(160).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    ticket_footer: z.string().max(240).nullable().optional(),
    ticket_prefix: z.string().max(8).nullable().optional(),
    iva_pct: z.number().int().min(0).max(100).nullable().optional(),
    default_credit_limit: z.number().int().min(0).max(2147483647).nullable().optional(),
    allow_negative_stock: z.boolean().optional(),
    require_annul_code: z.boolean().optional(),
    enable_fiado: z.boolean().optional(),
  })
  .strict();

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", { preHandler: app.requireAuth }, async (req) => ({
    settings: await repoFor(req).settings.get(),
  }));

  app.put(
    "/api/settings",
    { preHandler: [app.requireAuth, app.requireDueño] },
    async (req) => {
      const patch = settingsPatchSchema.parse(req.body);
      const settings = await repoFor(req).settings.upsert(patch, req.ctx.userId);
      return { settings };
    },
  );

  // roles-admin 4.3 / design D3 — code generation (Dueño tier). Lives in
  // this router (already registered in app.ts — nothing new to wire). The
  // plaintext is returned EXACTLY once; the response never carries the
  // hash, and the audit row it writes carries neither code nor hash.
  app.post(
    "/api/settings/annul-code",
    { preHandler: [app.requireAuth, app.requireDueño] },
    async (req) => repoFor(req).settings.generateAnnulCode(req.ctx.userId),
  );
}
