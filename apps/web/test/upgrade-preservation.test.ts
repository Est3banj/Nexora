import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalHandle } from "../src/db/pglite";
import { createLocalProduct } from "../src/db/local";
import { claimLocal } from "../src/db/preservation";
import { rehydrateFromServer } from "../src/sync/rehydrate";
import { CUSTOMER_ACCOUNTS_SQL, CUSTOMER_BALANCES_SQL, parseCustomerAccounts, parseCustomerBalances } from "@pos/shared";

const tenant = "11111111-1111-4111-8111-111111111111";
let old: LocalHandle;
let current: LocalHandle | undefined;
let versions: Map<string, string>;
beforeEach(async () => {
  vi.resetModules();
  versions = new Map([["pos:datadir-version", "2"]]);
  vi.stubGlobal("localStorage", { getItem: (k: string) => versions.get(k) ?? null, setItem: (k: string, v: string) => versions.set(k, v) });
  const { getLocalDb } = await import("../src/db/instance");
  old = (await getLocalDb({ url: "memory://", locks: null }))!;
  await claimLocal(old.db, tenant);
  await createLocalProduct(old.db, tenant, { name: "Versión anterior", variant: { name: "Único", price: 100 } });
});
afterEach(async () => {
  if (current) await current.db.close().catch(() => {});
  current = undefined;
  await old.db.close().catch(() => {});
  vi.unstubAllGlobals();
});

it("upgrade refuses unresolved work before opening or changing the URL/version, then retry switches and hydrates", async () => {
  const { switchToCurrentDatadir, planBoot, getLocalDb } = await import("../src/db/instance");
  const prepare = vi.fn();
  await expect(switchToCurrentDatadir({ locks: null, prepare })).rejects.toThrow("unacknowledged_local_work");
  expect(prepare).not.toHaveBeenCalled();
  expect(await getLocalDb()).toBe(old);
  expect(versions.get("pos:datadir-version")).toBe("2");
  expect((await old.db.query("SELECT * FROM products")).rows).toHaveLength(1);
  expect((await planBoot()).upgradeFrom).toBe(2);
  // Stand-in for a validated server ACK; actual queue ACK paths are covered
  // by preservation/sale-upload integration tests.
  await old.db.query("UPDATE sync_log SET status='synced'");
  current = await switchToCurrentDatadir({ locks: null, prepare: async handle => {
    await claimLocal(handle.db, tenant);
    await rehydrateFromServer(handle.db, tenant, { fetchFn: async () => Response.json({
      products: [{ id: tenant, name: "Confirmado servidor", active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }], next_offset: null,
    }) });
  } });
  expect((await current.db.query<{ name: string }>("SELECT name FROM products")).rows[0].name).toBe("Confirmado servidor");
  expect(versions.get("pos:datadir-version")).toBe("3");
  expect((await planBoot()).upgradeFrom).toBeNull();
});

it("new-datadir hydration failure leaves the old open handle and stored pointer intact for retry", async () => {
  const { switchToCurrentDatadir, getLocalDb } = await import("../src/db/instance");
  await old.db.query("UPDATE sync_log SET status='synced'");
  await expect(switchToCurrentDatadir({ locks: null, prepare: async () => { throw new Error("auth expired"); } })).rejects.toThrow("auth expired");
  expect(await getLocalDb()).toBe(old);
  expect(versions.get("pos:datadir-version")).toBe("2");
  expect((await old.db.query("SELECT * FROM products")).rows).toHaveLength(1);
});

it("populated multi-page rebuild/retry preserves accounts, inactive history, ticket links and historical costs without re-enqueue", async () => {
  await old.db.query("UPDATE sync_log SET status='synced'");
  const id = () => crypto.randomUUID();
  const customer = id(), zero = id(), inactive = id(), ticket = id(), line = id(), variant = id();
  const stamp = "2026-11-01T17:00:00.000Z";
  const row = (uuid: string) => ({ id: uuid, client_uuid: uuid, created_at: stamp, updated_at: stamp });
  const abono = id(), second = id();
  const pages = [
    {
      customers: [
        { ...row(customer), name: "A", active: true, credit_limit: 200000 },
        { ...row(zero), name: "B", active: true, credit_limit: 0 },
        { ...row(inactive), name: "Historia", active: false },
      ],
      categories: [{ ...row(customer), name: "Bebidas", icon_key: "bottle-water", active: true }],
      products: [{ ...row(variant), name: "Producto", icon_key: "coffee", category_id: customer, active: true }],
      variants: [{ ...row(variant), product_id: variant, name: "Único", price: 53000, cost: 9999, stock: 1, active: true }],
      tickets: [{ ...row(ticket), customer_id: customer, ticket_no: 1, status: "completed", total: 63000 }],
      ticket_lines: [
        { ...row(line), ticket_id: ticket, variant_id: variant, qty: 1, unit_price: 53000, subtotal: 53000, unit_cost: 1234 },
        { ...row(id()), ticket_id: ticket, variant_id: variant, qty: 1, unit_price: 10000, subtotal: 10000 },
      ],
      payments: [
        { ...row(id()), ticket_id: ticket, method: "credit", amount: 53000, status: "confirmed" },
        { ...row(id()), ticket_id: ticket, method: "cash", amount: 10000, status: "confirmed" },
      ],
      credit_abonos: [{ ...row(abono), customer_id: customer, ticket_id: ticket, method: "cash", amount: 10000, note: "Histórico" }],
      next_offset: 1,
    },
    { credit_abonos: [{ ...row(second), customer_id: customer, method: "transfer", amount: 5000 }], next_offset: null },
  ];
  const fetchFn = vi.fn(async (path: string) => Response.json(pages[Number(new URL(path, "http://test").searchParams.get("offset"))]));
  // Rebuild in a fresh handle, then repeat the entire pull as after a lost ACK.
  const { openLocalDb } = await import("../src/db/pglite");
  current = (await openLocalDb({ url: "memory://", locks: null }))!;
  await claimLocal(current.db, tenant);
  expect((await rehydrateFromServer(current.db, tenant, { pageSize: 1, fetchFn })).pages).toBe(2);
  await rehydrateFromServer(current.db, tenant, { pageSize: 1, fetchFn });
  expect((await current.db.query("SELECT icon_key FROM products")).rows).toEqual([{ icon_key: "coffee" }]);
  expect((await current.db.query("SELECT icon_key FROM categories")).rows).toEqual([{ icon_key: "bottle-water" }]);
  expect(fetchFn.mock.calls.map(([path]) => path)).toEqual([
    "/api/rehydrate?offset=0&limit=1", "/api/rehydrate?offset=1&limit=1",
    "/api/rehydrate?offset=0&limit=1", "/api/rehydrate?offset=1&limit=1",
  ]);
  const accounts = parseCustomerAccounts((await current.db.query<Record<string, unknown>>(CUSTOMER_ACCOUNTS_SQL, [tenant])).rows);
  expect(accounts).toEqual([
    { customer_id: customer, name: "A", phone: null, credit_limit: 200000, credit: 53000, abonos: 15000, balance: 38000 },
    { customer_id: zero, name: "B", phone: null, credit_limit: 0, credit: 0, abonos: 0, balance: 0 },
  ]);
  expect(parseCustomerBalances((await current.db.query<Record<string, unknown>>(CUSTOMER_BALANCES_SQL, [tenant])).rows)).toEqual([
    { customer_id: customer, name: "A", phone: null, credit: 53000, abonos: 15000, balance: 38000 },
  ]);
  expect((await current.db.query("SELECT active,credit_limit FROM customers WHERE id=$1", [inactive])).rows).toEqual([{ active: false, credit_limit: null }]);
  expect((await current.db.query("SELECT customer_id FROM tickets")).rows).toEqual([{ customer_id: customer }]);
  expect((await current.db.query("SELECT unit_cost FROM ticket_lines ORDER BY unit_price DESC")).rows).toEqual([{ unit_cost: 1234 }, { unit_cost: null }]);
  expect((await current.db.query("SELECT client_uuid,created_at,updated_at,note FROM credit_abonos WHERE id=$1", [abono])).rows).toEqual([
    { client_uuid: abono, created_at: new Date(stamp), updated_at: new Date(stamp), note: "Histórico" },
  ]);
  expect((await current.db.query("SELECT * FROM credit_abonos")).rows).toHaveLength(2);
  expect((await current.db.query("SELECT * FROM sync_log")).rows).toEqual([]);
});
