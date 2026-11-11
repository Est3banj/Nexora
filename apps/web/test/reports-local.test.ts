import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { defaultReportRange } from "@pos/shared";
import { openLocalDb } from "../src/db/pglite";
import {
  commitLocalSale,
  createLocalProduct,
} from "../src/db/local";
import {
  hasUnsyncedMutations,
  localLowStock,
  localSalesByDay,
  localSalesByHour,
  localTopProducts,
} from "../src/db/local-reports";

/**
 * D3-5 · Local report queries (offline path) + staleness flag.
 * AC (reports spec):
 *  - offline: same shared SQL over PGlite renders the numbers
 *  - §Empty period → empty rows, no crash
 *  - staleness indicator source: pending sync_log rows (clears after sync)
 */

const TENANT = "55555555-5555-4555-8555-555555555555";

let db: PGlite;
let release: () => void;

beforeEach(async () => {
  const handle = await openLocalDb({ url: "memory://", locks: null });
  db = handle!.db;
  release = handle!.release;
});

afterEach(async () => {
  release();
  await db.close();
});

describe("local reports (shared SQL over PGlite)", () => {
  it("offline sale shows up in sales-by-day + top products with exact numbers", async () => {
    const product = await createLocalProduct(db, TENANT, {
      name: "Granizado",
      variant: { name: "Mediano", price: 3500, stock: 10 },
    });
    await commitLocalSale(db, TENANT, {
      lines: [{ variant_id: product.variants[0].id, qty: 2, unit_price: 3500 }],
      tendered: 7000,
    });

    const range = defaultReportRange();
    const sales = await localSalesByDay(db, TENANT, range);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({
      day: range.to,
      tickets: 1,
      revenue: 7000,
      pending: 0,
      cash: 7000,
      transfer: 0,
    });

    const top = await localTopProducts(db, TENANT, range);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({
      product_name: "Granizado",
      variant_name: "Mediano",
      qty: 2,
      revenue: 7000,
    });
  });

  it("low stock flags the at-threshold variant (5 ≤ default 5) and skips the high one", async () => {
    await createLocalProduct(db, TENANT, {
      name: "Bajo",
      variant: { name: "Único", price: 1000, stock: 5 },
    });
    await createLocalProduct(db, TENANT, {
      name: "Alto",
      variant: { name: "Único", price: 1000, stock: 50 },
    });

    const low = await localLowStock(db, TENANT);
    expect(low).toHaveLength(1);
    expect(low[0]).toMatchObject({
      product_name: "Bajo",
      stock: 5,
      threshold: 5,
    });
  });

  it("empty period → empty rows, no error", async () => {
    const sales = await localSalesByDay(db, TENANT, {
      from: "2027-01-01",
      to: "2027-01-07",
    });
    const top = await localTopProducts(db, TENANT, {
      from: "2027-01-01",
      to: "2027-01-07",
    });
    expect(sales).toEqual([]);
    expect(top).toEqual([]);
    expect(await localLowStock(db, TENANT)).toEqual([]);
  });
});

describe("staleness (reports spec §Offline report behavior)", () => {
  it("pending queue rows → stale; drained queue → fresh", async () => {
    // catalog create enqueues product + variant + stockdiary
    await createLocalProduct(db, TENANT, {
      name: "Granizado",
      variant: { name: "Mediano", price: 3500, stock: 10 },
    });
    expect(await hasUnsyncedMutations(db, TENANT)).toBe(true);

    await db.query(
      `UPDATE sync_log SET status = 'synced' WHERE tenant_id = $1`,
      [TENANT],
    );
    expect(await hasUnsyncedMutations(db, TENANT)).toBe(false);
  });
});

describe("sales by hour (Panel · horas pico)", () => {
  it("buckets confirmed sales by LOCAL hour; pending payments excluded", async () => {
    /*17:00Z = 12:00 America/Bogota (UTC-5, no DST) → hour12 deterministic */
    const at = "2026-11-05T17:00:00.000Z";
    const confirmedTicket = crypto.randomUUID();
    const pendingTicket = crypto.randomUUID();
    await db.query(
      `INSERT INTO tickets (id, tenant_id, client_uuid, ticket_no, status, total, created_at)
       VALUES ($1,$2,$1,1,'completed',5000,$3)`,
      [confirmedTicket, TENANT, at],
    );
    await db.query(
      `INSERT INTO payments (id, tenant_id, client_uuid, ticket_id, method, amount, tendered, vuelto, status, created_at)
       VALUES ($1,$2,$1,$3,'cash',5000,5000,0,'confirmed',$4)`,
      [crypto.randomUUID(), TENANT, confirmedTicket, at],
    );
    /* pending transfer in the SAME hour must not appear */
    await db.query(
      `INSERT INTO tickets (id, tenant_id, client_uuid, ticket_no, status, total, created_at)
       VALUES ($1,$2,$1,2,'transfer_pending',7000,$3)`,
      [pendingTicket, TENANT, at],
    );
    await db.query(
      `INSERT INTO payments (id, tenant_id, client_uuid, ticket_id, method, amount, status, created_at)
       VALUES ($1,$2,$1,$3,'transfer',7000,'pending',$4)`,
      [crypto.randomUUID(), TENANT, pendingTicket, at],
    );

    const rows = await localSalesByHour(db, TENANT, {
      from: "2026-11-01",
      to: "2026-11-30",
    });
    expect(rows).toEqual([{ hour: 12, tickets: 1, revenue: 5000 }]);
  });

  it("empty range → empty rows", async () => {
    expect(
      await localSalesByHour(db, TENANT, { from: "2027-01-01", to: "2027-01-07" }),
    ).toEqual([]);
  });
});
