import type { PGlite } from "@electric-sql/pglite";
import { localTx, type LocalQueryable } from "./pglite";
import { assertWritable } from "./preservation";
import { commitLocalSale, enqueueMutation, type CommittedSale, type SaleCommitInput } from "./local";

/**
 * Mesas & comandas — LOCAL PGlite domain (CONTROL-MESAS.md · Fase 1 = opción
 * C) + Fase 2 sync entities (opción B: tables/orders/order_lines in
 * MUTATION_ENTITIES, LWW per mutation like every other entity).
 *
 * FASE 2 DECISIONS encoded here (see CONTROL-MESAS.md «Fase2 implementada»):
 *  - Occupancy is DERIVED from `orders` (LEFT JOIN LATERAL open order):
 *    `tables.status/current_order_id/opened_at` are LEGACY columns — kept in
 *    the DDL for parity + old data, never read, never written. Two devices
 *    can only ever conflict on table CATALOG edits, never on «who has the
 *    table open» (decision 8). «Pedir cuenta» is `orders.billing_at` — the
 *    flag lives on the comanda and dies with it.
 *  - EVERY write enqueues its sync mutation in the SAME local tx:
 *    table → `table`, order lifecycle → `order`, lines → `order_line`
 *    (upsert of changed rows, `deleted_at` STATE for removals — never a
 *    DELETE). «Guardar en Mesa» was already upsert-by-variant + soft-delete
 *    at the data layer (NOT a wipe-and-reinsert); Fase 2 only adds the
 *    per-line mutations so two devices never erase each other's rows.
 *  - Invariants unchanged: totals derived from live lines; stock untouched
 *    until cobro; an order closes ONCE (`ORDER_NOT_OPEN` = local double-cobro
 *    guard; cross-device is covered by the frescura check + the server
 *    `tickets.order_id` unique backstop).
 */

const newId = () => globalThis.crypto.randomUUID();

export type TableStatus = "available" | "occupied" | "billing";
export type OrderState = "open" | "cancelled" | "closed";

export type LocalTable = {
  id: string;
  name: string;
  zone: string | null;
  capacity: number;
  /** DERIVED from the table's open comanda (legacy column no longer read). */
  status: TableStatus;
  /** DERIVED: id of the table's open comanda, or null. */
  current_order_id: string | null;
  /** DERIVED: opened_at of the table's open comanda, or null. */
  opened_at: string | null;
  active: boolean;
};

/** Board row: the table plus the LIVE totals of its open comanda. */
export type BoardTable = LocalTable & {
  order_id: string | null;
  /** SUM(qty) of live lines — same "N ítems" unit the cart badge uses. */
  items: number;
  /** Derived total (COP). */
  total: number;
};

/** Cart-shaped line returned when a comanda is loaded into the POS. */
export type OrderCartLine = {
  variantId: string;
  label: string;
  price: number;
  qty: number;
  /** current stock — drives the same oversell banner the cart has. */
  stock: number;
};

export type OrderSaveLine = {
  variant_id: string;
  name: string;
  price: number;
  qty: number;
};

export const MESAS_ERRORS = {
  TABLE_NOT_FOUND: "Mesa no encontrada",
  TABLE_INACTIVE: "La mesa está desactivada",
  TABLE_NAME_TAKEN: "Ya existe una mesa activa con ese nombre",
  TABLE_IN_USE: "La mesa tiene una comanda abierta: liberá o cobrá antes de desactivarla",
  ORDER_NOT_OPEN: "La comanda ya no está abierta",
  EMPTY_ORDER: "No hay consumo para guardar",
} as const;

/** Fase 2 · gate de cierre de caja (decisión 6): exact message with count. */
export function openOrdersMessage(n: number): string {
  return `Hay ${n} mesa${n === 1 ? "" : "s"} con comanda${n === 1 ? "" : "s"} abierta${n === 1 ? "" : "s"} — cobralas o libralas antes de cerrar`;
}

/** Every read/write is tenant-scoped + sealed-vault checked (local.ts pattern). */
function mesasTx<T>(
  db: PGlite,
  tenantId: string,
  fn: (q: LocalQueryable) => Promise<T>,
): Promise<T> {
  return localTx(db, async (q) => {
    await assertWritable(q, tenantId);
    return fn(q);
  });
}

function assertTableInput(input: { name: string; zone: string | null; capacity: number }) {
  const name = input.name.trim();
  if (!name || name.length > 60) throw new Error("El nombre de la mesa es obligatorio (máx. 60 caracteres)");
  if (input.zone !== null && input.zone.length > 60) throw new Error("La zona no puede superar 60 caracteres");
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 999)
    throw new Error("La capacidad debe ser un entero entre 1 y 999");
  return { ...input, name };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505";
}

const isoOf = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(String(v)).toISOString();

/* ── derived table reads (decision 8: occupancy ALWAYS comes from orders) ─ */

/**
 * Every occupancy read goes through this lateral: the EARLIEST open comanda
 * of the table wins (the server's one-open-per-table unique index keeps that
 * deterministic; the LIMIT 1 also guarantees one board card per table even
 * if a legacy row ever slipped through).
 */
const DERIVED_TABLE_SELECT = `
  SELECT t.id, t.name, t.zone, t.capacity, t.active,
         o.id AS open_order_id, o.opened_at AS order_opened_at, o.billing_at AS order_billing_at
  FROM tables t
  LEFT JOIN LATERAL (
    SELECT id, opened_at, billing_at FROM orders
    WHERE tenant_id = t.tenant_id AND table_id = t.id AND state = 'open'
    ORDER BY opened_at ASC LIMIT 1
  ) o ON true`;

function rowToDerivedTable(r: Record<string, unknown>): LocalTable {
  const openId = r.open_order_id === null || r.open_order_id === undefined ? null : String(r.open_order_id);
  return {
    id: String(r.id),
    name: String(r.name),
    zone: r.zone === null || r.zone === undefined ? null : String(r.zone),
    capacity: Number(r.capacity),
    status: !openId ? "available" : r.order_billing_at ? "billing" : "occupied",
    current_order_id: openId,
    opened_at: openId ? isoOf(r.order_opened_at) : null,
    active: Boolean(r.active),
  };
}

type OpenOrderRow = { id: string; opened_at: string; billing_at: string | null };

async function findOpenOrder(
  tx: LocalQueryable,
  tenantId: string,
  tableId: string,
): Promise<OpenOrderRow | null> {
  const res = await tx.query<OpenOrderRow>(
    `SELECT id, opened_at, billing_at FROM orders
     WHERE tenant_id = $1 AND table_id = $2 AND state = 'open'
     ORDER BY opened_at ASC LIMIT 1`,
    [tenantId, tableId],
  );
  return res.rows[0] ?? null;
}

/** Current order row → the `order` mutation payload (state truth for sync). */
async function enqueueOrderState(
  q: LocalQueryable,
  tenantId: string,
  orderId: string,
): Promise<void> {
  const row = (await q.query<{
    table_id: string;
    state: string;
    opened_at: string;
    closed_at: string | null;
    billing_at: string | null;
    created_at: string;
  }>(
    `SELECT table_id, state, opened_at, closed_at, billing_at, created_at
     FROM orders WHERE tenant_id = $1 AND id = $2`,
    [tenantId, orderId],
  )).rows[0];
  if (!row) return;
  await enqueueMutation(q, tenantId, "order", orderId, {
    table_id: row.table_id,
    state: row.state,
    opened_at: isoOf(row.opened_at),
    closed_at: isoOf(row.closed_at),
    billing_at: isoOf(row.billing_at),
    created_at: isoOf(row.created_at),
  });
}

type LineRow = {
  id: string;
  order_id: string;
  variant_id: string;
  name: string;
  price: number;
  qty: number;
  notes: string | null;
  sort: number;
  deleted_at: string | null;
  created_at: string;
};

function linePayload(row: LineRow, overrides: { deleted_at?: string } = {}): Record<string, unknown> {
  return {
    order_id: row.order_id,
    variant_id: row.variant_id,
    name: row.name,
    price: Number(row.price),
    qty: Number(row.qty),
    notes: row.notes,
    sort: Number(row.sort),
    deleted_at: overrides.deleted_at !== undefined ? overrides.deleted_at : isoOf(row.deleted_at),
    created_at: isoOf(row.created_at),
  };
}

const LINE_COLS = `id, order_id, variant_id, name, price, qty, notes, sort, deleted_at, created_at`;

/* ── tables (CRUD, tenant-scoped local + `table` mutations) ───────────── */

export async function listTables(
  db: PGlite,
  tenantId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<LocalTable[]> {
  const res = await db.query<Record<string, unknown>>(
    `${DERIVED_TABLE_SELECT} WHERE t.tenant_id = $1${opts.activeOnly ? " AND t.active" : ""} ORDER BY t.name`,
    [tenantId],
  );
  return res.rows.map(rowToDerivedTable);
}

export async function getTable(db: PGlite, tenantId: string, id: string): Promise<LocalTable | null> {
  const res = await db.query<Record<string, unknown>>(
    `${DERIVED_TABLE_SELECT} WHERE t.tenant_id = $1 AND t.id = $2`,
    [tenantId, id],
  );
  return res.rows[0] ? rowToDerivedTable(res.rows[0]) : null;
}

/**
 * Board payload: every ACTIVE table + the live totals of its OPEN comanda.
 * Occupancy is the LATERAL join (an orphaned/legacy state column can never
 * show a ghost occupied table: no open order ⇒ `available`).
 */
export async function listBoardTables(db: PGlite, tenantId: string): Promise<BoardTable[]> {
  const res = await db.query<Record<string, unknown>>(
    `SELECT t.id, t.name, t.zone, t.capacity, t.active,
            o.id AS open_order_id, o.opened_at AS order_opened_at, o.billing_at AS order_billing_at,
            COALESCE((SELECT SUM(l.qty) FROM order_lines l
                       WHERE l.order_id = o.id AND l.deleted_at IS NULL), 0)::int AS items,
            COALESCE((SELECT SUM(l.price * l.qty) FROM order_lines l
                       WHERE l.order_id = o.id AND l.deleted_at IS NULL), 0)::int AS total
     FROM tables t
     LEFT JOIN LATERAL (
       SELECT id, opened_at, billing_at FROM orders
       WHERE tenant_id = t.tenant_id AND table_id = t.id AND state = 'open'
       ORDER BY opened_at ASC LIMIT 1
     ) o ON true
     WHERE t.tenant_id = $1 AND t.active
     ORDER BY t.name`,
    [tenantId],
  );
  return res.rows.map((r) => {
    const table = rowToDerivedTable(r);
    return {
      ...table,
      order_id: table.current_order_id,
      items: Number(r.items ?? 0),
      total: Number(r.total ?? 0),
    };
  });
}

export async function createLocalTable(
  db: PGlite,
  tenantId: string,
  input: { name: string; zone: string | null; capacity: number; active?: boolean },
): Promise<LocalTable> {
  const clean = assertTableInput(input);
  return mesasTx(db, tenantId, async (tx) => {
    const id = newId();
    try {
      await tx.query(
        `INSERT INTO tables (id, tenant_id, client_uuid, name, zone, capacity, active)
         VALUES ($1, $2, $1, $3, $4, $5, $6)`,
        [id, tenantId, clean.name, clean.zone, clean.capacity, input.active ?? true],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(MESAS_ERRORS.TABLE_NAME_TAKEN);
      throw err;
    }
    await enqueueMutation(tx, tenantId, "table", id, {
      name: clean.name,
      zone: clean.zone,
      capacity: clean.capacity,
      active: input.active ?? true,
    });
    const row = (await tx.query<Record<string, unknown>>(
      `${DERIVED_TABLE_SELECT} WHERE t.tenant_id = $1 AND t.id = $2`,
      [tenantId, id],
    )).rows[0];
    return rowToDerivedTable(row!);
  });
}

export async function updateLocalTable(
  db: PGlite,
  tenantId: string,
  id: string,
  patch: { name?: string; zone?: string | null; capacity?: number; active?: boolean },
): Promise<void> {
  await mesasTx(db, tenantId, async (tx) => {
    const current = (await tx.query<Record<string, unknown>>(
      `SELECT id, name, zone, capacity, active FROM tables WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    )).rows[0];
    if (!current) throw new Error(MESAS_ERRORS.TABLE_NOT_FOUND);
    const table = {
      id: String(current.id),
      name: String(current.name),
      zone: current.zone === null || current.zone === undefined ? null : String(current.zone),
      capacity: Number(current.capacity),
      active: Boolean(current.active),
    };

    const next = {
      name: patch.name !== undefined ? patch.name : table.name,
      zone: patch.zone !== undefined ? patch.zone : table.zone,
      capacity: patch.capacity !== undefined ? patch.capacity : table.capacity,
      active: patch.active !== undefined ? patch.active : table.active,
    };
    assertTableInput(next);

    /* Never silently destroy a comanda: deactivating a table that still has
     * an OPEN order is refused until the operator releases or charges it
     * (no hidden data loss — same principle as the leave-POS guard). The
     * check reads ORDERS, not the legacy status column. */
    if (next.active === false && table.active && await findOpenOrder(tx, tenantId, id)) {
      throw new Error(MESAS_ERRORS.TABLE_IN_USE);
    }

    try {
      await tx.query(
        `UPDATE tables SET name = $3, zone = $4, capacity = $5, active = $6, updated_at = now()
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id, next.name, next.zone, next.capacity, next.active],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(MESAS_ERRORS.TABLE_NAME_TAKEN);
      throw err;
    }
    await enqueueMutation(tx, tenantId, "table", id, {
      name: next.name,
      zone: next.zone,
      capacity: next.capacity,
      active: next.active,
    });
  });
}

/* ── orders: open / save / load / close (+ `order`/`order_line` sync) ──── */

/** Finds the table's OPEN order, creating one on first save/charge. */
async function ensureOpenOrder(tx: LocalQueryable, tenantId: string, tableId: string): Promise<string> {
  const existing = await findOpenOrder(tx, tenantId, tableId);
  if (existing) return existing.id;
  const id = newId();
  const openedAt = new Date().toISOString();
  await tx.query(
    `INSERT INTO orders (id, tenant_id, client_uuid, table_id, state, opened_at, created_at)
     VALUES ($1, $2, $1, $3, 'open', $4, $4)`,
    [id, tenantId, tableId, openedAt],
  );
  await enqueueMutation(tx, tenantId, "order", id, {
    table_id: tableId,
    state: "open",
    opened_at: openedAt,
    closed_at: null,
    billing_at: null,
    created_at: openedAt,
  });
  return id;
}

async function readTableForUpdate(tx: LocalQueryable, tenantId: string, tableId: string): Promise<LocalTable> {
  const row = (await tx.query<Record<string, unknown>>(
    `SELECT id, name, zone, capacity, active FROM tables WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, tableId],
  )).rows[0];
  if (!row) throw new Error(MESAS_ERRORS.TABLE_NOT_FOUND);
  const open = await findOpenOrder(tx, tenantId, tableId);
  const derived = rowToDerivedTable({
    ...row,
    open_order_id: open?.id ?? null,
    order_opened_at: open?.opened_at ?? null,
    order_billing_at: open?.billing_at ?? null,
  });
  if (!derived.active) throw new Error(MESAS_ERRORS.TABLE_INACTIVE);
  return derived;
}

async function liveTotal(tx: LocalQueryable, orderId: string): Promise<{ items: number; total: number }> {
  const row = (await tx.query<{ items: string; total: string }>(
    `SELECT COALESCE(SUM(qty), 0)::int AS items, COALESCE(SUM(price * qty), 0)::int AS total
     FROM order_lines WHERE order_id = $1 AND deleted_at IS NULL`,
    [orderId],
  )).rows[0];
  return { items: Number(row?.items ?? 0), total: Number(row?.total ?? 0) };
}

/**
 * «Guardar en Mesa» — REPLACES the comanda's live lines with `lines`
 * (insert new, update changed, soft-delete removed) and clears any
 * «Pedir cuenta» flag. One transaction: the board can never observe a
 * half-saved comanda. Stock is untouched (it moves only at cobro).
 *
 * FASE 2: the replace is now expressed as PER-LINE sync mutations inside the
 * same tx — upsert of every line that changed (stable client_uuid = row id),
 * `deleted_at` STATE for removals, and the `order` row refreshed (open +
 * billing cleared). Two devices saving different lines never wipe each
 * other: each line upserts independently under LWW.
 */
export async function saveOrderToTable(
  db: PGlite,
  tenantId: string,
  tableId: string,
  lines: OrderSaveLine[],
): Promise<{ orderId: string; items: number; total: number }> {
  if (lines.length === 0) throw new Error(MESAS_ERRORS.EMPTY_ORDER);
  return mesasTx(db, tenantId, async (tx) => {
    /* Locks the table row + validates it exists and is active (read-only —
     * occupancy itself lives on `orders`, so no legacy status write). */
    await readTableForUpdate(tx, tenantId, tableId);
    const orderId = await ensureOpenOrder(tx, tenantId, tableId);

    const existing = (await tx.query<{ id: string; variant_id: string }>(
      `SELECT id, variant_id FROM order_lines WHERE tenant_id = $1 AND order_id = $2 AND deleted_at IS NULL`,
      [tenantId, orderId],
    )).rows;
    const kept = new Set<string>();

    for (const [index, line] of lines.entries()) {
      const match = existing.find((e) => e.variant_id === line.variant_id);
      if (match) {
        kept.add(match.id);
        await tx.query(
          `UPDATE order_lines SET name = $3, price = $4, qty = $5, sort = $6, updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, match.id, line.name, line.price, line.qty, index],
        );
        const updated = (await tx.query<LineRow>(
          `SELECT ${LINE_COLS} FROM order_lines WHERE tenant_id = $1 AND id = $2`,
          [tenantId, match.id],
        )).rows[0];
        await enqueueMutation(tx, tenantId, "order_line", match.id, linePayload(updated!));
      } else {
        const id = newId();
        await tx.query(
          `INSERT INTO order_lines (id, tenant_id, client_uuid, order_id, variant_id, name, price, qty, sort)
           VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8)`,
          [id, tenantId, orderId, line.variant_id, line.name, line.price, line.qty, index],
        );
        const inserted = (await tx.query<LineRow>(
          `SELECT ${LINE_COLS} FROM order_lines WHERE tenant_id = $1 AND id = $2`,
          [tenantId, id],
        )).rows[0];
        await enqueueMutation(tx, tenantId, "order_line", id, linePayload(inserted!));
      }
    }

    /* Removals are a STATE (deleted_at), never a DELETE: the sync protocol
     * has no delete op — the mutation carries the timestamped state. */
    for (const row of existing) {
      if (kept.has(row.id)) continue;
      const removedAt = new Date().toISOString();
      await tx.query(
        `UPDATE order_lines SET deleted_at = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, row.id, removedAt],
      );
      const removed = (await tx.query<LineRow>(
        `SELECT ${LINE_COLS} FROM order_lines WHERE tenant_id = $1 AND id = $2`,
        [tenantId, row.id],
      )).rows[0];
      await enqueueMutation(tx, tenantId, "order_line", row.id, linePayload(removed!, { deleted_at: removedAt }));
    }

    /* Saving again returns a billing table to `occupied` (Fase 1 decision
     * #20) — the flag is orders.billing_at now, and the order mutation below
     * syncs its clearing. Enqueued on EVERY save so a device that only ever
     * saved lines still delivers its `order` row to the server. */
    const open = await findOpenOrder(tx, tenantId, tableId);
    if (open?.billing_at) {
      await tx.query(
        `UPDATE orders SET billing_at = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, orderId],
      );
    }
    await enqueueOrderState(tx, tenantId, orderId);

    const totals = await liveTotal(tx, orderId);
    return { orderId, ...totals };
  });
}

/**
 * Loads an open comanda as cart lines (stock read NOW, so the oversell
 * banner at cobro reflects reality). Returns null when the table has no
 * open order — the caller treats that as "nothing to resume".
 */
export async function loadTableOrder(
  db: PGlite,
  tenantId: string,
  tableId: string,
): Promise<{ orderId: string; lines: OrderCartLine[] } | null> {
  const order = await findOpenOrder(db, tenantId, tableId);
  if (!order) return null;

  const res = await db.query<{ variant_id: string; name: string; price: number; qty: number; stock: number | null }>(
    `SELECT l.variant_id, l.name, l.price, l.qty, v.stock
     FROM order_lines l
     LEFT JOIN product_variants v ON v.id = l.variant_id AND v.tenant_id = l.tenant_id
     WHERE l.tenant_id = $1 AND l.order_id = $2 AND l.deleted_at IS NULL
     ORDER BY l.sort, l.created_at`,
    [tenantId, order.id],
  );
  return {
    orderId: order.id,
    lines: res.rows.map((r) => ({
      variantId: r.variant_id,
      label: r.name,
      price: Number(r.price),
      qty: Number(r.qty),
      stock: r.stock === null || r.stock === undefined ? 0 : Number(r.stock),
    })),
  };
}

async function closeOrCancel(
  db: PGlite,
  tenantId: string,
  tableId: string,
  next: "closed" | "cancelled",
): Promise<{ orderId: string }> {
  return mesasTx(db, tenantId, async (tx) => {
    await readTableForUpdate(tx, tenantId, tableId);
    const order = await findOpenOrder(tx, tenantId, tableId);
    /* THE double-cobro guard: an order that is already closed/cancelled (or
     * a table with no order at all) can never be closed again — no second
     * ticket path exists through this function. */
    if (!order) throw new Error(MESAS_ERRORS.ORDER_NOT_OPEN);

    await tx.query(
      `UPDATE orders SET state = $3, closed_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, order.id, next],
    );
    await enqueueOrderState(tx, tenantId, order.id);
    return { orderId: order.id };
  });
}

/** Post-cobro: order → closed, table freed (Flujo C). */
export async function closeTableOrder(db: PGlite, tenantId: string, tableId: string): Promise<{ orderId: string }> {
  return closeOrCancel(db, tenantId, tableId, "closed");
}

/** «Liberar» without charging: order → cancelled, table freed. */
export async function releaseTable(db: PGlite, tenantId: string, tableId: string): Promise<{ orderId: string }> {
  return closeOrCancel(db, tenantId, tableId, "cancelled");
}

/** «Pedir cuenta»: orders.billing_at set — the comanda stays open. */
export async function setTableBilling(db: PGlite, tenantId: string, tableId: string): Promise<void> {
  await mesasTx(db, tenantId, async (tx) => {
    await readTableForUpdate(tx, tenantId, tableId);
    const order = await findOpenOrder(tx, tenantId, tableId);
    if (!order) throw new Error(MESAS_ERRORS.ORDER_NOT_OPEN);
    await tx.query(
      `UPDATE orders SET billing_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, order.id],
    );
    await enqueueOrderState(tx, tenantId, order.id);
  });
}

/**
 * The cobro path for a mesa (Flujo C):
 *
 *  1. PRE-CHECK — the table must have an OPEN order. Without it nothing is
 *     written: a second cobro of an already-settled comanda dies HERE with
 *     ORDER_NOT_OPEN and never reaches `commitLocalSale` (no second ticket,
 *     no second stock debit).
 *  2. `commitLocalSale` EXACTLY as a counter sale — ticket + payments +
 *     stockdiary in one tx, ticket stamped with `table_name` AND `order_id`
 *     (the server-side double-cobro backstop key). The invariant «stock
 *     debits at cobro, next to the persisted ticket» is untouched.
 *  3. CLOSE the order + free the table, only after the ticket exists (the
 *     close enqueues its own `order` mutation).
 *
 * Steps 1 and 3 are separate local transactions: the POS is single-tab with
 * a synchronous busy-flag on the payment modal, so no interleaving exists
 * between them in Fase 1. Cross-device concurrency is NOT assumed here —
 * it is handled by the frescura check at cobro + tickets.order_id on the
 * server (doble defensa, CONTROL-MESAS.md).
 */
export async function commitTableSale(
  db: PGlite,
  tenantId: string,
  tableId: string,
  input: SaleCommitInput,
): Promise<{ committed: CommittedSale; orderId: string }> {
  const table = await getTable(db, tenantId, tableId);
  if (!table) throw new Error(MESAS_ERRORS.TABLE_NOT_FOUND);
  if (!table.active) throw new Error(MESAS_ERRORS.TABLE_INACTIVE);
  const order = await findOpenOrder(db, tenantId, tableId);
  if (!order) throw new Error(MESAS_ERRORS.ORDER_NOT_OPEN);

  const committed = await commitLocalSale(db, tenantId, { ...input, order_id: order.id });
  await closeTableOrder(db, tenantId, tableId);
  return { committed, orderId: order.id };
}

/* ── Fase 2 helpers (pull / gate / upgrade backfill) ───────────────────── */

/** Open comanda ids of the tenant on THIS device (close-shift gate + counts). */
export async function listOpenOrderIds(db: LocalQueryable, tenantId: string): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE tenant_id = $1 AND state = 'open'`,
    [tenantId],
  );
  return res.rows.map((r) => r.id);
}

/**
 * Fase 1 → Fase 2 upgrade backfill: tables created BEFORE this module ever
 * touched sync_log have NO queue row, so they would never reach the server
 * (nor a rehydrating device). Idempotent: only rows WITHOUT a sync_log entry
 * are enqueued, so a queued edit is never overwritten and a re-run is a
 * no-op. Scope: every table + every OPEN comanda (and its lines) — settled
 * Fase 1 comanda history stays device-local on purpose: no other device
 * ever saw them open (they were never pushed), and their tickets already
 * carry `table_name`.
 *
 * Called once per session boot, BEFORE the sync engine's first drain
 * (App.tsx), so the enqueue rides the boot push.
 */
export async function backfillMesasMutations(db: PGlite, tenantId: string): Promise<number> {
  return localTx(db, async (tx) => {
    await assertWritable(tx, tenantId);
    const seen = (await tx.query<{ client_uuid: string }>(
      `SELECT client_uuid FROM sync_log WHERE tenant_id = $1`,
      [tenantId],
    )).rows;
    const queued = new Set(seen.map((r) => r.client_uuid));
    let enqueued = 0;

    const tables = (await tx.query<{
      id: string; name: string; zone: string | null; capacity: number; active: boolean;
    }>(`SELECT id, name, zone, capacity, active FROM tables WHERE tenant_id = $1`, [tenantId])).rows;
    for (const row of tables) {
      if (queued.has(row.id)) continue;
      await enqueueMutation(tx, tenantId, "table", row.id, {
        name: row.name, zone: row.zone, capacity: Number(row.capacity), active: row.active,
      });
      enqueued += 1;
    }

    const orders = (await tx.query<{
      id: string; table_id: string; state: string; opened_at: string;
      closed_at: string | null; billing_at: string | null; created_at: string;
    }>(`SELECT id, table_id, state, opened_at, closed_at, billing_at, created_at
        FROM orders WHERE tenant_id = $1 AND state = 'open'`, [tenantId])).rows;
    for (const order of orders) {
      if (queued.has(order.id)) continue;
      await enqueueMutation(tx, tenantId, "order", order.id, {
        table_id: order.table_id,
        state: order.state,
        opened_at: isoOf(order.opened_at),
        closed_at: isoOf(order.closed_at),
        billing_at: isoOf(order.billing_at),
        created_at: isoOf(order.created_at),
      });
      enqueued += 1;
      const lines = (await tx.query<LineRow>(
        `SELECT ${LINE_COLS} FROM order_lines WHERE tenant_id = $1 AND order_id = $2`,
        [tenantId, order.id],
      )).rows;
      for (const line of lines) {
        if (queued.has(line.id)) continue;
        await enqueueMutation(tx, tenantId, "order_line", line.id, linePayload(line));
        enqueued += 1;
      }
    }
    return enqueued;
  });
}
