import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_SCHEMA_SQL,
  MESAS_MIGRATION_SQL,
  SALE_OUTBOX_MIGRATION_SQL,
} from "@pos/shared";
import { openLocalDb } from "../src/db/pglite";
import { PRESERVATION_SQL } from "../src/db/preservation";
import { createLocalProduct } from "../src/db/local";
import {
  MESAS_ERRORS,
  commitTableSale,
  createLocalTable,
  getTable,
  listBoardTables,
  listTables,
  loadTableOrder,
  releaseTable,
  saveOrderToTable,
  setTableBilling,
  closeTableOrder,
  updateLocalTable,
} from "../src/db/local-orders";

/**
 * Fase 1 · Control de Mesas & Comandas — unit side.
 *
 * Pins the data-layer invariants of CONTROL-MESAS.md:
 *  - totals are DERIVED from live lines (never stored);
 *  - removing a line is a soft-delete (`deleted_at`), never a DELETE;
 *  - NO ticket / NO payment / NO stock movement before the cobro;
 *  - the ticket IS stamped with the table name at cobro;
 *  - an order closes ONCE — the second cobro dies with ORDER_NOT_OPEN
 *    and writes nothing;
 *  - comandas survive a real reload (file-backed PGlite, open → close →
 *    reopen), i.e. they live in PGlite, not in React state.
 */

const TENANT = "33333333-3333-4333-8333-333333333333";

let db: PGlite;
let release: () => void;
let variantA: string;
let variantB: string;

beforeEach(async () => {
  const handle = await openLocalDb({ url: "memory://", locks: null });
  db = handle!.db;
  release = handle!.release;

  const a = await createLocalProduct(db, TENANT, {
    name: "Cerveza",
    variant: { name: "330ml", price: 4000, stock: 50 },
  });
  const b = await createLocalProduct(db, TENANT, {
    name: "Papas",
    variant: { name: "Fritas", price: 8000, stock: 20 },
  });
  variantA = a.variants[0].id;
  variantB = b.variants[0].id;
});

afterEach(async () => {
  release();
  await db.close();
});

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const res = await db.query<{ n: string }>(sql, params);
  return Number(res.rows[0]?.n ?? 0);
}

async function newTable(name = "Mesa 1", zone: string | null = "Salón Principal", capacity = 4) {
  return createLocalTable(db, TENANT, { name, zone, capacity });
}

const lineA = (qty: number) => ({ variant_id: variantA, name: "Cerveza 330ml", price: 4000, qty });
const lineB = (qty: number) => ({ variant_id: variantB, name: "Papas Fritas", price: 8000, qty });

describe("CRUD de mesas (tenant-scoped local)", () => {
  it("crea, lista, edita y valida nombre/zone/capacidad", async () => {
    const table = await newTable();
    expect(table.status).toBe("available");
    expect(table.current_order_id).toBeNull();
    expect(table.zone).toBe("Salón Principal");
    expect(table.capacity).toBe(4);
    expect(table.active).toBe(true);

    const rows = await listTables(db, TENANT);
    expect(rows.map((t) => t.id)).toEqual([table.id]);

    await updateLocalTable(db, TENANT, table.id, { zone: "Terraza", capacity: 8, active: false });
    const updated = await getTable(db, TENANT, table.id);
    expect(updated).toMatchObject({ zone: "Terraza", capacity: 8, active: false });
    /* inactive tables leave the board */
    expect(await listTables(db, TENANT, { activeOnly: true })).toHaveLength(0);
  });

  it("rechaza capacidad < 1, nombre vacío y nombre duplicado activo", async () => {
    await expect(newTable("Mesa X", null, 0)).rejects.toThrow(/capacidad/i);
    await expect(createLocalTable(db, TENANT, { name: "   ", zone: null, capacity: 2 })).rejects.toThrow(
      /nombre/i,
    );
    await newTable("Mesa Dup");
    await expect(newTable("Mesa Dup")).rejects.toThrow(MESAS_ERRORS.TABLE_NAME_TAKEN);
  });

  it("no deja desactivar una mesa con comanda abierta", async () => {
    const table = await newTable();
    await saveOrderToTable(db, TENANT, table.id, [lineA(1)]);
    await expect(updateLocalTable(db, TENANT, table.id, { active: false })).rejects.toThrow(
      MESAS_ERRORS.TABLE_IN_USE,
    );
    /* liberar primero → ahora sí se puede desactivar */
    await releaseTable(db, TENANT, table.id);
    await updateLocalTable(db, TENANT, table.id, { active: false });
    expect((await getTable(db, TENANT, table.id))!.active).toBe(false);
  });
});

describe("transiciones available ↔ occupied ↔ billing", () => {
  it("guardar ocupa, pedir cuenta factura, volver a guardar desfactura, cerrar libera", async () => {
    const table = await newTable();
    expect((await listBoardTables(db, TENANT))[0].status).toBe("available");

    const saved = await saveOrderToTable(db, TENANT, table.id, [lineA(2), lineB(1)]);
    expect(saved).toEqual({ orderId: expect.any(String), items: 3, total: 16000 });

    let board = await listBoardTables(db, TENANT);
    expect(board[0]).toMatchObject({ status: "occupied", items: 3, total: 16000 });
    expect(board[0].order_id).toBe(saved.orderId);
    expect(board[0].opened_at).not.toBeNull();

    await setTableBilling(db, TENANT, table.id);
    board = await listBoardTables(db, TENANT);
    expect(board[0].status).toBe("billing");
    /* the comanda stays OPEN while the table is billing */
    expect((await loadTableOrder(db, TENANT, table.id))!.orderId).toBe(saved.orderId);

    /* «otro pedido después de pedir la cuenta» → vuelve a ocupada */
    await saveOrderToTable(db, TENANT, table.id, [lineA(2), lineB(2)]);
    board = await listBoardTables(db, TENANT);
    expect(board[0].status).toBe("occupied");
    expect(board[0].items).toBe(4);
    expect(board[0].total).toBe(24000);

    await closeTableOrder(db, TENANT, table.id);
    board = await listBoardTables(db, TENANT);
    expect(board[0].status).toBe("available");
    expect(board[0].order_id).toBeNull();
    expect(board[0].items).toBe(0);
    expect(board[0].total).toBe(0);
    const after = await getTable(db, TENANT, table.id);
    expect(after).toMatchObject({ current_order_id: null, opened_at: null, status: "available" });
  });

  it("«Pedir cuenta» sin comanda abierta está bloqueado", async () => {
    const table = await newTable();
    await expect(setTableBilling(db, TENANT, table.id)).rejects.toThrow(MESAS_ERRORS.ORDER_NOT_OPEN);
  });
});

describe("guardar / retomar comanda + soft-delete de líneas", () => {
  it("el carrito se persiste, se retoma completo y quitar una línea es un soft-delete", async () => {
    const table = await newTable();
    const first = await saveOrderToTable(db, TENANT, table.id, [lineA(2), lineB(1)]);
    expect(first.total).toBe(16000);

    /* retomar: las líneas vuelven al formato del carrito, con el stock ACTUAL */
    const resumed = await loadTableOrder(db, TENANT, table.id);
    expect(resumed).not.toBeNull();
    expect(resumed!.lines).toEqual([
      { variantId: variantA, label: "Cerveza 330ml", price: 4000, qty: 2, stock: 50 },
      { variantId: variantB, label: "Papas Fritas", price: 8000, qty: 1, stock: 20 },
    ]);

    /* quitar B + bajar A a 1 → la fila de B SOBREVIVE con deleted_at */
    const second = await saveOrderToTable(db, TENANT, table.id, [lineA(1)]);
    expect(second.total).toBe(4000);
    expect(second.items).toBe(1);

    const rows = await db.query<{ variant_id: string; qty: number; deleted_at: string | null }>(
      `SELECT variant_id, qty, deleted_at FROM order_lines WHERE tenant_id = $1 ORDER BY sort, created_at`,
      [TENANT],
    );
    expect(rows.rows).toHaveLength(2);
    const kept = rows.rows.find((r) => r.variant_id === variantA)!;
    const removed = rows.rows.find((r) => r.variant_id === variantB)!;
    expect(kept).toMatchObject({ qty: 1, deleted_at: null });
    expect(removed.deleted_at).not.toBeNull();

    /* the derived total NEVER counts a soft-deleted line */
    const board = await listBoardTables(db, TENANT);
    expect(board[0].total).toBe(4000);
    expect(board[0].items).toBe(1);
  });

  it("guardar sin líneas está bloqueado", async () => {
    const table = await newTable();
    await expect(saveOrderToTable(db, TENANT, table.id, [])).rejects.toThrow(MESAS_ERRORS.EMPTY_ORDER);
  });
});

describe("cero efecto en ventas hasta cobrar", () => {
  it("una comanda abierta no toca tickets, pagos ni stock", async () => {
    const table = await newTable();
    const before = {
      tickets: await scalar(`SELECT count(*) AS n FROM tickets WHERE tenant_id = $1`, [TENANT]),
      payments: await scalar(`SELECT count(*) AS n FROM payments WHERE tenant_id = $1`, [TENANT]),
      diary: await scalar(`SELECT count(*) AS n FROM stockdiary WHERE tenant_id = $1`, [TENANT]),
      stockA: await scalar(`SELECT stock AS n FROM product_variants WHERE tenant_id = $1 AND id = $2`, [TENANT, variantA]),
      outbox: await scalar(`SELECT count(*) AS n FROM sync_sale_outbox WHERE tenant_id = $1`, [TENANT]),
    };

    await saveOrderToTable(db, TENANT, table.id, [lineA(5)]);
    await setTableBilling(db, TENANT, table.id);

    expect(await scalar(`SELECT count(*) AS n FROM tickets WHERE tenant_id = $1`, [TENANT])).toBe(before.tickets);
    expect(await scalar(`SELECT count(*) AS n FROM payments WHERE tenant_id = $1`, [TENANT])).toBe(before.payments);
    expect(await scalar(`SELECT count(*) AS n FROM stockdiary WHERE tenant_id = $1`, [TENANT])).toBe(before.diary);
    expect(await scalar(`SELECT stock AS n FROM product_variants WHERE tenant_id = $1 AND id = $2`, [TENANT, variantA])).toBe(
      before.stockA,
    );
    expect(await scalar(`SELECT count(*) AS n FROM sync_sale_outbox WHERE tenant_id = $1`, [TENANT])).toBe(before.outbox);
  });
});

describe("cobro de mesa (Flujo C)", () => {
  it("emite UN ticket con table_name, debita stock y cierra la comanda", async () => {
    const table = await newTable("Mesa 7", "Terraza");
    await saveOrderToTable(db, TENANT, table.id, [lineA(2)]);

    const diaryBefore = await scalar(`SELECT count(*) AS n FROM stockdiary WHERE tenant_id = $1`, [TENANT]);
    const { committed, orderId } = await commitTableSale(db, TENANT, table.id, {
      lines: [{ variant_id: variantA, qty: 2, unit_price: 4000 }],
      tendered: 8000,
      table_name: "Mesa 7",
    });

    expect(committed.ticket.table_name).toBe("Mesa 7");
    expect(committed.ticket.total).toBe(8000);

    /* stock debits AT cobro, next to the persisted ticket (invariant) */
    expect(await scalar(`SELECT stock AS n FROM product_variants WHERE tenant_id = $1 AND id = $2`, [TENANT, variantA])).toBe(48);
    expect(await scalar(`SELECT count(*) AS n FROM stockdiary WHERE tenant_id = $1`, [TENANT])).toBe(diaryBefore + 1);
    expect(
      await scalar(`SELECT count(*) AS n FROM stockdiary WHERE tenant_id = $1 AND reason = 'sale'`, [TENANT]),
    ).toBe(1);

    /* order closed + table freed */
    const order = await db.query<{ state: string; closed_at: string | null }>(
      `SELECT state, closed_at FROM orders WHERE tenant_id = $1 AND id = $2`,
      [TENANT, orderId],
    );
    expect(order.rows[0].state).toBe("closed");
    expect(order.rows[0].closed_at).not.toBeNull();
    const freed = await getTable(db, TENANT, table.id);
    expect(freed).toMatchObject({ status: "available", current_order_id: null, opened_at: null });
    expect(await loadTableOrder(db, TENANT, table.id)).toBeNull();

    /* the sync payload carries the table too (receipt after rehydrate) */
    const payload = await db.query<{ payload: { table_name?: string | null } }>(
      `SELECT payload FROM sync_log WHERE tenant_id = $1 AND entity = 'ticket'`,
      [TENANT],
    );
    expect(payload.rows[0].payload.table_name).toBe("Mesa 7");
  });

  it("doble cobro bloqueado: el segundo intento no escribe nada", async () => {
    const table = await newTable();
    await saveOrderToTable(db, TENANT, table.id, [lineA(1)]);
    const input = {
      lines: [{ variant_id: variantA, qty: 1, unit_price: 4000 }],
      tendered: 4000,
      table_name: table.name,
    };
    await commitTableSale(db, TENANT, table.id, input);

    await expect(commitTableSale(db, TENANT, table.id, input)).rejects.toThrow(MESAS_ERRORS.ORDER_NOT_OPEN);
    await expect(closeTableOrder(db, TENANT, table.id)).rejects.toThrow(MESAS_ERRORS.ORDER_NOT_OPEN);

    expect(await scalar(`SELECT count(*) AS n FROM tickets WHERE tenant_id = $1`, [TENANT])).toBe(1);
    expect(await scalar(`SELECT count(*) AS n FROM payments WHERE tenant_id = $1`, [TENANT])).toBe(1);
    expect(await scalar(`SELECT stock AS n FROM product_variants WHERE tenant_id = $1 AND id = $2`, [TENANT, variantA])).toBe(49);
  });

  it("cobrar una mesa sin comanda abierta no emite ticket", async () => {
    const table = await newTable();
    await expect(
      commitTableSale(db, TENANT, table.id, {
        lines: [{ variant_id: variantA, qty: 1, unit_price: 4000 }],
        tendered: 4000,
        table_name: table.name,
      }),
    ).rejects.toThrow(MESAS_ERRORS.ORDER_NOT_OPEN);
    expect(await scalar(`SELECT count(*) AS n FROM tickets WHERE tenant_id = $1`, [TENANT])).toBe(0);
  });
});

describe("liberar sin cobrar", () => {
  it("cancela la comanda, libera la mesa y no emite ticket ni toca stock", async () => {
    const table = await newTable();
    await saveOrderToTable(db, TENANT, table.id, [lineA(3)]);
    const orderId = (await getTable(db, TENANT, table.id))!.current_order_id!;

    const { orderId: closed } = await releaseTable(db, TENANT, table.id);
    expect(closed).toBe(orderId);

    const order = await db.query<{ state: string }>(
      `SELECT state FROM orders WHERE tenant_id = $1 AND id = $2`,
      [TENANT, orderId],
    );
    expect(order.rows[0].state).toBe("cancelled");
    expect(await scalar(`SELECT count(*) AS n FROM tickets WHERE tenant_id = $1`, [TENANT])).toBe(0);
    expect(await scalar(`SELECT stock AS n FROM product_variants WHERE tenant_id = $1 AND id = $2`, [TENANT, variantA])).toBe(50);
    const freed = await getTable(db, TENANT, table.id);
    expect(freed).toMatchObject({ status: "available", current_order_id: null, opened_at: null });
  });

  it("liberar una mesa libre está bloqueado", async () => {
    const table = await newTable();
    await expect(releaseTable(db, TENANT, table.id)).rejects.toThrow(MESAS_ERRORS.ORDER_NOT_OPEN);
  });
});

describe("persistencia tras reload", () => {
  it("la comanda vive en PGlite: sobrevive close + reopen (file-backed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pos-mesas-"));
    const open = async () => {
      const handle = new PGlite(dir, { fs: new NodeFS(dir) });
      await handle.exec(LOCAL_SCHEMA_SQL);
      await handle.exec(SALE_OUTBOX_MIGRATION_SQL);
      await handle.exec(MESAS_MIGRATION_SQL);
      await handle.exec(PRESERVATION_SQL);
      return handle;
    };
    try {
      let conn = await open();
      await createLocalProduct(conn, TENANT, {
        name: "Cerveza",
        variant: { name: "330ml", price: 4000, stock: 50 },
      });
      const variant = (await conn.query<{ id: string }>(
        `SELECT id FROM product_variants WHERE tenant_id = $1`,
        [TENANT],
      )).rows[0].id;
      const table = await createLocalTable(conn, TENANT, { name: "Mesa Reload", zone: "Barra", capacity: 2 });
      await saveOrderToTable(conn, TENANT, table.id, [
        { variant_id: variant, name: "Cerveza 330ml", price: 4000, qty: 2 },
      ]);
      await conn.close();

      /* reload: a brand-new connection over the same data dir */
      conn = await open();
      const board = await listBoardTables(conn, TENANT);
      expect(board).toHaveLength(1);
      expect(board[0]).toMatchObject({ name: "Mesa Reload", status: "occupied", items: 2, total: 8000 });
      const resumed = await loadTableOrder(conn, TENANT, board[0].id);
      expect(resumed!.lines).toEqual([
        { variantId: variant, label: "Cerveza 330ml", price: 4000, qty: 2, stock: 50 },
      ]);
      await conn.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
