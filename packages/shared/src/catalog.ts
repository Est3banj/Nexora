import { z } from "zod";

/** Catalog contracts shared by API routes and web forms (task D1-7). */

export const variantNameSchema = z.string().trim().min(1, "required").max(80);
export const productNameSchema = z.string().trim().min(1, "required").max(120);
export const categoryNameSchema = z.string().trim().min(1, "required").max(60);

/** Prices are integer COP and must be >= 0 (catalog spec: invalid price rejected). */
export const priceSchema = z
  .number("price must be a number")
  .int("price must be an integer (COP pesos)")
  .nonnegative("price cannot be negative");

export const stockSchema = z.number().int();

export const lowStockThresholdSchema = z.number().int().nonnegative().nullable();

/** Compressed data-URL image (client caps ~150KB before enqueue). */
export const photoSchema = z
  .string()
  .max(220_000, "photo too large (max ~150KB compressed)")
  .regex(/^data:image\//, "photo must be a data URL image");

export const createCategoryInputSchema = z.object({
  name: categoryNameSchema,
});

export const updateCategoryInputSchema = z.object({
  name: categoryNameSchema.optional(),
  active: z.boolean().optional(),
});

export const createProductInputSchema = z.object({
  name: productNameSchema,
  category_id: z.uuid().nullable().optional(),
  photo: photoSchema.nullable().optional(),
  variant: z.object({
    name: variantNameSchema,
    price: priceSchema,
    cost: priceSchema.nullable().optional(),
    stock: stockSchema.default(0),
    low_stock_threshold: lowStockThresholdSchema.default(null),
  }),
  // Deliberately NOT part of the schema: a forged tenant_id is ignored by
  // construction (tenancy-auth spec §Tenant resolution).
});

export const updateProductInputSchema = z
  .object({
    name: productNameSchema.optional(),
    category_id: z.uuid().nullable().optional(),
    photo: photoSchema.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.category_id !== undefined ||
      v.photo !== undefined ||
      v.active !== undefined,
    { message: "nothing to update" },
  );

export const updateVariantInputSchema = z.object({
  name: variantNameSchema.optional(),
  price: priceSchema.optional(),
  cost: priceSchema.nullable().optional(),
  active: z.boolean().optional(),
  low_stock_threshold: lowStockThresholdSchema.optional(),
});

/** Manual stock adjustment: reason + note are mandatory (auditable, catalog spec). */
export const adjustStockInputSchema = z.object({
  delta: z.number().int(),
  reason: z.string().trim().min(1, "reason is required").max(60),
  note: z.string().trim().min(1, "note is required").max(240),
});

export type CreateCategoryInput = z.infer<typeof createCategoryInputSchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategoryInputSchema>;
export type CreateProductInput = z.infer<typeof createProductInputSchema>;
export type UpdateProductInput = z.infer<typeof updateProductInputSchema>;
export type UpdateVariantInput = z.infer<typeof updateVariantInputSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockInputSchema>;

/** Sale commit contracts (task D1-8 — local skeleton, cash only). */
export const saleLineInputSchema = z.object({
  variant_id: z.uuid(),
  qty: z.number().int().positive(),
  unit_price: priceSchema,
});

export const cashCheckoutInputSchema = z.object({
  lines: z.array(saleLineInputSchema).min(1),
  tendered: priceSchema,
});

export type SaleLineInput = z.infer<typeof saleLineInputSchema>;
export type CashCheckoutInput = z.infer<typeof cashCheckoutInputSchema>;
