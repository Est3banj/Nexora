import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  adjustStockInputSchema,
  createCategoryInputSchema,
  createProductInputSchema,
  updateCategoryInputSchema,
  updateProductInputSchema,
  updateVariantInputSchema,
} from "@pos/shared";
import { repoFor } from "../auth/ctx";

const uuidParam = z.object({ id: z.uuid() });

const variantInputSchema = createProductInputSchema.shape.variant;

/**
 * Catalog vertical slice (task D1-7) — every handler reads/writes through
 * `repoFor(req)` = scopedRepo(db, session tenant). No raw db access here
 * (lint gate enforces it).
 */
export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/catalog/categories",
    { preHandler: app.requireAuth },
    async (req) => ({ categories: await repoFor(req).categories.list() }),
  );

  app.post(
    "/api/catalog/categories",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const input = createCategoryInputSchema.parse(req.body);
      const category = await repoFor(req).categories.create({
        name: input.name,
      });
      return reply.code(201).send({ category });
    },
  );

  app.patch(
    "/api/catalog/categories/:id",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = uuidParam.parse(req.params);
      const input = updateCategoryInputSchema.parse(req.body);
      const affected = await repoFor(req).categories.update(id, input);
      if (affected === 0) return reply.code(404).send({ error: "not_found" });
      return { ok: true, affected };
    },
  );

  app.get<{ Querystring: { active?: string } }>(
    "/api/catalog/products",
    { preHandler: app.requireAuth },
    async (req) => {
      const repo = repoFor(req);
      const active =
        req.query.active === undefined
          ? {}
          : { active: req.query.active === "1" };
      const products = await repo.products.list(active);
      const variants = await repo.productVariants.list({
        ...(active.active !== undefined ? { active: active.active } : {}),
      });
      return {
        products: products.map((p) => ({
          ...p,
          variants: variants.filter((v) => v.product_id === p.id),
        })),
      };
    },
  );

  /** Sale-flow view: active variants of active products, with product name. */
  app.get(
    "/api/catalog/sale-items",
    { preHandler: app.requireAuth },
    async (req) => ({ items: await repoFor(req).productVariants.listForSale() }),
  );

  app.post(
    "/api/catalog/products",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      // zod strips unknown keys → a forged tenant_id in the body is ignored
      // by construction (tenancy-auth spec §Forged tenant_id ignored).
      const input = createProductInputSchema.parse(req.body);
      const result = await repoFor(req).catalog.createProduct({
        name: input.name,
        category_id: input.category_id ?? null,
        photo: input.photo ?? null,
        variant: input.variant,
      });
      return reply.code(201).send(result);
    },
  );

  /** Extra size/price on an existing product (two sizes, independent prices). */
  app.post(
    "/api/catalog/products/:id/variants",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = uuidParam.parse(req.params);
      const input = variantInputSchema.parse(req.body);
      const variant = await repoFor(req).catalog.addVariant(id, input);
      if (!variant) return reply.code(404).send({ error: "not_found" });
      return reply.code(201).send({ variant });
    },
  );

  app.patch(
    "/api/catalog/products/:id",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = uuidParam.parse(req.params);
      const input = updateProductInputSchema.parse(req.body);
      const affected = await repoFor(req).products.update(id, input);
      if (affected === 0) return reply.code(404).send({ error: "not_found" });
      return { ok: true, affected };
    },
  );

  app.patch(
    "/api/catalog/variants/:id",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = uuidParam.parse(req.params);
      const input = updateVariantInputSchema.parse(req.body);
      const affected = await repoFor(req).productVariants.update(id, input);
      if (affected === 0) return reply.code(404).send({ error: "not_found" });
      return { ok: true, affected };
    },
  );

  /** Manual stock adjustment — reason + note are mandatory (catalog spec). */
  app.post(
    "/api/catalog/variants/:id/stock-adjust",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      const { id } = uuidParam.parse(req.params);
      const input = adjustStockInputSchema.parse(req.body);
      const result = await repoFor(req).stock.adjust({
        variant_id: id,
        delta: input.delta,
        reason: input.reason,
        note: input.note,
      });
      if (!result) return reply.code(404).send({ error: "not_found" });
      return reply.code(201).send(result);
    },
  );
}
