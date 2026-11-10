import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalHandle } from "../src/db/pglite";
import { createLocalProduct } from "../src/db/local";
import { claimLocal } from "../src/db/preservation";
import { rehydrateFromServer } from "../src/sync/rehydrate";

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
