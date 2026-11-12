import { afterEach, beforeEach, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../src/db/pglite";
import { createLocalCustomer, updateLocalCustomer, listLocalCustomers, listCustomerAccounts, listCustomerBalances, customerAccountById, registerLocalAbono, commitLocalSale, createLocalProduct, openLocalShift, listLocalCustomerTickets, getLocalTicket, listLocalTickets, computeLocalExpected } from "../src/db/local";
import { ticketHasAbonos } from "../src/db/void-sale";
import { mutationEnvelopeSchema } from "@pos/shared";
import { applyRehydratePage } from "../src/sync/rehydrate";

const tenant = "33333333-3333-4333-8333-333333333333", other = "44444444-4444-4444-8444-444444444444";
let db: PGlite, customer: string, variant: string;
beforeEach(async () => {
  db = (await openLocalDb({ url: "memory://", locks: null }))!.db;
  customer = (await createLocalCustomer(db, tenant, { name: "Doña María", phone: "+57 300 111 2233", credit_limit: 100000 })).id;
  variant = (await createLocalProduct(db, tenant, { name: "Café", variant: { name: "Único", price: 35000, cost: 4000, stock: 100 } })).variants[0].id;
});
afterEach(async () => { await db.close(); });
const lines = () => [{ variant_id: variant, qty: 1, unit_price: 35000 }];
const sell = (cashAmount = 0) => commitLocalSale(db, tenant, { method: "credit", customerId: customer, cashAmount, lines: lines() });
async function snapshot() {
  return Promise.all(["tickets", "ticket_lines", "payments", "stockdiary", "stockcurrent", "product_variants", "sync_log", "credit_abonos"].map(async table =>
    (await db.query(`SELECT * FROM ${table} ORDER BY id`)).rows));
}

it("CRUD queues one customer UUID, preserves omitted limit, supports zero/deactivation/reactivation and isolates known UUID", async () => {
  await updateLocalCustomer(db, tenant, customer, { notes: "Libreta", phone: "3009998877" });
  expect(await customerAccountById(db, tenant, customer)).toMatchObject({ credit_limit: 100000, balance: 0 });
  await updateLocalCustomer(db, tenant, customer, { credit_limit: 0, active: false });
  expect(await listLocalCustomers(db, tenant)).toEqual([]);
  expect(await customerAccountById(db, tenant, customer)).toMatchObject({ active: false, credit_limit: 0 });
  await updateLocalCustomer(db, tenant, customer, { active: true });
  expect(await listLocalCustomers(db, tenant)).toHaveLength(1);
  expect(await listLocalCustomers(db, other)).toEqual([]);
  await expect(updateLocalCustomer(db, other, customer, { name: "No" })).rejects.toThrow("CUSTOMER_NOT_FOUND");
  expect(await customerAccountById(db, other, customer)).toBeNull();
  const queue = (await db.query<{ payload: unknown }>("SELECT payload FROM sync_log WHERE entity='customer'")).rows;
  expect(queue).toHaveLength(1);
  expect(queue[0].payload).toMatchObject({ name: "Doña María", credit_limit: 0, active: true, notes: "Libreta" });
});

it("new-customer validation is atomic: explicit integer limit, trimmed nonblank name and int32 bounds", async () => {
  for (const input of [{ name: "  ", credit_limit: 0 }, { name: "X", credit_limit: -1 }, { name: "X", credit_limit: 1.5 }, { name: "X", credit_limit: 2147483648 }, { name: "X", credit_limit: undefined }]) {
    const before = await snapshot();
    await expect(createLocalCustomer(db, tenant, input as Parameters<typeof createLocalCustomer>[2])).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
  expect(await listLocalCustomers(db, tenant)).toHaveLength(1);
});

it("NFD/case/phone search, alphabetic order, active filter and cap20", async () => {
  await createLocalCustomer(db, tenant, { name: "Maria Elena", credit_limit: 0 });
  expect((await listLocalCustomers(db, tenant, "MARÍA")).map(c => c.name)).toEqual(["Doña María", "Maria Elena"]);
  expect((await listLocalCustomers(db, tenant, "dona"))[0].id).toBe(customer);
  expect((await listLocalCustomers(db, tenant, "300111"))[0].id).toBe(customer);
  for (let n = 0; n < 30; n++) await createLocalCustomer(db, tenant, { name: `Ma ${String(n).padStart(2, "0")}`, credit_limit: 0 });
  expect(await listLocalCustomers(db, tenant, "ma")).toHaveLength(20);
  expect(await listCustomerAccounts(db, tenant)).toHaveLength(32);
  expect(await listCustomerBalances(db, tenant)).toEqual([]);
});

it("mixed payments sum exactly, list once, transfer ID separate, credit-only void guard and customer history", async () => {
  await openLocalShift(db, tenant);
  const sale = await sell(10000);
  expect(sale.ticket).toMatchObject({ status: "completed", total: 35000 });
  expect(sale.payments.map(p => [p.method,p.amount,p.status,p.vuelto])).toEqual([["cash",10000,"confirmed",0],["credit",25000,"confirmed",null]]);
  const detail = await getLocalTicket(db, tenant, sale.ticket.id);
  expect(detail?.payment_id).toBeNull();
  expect(detail?.payments).toHaveLength(2);
  expect((await listLocalTickets(db, tenant)).map(t => t.method)).toEqual(["cash,credit"]);
  expect(await listLocalCustomerTickets(db, tenant, customer)).toHaveLength(1);
  expect(await ticketHasAbonos(db, tenant, sale.ticket.id)).toBe(false);
  const cash = await commitLocalSale(db, tenant, { lines: lines(), tendered: 35000 });
  const beforePayments = (await db.query("SELECT * FROM payments ORDER BY id")).rows;
  const abono = await registerLocalAbono(db, tenant, { customer_id: customer, amount: 5000, method: "cash" });
  expect(abono.balance).toBe(20000);
  expect((await db.query("SELECT * FROM payments ORDER BY id")).rows).toEqual(beforePayments);
  expect(await ticketHasAbonos(db, tenant, sale.ticket.id)).toBe(true);
  expect(await ticketHasAbonos(db, tenant, cash.ticket.id)).toBe(false);
  expect(await ticketHasAbonos(db, other, sale.ticket.id)).toBe(false);
  expect(await computeLocalExpected(db, tenant, (await db.query<{id:string}>("SELECT id FROM shifts")).rows[0].id)).toMatchObject({ cash: 45000, abonos: 5000, pending: 0, expected: 50000 });
});

it("abono rejects invalid amount, overpay, zero balance, absent/foreign/mismatched link and closed shift atomically", async () => {
  await sell();
  await expect(registerLocalAbono(db, tenant, { customer_id: customer, amount: 1, method: "cash" })).rejects.toThrow("SHIFT_REQUIRED");
  const shift = await openLocalShift(db, tenant);
  const zero = await createLocalCustomer(db, tenant, { name: "Al día", credit_limit: 0 });
  const mismatched = await commitLocalSale(db, tenant, { method: "credit", customerId: zero.id, cashAmount: 0, lines: lines() }).catch(() => null);
  expect(mismatched).toBeNull();
  for (const input of [{ amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: 35001 }, { customer_id: zero.id }, { customer_id: crypto.randomUUID() }, { ticket_id: crypto.randomUUID() }]) {
    const before = await snapshot();
    await expect(registerLocalAbono(db, tenant, { customer_id: customer, amount: 1, method: "cash", ...input })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
  await db.query("UPDATE shifts SET status='closed' WHERE id=$1", [shift.id]);
  await expect(registerLocalAbono(db, tenant, { customer_id: customer, amount: 1, method: "cash" })).rejects.toThrow("SHIFT_REQUIRED");
});

it("exact credit limit uses only remainder; exceeding by1 rolls back stock, ticket and queue; lower limit still permits repayment", async () => {
  await updateLocalCustomer(db, tenant, customer, { credit_limit: 25000 });
  const before = await snapshot();
  await expect(sell(9999)).rejects.toThrow("CREDIT_LIMIT_EXCEEDED");
  expect(await snapshot()).toEqual(before);
  await sell(10000);
  expect(await customerAccountById(db, tenant, customer)).toMatchObject({ balance: 25000 });
  const after = await snapshot();
  await expect(sell()).rejects.toThrow("CREDIT_LIMIT_EXCEEDED");
  expect(await snapshot()).toEqual(after);
  await updateLocalCustomer(db, tenant, customer, { credit_limit: 0 });
  await openLocalShift(db, tenant);
  await registerLocalAbono(db, tenant, { customer_id: customer, amount: 25000, method: "transfer" });
  expect(await customerAccountById(db, tenant, customer)).toMatchObject({ balance: 0, credit_limit: 0 });
});

it("failure after stock/lines were written rolls back the entire mixed sale and queue", async () => {
  await db.exec(`CREATE FUNCTION reject_test_payment() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'payment_storage_failure'; END $$;
    CREATE TRIGGER reject_test_payment BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION reject_test_payment()`);
  const before = await snapshot();
  await expect(sell(10000)).rejects.toThrow("payment_storage_failure");
  expect(await snapshot()).toEqual(before);
});

it.each([0, null, "inactive", "foreign", "missing"])("credit blocks %s customer configuration with zero side effects", async kind => {
  if (kind === 0 || kind === null) await db.query("UPDATE customers SET credit_limit=$2 WHERE id=$1", [customer, kind]);
  if (kind === "inactive") await updateLocalCustomer(db, tenant, customer, { active: false });
  if (kind === "foreign") await db.query("UPDATE customers SET tenant_id=$2 WHERE id=$1", [customer, other]);
  if (kind === "missing") customer = "";
  const before = await snapshot();
  await expect(sell()).rejects.toThrow(kind === null ? "CREDIT_LIMIT_REQUIRED" : kind === 0 ? "CREDIT_LIMIT_EXCEEDED" : "CREDIT_CUSTOMER_REQUIRED");
  expect(await snapshot()).toEqual(before);
});

it.each([-1, 35000, 35001, 10000.5, NaN])("invalid mixed cash part %s cannot mutate anything", async amount => {
  const before = await snapshot();
  await expect(sell(amount)).rejects.toThrow("MIXED_AMOUNT_INVALID");
  expect(await snapshot()).toEqual(before);
});

it("parallel local commits cannot exceed credit limit or overpay the known balance", async () => {
  await updateLocalCustomer(db, tenant, customer, { credit_limit: 50000 });
  const sales = await Promise.allSettled([sell(), sell()]);
  expect(sales.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(await customerAccountById(db, tenant, customer)).toMatchObject({ balance: 35000 });
  await openLocalShift(db, tenant);
  const abonos = await Promise.allSettled([1, 2].map(() => registerLocalAbono(db, tenant, { customer_id: customer, amount: 20000, method: "cash" })));
  expect(abonos.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(await customerAccountById(db, tenant, customer)).toMatchObject({ balance: 15000 });
});

it("disconnected devices may each sell60000; convergence exposes120000 and blocks further local credit", async () => {
  const second = await PGlite.create({ loadDataDir: await db.dumpDataDir() });
  try {
    const input = { method: "credit" as const, customerId: customer, cashAmount: 0, lines: [{ variant_id: variant, qty: 1, unit_price: 60000 }] };
    await commitLocalSale(db, tenant, input);
    const remote = await commitLocalSale(second, tenant, input);
    const tickets = (await second.query("SELECT * FROM tickets WHERE id=$1", [remote.ticket.id])).rows;
    const payments = (await second.query("SELECT * FROM payments WHERE ticket_id=$1", [remote.ticket.id])).rows;
    // Isolate credit convergence from the existing ticket-number uniqueness
    // contract (the remote fixture has a distinct assigned ticket number).
    const page = JSON.parse(JSON.stringify({ tickets, payments, next_offset: null }));
    page.tickets[0].ticket_no = 2;
    await applyRehydratePage(db, tenant, page);
    expect(await customerAccountById(db, tenant, customer)).toMatchObject({ balance: 120000, credit_limit: 100000 });
    const before = await snapshot();
    await expect(sell()).rejects.toThrow("CREDIT_LIMIT_EXCEEDED");
    expect(await snapshot()).toEqual(before);
  } finally { await second.close(); }
});

it("offline dump/reload preserves customer, sale, stock, abono and valid original queue UUIDs", async () => {
  await openLocalShift(db, tenant);
  await sell(10000);
  const abono = await registerLocalAbono(db, tenant, { customer_id: customer, amount: 5000, method: "cash", note: "Cuota" });
  const before = await snapshot();
  const dump = await db.dumpDataDir();
  await db.close();
  db = await PGlite.create({ loadDataDir: dump });
  expect(await snapshot()).toEqual(before);
  expect(await customerAccountById(db, tenant, customer)).toMatchObject({ balance: 20000 });
  const queue = (await db.query<{client_uuid:string;client_ts:number;entity:string;payload:unknown}>("SELECT * FROM sync_log")).rows;
  expect(queue.some(r => r.client_uuid === abono.id)).toBe(true);
  for (const row of queue) expect(mutationEnvelopeSchema.safeParse(row).success).toBe(true);
});
