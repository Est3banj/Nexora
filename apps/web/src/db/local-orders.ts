import type { PGlite } from "@electric-sql/pglite";
import { localTx, type LocalQueryable } from "./pglite";
import { assertWritable } from "./preservation";
import { commitLocalSale, type CommittedSale, type SaleCommitInput } from "./local";

/**
 * Mesas & comandas — LOCAL PGlite domain (CONTROL-MESAS.md · Fase 1 = opción C).
 *
 * Nothing in this file ever touches `sync_log`: orders are device-local until
 * Fase 2 turns them into sync entities. The ONLY thing that leaves the device
 * is `tickets.table_name`, stamped by `commitLocalSale` at cobro time.
 *
 * Invariants encoded here (each one is pinned by test/local-orders.test.ts):
 *  - `total_amount` is DERIVED from live lines (SUM(price*qty) WHERE
 *    deleted_at IS NULL) — never stored, so it can never drift.
 *  - Removing a line is a SOFT-DELETE (`deleted_at`): the sync protocol has
 *    no delete op, and a comanda is not money evidence until it is charged.
 *  - Stock is NEVER touched here — it is debited inside `commitLocalSale`,
 *    at cobro, by the existing sale transaction (invariant: no stockdiary
 *    before the ticket exists).
 *  - An order can only be closed ONCE: `closeTableOrder` throws
 *    ORDER_NOT_OPEN for an order that is already closed/cancelled, which is
 *    what blocks a double cobro at the data layer.
 */

const newId = () => globalThis.crypto.randomUUID();

export type TableStatus = "available" | "occupied" | "billing";
export type OrderState = "open" | "cancelled" | "closed";

export type LocalTable = {
  id: string;
  name: string;
  zone: string | null;
  capacity: number;
  status: TableStatus;
  current_order_id: string | null;
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

/* ── tables (CRUD, tenant-scoped local) ─────────────────────────────── */

const TABLE_COLS = `id, name, zone, capacity, status, current_order_id, opened_at, active`;

function rowToTable(r: Record<string, unknown>): LocalTable {
  return {
    id: String(r.id),
    name: String(r.name),
    zone: r.zone === null || r.zone === undefined ? null : String(r.zone),
    capacity: Number(r.capacity),
    status: String(r.status) as TableStatus,
    current_order_id: r.current_order_id === null || r.current_order_id === undefined ? null : String(r.current_order_id),
    opened_at: r.opened_at === null || r.opened_at === undefined ? null : new Date(String(r.opened_at)).toISOString(),
    active: Boolean(r.active),
  };
}

export async function listTables(
  db: PGlite,
  tenantId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<LocalTable[]> {
  const res = await db.query<Record<string, unknown>>(
    `SELECT ${TABLE_COLS} FROM tables WHERE tenant_id = $1${opts.activeOnly ? " AND active" : ""} ORDER BY name`,
    [tenantId],
  );
  return res.rows.map(rowToTable);
}

export async function getTable(db: PGlite, tenantId: string, id: string): Promise<LocalTable | null> {
  const res = await db.query<Record<string, unknown>>(
    `SELECT ${TABLE_COLS} FROM tables WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return res.rows[0] ? rowToTable(res.rows[0]) : null;
}

/**
 * Board payload: every ACTIVE table + the live totals of its OPEN comanda.
 * Status is NORMALIZED against the join (an orphaned `current_order_id`
 * pointing at a closed order reads as `available`, never as a ghost
 * occupied table).
 */
export async function listBoardTables(db: PGlite, tenantId: string): Promise<BoardTable[]> {
  const res = await db.query<Record<string, unknown>>(
    `SELECT t.id, t.name, t.zone, t.capacity, t.status, t.current_order_id, t.opened_at, t.active,
            o.id AS order_id,
            COALESCE((SELECT SUM(l.qty) FROM order_lines l
                       WHERE l.order_id = o.id AND l.deleted_at IS NULL), 0)::int AS items,
            COALESCE((SELECT SUM(l.price * l.qty) FROM order_lines l
                       WHERE l.order_id = o.id AND l.deleted_at IS NULL), 0)::int AS total
     FROM tables t
     LEFT JOIN orders o ON o.id = t.current_order_id AND o.state = 'open'
     WHERE t.tenant_id = $1 AND t.active
     ORDER BY t.name`,
    [tenantId],
  );
  return res.rows.map((r) => {
    const table = rowToTable(r);
    const orderId = r.order_id === null || r.order_id === undefined ? null : String(r.order_id);
    return {
      ...table,
      order_id: orderId,
      status: !orderId ? "available" : table.status === "billing" ? "billing" : "occupied",
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
        `INSERT INTO tables (id, tenant_id, name, zone, capacity, status, active)
         VALUES ($1, $2, $3, $4, $5, 'available', $6)`,
        [id, tenantId, clean.name, clean.zone, clean.capacity, input.active ?? true],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(MESAS_ERRORS.TABLE_NAME_TAKEN);
      throw err;
    }
    const row = (await tx.query<Record<string, unknown>>(
      `SELECT ${TABLE_COLS} FROM tables WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    )).rows[0];
    return rowToTable(row!);
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
      `SELECT ${TABLE_COLS} FROM tables WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [tenantId, id],
    )).rows[0];
    if (!current) throw new Error(MESAS_ERRORS.TABLE_NOT_FOUND);
    const table = rowToTable(current);

    const next = {
      name: patch.name !== undefined ? patch.name : table.name,
      zone: patch.zone !== undefined ? patch.zone : table.zone,
      capacity: patch.capacity !== undefined ? patch.capacity : table.capacity,
      active: patch.active !== undefined ? patch.active : table.active,
    };
    assertTableInput(next);

    /* Never silently destroy a comanda: deactivating an occupied table is
     * refused until the operator releases or charges it (no hidden data
     * loss — same principle as the leave-POS guard). */
    if (next.active === false && table.active && table.current_order_id) {
      const open = (await tx.query<{ state: string }>(
        `SELECT state FROM orders WHERE tenant_id = $1 AND id = $2`,
        [tenantId, table.current_order_id],
      )).rows[0];
      if (open?.state === "open") throw new Error(MESAS_ERRORS.TABLE_IN_USE);
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
  });
}

/* ── orders: open / save / load / close ─────────────────────────────── */

/** Finds the table's OPEN order, creating one on first save/charge. */
async function ensureOpenOrder(tx: LocalQueryable, tenantId: string, table: LocalTable): Promise<string> {
  if (table.current_order_id) {
    const order = (await tx.query<{ state: string }>(
      `SELECT state FROM orders WHERE tenant_id = $1 AND id = $2`,
      [tenantId, table.current_order_id],
    )).rows[0];
    if (order?.state === "open") return table.current_order_id;
  }
  const id = newId();
  await tx.query(
    `INSERT INTO orders (id, tenant_id, table_id, state, opened_at) VALUES ($1, $2, $3, 'open', now())`,
    [id, tenantId, table.id],
  );
  await tx.query(
    `UPDATE tables SET status = 'occupied', current_order_id = $3, opened_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, table.id, id],
  );
  table.current_order_id = id;
  return id;
}

async function readTableForUpdate(tx: LocalQueryable, tenantId: string, tableId: string): Promise<LocalTable> {
  const row = (await tx.query<Record<string, unknown>>(
    `SELECT ${TABLE_COLS} FROM tables WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenantId, tableId],
  )).rows[0];
  if (!row) throw new Error(MESAS_ERRORS.TABLE_NOT_FOUND);
  const table = rowToTable(row);
  if (!table.active) throw new Error(MESAS_ERRORS.TABLE_INACTIVE);
  return table;
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
 * (insert new, update changed, soft-delete removed) and flips the table to
 * `occupied`. One transaction: the board can never observe a half-saved
 * comanda. Stock is untouched (it moves only at cobro).
 */
export async function saveOrderToTable(
  db: PGlite,
  tenantId: string,
  tableId: string,
  lines: OrderSaveLine[],
): Promise<{ orderId: string; items: number; total: number }> {
  if (lines.length === 0) throw new Error(MESAS_ERRORS.EMPTY_ORDER);
  return mesasTx(db, tenantId, async (tx) => {
    const table = await readTableForUpdate(tx, tenantId, tableId);
    const orderId = await ensureOpenOrder(tx, tenantId, table);

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
      } else {
        await tx.query(
          `INSERT INTO order_lines (id, tenant_id, order_id, variant_id, name, price, qty, sort)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [newId(), tenantId, orderId, line.variant_id, line.name, line.price, line.qty, index],
        );
      }
    }

    /* Removals are a STATE (deleted_at), never a DELETE: the sync protocol
     * has no delete op and Fase 2 must reuse these rows as-is. */
    for (const row of existing) {
      if (kept.has(row.id)) continue;
      await tx.query(
        `UPDATE order_lines SET deleted_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, row.id],
      );
    }

    const openedAt = (await tx.query<{ opened_at: string }>(
      `SELECT opened_at FROM orders WHERE tenant_id = $1 AND id = $2`,
      [tenantId, orderId],
    )).rows[0]?.opened_at;
    await tx.query(
      `UPDATE tables SET status = 'occupied', current_order_id = $3, opened_at = $4, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, table.id, orderId, openedAt ?? new Date().toISOString()],
    );

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
  const table = await getTable(db, tenantId, tableId);
  if (!table?.current_order_id) return null;
  const order = (await db.query<{ state: string }>(
    `SELECT state FROM orders WHERE tenant_id = $1 AND id = $2`,
    [tenantId, table.current_order_id],
  )).rows[0];
  if (order?.state !== "open") return null;

  const res = await db.query<{ variant_id: string; name: string; price: number; qty: number; stock: number | null }>(
    `SELECT l.variant_id, l.name, l.price, l.qty, v.stock
     FROM order_lines l
     LEFT JOIN product_variants v ON v.id = l.variant_id AND v.tenant_id = l.tenant_id
     WHERE l.tenant_id = $1 AND l.order_id = $2 AND l.deleted_at IS NULL
     ORDER BY l.sort, l.created_at`,
    [tenantId, table.current_order_id],
  );
  return {
    orderId: table.current_order_id,
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
    const table = await readTableForUpdate(tx, tenantId, tableId);
    const orderId = table.current_order_id;
    const order = orderId
      ? (await tx.query<{ state: string }>(
          `SELECT state FROM orders WHERE tenant_id = $1 AND id = $2`,
          [tenantId, orderId],
        )).rows[0]
      : undefined;
    /* THE double-cobro guard: an order that is already closed/cancelled (or
     * a table with no order at all) can never be closed again — no second
     * ticket path exists through this function. */
    if (!orderId || order?.state !== "open") throw new Error(MESAS_ERRORS.ORDER_NOT_OPEN);

    await tx.query(
      `UPDATE orders SET state = $3, closed_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, orderId, next],
    );
    await tx.query(
      `UPDATE tables SET status = 'available', current_order_id = NULL, opened_at = NULL, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, table.id],
    );
    return { orderId };
  });
}

/** Post-cobro: order → closed, table → available (Flujo C). */
export async function closeTableOrder(db: PGlite, tenantId: string, tableId: string): Promise<{ orderId: string }> {
  return closeOrCancel(db, tenantId, tableId, "closed");
}

/** «Liberar» without charging: order → cancelled, table → available. */
export async function releaseTable(db: PGlite, tenantId: string, tableId: string): Promise<{ orderId: string }> {
  return closeOrCancel(db, tenantId, tableId, "cancelled");
}

/** «Pedir cuenta»: table → billing, the comanda stays open. */
export async function setTableBilling(db: PGlite, tenantId: string, tableId: string): Promise<void> {
  await mesasTx(db, tenantId, async (tx) => {
    const table = await readTableForUpdate(tx, tenantId, tableId);
    const order = table.current_order_id
      ? (await tx.query<{ state: string }>(
          `SELECT state FROM orders WHERE tenant_id = $1 AND id = $2`,
          [tenantId, table.current_order_id],
        )).rows[0]
      : undefined;
    if (!table.current_order_id || order?.state !== "open") throw new Error(MESAS_ERRORS.ORDER_NOT_OPEN);
    await tx.query(
      `UPDATE tables SET status = 'billing', updated_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tenantId, table.id],
    );
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
 *     stockdiary in one tx, ticket stamped with `table_name`. The invariant
 *     «stock debits at cobro, next to the persisted ticket» is untouched.
 *  3. CLOSE the order + free the table, only after the ticket exists.
 *
 * Steps 1 and 3 are separate local transactions: the POS is single-tab with
 * a synchronous busy-flag on the payment modal, so no interleaving exists
 * between them in Fase 1.
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
  const orderId = table.current_order_id;
  const state = orderId
    ? (await db.query<{ state: string }>(
        `SELECT state FROM orders WHERE tenant_id = $1 AND id = $2`,
        [tenantId, orderId],
      )).rows[0]?.state
    : undefined;
  if (!orderId || state !== "open") throw new Error(MESAS_ERRORS.ORDER_NOT_OPEN);

  const committed = await commitLocalSale(db, tenantId, input);
  await closeTableOrder(db, tenantId, tableId);
  return { committed, orderId };
}
