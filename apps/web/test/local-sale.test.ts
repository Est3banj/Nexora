import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../src/db/pglite";
import {
  adjustLocalStock,
  commitLocalSale,
  createLocalProduct,
  getLocalTicket,
  listLocalTickets,
  pendingCount,
  recountLocal,
} from "../src/db/local";
import { DEFAULT_SETTINGS, settingsCacheKey } from "../src/lib/settings";

/**
 * D1-8 · Local-only sale skeleton [D1 E2E GATE — unit side]
 * AC (sales spec):
 *  - §Cart arithmetic: 2×4000 + 3×7000 = 29000; empty cart blocked
 *  - §Cash checkout: exact / over / under-payment
 *  - §Atomic local-first: partial write impossible; sale visible locally
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
    variant: { name: "330ml", price: 4000, stock: 100 },
  });
  const b = await createLocalProduct(db, TENANT, {
    name: "Cerveza",
    variant: { name: "600ml", price: 7000, stock: 100 },
  });
  variantA = a.variants[0].id;
  variantB = b.variants[0].id;
});

afterEach(async () => {
  release();
  await db.close();
  vi.unstubAllGlobals();
});

async function countRows(table: string): Promise<number> {
  const res = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`,
    [TENANT],
  );
  return Number(res.rows[0]?.n ?? 0);
}

describe("cart arithmetic (spec number)", () => {
  it("2×4000 + 3×7000 = 29000 as the ticket total", async () => {
    const sale = await commitLocalSale(db, TENANT, {
      lines: [
        { variant_id: variantA, qty: 2, unit_price: 4000 },
        { variant_id: variantB, qty: 3, unit_price: 7000 },
      ],
      tendered: 29000,
    });
    expect(sale.ticket.total).toBe(29000);
    expect(sale.payments[0].amount).toBe(29000);
    expect(sale.payments[0].vuelto).toBe(0);
  });
});

describe("empty cart blocked", () => {
  it("throws EMPTY_CART and creates NO rows", async () => {
    await expect(
      commitLocalSale(db, TENANT, { lines: [], tendered: 0 }),
    ).rejects.toThrow("EMPTY_CART");
    expect(await countRows("tickets")).toBe(0);
    expect(await countRows("ticket_lines")).toBe(0);
    expect(await countRows("payments")).toBe(0);
  });
});

describe("cash checkout (exact / over / under)", () => {
  it("exact change → vuelto 0", async () => {
    const sale = await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: variantA, qty: 3, unit_price: 4000 }],
      tendered: 12000,
    });
    expect(sale.payments[0].vuelto).toBe(0);
    expect(sale.payments[0].status).toBe("confirmed");
  });

  it("overpayment computes vuelto 8000", async () => {
    const sale = await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: variantA, qty: 3, unit_price: 4000 }],
      tendered: 20000,
    });
    expect(sale.payments[0].vuelto).toBe(8000);
  });

  it("underpayment rejected — no ticket created", async () => {
    await expect(
      commitLocalSale(db, TENANT, {
        lines: [{ variant_id: variantA, qty: 3, unit_price: 4000 }],
        tendered: 10000,
      }),
    ).rejects.toThrow("UNDERPAYMENT");
    expect(await countRows("tickets")).toBe(0);
    expect(await countRows("payments")).toBe(0);
  });
});

describe("atomic local-first commit", () => {
  it("ticket + lines + payment + sync_log land together, visible locally", async () => {
    const sale = await commitLocalSale(db, TENANT, {
      lines: [
        { variant_id: variantA, qty: 2, unit_price: 4000 },
        { variant_id: variantB, qty: 1, unit_price: 7000 },
      ],
      tendered: 15000,
    });

    expect(await countRows("tickets")).toBe(1);
    expect(await countRows("ticket_lines")).toBe(2);
    expect(await countRows("payments")).toBe(1);

    // one pending queue entry per sale entity: 1 ticket + 2 lines + 1 payment
    // + 2 stockdiary (one per line, D3-1); the catalog fixture adds 6
    // (2 products × [product, variant, stockdiary]) and the 2 sale variant
    // REFRESHES reuse those existing variant rows (upsert-latest, D1 note)
    const queue = await db.query<{ entity: string; status: string }>(
      `SELECT entity, status FROM sync_log WHERE tenant_id = $1 ORDER BY entity`,
      [TENANT],
    );
    const saleEntities = queue.rows
      .map((r) => r.entity)
      .filter((e) => e === "ticket" || e === "ticket_line" || e === "payment");
    expect(saleEntities).toEqual(["payment", "ticket", "ticket_line", "ticket_line"]);
    expect(queue.rows.every((r) => r.status === "pending")).toBe(true);

    // visible locally through the list + detail views
    const tickets = await listLocalTickets(db, TENANT);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].total).toBe(15000);
    expect(tickets[0].method).toBe("cash");

    const detail = await getLocalTicket(db, TENANT, sale.ticket.id);
    expect(detail?.lines).toHaveLength(2);
    expect(detail?.ticket.total).toBe(15000);

    // sale 4 + 2 stockdiary + fixture catalog 6 = 12 pending rows
    expect(await pendingCount(db, TENANT)).toBe(4 + 2 + 6);
  });

  it("ticket_no is a tenant sequence starting at 1", async () => {
    const first = await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: variantA, qty: 1, unit_price: 4000 }],
      tendered: 4000,
    });
    const second = await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: variantA, qty: 1, unit_price: 4000 }],
      tendered: 4000,
    });
    expect(first.ticket.ticket_no).toBe(1);
    expect(second.ticket.ticket_no).toBe(2);
  });

  it("sale attaches to the open shift when one exists", async () => {
    const shiftId = crypto.randomUUID();
    await db.query(
      `INSERT INTO shifts (id, tenant_id, client_uuid, status) VALUES ($1, $2, $1, 'open')`,
      [shiftId, TENANT],
    );
    const sale = await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: variantA, qty: 1, unit_price: 4000 }],
      tendered: 4000,
    });
    const payment = await db.query<{ shift_id: string | null }>(
      `SELECT shift_id FROM payments WHERE id = $1`,
      [sale.payments[0].id],
    );
    expect(payment.rows[0]?.shift_id).toBe(shiftId);
  });

  it("sale without an open shift is still recorded (shift_id null)", async () => {
    const sale = await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: variantA, qty: 1, unit_price: 4000 }],
      tendered: 4000,
    });
    const ticket = await db.query<{ shift_id: string | null }>(
      `SELECT shift_id FROM tickets WHERE id = $1`,
      [sale.ticket.id],
    );
    expect(ticket.rows[0]?.shift_id).toBeNull();
  });
});

describe("stock on sale (D3-1)", () => {
  async function invariant(id: string) {
    const v = await db.query<{ stock: number }>(
      `SELECT stock FROM product_variants WHERE tenant_id = $1 AND id = $2`,
      [TENANT, id],
    );
    const s = await db.query<{ stock: number }>(
      `SELECT stock FROM stockcurrent WHERE tenant_id = $1 AND variant_id = $2`,
      [TENANT, id],
    );
    const sum = await recountLocal(db, TENANT, id);
    return {
      variants: v.rows[0]?.stock ?? null,
      current: s.rows[0]?.stock ?? null,
      sum,
    };
  }

  it("sale of 2 from stock 10 records −2 and leaves 8 (catalog spec)", async () => {
    // fixture starts at 100 → bring it to the spec's 10
    await adjustLocalStock(db, TENANT, {
      variant_id: variantA,
      delta: -90,
      reason: "recount",
      note: "ajuste inicial al escenario",
    });

    const sale = await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: variantA, qty: 2, unit_price: 4000 }],
      tendered: 8000,
    });

    const inv = await invariant(variantA);
    expect(inv.sum).toBe(8);
    expect(inv.variants).toBe(8);
    expect(inv.current).toBe(8);

    // movement references the ticket and is queued as pending
    const diary = await db.query<{
      delta: number;
      reason: string;
      ref_ticket_id: string | null;
    }>(
      `SELECT delta, reason, ref_ticket_id FROM stockdiary
       WHERE tenant_id = $1 AND variant_id = $2 AND reason = 'sale'`,
      [TENANT, variantA],
    );
    expect(diary.rows).toHaveLength(1);
    expect(diary.rows[0].delta).toBe(-2);
    expect(diary.rows[0].ref_ticket_id).toBe(sale.ticket.id);

    // the ABSOLUTE stock refresh rides along with the movement (upsert-latest)
    const refresh = await db.query<{ payload: Record<string, unknown>; status: string }>(
      `SELECT payload, status FROM sync_log WHERE tenant_id = $1 AND client_uuid = $2`,
      [TENANT, variantA],
    );
    expect(refresh.rows[0].status).toBe("pending");
    expect(refresh.rows[0].payload).toMatchObject({
      stock: 8,
      ref_ticket_id: sale.ticket.id,
    });
  });

  it("overselling is allowed: stock 1, sell 3 → balance −2 (flagged later in reports)", async () => {
    await adjustLocalStock(db, TENANT, {
      variant_id: variantA,
      delta: -99,
      reason: "recount",
      note: "al mínimo",
    });
    const sale = await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: variantA, qty: 3, unit_price: 4000 }],
      tendered: 12000,
    });
    expect(sale.ticket.total).toBe(12000);

    const inv = await invariant(variantA);
    expect(inv.sum).toBe(-2);
    expect(inv.variants).toBe(-2);
    expect(inv.current).toBe(-2);
  });

  it("two lines → two movements, each −qty, recount equals stored balance", async () => {
    await commitLocalSale(db, TENANT, {
      lines: [
        { variant_id: variantA, qty: 5, unit_price: 4000 },
        { variant_id: variantB, qty: 3, unit_price: 7000 },
      ],
      tendered: 41000,
    });

    const invA = await invariant(variantA);
    const invB = await invariant(variantB);
    expect(invA).toEqual({ sum: 95, variants: 95, current: 95 });
    expect(invB).toEqual({ sum: 97, variants: 97, current: 97 });
  });
});

describe("NEGATIVE_STOCK local guard (roles-admin 3.8)", () => {
  function stubNegativeStockCache() {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) =>
        k === settingsCacheKey(TENANT)
          ? JSON.stringify({ ...DEFAULT_SETTINGS, allow_negative_stock: false })
          : null,
      setItem: () => {},
      removeItem: () => {},
      key: () => null,
      length: 0,
    });
  }

  it("cached allow_negative_stock=false blocks a below-zero sale with NEGATIVE_STOCK (no rows land)", async () => {
    stubNegativeStockCache();
    // fixture starts at 100 → bring it to 1
    await adjustLocalStock(db, TENANT, {
      variant_id: variantA,
      delta: -99,
      reason: "recount",
      note: "al mínimo",
    });

    await expect(
      commitLocalSale(db, TENANT, {
        lines: [{ variant_id: variantA, qty: 3, unit_price: 4000 }],
        tendered: 12000,
      }),
    ).rejects.toThrow("NEGATIVE_STOCK");

    // whole tx rolled back — nothing committed, nothing enqueued
    expect(await countRows("tickets")).toBe(0);
    expect(await countRows("ticket_lines")).toBe(0);
    expect(await countRows("payments")).toBe(0);
    // 2 fixture initial movements + 1 adjustment; the blocked sale adds ZERO
    expect(await countRows("stockdiary")).toBe(3);
    const stock = await db.query<{ stock: number }>(
      `SELECT stock FROM product_variants WHERE tenant_id = $1 AND id = $2`,
      [TENANT, variantA],
    );
    expect(stock.rows[0].stock).toBe(1);
  });

  it("same cache still allows a sale that stays non-negative (qty 1 from stock 1 → 0)", async () => {
    stubNegativeStockCache();
    await adjustLocalStock(db, TENANT, {
      variant_id: variantA,
      delta: -99,
      reason: "recount",
      note: "al mínimo",
    });

    const sale = await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: variantA, qty: 1, unit_price: 4000 }],
      tendered: 4000,
    });
    expect(sale.ticket.total).toBe(4000);
    const stock = await db.query<{ stock: number }>(
      `SELECT stock FROM product_variants WHERE tenant_id = $1 AND id = $2`,
      [TENANT, variantA],
    );
    expect(stock.rows[0].stock).toBe(0);
  });

  it("absent cache (defaults) keeps today's oversell-allowed behavior", async () => {
    // no localStorage stub → readSettingsCache returns DEFAULT_SETTINGS
    await adjustLocalStock(db, TENANT, {
      variant_id: variantA,
      delta: -99,
      reason: "recount",
      note: "al mínimo",
    });
    const sale = await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: variantA, qty: 3, unit_price: 4000 }],
      tendered: 12000,
    });
    expect(sale.ticket.total).toBe(12000);
    expect(await recountLocal(db, TENANT, variantA)).toBe(-2);
  });
});
