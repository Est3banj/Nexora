import type { PGlite } from "@electric-sql/pglite";
import {
  EXPECTED_FROM_PAYMENTS_SQL,
  arqueoDiff,
  assertCheckoutable,
  computeVuelto,
  countedSchema,
  lineSubtotal,
  mutationEnvelopeSchema,
  parseExpectedRow,
  type ExpectedBreakdown,
  type MutationEntity,
  variantCodeSchema,
  CUSTOMER_ACCOUNT_BY_ID_SQL,
  CUSTOMER_ACCOUNTS_SQL,
  CUSTOMER_BALANCES_SQL,
  parseCustomerAccounts,
  parseCustomerBalances,
  customerPayloadSchema,
  creditAbonoPayloadSchema,
  cashMovementPayloadSchema,
  productIconKeySchema,
  type ProductIconKey,
  createProductInputSchema,
  adjustStockInputSchema,
} from "@pos/shared";
import { localTx, type LocalQueryable } from "./pglite";
import { assertWritable, unresolvedWork, BUSINESS_TABLES } from "./preservation";
import { readSettingsCache } from "../lib/settings";

/**
 * Local-first data layer (tasks D1-7 / D1-8).
 *
 * Mirrors the server's scopedRepo semantics: EVERY query is bound to the
 * session tenantId — the local cache is tenant-partitioned (tenancy-auth
 * spec §Session data is tenant-partitioned locally).
 *
 * Every mutation writes entity rows AND its sync_log enqueue inside the SAME
 * transaction (queue push itself lands in D2 — here we only enqueue, design
 * §6 step 2).
 */

type Q = LocalQueryable;

function tenantTx<T>(db: PGlite | Q, tenant: string, fn: (tx: Q) => Promise<T>): Promise<T> {
  const run = async (tx: Q) => {
    await assertWritable(tx, tenant);
    return fn(tx);
  };
  return "transaction" in db ? localTx(db as PGlite, run) : run(db);
}

async function assertLocalCategory(q: Q, tenantId: string, id?: string | null) {
  if (!id) return;
  const result = await q.query("SELECT id FROM categories WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
  if (!result.rows[0]) throw new Error("Categoría no encontrada en este comercio");
}

export function catalogError(err: unknown): string {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code === "23505" && e.constraint === "product_variants_tenant_code_uq")
    return "El código ya pertenece a otra variante de este comercio";
  return e?.message ?? "No se pudo guardar el catálogo";
}

const newId = () => globalThis.crypto.randomUUID();

/* ------------------------------------------------------------------ */
/* sync_log enqueue (D1 placeholder shape — full contract is D2-1)     */
/* ------------------------------------------------------------------ */

/**
 * Upsert-latest enqueue: one sync_log row per entity client_uuid
 * (unique(tenant_id, client_uuid) — never-cut). Re-enqueueing after an edit
 * REFRESHES payload + client_ts and resets status to pending, so the server
 * receives the latest state exactly once (LWW by client_ts, design §3).
 */
export async function enqueueMutation(
  q: Q,
  tenantId: string,
  entity: MutationEntity,
  clientUuid: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await assertWritable(q, tenantId);
  const envelope = mutationEnvelopeSchema.parse({
    client_uuid: clientUuid,
    client_ts: Date.now(),
    entity,
    payload,
  });
  await q.query(
    `INSERT INTO sync_log
       (id, tenant_id, client_uuid, entity, op, payload, status, client_ts)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     ON CONFLICT (tenant_id, client_uuid) DO UPDATE SET
       payload = excluded.payload,
       client_ts = excluded.client_ts,
       status = 'pending',
       attempts = 0,
       last_error = NULL,
       updated_at = now()`,
    [
      envelope.client_uuid,
      tenantId,
      envelope.client_uuid,
      envelope.entity,
      envelope.op,
      JSON.stringify(envelope.payload),
      envelope.client_ts,
    ],
  );
}

export async function pendingCount(db: Q, tenantId: string): Promise<number> {
  const res = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM sync_log
     WHERE tenant_id = $1 AND status IN ('pending', 'in_flight', 'failed')`,
    [tenantId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** Queue-only tenant count. Lifecycle checks MUST use unresolvedWork, which
 * also covers snapshots and foreign tenants. */
export async function unsyncedCount(db: Q, tenantId: string): Promise<number> {
  const res = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM sync_log
     WHERE tenant_id = $1 AND status <> 'synced'`,
    [tenantId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/* ------------------------------------------------------------------ */
/* catalog (D1-7)                                                      */
/* ------------------------------------------------------------------ */

export type LocalCategory = {
  icon_key?: ProductIconKey | null;
  id: string;
  client_uuid: string;
  name: string;
  active: boolean;
};

export type LocalProduct = {
  icon_key?: ProductIconKey | null;
  id: string;
  client_uuid: string;
  name: string;
  category_id: string | null;
  photo: string | null;
  active: boolean;
  variants: Array<{
    id: string;
    client_uuid: string;
    name: string;
    price: number;
    cost: number | null;
    code: string | null;
    stock: number;
    low_stock_threshold: number | null;
    active: boolean;
  }>;
};

export async function listProducts(
  db: Q,
  tenantId: string,
  opts: { active?: boolean } = {},
): Promise<LocalProduct[]> {
  const productRes = await db.query<{
    icon_key: ProductIconKey | null;
    id: string;
    client_uuid: string;
    name: string;
    category_id: string | null;
    photo: string | null;
    active: boolean;
  }>(
    opts.active === undefined
      ? `SELECT id, client_uuid, name, category_id, photo, icon_key, active FROM products WHERE tenant_id = $1 ORDER BY name`
      : `SELECT id, client_uuid, name, category_id, photo, icon_key, active FROM products WHERE tenant_id = $1 AND active = $2 ORDER BY name`,
    opts.active === undefined ? [tenantId] : [tenantId, opts.active],
  );
  const variantRes = await db.query<{
    id: string;
    client_uuid: string;
    product_id: string;
    name: string;
    price: number;
    cost: number | null;
    code: string | null;
    stock: number;
    low_stock_threshold: number | null;
    active: boolean;
  }>(
    `SELECT id, client_uuid, product_id, name, price, cost, code, stock, low_stock_threshold, active
     FROM product_variants WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  );
  return productRes.rows.map((p) => ({
    id: p.id,
    client_uuid: p.client_uuid,
    name: p.name,
    category_id: p.category_id,
    photo: p.photo,
    icon_key: p.icon_key,
    active: p.active,
    variants: variantRes.rows
      .filter((v) => v.product_id === p.id)
      .map(({ product_id: _productId, ...rest }) => rest),
  }));
}

export async function listCategories(
  db: Q,
  tenantId: string,
): Promise<LocalCategory[]> {
  const res = await db.query<LocalCategory>(
    `SELECT id, client_uuid, name, icon_key, active FROM categories
     WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  );
  return res.rows;
}

export async function createLocalCategory(
  db: PGlite,
  tenantId: string,
  input: { name: string; icon_key?: ProductIconKey | null },
): Promise<LocalCategory> {
  return tenantTx(db, tenantId, async (tx) => {
    const icon = productIconKeySchema.nullable().parse(input.icon_key ?? null);
    const id = newId();
    await tx.query(
      `INSERT INTO categories (id, tenant_id, client_uuid, name, icon_key, active)
       VALUES ($1, $2, $1, $3, $4, TRUE)`,
      [id, tenantId, input.name, icon],
    );
    await enqueueMutation(tx, tenantId, "category", id, {
      name: input.name,
      icon_key: icon,
      active: true,
    });
    return { id, client_uuid: id, name: input.name, icon_key: icon, active: true };
  });
}

export type SaleItem = {
  icon_key?: ProductIconKey | null;
  code?: string | null;
  id: string;
  product_id: string;
  product_name: string;
  name: string;
  price: number;
  cost: number | null;
  stock: number;
  active: boolean;
  category_id: string | null;
  photo: string | null;
};

export async function updateLocalCategory(db: PGlite, tenantId: string, id: string, patch: { name?: string; active?: boolean; icon_key?: ProductIconKey | null }) {
  return tenantTx(db, tenantId, async tx => {
    const current = (await tx.query<LocalCategory>("SELECT id,client_uuid,name,active,icon_key FROM categories WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, id])).rows[0];
    if (!current) return 0;
    const icon = productIconKeySchema.nullable().parse(patch.icon_key !== undefined ? patch.icon_key : current.icon_key);
    const name = patch.name ?? current.name;
    const active = patch.active ?? current.active;
    await tx.query("UPDATE categories SET name=$3,active=$4,icon_key=$5,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, id, name, active, icon]);
    await enqueueMutation(tx, tenantId, "category", current.client_uuid, { name, active, icon_key: icon });
    return 1;
  });
}

/** Sale flow view: active variants of active products (empty catalog → []). */
export async function listSaleItems(db: Q, tenantId: string): Promise<SaleItem[]> {
  const res = await db.query<{
    icon_key: ProductIconKey | null;
    id: string;
    product_id: string;
    product_name: string;
    name: string;
    price: number;
    cost: number | null;
    code: string | null;
    stock: number;
    active: boolean;
    product_active: boolean;
    category_id: string | null;
    photo: string | null;
  }>(
    `SELECT v.id, v.product_id, p.name AS product_name, v.name, v.price, v.cost, v.code, v.stock, v.active,
            p.active AS product_active, p.category_id, p.photo, p.icon_key
     FROM product_variants v
     JOIN products p ON p.id = v.product_id AND p.tenant_id = v.tenant_id
     WHERE v.tenant_id = $1 AND v.active = TRUE AND p.active = TRUE
     ORDER BY p.name, v.name`,
    [tenantId],
  );
  return res.rows.map(({ product_active: _pa, ...rest }) => rest);
}

export async function createLocalProduct(
  db: PGlite | Q,
  tenantId: string,
  input: {
    icon_key?: ProductIconKey | null;
    name: string;
    category_id?: string | null;
    photo?: string | null;
    variant: { name: string; price: number; code?: string | null; cost?: number | null; stock?: number };
  },
): Promise<LocalProduct> {
  return tenantTx(db, tenantId, async (tx) => {
    const productId = newId();
    const icon = productIconKeySchema.nullable().parse(input.icon_key ?? null);
    await assertLocalCategory(tx, tenantId, input.category_id);
    const code = variantCodeSchema.parse(input.variant.code ?? null);
    const variantId = newId();
    const stock = input.variant.stock ?? 0;
    const cost = input.variant.cost ?? null;

    await tx.query(
      `INSERT INTO products (id, tenant_id, client_uuid, name, category_id, photo, icon_key, active)
       VALUES ($1, $2, $1, $3, $4, $5, $6, TRUE)`,
      [productId, tenantId, input.name, input.category_id ?? null, input.photo ?? null, icon],
    );
    await tx.query(
      `INSERT INTO product_variants
         (id, tenant_id, client_uuid, product_id, name, price, cost, stock, code, low_stock_threshold, active)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, NULL, TRUE)`,
      [variantId, tenantId, productId, input.variant.name, input.variant.price, cost, stock, code],
    );
    if (stock !== 0) {
      const diaryId = newId();
      await tx.query(
        `INSERT INTO stockdiary (id, tenant_id, client_uuid, variant_id, delta, reason, note)
         VALUES ($1, $2, $1, $3, $4, 'initial', 'Stock inicial al crear la variante')`,
        [diaryId, tenantId, variantId, stock],
      );
      await enqueueMutation(tx, tenantId, "stockdiary", diaryId, {
        variant_id: variantId,
        delta: stock,
        reason: "initial",
        note: "Stock inicial al crear la variante",
      });
    }
    await tx.query(
      `INSERT INTO stockcurrent (id, tenant_id, variant_id, stock) VALUES ($1, $2, $3, $4)`,
      [newId(), tenantId, variantId, stock],
    );

    await enqueueMutation(tx, tenantId, "product", productId, {
      icon_key: icon,
      name: input.name,
      category_id: input.category_id ?? null,
      photo: input.photo ?? null,
      active: true,
    });
    await enqueueMutation(tx, tenantId, "variant", variantId, {
      product_id: productId,
      name: input.variant.name,
      code,
      price: input.variant.price,
      cost,
      stock,
      low_stock_threshold: null,
      active: true,
    });

    return {
      id: productId,
      icon_key: icon,
      client_uuid: productId,
      name: input.name,
      category_id: input.category_id ?? null,
      photo: input.photo ?? null,
      active: true,
      variants: [
        {
          id: variantId,
          client_uuid: variantId,
          name: input.variant.name,
          code,
          price: input.variant.price,
          cost,
          stock,
          low_stock_threshold: null,
          active: true,
        },
      ],
    };
  });
}

/** Extra size/price on an existing local product (catalog spec §Variants). */
export async function addLocalVariant(
  db: PGlite | Q,
  tenantId: string,
  productId: string,
  variant: { name: string; price: number; code?: string | null; cost?: number | null; stock?: number },
): Promise<{ id: string; stock: number } | null> {
  return tenantTx(db, tenantId, async (tx) => {
    const product = await tx.query<{ id: string }>(
      `SELECT id FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, productId],
    );
    if (!product.rows[0]) return null;

    const variantId = newId();
    const stock = variant.stock ?? 0;
    const code = variantCodeSchema.parse(variant.code ?? null);
    const cost = variant.cost ?? null;
    await tx.query(
      `INSERT INTO product_variants
         (id, tenant_id, client_uuid, product_id, name, price, cost, stock, code, low_stock_threshold, active)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, NULL, TRUE)`,
      [variantId, tenantId, productId, variant.name, variant.price, cost, stock, code],
    );
    if (stock !== 0) {
      const diaryId = newId();
      await tx.query(
        `INSERT INTO stockdiary (id, tenant_id, client_uuid, variant_id, delta, reason, note)
         VALUES ($1, $2, $1, $3, $4, 'initial', 'Stock inicial al crear la variante')`,
        [diaryId, tenantId, variantId, stock],
      );
      await enqueueMutation(tx, tenantId, "stockdiary", diaryId, {
        variant_id: variantId,
        delta: stock,
        reason: "initial",
        note: "Stock inicial al crear la variante",
      });
    }
    await tx.query(
      `INSERT INTO stockcurrent (id, tenant_id, variant_id, stock) VALUES ($1, $2, $3, $4)`,
      [newId(), tenantId, variantId, stock],
    );
    await enqueueMutation(tx, tenantId, "variant", variantId, {
      product_id: productId,
      name: variant.name,
      code,
      price: variant.price,
      cost,
      stock,
      low_stock_threshold: null,
      active: true,
    });
    return { id: variantId, stock };
  });
}

export async function updateLocalProduct(
  db: PGlite | Q,
  tenantId: string,
  productId: string,
  patch: {
    icon_key?: ProductIconKey | null;
    name?: string;
    category_id?: string | null;
    photo?: string | null;
    active?: boolean;
  },
): Promise<number> {
  return tenantTx(db, tenantId, async (tx) => {
    await assertLocalCategory(tx, tenantId, patch.category_id);
    const rows = await tx.query<{
      icon_key: ProductIconKey | null;
      client_uuid: string;
      name: string;
      category_id: string | null;
      photo: string | null;
      active: boolean;
    }>(
      `SELECT client_uuid, name, category_id, photo, icon_key, active FROM products
       WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, productId],
    );
    const current = rows.rows[0];
    if (!current) return 0;

    const nextName = patch.name ?? current.name;
    const nextCategoryId =
      patch.category_id !== undefined ? patch.category_id : current.category_id;
    const nextPhoto = patch.photo !== undefined ? patch.photo : current.photo;
    const nextActive = patch.active ?? current.active;
    const icon = productIconKeySchema.nullable().parse(patch.icon_key !== undefined ? patch.icon_key : current.icon_key);
    await tx.query(
      `UPDATE products SET name = $3, category_id = $4, photo = $5, active = $6, icon_key = $7, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, productId, nextName, nextCategoryId, nextPhoto, nextActive, icon],
    );
    await enqueueMutation(tx, tenantId, "product", current.client_uuid, {
      icon_key: icon,
      name: nextName,
      category_id: nextCategoryId,
      photo: nextPhoto,
      active: nextActive,
    });
    return 1;
  });
}

export async function updateLocalVariant(
  db: PGlite | Q,
  tenantId: string,
  variantId: string,
  patch: { name?: string; price?: number; code?: string | null; cost?: number | null; active?: boolean },
): Promise<number> {
  return tenantTx(db, tenantId, async (tx) => {
    const rows = await tx.query<{
      client_uuid: string;
      product_id: string;
      name: string;
      price: number;
      cost: number | null;
      stock: number;
      code: string | null;
      low_stock_threshold: number | null;
      active: boolean;
    }>(
      `SELECT client_uuid, product_id, name, price, cost, code, stock, low_stock_threshold, active
       FROM product_variants WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, variantId],
    );
    const current = rows.rows[0];
    if (!current) return 0;

    const next = {
      name: patch.name ?? current.name,
      price: patch.price ?? current.price,
      cost: patch.cost !== undefined ? patch.cost : current.cost,
      code: patch.code !== undefined ? variantCodeSchema.parse(patch.code) : current.code,
      active: patch.active ?? current.active,
    };
    await tx.query(
      `UPDATE product_variants SET name = $3, price = $4, cost = $5, active = $6, code = $7, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, variantId, next.name, next.price, next.cost, next.active, next.code],
    );
    await enqueueMutation(tx, tenantId, "variant", current.client_uuid, {
      product_id: current.product_id,
      name: next.name,
      price: next.price,
      cost: next.cost,
      code: next.code,
      stock: current.stock,
      low_stock_threshold: current.low_stock_threshold,
      active: next.active,
    });
    return 1;
  });
}

/** Manual stock adjustment: reason + note mandatory, auditable, atomic. */
export async function adjustLocalStock(
  db: PGlite | Q,
  tenantId: string,
  input: {
    variant_id: string;
    delta: number;
    reason: string;
    note: string;
  },
): Promise<{ stock: number } | null> {
  return tenantTx(db, tenantId, async (tx) => {
    const rows = await tx.query<{ stock: number; product_id: string; name: string; price: number; cost: number | null; code: string | null; active: boolean; low_stock_threshold: number | null }>(
      `SELECT stock, product_id, name, price, cost, code, active, low_stock_threshold FROM product_variants
       WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, input.variant_id],
    );
    const variant = rows.rows[0];
    if (!variant) return null;

    const diaryId = newId();
    await tx.query(
      `INSERT INTO stockdiary (id, tenant_id, client_uuid, variant_id, delta, reason, note)
       VALUES ($1, $2, $1, $3, $4, $5, $6)`,
      [diaryId, tenantId, input.variant_id, input.delta, input.reason, input.note],
    );
    await tx.query(
      `UPDATE product_variants SET stock = stock + $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.variant_id, input.delta],
    );
    await tx.query(
      `INSERT INTO stockcurrent (id, tenant_id, variant_id, stock)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, variant_id) DO UPDATE SET
         stock = stockcurrent.stock + excluded.stock, updated_at = now()`,
      [newId(), tenantId, input.variant_id, input.delta],
    );

    await enqueueMutation(tx, tenantId, "stockdiary", diaryId, {
      variant_id: input.variant_id,
      delta: input.delta,
      reason: input.reason,
      note: input.note,
    });
    const nextStock = variant.stock + input.delta;
    await enqueueMutation(tx, tenantId, "variant", input.variant_id, {
      product_id: variant.product_id,
      name: variant.name,
      price: variant.price,
      cost: variant.cost,
      code: variant.code,
      stock: nextStock,
      low_stock_threshold: variant.low_stock_threshold,
      active: variant.active,
    });

    return { stock: nextStock };
  });
}

/** One durable modal save: metadata, ALL variant edits and audited deltas, or nothing.
 * Deltas apply to current stock, never overwrite sales made while the editor was open.
 * Omitted fields/variants retain their current values and historical ticket costs.
 */
export async function saveLocalCatalogProduct(db: PGlite, tenantId: string, input: {
  id?: string;
  product: Parameters<typeof updateLocalProduct>[3] & { name: string };
  variants: Array<{ id?: string; name: string; price: number; cost: number | null; code: string | null; stock: number; reason?: string; note?: string }>;
}): Promise<string> {
  if (!input.variants.length) throw new Error("Agregá al menos una variante");
  if (!input.id && input.variants.some(v => v.id)) throw new Error("Variante no encontrada en este producto");
  const parsed = input.variants.map(v => ({ ...v, ...createProductInputSchema.shape.variant.parse(v) }));
  const product = createProductInputSchema.omit({ variant: true }).parse(input.product);
  return tenantTx(db, tenantId, async tx => {
    // Query-only facade deliberately reuses this transaction, not nested transactions.
    const q: Q = { query: tx.query.bind(tx) };
    let id = input.id;
    let start = 0;
    if (id) {
      if (!await updateLocalProduct(q, tenantId, id, { ...product, active: input.product.active })) throw new Error("Producto no encontrado");
    } else {
      id = (await createLocalProduct(q, tenantId, { ...product, variant: parsed[0] })).id;
      start = 1;
    }
    for (const v of parsed.slice(start)) {
      if (!v.id) {
        if (!await addLocalVariant(q, tenantId, id, v)) throw new Error("Producto no encontrado");
      } else {
        const belongs = await q.query("SELECT id FROM product_variants WHERE tenant_id=$1 AND product_id=$2 AND id=$3", [tenantId, id, v.id]);
        if (!belongs.rows.length) throw new Error("Variante no encontrada en este producto");
        await updateLocalVariant(q, tenantId, v.id, { name: v.name, price: v.price, cost: v.cost, code: v.code });
        if (v.stock !== 0) {
          const adjustment = adjustStockInputSchema.parse({ delta: v.stock, reason: v.reason, note: v.note });
          await adjustLocalStock(q, tenantId, { variant_id: v.id, ...adjustment });
        }
      }
    }
    return id;
  });
}

export async function recountLocal(
  db: Q,
  tenantId: string,
  variantId: string,
): Promise<number> {
  const res = await db.query<{ sum: string }>(
    `SELECT coalesce(sum(delta), 0) AS sum FROM stockdiary
     WHERE tenant_id = $1 AND variant_id = $2`,
    [tenantId, variantId],
  );
  return Number(res.rows[0]?.sum ?? 0);
}

/* ------------------------------------------------------------------ */
/* local sale skeleton (D1-8)                                          */
/* ------------------------------------------------------------------ */

export type LocalCustomer = {
  id: string; name: string; phone: string | null; notes: string | null;
  credit_limit: number | null; active: boolean; created_at: string;
};
type CustomerInput = { name: string; phone?: string | null; notes?: string | null; credit_limit: number | null; active?: boolean };

export async function createLocalCustomer(db: PGlite, tenantId: string, input: CustomerInput): Promise<LocalCustomer> {
  // New credit customers require an explicit limit; legacy rows remain readable.
  if (input.credit_limit == null) throw new Error("CREDIT_LIMIT_REQUIRED");
  const p = customerPayloadSchema.parse({ ...input, name: input.name.trim() });
  return tenantTx(db, tenantId, async tx => {
    const id = newId(), created_at = new Date().toISOString();
    const result = await tx.query<LocalCustomer>(`INSERT INTO customers
      (id,tenant_id,client_uuid,name,phone,notes,credit_limit,active,created_at)
      VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [id, tenantId, p.name, p.phone ?? null, p.notes ?? null, p.credit_limit, p.active, created_at]);
    await enqueueMutation(tx, tenantId, "customer", id, { ...p, created_at });
    return result.rows[0];
  });
}

export async function updateLocalCustomer(db: PGlite, tenantId: string, id: string, input: Partial<CustomerInput>): Promise<LocalCustomer> {
  return tenantTx(db, tenantId, async tx => {
    const old = (await tx.query<LocalCustomer>("SELECT * FROM customers WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0];
    if (!old) throw new Error("CUSTOMER_NOT_FOUND");
    const p = customerPayloadSchema.parse({ ...old, ...input, name: (input.name ?? old.name).trim(), created_at: new Date(old.created_at).toISOString() });
    const result = await tx.query<LocalCustomer>(`UPDATE customers SET name=$3,phone=$4,notes=$5,credit_limit=$6,active=$7,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId, id, p.name, p.phone, p.notes, p.credit_limit, p.active]);
    await enqueueMutation(tx, tenantId, "customer", id, p);
    return result.rows[0];
  });
}

export async function listLocalCustomers(db: Q, tenantId: string, search = ""): Promise<LocalCustomer[]> {
  const rows = (await db.query<LocalCustomer>("SELECT * FROM customers WHERE tenant_id=$1 AND active=TRUE ORDER BY name ASC,id ASC", [tenantId])).rows;
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const name = fold(search.trim()), digits = search.replace(/\D/g, "");
  return rows.filter(r => fold(r.name).includes(name) || (digits.length > 0 && (r.phone ?? "").replace(/\D/g, "").includes(digits))).slice(0, 20);
}

/** Full edit record, not the accounts/report projection (which omits notes). */
export async function getLocalCustomer(db: Q, tenantId: string, id: string): Promise<LocalCustomer | null> {
  return (await db.query<LocalCustomer>(
    "SELECT * FROM customers WHERE tenant_id=$1 AND id=$2", [tenantId, id],
  )).rows[0] ?? null;
}

export async function listCustomerAccounts(db: Q, tenantId: string) {
  return parseCustomerAccounts((await db.query(CUSTOMER_ACCOUNTS_SQL, [tenantId])).rows);
}
export async function listCustomerBalances(db: Q, tenantId: string) {
  return parseCustomerBalances((await db.query(CUSTOMER_BALANCES_SQL, [tenantId])).rows);
}
export async function customerAccountById(db: Q, tenantId: string, id: string) {
  const rows = (await db.query(CUSTOMER_ACCOUNT_BY_ID_SQL, [tenantId, id])).rows;
  return rows[0] ? { ...parseCustomerAccounts(rows)[0], active: rows[0].active === true } : null;
}
export async function listLocalCustomerTickets(db: Q, tenantId: string, id: string) {
  return (await db.query<LocalTicketRow & { credit_amount: number; attributed_abonos: number }>(`SELECT t.*,
    (SELECT COALESCE(SUM(p.amount),0)::int FROM payments p WHERE p.tenant_id=t.tenant_id AND p.ticket_id=t.id AND p.method='credit' AND p.status='confirmed') AS credit_amount,
    (SELECT COALESCE(SUM(a.amount),0)::int FROM credit_abonos a WHERE a.tenant_id=t.tenant_id AND a.customer_id=t.customer_id AND a.ticket_id=t.id) AS attributed_abonos,
    (SELECT string_agg(DISTINCT p.method, ',' ORDER BY p.method) FROM payments p WHERE p.tenant_id=t.tenant_id AND p.ticket_id=t.id) AS method
    FROM tickets t WHERE t.tenant_id=$1 AND t.customer_id=$2 ORDER BY t.created_at DESC`, [tenantId, id])).rows;
}

/**
 * Soft-deleted customers (active=FALSE). The Clientes management screen
 * needs them so staff can REACTIVATE (customers spec §soft-delete);
 * they stay out of the Venta picker and the active accounts grid.
 */
export async function listLocalInactiveCustomers(db: Q, tenantId: string): Promise<LocalCustomer[]> {
  const result = await db.query<LocalCustomer>(
    "SELECT * FROM customers WHERE tenant_id=$1 AND active=FALSE ORDER BY name ASC, id ASC",
    [tenantId],
  );
  return result.rows;
}

export type LocalAbonoRow = {
  id: string;
  amount: number;
  method: string;
  ticket_id: string | null;
  note: string | null;
  created_at: string;
};

/** Customer detail: their abonos — own table, never payments (abonos spec). */
export async function listLocalCustomerAbonos(db: Q, tenantId: string, customerId: string): Promise<LocalAbonoRow[]> {
  const result = await db.query<LocalAbonoRow>(
    `SELECT id, amount, method, ticket_id, note, created_at FROM credit_abonos
     WHERE tenant_id=$1 AND customer_id=$2 ORDER BY created_at DESC, id`,
    [tenantId, customerId],
  );
  return result.rows;
}

export async function registerLocalAbono(db: PGlite, tenantId: string, input: {
  customer_id: string; amount: number; method: "cash" | "transfer"; ticket_id?: string | null; note?: string | null;
}) {
  return tenantTx(db, tenantId, async tx => {
    const shift = await getOpenShiftLocal(tx, tenantId);
    if (!shift) throw new Error("SHIFT_REQUIRED");
    const p = creditAbonoPayloadSchema.parse({ ...input, shift_id: shift.id, created_at: new Date().toISOString() });
    const account = await customerAccountById(tx, tenantId, p.customer_id);
    if (!account) throw new Error("CUSTOMER_NOT_FOUND");
    if (p.amount > account.balance) throw new Error(`ABONO_EXCEEDS_BALANCE: ${account.balance}`);
    if (p.ticket_id) {
      const ticket = (await tx.query<{ customer_id: string | null }>("SELECT customer_id FROM tickets WHERE tenant_id=$1 AND id=$2", [tenantId, p.ticket_id])).rows[0];
      if (!ticket || (ticket.customer_id !== null && ticket.customer_id !== p.customer_id)) throw new Error("ABONO_TICKET_MISMATCH");
    }
    const id = newId();
    await tx.query(`INSERT INTO credit_abonos (id,tenant_id,client_uuid,customer_id,amount,method,shift_id,ticket_id,note,created_at)
      VALUES ($1,$2,$1,$3,$4,$5,$6,$7,$8,$9)`, [id, tenantId, p.customer_id, p.amount, p.method, p.shift_id, p.ticket_id ?? null, p.note ?? null, p.created_at]);
    await enqueueMutation(tx, tenantId, "credit_abono", id, p);
    return { id, ...p, balance: account.balance - p.amount };
  });
}

export type SaleLineInput = {
  variant_id: string;
  qty: number;
  unit_price: number;
};

export type CommittedSale = {
  ticket: {
    id: string;
    ticket_no: number;
    total: number;
    status: string;
    created_at: string;
  };
  lines: Array<{ id: string; qty: number; unit_price: number; subtotal: number }>;
  payments: Array<{
    id: string;
    method: string;
    amount: number;
    tendered: number | null;
    vuelto: number | null;
    status: string;
    confirmed_at: string | null;
  }>;
};

export type SaleCommitInput =
  | { lines: SaleLineInput[]; method?: "cash"; tendered: number }
  | { lines: SaleLineInput[]; method: "transfer" }
  | { lines: SaleLineInput[]; method: "credit"; customerId: string; cashAmount: number };

/**
 * ONE local transaction = ticket + lines + payment + shift lookup +
 * sync_log pending entries (D1-8 AC: atomic local-first, partial write
 * impossible; sales spec §Sale persistence is atomic and local-first).
 *
 * D2-6: cash (tendered ≥ total, vuelto) AND bank transfer (payment
 * `pending`, ticket `transfer_pending` until an owner confirms).
 *
 * D3-1 stock obligation: every stock change must keep enqueueing the
 * ABSOLUTE `variant` refresh next to its `stockdiary` entry (server
 * balances come from the variant payload — see api db/sync-apply.ts).
 */
export async function commitLocalSale(
  db: PGlite,
  tenantId: string,
  input: SaleCommitInput,
): Promise<CommittedSale> {
  const total = assertCheckoutable(
    input.lines.map((l) => ({ price: l.unit_price, qty: l.qty })),
  ); // throws EMPTY_CART

  // roles-admin 3.8 · oversell LOCAL guard (spec settings §Oversell disabled
  // blocks both layers): when the cached toggle forbids negative stock,
  // every line is pre-checked against its FOR UPDATE stock read and the sale
  // dies with "NEGATIVE_STOCK" before any row commits (whole tx rolls back).
  // Cache is a hint only — the server re-checks at sync apply (3.7).
  // SALES ONLY: manual catalog adjustments stay unrestricted (explicit
  // non-goal). Absent/corrupt cache → defaults → oversell allowed (today).
  const blockNegativeStock = readSettingsCache(tenantId).allow_negative_stock === false;

  const isTransfer = input.method === "transfer";
  const isCredit = input.method === "credit";
  let tendered: number | null = null;
  let vuelto: number | null = null;
  if (!isTransfer && !isCredit) {
    // cash: tendered ≥ total required (throws UNDERPAYMENT)
    vuelto = computeVuelto(total, input.tendered);
    tendered = input.tendered;
  }

  return tenantTx(db, tenantId, async (tx) => {
    let customerId: string | null = null;
    if (input.method === "credit") {
      if (!input.customerId) throw new Error("CREDIT_CUSTOMER_REQUIRED");
      if (!Number.isInteger(input.cashAmount) || input.cashAmount < 0 || input.cashAmount >= total)
        throw new Error("MIXED_AMOUNT_INVALID");
      const account = await customerAccountById(tx, tenantId, input.customerId);
      if (!account?.active) throw new Error("CREDIT_CUSTOMER_REQUIRED");
      if (account.credit_limit === null) throw new Error("CREDIT_LIMIT_REQUIRED");
      if (account.balance + total - input.cashAmount > account.credit_limit) throw new Error("CREDIT_LIMIT_EXCEEDED");
      customerId = input.customerId;
    }
    const noRes = await tx.query<{ next: string }>(
      `SELECT coalesce(max(ticket_no), 0) + 1 AS next FROM tickets WHERE tenant_id = $1`,
      [tenantId],
    );
    const ticketNo = Number(noRes.rows[0]?.next ?? 1);

    const shiftRes = await tx.query<{ id: string }>(
      `SELECT id FROM shifts WHERE tenant_id = $1 AND status = 'open' LIMIT 1`,
      [tenantId],
    );
    const shiftId = shiftRes.rows[0]?.id ?? null;

    const createdAt = new Date().toISOString();
    const ticketStatus = isTransfer ? "transfer_pending" : "completed";
    const paymentStatus = isTransfer ? "pending" : "confirmed";

    const ticketId = newId();
    await tx.query(
      `INSERT INTO tickets (id, tenant_id, client_uuid, shift_id, ticket_no, status, total, created_at, customer_id)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8)`,
      [ticketId, tenantId, shiftId, ticketNo, ticketStatus, total, createdAt, customerId],
    );

    const lines: CommittedSale["lines"] = [];
    for (const line of input.lines) {
      /* Cost is captured HERE, at sale time — historical COGS never follows
         later edits to the variant's cost (audit: historical costs). */
      const vRes = await tx.query<{
        product_id: string;
        name: string;
        price: number;
        cost: number | null;
        code: string | null;
        stock: number;
        low_stock_threshold: number | null;
        active: boolean;
      }>(
        `SELECT product_id, name, price, cost, code, stock, low_stock_threshold, active
         FROM product_variants WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, line.variant_id],
      );
      const variant = vRes.rows[0];
      // roles-admin 3.8 · per-line pre-check (sales only). The FOR UPDATE
      // read above is authoritative, so two lines of the same variant are
      // checked against the running balance; a hit throws before THIS line
      // writes and the surrounding tenantTx rolls everything back.
      if (blockNegativeStock && variant && variant.stock - line.qty < 0) {
        throw new Error("NEGATIVE_STOCK");
      }
      const unitCost = variant?.cost ?? null;

      const lineId = newId();
      const subtotal = lineSubtotal(line.unit_price, line.qty);
      await tx.query(
        `INSERT INTO ticket_lines
           (id, tenant_id, client_uuid, ticket_id, variant_id, qty, unit_price, subtotal, unit_cost, created_at)
         VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, $9)`,
        [lineId, tenantId, ticketId, line.variant_id, line.qty, line.unit_price, subtotal, unitCost, createdAt],
      );
      lines.push({
        id: lineId,
        qty: line.qty,
        unit_price: line.unit_price,
        subtotal,
      });
      await enqueueMutation(tx, tenantId, "ticket_line", lineId, {
        ticket_id: ticketId,
        variant_id: line.variant_id,
        qty: line.qty,
        unit_price: line.unit_price,
        subtotal,
        unit_cost: unitCost,
        created_at: createdAt,
      });

      /* ---- D3-1: stock movement for THIS sale line, same local tx ---- */
      if (variant) {
        const nextStock = variant.stock - line.qty;
        const diaryId = newId();
        const note = `Venta #${ticketNo}`;
        await tx.query(
          `INSERT INTO stockdiary
             (id, tenant_id, client_uuid, variant_id, delta, reason, note, ref_ticket_id, created_at)
           VALUES ($1, $2, $1, $3, $4, 'sale', $5, $6, $7)`,
          [diaryId, tenantId, line.variant_id, -line.qty, note, ticketId, createdAt],
        );
        await tx.query(
          `UPDATE product_variants SET stock = stock + $3, updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, line.variant_id, -line.qty],
        );
        await tx.query(
          `INSERT INTO stockcurrent (id, tenant_id, variant_id, stock)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, variant_id) DO UPDATE SET
             stock = stockcurrent.stock + excluded.stock, updated_at = now()`,
          [newId(), tenantId, line.variant_id, -line.qty],
        );
        // movement + ABSOLUTE stock refresh travel together (server groups
        // both into the sale tx via ref_ticket_id — api db/sync-apply.ts)
        await enqueueMutation(tx, tenantId, "stockdiary", diaryId, {
          variant_id: line.variant_id,
          delta: -line.qty,
          reason: "sale",
          note,
          ref_ticket_id: ticketId,
          created_at: createdAt,
        });
        await enqueueMutation(tx, tenantId, "variant", line.variant_id, {
          product_id: variant.product_id,
          name: variant.name,
          price: variant.price,
          cost: variant.cost,
          code: variant.code,
          stock: nextStock,
          low_stock_threshold: variant.low_stock_threshold,
          active: variant.active,
          ref_ticket_id: ticketId,
        });
      }
    }

    const payments: CommittedSale["payments"] = input.method === "credit"
      ? [
        ...(input.cashAmount > 0 ? [{ id: newId(), method: "cash", amount: input.cashAmount, tendered: input.cashAmount, vuelto: 0, status: "confirmed", confirmed_at: null }] : []),
        { id: newId(), method: "credit", amount: total - input.cashAmount, tendered: null, vuelto: null, status: "confirmed", confirmed_at: null },
      ]
      : [{ id: newId(), method: isTransfer ? "transfer" : "cash", amount: total, tendered, vuelto, status: paymentStatus, confirmed_at: null }];
    for (const payment of payments) {
    await tx.query(
      `INSERT INTO payments
         (id, tenant_id, client_uuid, ticket_id, method, amount, tendered, vuelto, status, shift_id, created_at)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        payment.id,
        tenantId,
        ticketId,
        payment.method,
        payment.amount,
        payment.tendered,
        payment.vuelto,
        payment.status,
        shiftId,
        createdAt,
      ],
    );
    await enqueueMutation(tx, tenantId, "payment", payment.id, {
      ticket_id: ticketId, method: payment.method, amount: payment.amount,
      tendered: payment.tendered, vuelto: payment.vuelto, status: payment.status,
      shift_id: shiftId, created_at: createdAt,
    });
    }

    await enqueueMutation(tx, tenantId, "ticket", ticketId, {
      shift_id: shiftId,
      ticket_no: ticketNo,
      status: ticketStatus,
      total,
      customer_id: customerId,
      created_at: createdAt,
    });

    return {
      ticket: {
        id: ticketId,
        ticket_no: ticketNo,
        total,
        status: ticketStatus,
        created_at: createdAt,
      },
      lines,
      payments,
    };
  });
}

/**
 * Owner-confirmed transfer (local side of D2-6). The ROLE check lives on
 * the server (`POST /api/payments/:id/confirm`) — the UI calls that first
 * and only mirrors the result here, refreshing the queue entries so the
 * server ledger and local state stay in step (LWW by client_ts).
 *
 * Strict transition: only `pending` may confirm — anything else throws
 * (ALREADY_CONFIRMED / NOT_FOUND): no silent revert (sales spec).
 */
export async function confirmLocalPayment(
  db: PGlite,
  tenantId: string,
  paymentId: string,
  confirmedAtIso?: string,
): Promise<{ payment: CommittedSale["payments"][number]; confirmed_at: string }> {
  return tenantTx(db, tenantId, async (tx) => {
    const payRes = await tx.query<{
      id: string;
      client_uuid: string;
      ticket_id: string;
      method: string;
      amount: number;
      tendered: number | null;
      vuelto: number | null;
      status: string;
      shift_id: string | null;
    }>(
      `SELECT id, client_uuid, ticket_id, method, amount, tendered, vuelto, status, shift_id
       FROM payments WHERE tenant_id = $1 AND id = $2`,
      [tenantId, paymentId],
    );
    const payment = payRes.rows[0];
    if (!payment) throw new Error("NOT_FOUND");
    if (payment.status !== "pending") throw new Error("ALREADY_CONFIRMED");

    const confirmedAt = confirmedAtIso ?? new Date().toISOString();
    await tx.query(
      `UPDATE payments SET status = 'confirmed', confirmed_at = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, paymentId, confirmedAt],
    );
    await tx.query(
      `UPDATE tickets SET status = 'completed', updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND status = 'transfer_pending'`,
      [tenantId, payment.ticket_id],
    );

    // refresh both queue entries with the confirmed state (upsert-latest)
    await enqueueMutation(tx, tenantId, "payment", payment.client_uuid, {
      ticket_id: payment.ticket_id,
      method: payment.method,
      amount: payment.amount,
      tendered: payment.tendered,
      vuelto: payment.vuelto,
      status: "confirmed",
      shift_id: payment.shift_id,
      confirmed_at: confirmedAt,
    });
    const ticketRes = await tx.query<{
      client_uuid: string;
      shift_id: string | null;
      ticket_no: number;
      total: number;
    }>(
      `SELECT client_uuid, shift_id, ticket_no, total
       FROM tickets WHERE tenant_id = $1 AND id = $2`,
      [tenantId, payment.ticket_id],
    );
    const ticket = ticketRes.rows[0];
    if (ticket) {
      await enqueueMutation(tx, tenantId, "ticket", ticket.client_uuid, {
        shift_id: ticket.shift_id,
        ticket_no: ticket.ticket_no,
        status: "completed",
        total: ticket.total,
      });
    }

    return {
      payment: {
        id: payment.id,
        method: payment.method,
        amount: payment.amount,
        tendered: payment.tendered,
        vuelto: payment.vuelto,
        status: "confirmed",
        confirmed_at: confirmedAt,
      },
      confirmed_at: confirmedAt,
    };
  });
}

export type LocalTicketRow = {
  id: string;
  ticket_no: number;
  total: number;
  status: string;
  created_at: string;
  method: string | null;
  pay_status: string | null;
  tendered: number | null;
  vuelto: number | null;
  void_reason?: string | null;
  voided_at?: string | null;
  /** Product names on the ticket — powers search without opening detail. */
  items?: string;
  /** Credit customer link (M5): receipt header + Tickets search by client. */
  customer_id?: string | null;
  customer_name?: string | null;
};

const TICKET_PAYMENT_COLUMNS = `
 (SELECT string_agg(DISTINCT p.method, ',' ORDER BY p.method) FROM payments p WHERE p.tenant_id=t.tenant_id AND p.ticket_id=t.id) AS method,
 (SELECT p.status FROM payments p WHERE p.tenant_id=t.tenant_id AND p.ticket_id=t.id ORDER BY (p.method='transfer') DESC,p.id LIMIT 1) AS pay_status,
 (SELECT p.tendered FROM payments p WHERE p.tenant_id=t.tenant_id AND p.ticket_id=t.id AND p.method='cash' LIMIT 1) AS tendered,
 (SELECT p.vuelto FROM payments p WHERE p.tenant_id=t.tenant_id AND p.ticket_id=t.id AND p.method='cash' LIMIT 1) AS vuelto`;

/* M5: customer link travels with the row — receipt header, "Ver cuenta"
 * hand-off and Tickets search by client (prototype: buscar por cliente). */
const TICKET_CUSTOMER_COLUMNS = `
 t.customer_id,
 (SELECT c.name FROM customers c WHERE c.tenant_id=t.tenant_id AND c.id=t.customer_id) AS customer_name`;

/* Items as "qty× name" per line, in line order — the Ítems column shows
 * quantities (prototype) and search still matches product names. */
const TICKET_ITEMS_COLUMN = `
 (
   SELECT string_agg(
            trim(tl.qty || '× ' || trim(COALESCE(pr.name, '') || ' ' || COALESCE(v.name, ''))),
            ', ' ORDER BY tl.created_at, tl.id)
   FROM ticket_lines tl
   JOIN product_variants v ON v.id = tl.variant_id
   JOIN products pr ON pr.id = v.product_id
   WHERE tl.ticket_id = t.id
 ) AS items`;

export async function listLocalTickets(
  db: Q,
  tenantId: string,
  limit = 100,
  status?: "voided",
): Promise<LocalTicketRow[]> {
  const res = await db.query<LocalTicketRow>(
    `SELECT t.id, t.ticket_no, t.total, t.status, t.created_at,
            ${TICKET_PAYMENT_COLUMNS},
            ${TICKET_CUSTOMER_COLUMNS},
            ${TICKET_ITEMS_COLUMN}
     FROM tickets t
     WHERE t.tenant_id = $1 AND ($3::text IS NULL OR t.status = $3)
     ORDER BY t.created_at DESC
     LIMIT $2`,
    [tenantId, limit, status ?? null],
  );
  return res.rows;
}

export async function getLocalTicket(
  db: Q,
  tenantId: string,
  ticketId: string,
): Promise<{
  ticket: LocalTicketRow;
  lines: Array<{
    id: string;
    qty: number;
    unit_price: number;
    subtotal: number;
    variant_id: string;
    variant_name: string | null;
    product_name: string | null;
  }>;
  payment_id: string | null;
  payments: CommittedSale["payments"];
  /** false while the payment's queue entry has not synced yet (D2-6 gate). */
  payment_synced: boolean;
} | null> {
  const ticket = await db.query<LocalTicketRow>(
    `SELECT t.id, t.ticket_no, t.total, t.status, t.created_at,
            (SELECT p.id FROM payments p WHERE p.tenant_id=t.tenant_id AND p.ticket_id=t.id AND p.method='transfer' LIMIT 1) AS payment_id,
            ${TICKET_PAYMENT_COLUMNS},
            ${TICKET_CUSTOMER_COLUMNS},
            (SELECT note FROM stockdiary d WHERE d.tenant_id=t.tenant_id AND d.ref_ticket_id=t.id AND d.reason='sale_void' ORDER BY created_at LIMIT 1) AS void_reason,
            (SELECT created_at FROM stockdiary d WHERE d.tenant_id=t.tenant_id AND d.ref_ticket_id=t.id AND d.reason='sale_void' ORDER BY created_at LIMIT 1) AS voided_at
     FROM tickets t
     WHERE t.tenant_id = $1 AND t.id = $2`,
    [tenantId, ticketId],
  );
  if (!ticket.rows[0]) return null;
  const row = ticket.rows[0] as LocalTicketRow & { payment_id: string | null };
  const lines = await db.query<{
    id: string;
    qty: number;
    unit_price: number;
    subtotal: number;
    variant_id: string;
    variant_name: string | null;
    product_name: string | null;
  }>(
    `SELECT l.id, l.qty, l.unit_price, l.subtotal, l.variant_id,
            v.name AS variant_name, p.name AS product_name
     FROM ticket_lines l
     LEFT JOIN product_variants v ON v.id = l.variant_id
     LEFT JOIN products p ON p.id = v.product_id
     WHERE l.tenant_id = $1 AND l.ticket_id = $2`,
    [tenantId, ticketId],
  );
  let paymentSynced = true;
  if (row.payment_id) {
    const sync = await db.query<{ status: string }>(
      `SELECT status FROM sync_log WHERE tenant_id = $1 AND client_uuid = $2`,
      [tenantId, row.payment_id],
    );
    paymentSynced =
      !sync.rows[0] || sync.rows[0].status === "synced";
  }
  const { payment_id: paymentId, ...ticketRow } = row;
  return {
    ticket: ticketRow,
    lines: lines.rows,
    payment_id: paymentId,
    payments: (await db.query<CommittedSale["payments"][number]>("SELECT id,method,amount,tendered,vuelto,status,confirmed_at FROM payments WHERE tenant_id=$1 AND ticket_id=$2 ORDER BY method,id", [tenantId, ticketId])).rows,
    payment_synced: paymentSynced,
  };
}

/* ------------------------------------------------------------------ */
/* shifts + arqueo (D3-2) — offline close = SAME SQL as the server     */
/* ------------------------------------------------------------------ */

export type LocalShift = {
  opening_cash: number;
  opened_by: string | null;
  calculation_version: "legacy_v1" | "drawer_cash_v2";
  id: string;
  client_uuid: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
};

export type LocalClosedCash = {
  sync_pending?: boolean;
  closing_note: string | null;
  calculation_version: string;
  id: string;
  shift_id: string;
  expected: number;
  counted: number;
  diff: number;
  closed_by: string | null;
  created_at: string;
};

const SHIFT_COLS = "id, client_uuid, status, opened_at, closed_at, opening_cash, opened_by, calculation_version";

export async function getOpenShiftLocal(
  db: Q,
  tenantId: string,
): Promise<LocalShift | null> {
  const res = await db.query<LocalShift>(
    `SELECT ${SHIFT_COLS} FROM shifts
     WHERE tenant_id = $1 AND status = 'open' LIMIT 1`,
    [tenantId],
  );
  return res.rows[0] ?? null;
}

/** Offline open: create locally + enqueue (server rejects a 2nd open shift). */
export async function openLocalShift(
  db: PGlite,
  tenantId: string,
  opts: { client_uuid?: string; opening_cash?: number; opened_by?: string | null; calculation_version?: "legacy_v1" | "drawer_cash_v2" } = {},
): Promise<LocalShift> {
  return tenantTx(db, tenantId, async (tx) => {
    const open = await tx.query<{ id: string }>(
      `SELECT id FROM shifts WHERE tenant_id = $1 AND status = 'open' LIMIT 1`,
      [tenantId],
    );
    if (open.rows[0]) throw new Error("SHIFT_ALREADY_OPEN");
    const id = opts.client_uuid ?? newId();
    const payload = mutationEnvelopeSchema.parse({ entity: "shift", client_uuid: id, client_ts: Date.now(), payload: {
      status: "open", opened_at: new Date().toISOString(), opening_cash: opts.opening_cash ?? 0,
      opened_by: opts.opened_by ?? null, calculation_version: opts.calculation_version ?? "drawer_cash_v2",
    } }).payload as { status: "open"; opened_at: string; opening_cash: number; opened_by: string | null; calculation_version: "legacy_v1" | "drawer_cash_v2" };
    await tx.query(
      `INSERT INTO shifts (id, tenant_id, client_uuid, status, opened_at, opening_cash, opened_by, calculation_version)
       VALUES ($1, $2, $1, 'open', $3, $4, $5, $6)`,
      [id, tenantId, payload.opened_at, payload.opening_cash, payload.opened_by, payload.calculation_version],
    );
    await enqueueMutation(tx, tenantId, "shift", id, payload);
    return {
      ...payload,
      id,
      client_uuid: id,
      status: "open",
      opened_at: payload.opened_at,
      closed_at: null,
    };
  });
}

/**
 * Mirror the SERVER's open shift into the cache (online path) WITHOUT a
 * queue entry: the server already holds the row — pushing it back would be
 * a no-op. Keeps the local sale's shift lookup in step with the server.
 */
export async function mirrorOpenShift(
  db: PGlite,
  tenantId: string,
  shift: {
    id: string;
    status?: string;
    opened_at?: string | Date | null;
    closed_at?: string | Date | null;
    opening_cash?: number;
    opened_by?: string | null;
    calculation_version?: string;
  },
): Promise<boolean> {
  return tenantTx(db, tenantId, async (tx) => {
    const open = await tx.query<{ id: string }>(
      `SELECT id FROM shifts WHERE tenant_id = $1 AND status = 'open' LIMIT 1`,
      [tenantId],
    );
    if (open.rows[0]) return false;
    await tx.query(
      `INSERT INTO shifts (id, tenant_id, client_uuid, status, opened_at, closed_at, opening_cash, opened_by, calculation_version)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8)
       ON CONFLICT DO NOTHING`,
      [
        shift.id,
        tenantId,
        shift.status ?? "open",
        shift.opened_at ? new Date(shift.opened_at).toISOString() : new Date().toISOString(),
        shift.closed_at ? new Date(shift.closed_at).toISOString() : null,
        shift.opening_cash ?? 0, shift.opened_by ?? null, shift.calculation_version ?? "legacy_v1",
      ],
    );
    return true;
  });
}

/**
 * Expected from payments — byte-identical SQL to the server close path
 * (@pos/shared EXPECTED_FROM_PAYMENTS_SQL), so local == server by
 * construction and the D3-3 reconciliation test proves it with data.
 */
export async function computeLocalExpected(
  db: Q,
  tenantId: string,
  shiftId: string,
): Promise<ExpectedBreakdown> {
  const res = await db.query<Record<string, unknown>>(
    EXPECTED_FROM_PAYMENTS_SQL,
    [tenantId, shiftId],
  );
  return parseExpectedRow(res.rows[0]);
}

/** The online close must not persist before this device's shift evidence ACKs. */
export async function hasPendingShiftEvidence(db: Q, tenantId: string, shiftId: string): Promise<boolean> {
  const result = await db.query<{ pending: boolean }>(`SELECT EXISTS(
    SELECT 1 FROM sync_log WHERE tenant_id=$1 AND status<>'synced' AND
      ((entity IN ('ticket','payment','credit_abono','cash_movement') AND payload->>'shift_id'=$2)
       OR (entity='shift' AND client_uuid=$2::uuid))
    UNION ALL SELECT 1 FROM sync_sale_outbox o WHERE o.tenant_id=$1 AND EXISTS(
      SELECT 1 FROM jsonb_array_elements(o.rows) r WHERE r->'payload'->>'shift_id'=$2)
    ) AS pending`, [tenantId, shiftId]);
  return result.rows[0].pending;
}

/**
 * Offline close (D3-2): expected computed from LOCAL payments with the
 * shared SQL, `counted` is the only manual figure, diff derived, closedcash
 * immutable (ON CONFLICT DO NOTHING) — both mutations enqueue for sync.
 * Throws NO_OPEN_SHIFT / NEGATIVE_COUNTED / ALREADY_CLOSED.
 */
export async function closeLocalShift(
  db: PGlite,
  tenantId: string,
  input: { counted: number; closedBy?: string | null; closingNote?: string | null },
): Promise<{
  closedcash: LocalClosedCash;
  expected: ExpectedBreakdown;
  diff: number;
}> {
  const counted = countedSchema.safeParse(input.counted);
  if (!counted.success) throw new Error("NEGATIVE_COUNTED");
  if (input.closingNote != null && input.closingNote.length > 500) throw new Error("INVALID_CLOSING_NOTE");

  return tenantTx(db, tenantId, async (tx) => {
    const open = await tx.query<LocalShift>(
      `SELECT ${SHIFT_COLS} FROM shifts
       WHERE tenant_id = $1 AND status = 'open' LIMIT 1 FOR UPDATE`,
      [tenantId],
    );
    const shift = open.rows[0];
    if (!shift) throw new Error("NO_OPEN_SHIFT");

    const expected = await computeLocalExpected(tx, tenantId, shift.id);
    const diff = arqueoDiff(counted.data, expected.expected);
    const closedAt = new Date().toISOString();
    const id = newId();

    const inserted = await tx.query<LocalClosedCash>(
      `INSERT INTO closedcash
         (id, tenant_id, client_uuid, shift_id, expected, counted, diff, closed_by, closing_note, calculation_version)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, shift_id) DO NOTHING
       RETURNING id, shift_id, expected, counted, diff, closed_by, created_at`,
       [id, tenantId, shift.id, expected.expected, counted.data, diff, input.closedBy ?? null, input.closingNote ?? null, shift.calculation_version],
    );
    if (!inserted.rows[0]) throw new Error("ALREADY_CLOSED");

    await tx.query(
      `UPDATE shifts SET status = 'closed', closed_at = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, shift.id, closedAt],
    );

    await enqueueMutation(tx, tenantId, "closedcash", id, {
      closing_note: input.closingNote ?? null,
      calculation_version: shift.calculation_version,
      shift_id: shift.id,
      expected: expected.expected,
      counted: counted.data,
      diff,
      closed_by: input.closedBy ?? null,
    });
    await enqueueMutation(tx, tenantId, "shift", shift.client_uuid, {
      opening_cash: shift.opening_cash,
      opened_by: shift.opened_by,
      calculation_version: shift.calculation_version,
      status: "closed",
      opened_at: new Date(shift.opened_at).toISOString(),
      closed_at: closedAt,
    });

    return {
      closedcash: {
        closing_note: input.closingNote ?? null,
        calculation_version: shift.calculation_version,
        id,
        shift_id: shift.id,
        expected: expected.expected,
        counted: counted.data,
        diff,
        closed_by: input.closedBy ?? null,
        created_at: closedAt,
      },
      expected,
      diff,
    };
  });
}

/**
 * Mirror a SERVER close into the cache without queueing: the server already
 * computed + persisted the row (online path), so there is nothing to push.
 */
export async function mirrorServerClose(
  db: PGlite,
  tenantId: string,
  row: {
    id: string;
    client_uuid?: string;
    shift_id: string;
    expected: number;
    counted: number;
    diff: number;
    closed_by?: string | null;
    closing_note?: string | null;
    calculation_version?: string;
    created_at?: string;
  },
): Promise<void> {
  await tenantTx(db, tenantId, async (tx) => {
    await tx.query(
      `INSERT INTO closedcash
          (id, tenant_id, client_uuid, shift_id, expected, counted, diff, closed_by, closing_note, calculation_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11::timestamptz, now()))
       ON CONFLICT DO NOTHING`,
      [
        row.id,
        tenantId,
        row.client_uuid ?? row.id,
        row.shift_id,
        row.expected,
        row.counted,
        row.diff,
        row.closed_by ?? null,
        row.closing_note ?? null, row.calculation_version ?? "legacy_v1",
        row.created_at ?? null,
      ],
    );
    await tx.query(
      `UPDATE shifts SET status = 'closed', closed_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, row.shift_id],
    );
  });
}

/** Arqueo history (newest first). */
export async function listLocalClosedCash(
  db: Q,
  tenantId: string,
  limit = 20,
): Promise<LocalClosedCash[]> {
  const res = await db.query<LocalClosedCash>(
    `SELECT c.id, c.shift_id, c.expected, c.counted, c.diff, c.closed_by, c.created_at, c.closing_note, c.calculation_version,
       EXISTS(SELECT 1 FROM sync_log l WHERE l.tenant_id=c.tenant_id AND l.entity='closedcash'
         AND l.client_uuid=c.client_uuid AND l.status<>'synced') AS sync_pending
     FROM closedcash c WHERE c.tenant_id = $1
     ORDER BY c.created_at DESC, c.id DESC LIMIT $2`,
    [tenantId, limit],
  );
  return res.rows;
}

/** Append-only drawer ledger, committed atomically with its queue entry. */
export async function registerLocalCashMovement(db: PGlite, tenantId: string, input: {
  direction: "in" | "out"; amount: number; reason: string; note?: string | null;
}) {
  return tenantTx(db, tenantId, async tx => {
    const shift = await getOpenShiftLocal(tx, tenantId);
    if (!shift) throw new Error("SHIFT_REQUIRED");
    const id = newId();
    const payload = cashMovementPayloadSchema.parse({ ...input, shift_id: shift.id, created_at: new Date().toISOString() });
    await tx.query(`INSERT INTO cash_movements(id,tenant_id,client_uuid,shift_id,direction,amount,reason,note,created_at)
      VALUES($1,$2,$1,$3,$4,$5,$6,$7,$8)`,
    [id, tenantId, shift.id, payload.direction, payload.amount, payload.reason, payload.note ?? null, payload.created_at]);
    await enqueueMutation(tx, tenantId, "cash_movement", id, payload);
    return { id, ...payload };
  });
}

export type LocalCashMovement = {
  id: string; direction: "in" | "out"; amount: number; reason: string; note: string | null; created_at: string;
};

export async function listLocalCashMovements(db: Q, tenantId: string, shiftId: string): Promise<LocalCashMovement[]> {
  return (await db.query<LocalCashMovement>(`SELECT id,direction,amount,reason,note,created_at FROM cash_movements WHERE tenant_id=$1 AND shift_id=$2 ORDER BY created_at DESC, id DESC`, [tenantId, shiftId])).rows;
}

/** Bank collections are disclosed separately; never added to drawer expected. */
export async function localShiftTransferAbonos(db: Q, tenantId: string, shiftId: string): Promise<number> {
  const result = await db.query<{ amount: string | number }>(
    `SELECT COALESCE(SUM(amount),0) AS amount FROM credit_abonos WHERE tenant_id=$1 AND shift_id=$2 AND method='transfer'`,
    [tenantId, shiftId],
  );
  return Number(result.rows[0].amount);
}

/**
 * D4-4 · Sign-out / tenant switch partitioning (tenancy-auth §Session data
 * is tenant-partitioned locally): wipe acknowledged business rows only.
 * The caller ends auth first, with the durable write seal held throughout.
 */
export async function clearLocalBusinessData(db: PGlite): Promise<void> {
  await db.transaction(async (tx) => {
    // Check and delete in ONE transaction; includes every tenant and every
    // non-ACK status, including poison, unknown states and orphan snapshots.
    await tx.query("UPDATE local_vault SET sealed=true WHERE id=1");
    if (await unresolvedWork(tx)) throw new Error("unacknowledged_local_work");
    for (const table of BUSINESS_TABLES) {
      await tx.query(`DELETE FROM ${table}`);
    }
  });
}

/**
 * D4-4 · First-boot empty-cache detection: a fresh device (or post sign-out
 * wipe) against a populated server must rehydrate BEFORE the first sale so
 * ticket_no continues the server sequence (avoids unique(tenant, ticket_no)
 * collision — D2 risk note).
 */
export async function isLocalCacheEmpty(db: Q, tenantId: string): Promise<boolean> {
  const res = await db.query<{ products: string; tickets: string }>(
    `SELECT
       (SELECT count(*) FROM products WHERE tenant_id = $1)::text AS products,
       (SELECT count(*) FROM tickets WHERE tenant_id = $1)::text AS tickets`,
    [tenantId],
  );
  const row = res.rows[0];
  return Number(row?.products ?? 0) === 0 && Number(row?.tickets ?? 0) === 0;
}
