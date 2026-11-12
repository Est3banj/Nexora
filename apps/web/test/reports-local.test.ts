import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { CUSTOMER_ACCOUNTS_SQL, CUSTOMER_BALANCES_SQL, parseCustomerAccounts, parseCustomerBalances, defaultReportRange, SALES_BY_DAY_SQL, DASHBOARD_SUMMARY_SQL, parseSalesByDay, parseDashboardSummary } from "@pos/shared";
import { applyRehydratePage } from "../src/sync/rehydrate";
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
  it("payment and collection day boundaries use Bogotá midnight, not UTC or host date", async () => {
    const ticket = crypto.randomUUID(), customer = crypto.randomUUID();
    await db.query(`INSERT INTO tickets(id,tenant_id,client_uuid,ticket_no,status,total) VALUES($1,$2,$1,1,'completed',3000)`, [ticket, TENANT]);
    for (const [stamp, amount] of [["2027-01-01T04:59:59Z", 1000], ["2027-01-01T05:00:00Z", 2000]] as const) {
      await db.query(`INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,method,amount,status,created_at) VALUES($1,$2,$1,$3,'credit',$4,'confirmed',$5)`, [crypto.randomUUID(), TENANT, ticket, amount, stamp]);
      await db.query(`INSERT INTO credit_abonos(id,tenant_id,client_uuid,customer_id,method,amount,created_at) VALUES($1,$2,$1,$3,'cash',$4,$5)`, [crypto.randomUUID(), TENANT, customer, amount / 10, stamp]);
    }
    expect(await localSalesByDay(db, TENANT, { from: "2026-12-31", to: "2026-12-31" })).toEqual([{ day: "2026-12-31", tickets: 1, revenue: 1000, cash: 0, transfer: 0, credit: 1000, abonos: 100, pending: 0 }]);
    expect(await localSalesByDay(db, TENANT, { from: "2027-01-01", to: "2027-01-01" })).toEqual([{ day: "2027-01-01", tickets: 1, revenue: 2000, cash: 0, transfer: 0, credit: 2000, abonos: 200, pending: 0 }]);
  });
  it("pinned Day3 reports accrual65000/credit55000/cobros8000 and abono-only day", async () => {
    const x = crypto.randomUUID(), y = crypto.randomUUID(), tx = crypto.randomUUID(), ty = crypto.randomUUID();
    const stamp = { created_at: "2026-11-03T15:00:00.000Z", updated_at: "2026-11-03T15:00:00.000Z" };
    await applyRehydratePage(db, TENANT, {
      customers: [{ id:x, name:"X", active:true, credit_limit:100000,...stamp },{ id:y,name:"Y",active:true,credit_limit:100000,...stamp }],
      tickets: [{id:tx,customer_id:x,ticket_no:1,total:35000,status:"completed",...stamp},{id:ty,customer_id:y,ticket_no:2,total:30000,status:"completed",...stamp}],
      payments: [[tx,"credit",35000],[ty,"cash",10000],[ty,"credit",20000]].map(([ticket_id,method,amount]) => ({id:crypto.randomUUID(),ticket_id,method,amount,status:"confirmed",...stamp})),
      ticket_lines: [tx,ty].map(ticket_id => ({ id:crypto.randomUUID(),ticket_id,variant_id:crypto.randomUUID(),qty:1,unit_price:ticket_id===tx?35000:30000,subtotal:ticket_id===tx?35000:30000,unit_cost:4000,...stamp })),
      credit_abonos: [{id:crypto.randomUUID(),customer_id:x,amount:5000,method:"cash",...stamp},{id:crypto.randomUUID(),customer_id:y,amount:3000,method:"transfer",...stamp}], next_offset:null,
    });
    const params = [TENANT,"2026-11-03","2026-11-03"];
    expect(parseSalesByDay((await db.query<Record<string, unknown>>(SALES_BY_DAY_SQL,params)).rows)).toEqual([{day:"2026-11-03",tickets:2,revenue:65000,cash:10000,transfer:0,credit:55000,abonos:8000,pending:0}]);
    expect(parseDashboardSummary((await db.query<Record<string, unknown>>(DASHBOARD_SUMMARY_SQL,params)).rows)).toMatchObject({revenue:65000,credit:55000,abonos:8000,cogs:8000,pending_count:0});
    expect(parseCustomerAccounts((await db.query<Record<string, unknown>>(CUSTOMER_ACCOUNTS_SQL,[TENANT])).rows).map(r=>r.balance).sort()).toEqual([17000,30000]);
    await db.query(`INSERT INTO credit_abonos(id,tenant_id,client_uuid,customer_id,amount,method,created_at)
      VALUES($1,$2,$1,$3,1000,'transfer','2026-11-04T15:00:00Z')`,[crypto.randomUUID(),TENANT,x]);
    expect(parseSalesByDay((await db.query<Record<string, unknown>>(SALES_BY_DAY_SQL,[TENANT,"2026-11-04","2026-11-04"])).rows)).toEqual([{day:"2026-11-04",tickets:0,revenue:0,cash:0,transfer:0,credit:0,abonos:1000,pending:0}]);
  });
  it("accounts keep zero/null limits and exclude inactive/foreign ledger while Por Cobrar stays positive", async () => {
    const a = crypto.randomUUID(), b = crypto.randomUUID(), inactive = crypto.randomUUID(), ticket = crypto.randomUUID();
    const stamp = { created_at: "2026-11-01T17:00:00.000Z", updated_at: "2026-11-01T17:00:00.000Z" };
    await applyRehydratePage(db, TENANT, {
      customers: [{ id: a, name: "A", credit_limit: 100000, active: true, ...stamp }, { id: b, name: "B", active: true, ...stamp },
        { id: inactive, name: "Inactivo", credit_limit: 0, active: false, ...stamp }],
      tickets: [{ id: ticket, ticket_no: 1, customer_id: a, total: 53000, status: "completed", ...stamp }],
      payments: [{ id: crypto.randomUUID(), ticket_id: ticket, method: "credit", amount: 53000, status: "confirmed", ...stamp }],
      credit_abonos: [{ id: crypto.randomUUID(), customer_id: a, amount: 15000, method: "cash", ...stamp }], next_offset: null,
    });
    const foreign = "11111111-1111-4111-8111-111111111111";
    // Deliberately forged cross-tenant links must not pollute A's ledger.
    await db.query(`INSERT INTO credit_abonos(id,tenant_id,client_uuid,customer_id,amount,method)
      VALUES($1,$2,$1,$3,9000,'cash')`, [crypto.randomUUID(), foreign, a]);
    const rows = parseCustomerAccounts((await db.query<Record<string, unknown>>(CUSTOMER_ACCOUNTS_SQL, [TENANT])).rows);
    expect(rows).toEqual([
      { customer_id: a, name: "A", phone: null, credit_limit: 100000, credit: 53000, abonos: 15000, balance: 38000 },
      { customer_id: b, name: "B", phone: null, credit_limit: null, credit: 0, abonos: 0, balance: 0 },
    ]);
    expect(parseCustomerBalances((await db.query<Record<string, unknown>>(CUSTOMER_BALANCES_SQL, [TENANT])).rows)).toEqual([
      { customer_id: a, name: "A", phone: null, credit: 53000, abonos: 15000, balance: 38000 },
    ]);
    expect(parseCustomerAccounts((await db.query<Record<string, unknown>>(CUSTOMER_ACCOUNTS_SQL, [foreign])).rows)).toEqual([]);
  });
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
