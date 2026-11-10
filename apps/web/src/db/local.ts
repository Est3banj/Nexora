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
} from "@pos/shared";
import { localTx, type LocalQueryable } from "./pglite";

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

/** Anything not yet synced — used by the datadir-upgrade flush check (D2-8). */
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
  id: string;
  client_uuid: string;
  name: string;
  active: boolean;
};

export type LocalProduct = {
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
    id: string;
    client_uuid: string;
    name: string;
    category_id: string | null;
    photo: string | null;
    active: boolean;
  }>(
    opts.active === undefined
      ? `SELECT id, client_uuid, name, category_id, photo, active FROM products WHERE tenant_id = $1 ORDER BY name`
      : `SELECT id, client_uuid, name, category_id, photo, active FROM products WHERE tenant_id = $1 AND active = $2 ORDER BY name`,
    opts.active === undefined ? [tenantId] : [tenantId, opts.active],
  );
  const variantRes = await db.query<{
    id: string;
    client_uuid: string;
    product_id: string;
    name: string;
    price: number;
    cost: number | null;
    stock: number;
    low_stock_threshold: number | null;
    active: boolean;
  }>(
    `SELECT id, client_uuid, product_id, name, price, cost, stock, low_stock_threshold, active
     FROM product_variants WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  );
  return productRes.rows.map((p) => ({
    id: p.id,
    client_uuid: p.client_uuid,
    name: p.name,
    category_id: p.category_id,
    photo: p.photo,
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
    `SELECT id, client_uuid, name, active FROM categories
     WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  );
  return res.rows;
}

export async function createLocalCategory(
  db: PGlite,
  tenantId: string,
  input: { name: string },
): Promise<LocalCategory> {
  return localTx(db, async (tx) => {
    const id = newId();
    await tx.query(
      `INSERT INTO categories (id, tenant_id, client_uuid, name, active)
       VALUES ($1, $2, $1, $3, TRUE)`,
      [id, tenantId, input.name],
    );
    await enqueueMutation(tx, tenantId, "category", id, {
      name: input.name,
      active: true,
    });
    return { id, client_uuid: id, name: input.name, active: true };
  });
}

export type SaleItem = {
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

/** Sale flow view: active variants of active products (empty catalog → []). */
export async function listSaleItems(db: Q, tenantId: string): Promise<SaleItem[]> {
  const res = await db.query<{
    id: string;
    product_id: string;
    product_name: string;
    name: string;
    price: number;
    cost: number | null;
    stock: number;
    active: boolean;
    product_active: boolean;
    category_id: string | null;
    photo: string | null;
  }>(
    `SELECT v.id, v.product_id, p.name AS product_name, v.name, v.price, v.cost, v.stock, v.active,
            p.active AS product_active, p.category_id, p.photo
     FROM product_variants v
     JOIN products p ON p.id = v.product_id
     WHERE v.tenant_id = $1 AND v.active = TRUE AND p.active = TRUE
     ORDER BY p.name, v.name`,
    [tenantId],
  );
  return res.rows.map(({ product_active: _pa, ...rest }) => rest);
}

export async function createLocalProduct(
  db: PGlite,
  tenantId: string,
  input: {
    name: string;
    category_id?: string | null;
    photo?: string | null;
    variant: { name: string; price: number; cost?: number | null; stock?: number };
  },
): Promise<LocalProduct> {
  return localTx(db, async (tx) => {
    const productId = newId();
    const variantId = newId();
    const stock = input.variant.stock ?? 0;
    const cost = input.variant.cost ?? null;

    await tx.query(
      `INSERT INTO products (id, tenant_id, client_uuid, name, category_id, photo, active)
       VALUES ($1, $2, $1, $3, $4, $5, TRUE)`,
      [productId, tenantId, input.name, input.category_id ?? null, input.photo ?? null],
    );
    await tx.query(
      `INSERT INTO product_variants
         (id, tenant_id, client_uuid, product_id, name, price, cost, stock, low_stock_threshold, active)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, NULL, TRUE)`,
      [variantId, tenantId, productId, input.variant.name, input.variant.price, cost, stock],
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
      name: input.name,
      category_id: input.category_id ?? null,
      photo: input.photo ?? null,
      active: true,
    });
    await enqueueMutation(tx, tenantId, "variant", variantId, {
      product_id: productId,
      name: input.variant.name,
      price: input.variant.price,
      cost,
      stock,
      low_stock_threshold: null,
      active: true,
    });

    return {
      id: productId,
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
  db: PGlite,
  tenantId: string,
  productId: string,
  variant: { name: string; price: number; cost?: number | null; stock?: number },
): Promise<{ id: string; stock: number } | null> {
  return localTx(db, async (tx) => {
    const product = await tx.query<{ id: string }>(
      `SELECT id FROM products WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, productId],
    );
    if (!product.rows[0]) return null;

    const variantId = newId();
    const stock = variant.stock ?? 0;
    const cost = variant.cost ?? null;
    await tx.query(
      `INSERT INTO product_variants
         (id, tenant_id, client_uuid, product_id, name, price, cost, stock, low_stock_threshold, active)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, NULL, TRUE)`,
      [variantId, tenantId, productId, variant.name, variant.price, cost, stock],
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
  db: PGlite,
  tenantId: string,
  productId: string,
  patch: {
    name?: string;
    category_id?: string | null;
    photo?: string | null;
    active?: boolean;
  },
): Promise<number> {
  return localTx(db, async (tx) => {
    const rows = await tx.query<{
      client_uuid: string;
      name: string;
      category_id: string | null;
      photo: string | null;
      active: boolean;
    }>(
      `SELECT client_uuid, name, category_id, photo, active FROM products
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
    await tx.query(
      `UPDATE products SET name = $3, category_id = $4, photo = $5, active = $6, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, productId, nextName, nextCategoryId, nextPhoto, nextActive],
    );
    await enqueueMutation(tx, tenantId, "product", current.client_uuid, {
      name: nextName,
      category_id: nextCategoryId,
      photo: nextPhoto,
      active: nextActive,
    });
    return 1;
  });
}

export async function updateLocalVariant(
  db: PGlite,
  tenantId: string,
  variantId: string,
  patch: { name?: string; price?: number; cost?: number | null; active?: boolean },
): Promise<number> {
  return localTx(db, async (tx) => {
    const rows = await tx.query<{
      client_uuid: string;
      product_id: string;
      name: string;
      price: number;
      cost: number | null;
      stock: number;
      low_stock_threshold: number | null;
      active: boolean;
    }>(
      `SELECT client_uuid, product_id, name, price, cost, stock, low_stock_threshold, active
       FROM product_variants WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, variantId],
    );
    const current = rows.rows[0];
    if (!current) return 0;

    const next = {
      name: patch.name ?? current.name,
      price: patch.price ?? current.price,
      cost: patch.cost !== undefined ? patch.cost : current.cost,
      active: patch.active ?? current.active,
    };
    await tx.query(
      `UPDATE product_variants SET name = $3, price = $4, cost = $5, active = $6, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, variantId, next.name, next.price, next.cost, next.active],
    );
    await enqueueMutation(tx, tenantId, "variant", current.client_uuid, {
      product_id: current.product_id,
      name: next.name,
      price: next.price,
      cost: next.cost,
      stock: current.stock,
      low_stock_threshold: current.low_stock_threshold,
      active: next.active,
    });
    return 1;
  });
}

/** Manual stock adjustment: reason + note mandatory, auditable, atomic. */
export async function adjustLocalStock(
  db: PGlite,
  tenantId: string,
  input: {
    variant_id: string;
    delta: number;
    reason: string;
    note: string;
  },
): Promise<{ stock: number } | null> {
  return localTx(db, async (tx) => {
    const rows = await tx.query<{ stock: number; product_id: string; name: string; price: number }>(
      `SELECT stock, product_id, name, price FROM product_variants
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
      stock: nextStock,
      low_stock_threshold: null,
      active: true,
    });

    return { stock: nextStock };
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
  payment: {
    id: string;
    method: string;
    amount: number;
    tendered: number | null;
    vuelto: number | null;
    status: string;
    confirmed_at: string | null;
  };
};

export type SaleCommitInput =
  | { lines: SaleLineInput[]; method?: "cash"; tendered: number }
  | { lines: SaleLineInput[]; method: "transfer" };

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

  const isTransfer = input.method === "transfer";
  let tendered: number | null = null;
  let vuelto: number | null = null;
  if (!isTransfer) {
    // cash: tendered ≥ total required (throws UNDERPAYMENT)
    vuelto = computeVuelto(total, input.tendered);
    tendered = input.tendered;
  }

  return localTx(db, async (tx) => {
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
      `INSERT INTO tickets (id, tenant_id, client_uuid, shift_id, ticket_no, status, total, created_at)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7)`,
      [ticketId, tenantId, shiftId, ticketNo, ticketStatus, total, createdAt],
    );

    const lines: CommittedSale["lines"] = [];
    for (const line of input.lines) {
      const lineId = newId();
      const subtotal = lineSubtotal(line.unit_price, line.qty);
      await tx.query(
        `INSERT INTO ticket_lines
           (id, tenant_id, client_uuid, ticket_id, variant_id, qty, unit_price, subtotal, created_at)
         VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8)`,
        [lineId, tenantId, ticketId, line.variant_id, line.qty, line.unit_price, subtotal, createdAt],
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
        created_at: createdAt,
      });

      /* ---- D3-1: stock movement for THIS sale line, same local tx ---- */
      const vRes = await tx.query<{
        product_id: string;
        name: string;
        price: number;
        stock: number;
        low_stock_threshold: number | null;
        active: boolean;
      }>(
        `SELECT product_id, name, price, stock, low_stock_threshold, active
         FROM product_variants WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, line.variant_id],
      );
      const variant = vRes.rows[0];
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
          stock: nextStock,
          low_stock_threshold: variant.low_stock_threshold,
          active: variant.active,
          ref_ticket_id: ticketId,
        });
      }
    }

    const paymentId = newId();
    await tx.query(
      `INSERT INTO payments
         (id, tenant_id, client_uuid, ticket_id, method, amount, tendered, vuelto, status, shift_id, created_at)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        paymentId,
        tenantId,
        ticketId,
        isTransfer ? "transfer" : "cash",
        total,
        tendered,
        vuelto,
        paymentStatus,
        shiftId,
        createdAt,
      ],
    );

    await enqueueMutation(tx, tenantId, "ticket", ticketId, {
      shift_id: shiftId,
      ticket_no: ticketNo,
      status: ticketStatus,
      total,
      created_at: createdAt,
    });
    await enqueueMutation(tx, tenantId, "payment", paymentId, {
      ticket_id: ticketId,
      method: isTransfer ? "transfer" : "cash",
      amount: total,
      tendered,
      vuelto,
      status: paymentStatus,
      shift_id: shiftId,
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
      payment: {
        id: paymentId,
        method: isTransfer ? "transfer" : "cash",
        amount: total,
        tendered,
        vuelto,
        status: paymentStatus,
        confirmed_at: null,
      },
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
): Promise<{ payment: CommittedSale["payment"]; confirmed_at: string }> {
  return localTx(db, async (tx) => {
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
};

export async function listLocalTickets(
  db: Q,
  tenantId: string,
  limit = 50,
): Promise<LocalTicketRow[]> {
  const res = await db.query<LocalTicketRow>(
    `SELECT t.id, t.ticket_no, t.total, t.status, t.created_at,
            p.method, p.status AS pay_status, p.tendered, p.vuelto
     FROM tickets t
     LEFT JOIN payments p ON p.ticket_id = t.id
     WHERE t.tenant_id = $1
     ORDER BY t.created_at DESC
     LIMIT $2`,
    [tenantId, limit],
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
  /** false while the payment's queue entry has not synced yet (D2-6 gate). */
  payment_synced: boolean;
} | null> {
  const ticket = await db.query<LocalTicketRow>(
    `SELECT t.id, t.ticket_no, t.total, t.status, t.created_at,
            p.id AS payment_id, p.method, p.status AS pay_status, p.tendered, p.vuelto
     FROM tickets t
     LEFT JOIN payments p ON p.ticket_id = t.id
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
    payment_synced: paymentSynced,
  };
}

/* ------------------------------------------------------------------ */
/* shifts + arqueo (D3-2) — offline close = SAME SQL as the server     */
/* ------------------------------------------------------------------ */

export type LocalShift = {
  id: string;
  client_uuid: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
};

export type LocalClosedCash = {
  id: string;
  shift_id: string;
  expected: number;
  counted: number;
  diff: number;
  closed_by: string | null;
  created_at: string;
};

const SHIFT_COLS = "id, client_uuid, status, opened_at, closed_at";

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
  opts: { client_uuid?: string } = {},
): Promise<LocalShift> {
  return localTx(db, async (tx) => {
    const open = await tx.query<{ id: string }>(
      `SELECT id FROM shifts WHERE tenant_id = $1 AND status = 'open' LIMIT 1`,
      [tenantId],
    );
    if (open.rows[0]) throw new Error("SHIFT_ALREADY_OPEN");
    const id = opts.client_uuid ?? newId();
    await tx.query(
      `INSERT INTO shifts (id, tenant_id, client_uuid, status) VALUES ($1, $2, $1, 'open')`,
      [id, tenantId],
    );
    await enqueueMutation(tx, tenantId, "shift", id, { status: "open" });
    return {
      id,
      client_uuid: id,
      status: "open",
      opened_at: new Date().toISOString(),
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
  },
): Promise<boolean> {
  return localTx(db, async (tx) => {
    const open = await tx.query<{ id: string }>(
      `SELECT id FROM shifts WHERE tenant_id = $1 AND status = 'open' LIMIT 1`,
      [tenantId],
    );
    if (open.rows[0]) return false;
    await tx.query(
      `INSERT INTO shifts (id, tenant_id, client_uuid, status, opened_at, closed_at)
       VALUES ($1, $2, $1, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        shift.id,
        tenantId,
        shift.status ?? "open",
        shift.opened_at ? new Date(shift.opened_at).toISOString() : new Date().toISOString(),
        shift.closed_at ? new Date(shift.closed_at).toISOString() : null,
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

/**
 * Offline close (D3-2): expected computed from LOCAL payments with the
 * shared SQL, `counted` is the only manual figure, diff derived, closedcash
 * immutable (ON CONFLICT DO NOTHING) — both mutations enqueue for sync.
 * Throws NO_OPEN_SHIFT / NEGATIVE_COUNTED / ALREADY_CLOSED.
 */
export async function closeLocalShift(
  db: PGlite,
  tenantId: string,
  input: { counted: number; closedBy?: string | null },
): Promise<{
  closedcash: LocalClosedCash;
  expected: ExpectedBreakdown;
  diff: number;
}> {
  const counted = countedSchema.safeParse(input.counted);
  if (!counted.success) throw new Error("NEGATIVE_COUNTED");

  return localTx(db, async (tx) => {
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
         (id, tenant_id, client_uuid, shift_id, expected, counted, diff, closed_by)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, shift_id) DO NOTHING
       RETURNING id, shift_id, expected, counted, diff, closed_by, created_at`,
      [id, tenantId, shift.id, expected.expected, counted.data, diff, input.closedBy ?? null],
    );
    if (!inserted.rows[0]) throw new Error("ALREADY_CLOSED");

    await tx.query(
      `UPDATE shifts SET status = 'closed', closed_at = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, shift.id, closedAt],
    );

    await enqueueMutation(tx, tenantId, "closedcash", id, {
      shift_id: shift.id,
      expected: expected.expected,
      counted: counted.data,
      diff,
      closed_by: input.closedBy ?? null,
    });
    await enqueueMutation(tx, tenantId, "shift", shift.client_uuid, {
      status: "closed",
      opened_at: new Date(shift.opened_at).toISOString(),
      closed_at: closedAt,
    });

    return {
      closedcash: {
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
  },
): Promise<void> {
  await localTx(db, async (tx) => {
    await tx.query(
      `INSERT INTO closedcash
         (id, tenant_id, client_uuid, shift_id, expected, counted, diff, closed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    `SELECT id, shift_id, expected, counted, diff, closed_by, created_at
     FROM closedcash WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return res.rows;
}

/**
 * D4-4 · Sign-out / tenant switch partitioning (tenancy-auth §Session data
 * is tenant-partitioned locally): wipe ALL local business rows so the next
 * session (any tenant) starts from an empty cache. Auth/session data lives
 * outside PGlite and is untouched.
 */
const LOCAL_BUSINESS_TABLES = [
  "sync_log",
  "stockdiary",
  "stockcurrent",
  "closedcash",
  "payments",
  "ticket_lines",
  "tickets",
  "shifts",
  "product_variants",
  "products",
] as const;

export async function clearLocalBusinessData(db: PGlite): Promise<void> {
  await localTx(db, async (tx) => {
    for (const table of LOCAL_BUSINESS_TABLES) {
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
