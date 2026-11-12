import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../src/db/pglite";
import { claimLocal, PRESERVATION_SQL, sealLocal, unresolvedWork, BUSINESS_TABLES } from "../src/db/preservation";
import { clearLocalBusinessData, commitLocalSale, createLocalProduct, enqueueMutation, listProducts, openLocalShift, mirrorOpenShift } from "../src/db/local";
import { mirrorVoidedSale } from "../src/db/void-sale";
import { safeTransition, type TransitionState } from "../src/sync/safe-transition";
import { pushNow, retryPoison, stopSync } from "../src/sync/queue";
import { saveSaleSnapshot } from "../src/sync/sale-upload";
import { applyRehydratePage } from "../src/sync/rehydrate";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
let state: TransitionState;
beforeEach(async () => {
  db = (await openLocalDb({ url: "memory://", locks: null }))!.db;
  await claimLocal(db, A);
  state = { phase: "idle" };
});
afterEach(async () => { await stopSync(); vi.unstubAllGlobals(); await db.close(); });

function ack() {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get("x-nexora-tenant")).toBe(A);
    const { mutations } = JSON.parse(init.body as string);
    return Response.json({ results: mutations.map((m: { client_uuid: string }) => ({ client_uuid: m.client_uuid, status: "applied" })) });
  }));
}
async function product(name = "Local") {
  return createLocalProduct(db, A, { name, variant: { name: "Único", price: 100, stock: 100 } });
}
async function creditCache() {
  const customer = crypto.randomUUID(), abono = crypto.randomUUID();
  const timestamps = { created_at: "2026-11-01T17:00:00.000Z", updated_at: "2026-11-01T17:00:00.000Z" };
  await applyRehydratePage(db, A, {
    customers: [{ id: customer, name: "Cliente", active: true, credit_limit: 150000, ...timestamps }],
    credit_abonos: [{ id: abono, customer_id: customer, amount: 1000, method: "cash", ...timestamps }],
    cash_movements: [{ id: crypto.randomUUID(), shift_id: crypto.randomUUID(), amount: 2000, direction: "in", reason: "Base adicional", ...timestamps }], next_offset: null,
  });
  return { customer, abono };
}
function transition(finish = () => clearLocalBusinessData(db)) {
  return safeTransition(db, { flush: () => pushNow(db, A, { force: true }), finish, state: s => { state = s; } });
}

it("logout waits for real ACK, clears all tables including categories, leaves writes sealed", async () => {
  await product();
  await creditCache();
  expect(BUSINESS_TABLES).toHaveLength(15);
  expect((await db.query("SELECT * FROM cash_movements")).rows).toHaveLength(1);
  expect((await db.query("SELECT * FROM customers")).rows).toHaveLength(1);
  expect((await db.query("SELECT * FROM credit_abonos")).rows).toHaveLength(1);
  ack();
  const signOut = vi.fn(async () => {
    expect(await unresolvedWork(db)).toBe(0);
    expect(await listProducts(db, A)).toHaveLength(1); // no wipe before auth result
  });
  await transition(async () => { await signOut(); await clearLocalBusinessData(db); });
  expect(state.phase).toBe("idle");
  expect(signOut).toHaveBeenCalledTimes(1);
  for (const table of BUSINESS_TABLES) expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
  await expect(product("Late stale write")).rejects.toThrow("Base protegida");
  await expect(mirrorVoidedSale(db, A, { ticket_id: crypto.randomUUID(), stockdiary: [] })).rejects.toThrow("Base protegida");
  await claimLocal(db, B);
  await expect(product("Wrong tenant")).rejects.toThrow("tenant_mismatch");
});

it.each(["pending", "failed", "poison", "in_flight"])("%s work blocks destructive low-level clear, offline exit, and foreign adoption", async status => {
  await product();
  const { customer, abono } = await creditCache();
  await enqueueMutation(db, A, "customer", customer, { name: "Cliente", credit_limit: 150000 });
  await enqueueMutation(db, A, "credit_abono", abono, { customer_id: customer, amount: 1000, method: "cash", shift_id: null });
  await db.query("UPDATE sync_log SET status=$1", [status]);
  vi.stubGlobal("navigator", { onLine: false });
  const before = (await db.query("SELECT * FROM sync_log ORDER BY id")).rows;
  const finish = vi.fn();
  await transition(finish);
  expect(state.phase).toBe("blocked");
  expect(finish).not.toHaveBeenCalled();
  await expect(clearLocalBusinessData(db)).rejects.toThrow("unacknowledged_local_work");
  await expect(claimLocal(db, B)).rejects.toThrow("otro comercio");
  expect((await db.query("SELECT credit_limit FROM customers")).rows).toEqual([{ credit_limit: 150000 }]);
  expect((await db.query("SELECT amount FROM credit_abonos")).rows).toEqual([{ amount: 1000 }]);
  await db.exec(PRESERVATION_SQL); // boot migration must not reset seal/work
  expect((await db.query("SELECT * FROM sync_log ORDER BY id")).rows).toEqual(before);
  expect((await db.query<{ sealed: boolean }>("SELECT sealed FROM local_vault")).rows[0].sealed).toBe(true);
  expect(await listProducts(db, A)).toHaveLength(1);
  await claimLocal(db, A);
  vi.stubGlobal("navigator", { onLine: true });
  ack();
  if (status === "in_flight") await db.query("UPDATE sync_log SET status='pending'");
  if (status === "poison") await retryPoison(db, A);
  await transition();
  expect(state.phase).toBe("idle");
});

it("snapshot alone blocks wipe even with every queue member apparently synced", async () => {
  await product();
  await creditCache();
  await saveSaleSnapshot(db, A, (await db.query("SELECT * FROM sync_log")).rows);
  await db.query("UPDATE sync_log SET status='synced'");
  await expect(clearLocalBusinessData(db)).rejects.toThrow("unacknowledged_local_work");
  expect(await unresolvedWork(db)).toBe(1);
  await expect(claimLocal(db, B)).rejects.toThrow("otro comercio");
  expect((await db.query("SELECT * FROM customers")).rows).toHaveLength(1);
  expect((await db.query("SELECT * FROM credit_abonos")).rows).toHaveLength(1);
});

it("lost finalize ACK of a large sale retains snapshot and ticket; retry recovers the same operation before clearing", async () => {
  const p = await product();
  await openLocalShift(db, A);
  await db.query("UPDATE sync_log SET status='synced'");
  await commitLocalSale(db, A, { lines: Array.from({ length: 26 }, () => ({ variant_id: p.variants[0].id, qty: 1, unit_price: 100 })), tendered: 2600 });
  const parts = new Map<number, Array<{ client_uuid: string }>>();
  const operations = new Set<string>();
  let lost = true;
  let commits = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    operations.add(url.split("/")[4]);
    const body = JSON.parse(init.body as string);
    if (url.endsWith("/parts")) { parts.set(body.index, body.mutations); return Response.json({ staged: true }); }
    if (!commits) commits++;
    if (lost) { lost = false; throw new Error("lost_ack"); }
    return Response.json({ results: [...parts.values()].flat().map(m => ({ client_uuid: m.client_uuid, status: "duplicate" })) });
  });
  await transition();
  expect(state.phase).toBe("blocked");
  expect((await db.query("SELECT * FROM tickets")).rows).toHaveLength(1);
  expect((await db.query("SELECT * FROM sync_sale_outbox")).rows).toHaveLength(1);
  await transition();
  expect(state.phase).toBe("idle");
  expect(operations.size).toBe(1);
  expect(commits).toBe(1);
});

it("poison retry never deletes business evidence, even a deterministically rejected immutable snapshot", async () => {
  const p = await product();
  await openLocalShift(db, A);
  await db.query("UPDATE sync_log SET status='synced'");
  await commitLocalSale(db, A, { lines: Array.from({ length: 26 }, () => ({ variant_id: p.variants[0].id, qty: 1, unit_price: 100 })), tendered: 2600 });
  vi.stubGlobal("fetch", async () => Response.json({ error: "sale_rejected:test" }, { status: 409 }));
  for (let i = 0; i < 3; i++) await pushNow(db, A, { force: true });
  const before = (await db.query("SELECT rows FROM sync_sale_outbox")).rows;
  expect(before).toHaveLength(1);
  await retryPoison(db, A);
  expect((await db.query("SELECT rows FROM sync_sale_outbox")).rows).toEqual(before);
  await expect(clearLocalBusinessData(db)).rejects.toThrow("unacknowledged_local_work");
});

it("double exit joins in-flight flush; mutations during/after the seal rollback atomically", async () => {
  await product();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let sent!: () => void;
  const started = new Promise<void>(resolve => { sent = resolve; });
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent(); await held;
    return Response.json({ results: JSON.parse(init.body as string).mutations.map((m: { client_uuid: string }) => ({ client_uuid: m.client_uuid, status: "applied" })) });
  });
  const existingDrain = pushNow(db, A, { force: true });
  await started;
  const finish = vi.fn(() => clearLocalBusinessData(db));
  const first = transition(finish);
  const otherState = vi.fn();
  const otherFinish = vi.fn();
  const second = safeTransition(db, { flush: vi.fn(), finish: otherFinish, state: otherState });
  await vi.waitFor(async () => expect((await db.query<{ sealed: boolean }>("SELECT sealed FROM local_vault")).rows[0].sealed).toBe(true));
  await expect(product("Racing edit")).rejects.toThrow("Base protegida");
  release();
  await Promise.all([existingDrain, first, second]);
  expect(finish).toHaveBeenCalledTimes(1);
  expect(otherState).not.toHaveBeenCalled(); // a competing upgrade cannot relabel logout
  expect(otherFinish).not.toHaveBeenCalled();
  expect(state.phase).toBe("idle");
});

it("a mutation committed just before the seal is included and cannot be erased on transport failure", async () => {
  const p = await product();
  ack(); await pushNow(db, A);
  await enqueueMutation(db, A, "product", p.id, { name: "New version", active: true });
  vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
  await transition();
  expect(state.phase).toBe("blocked");
  expect((await db.query<{ payload: { name: string } }>("SELECT payload FROM sync_log WHERE client_uuid=$1", [p.id])).rows[0].payload.name).toBe("New version");
});

it.each(["signout", "clear"])("%s failure preserves data and leaves a recoverable seal", async failure => {
  await product(); ack();
  if (failure === "clear") await db.exec(`CREATE FUNCTION fail_clear() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disk failure'; END $$;
    CREATE TRIGGER fail_clear BEFORE DELETE ON products FOR EACH ROW EXECUTE FUNCTION fail_clear();`);
  await transition(async () => {
    if (failure === "signout") throw new Error("auth failed");
    await clearLocalBusinessData(db);
  });
  expect(state.phase).toBe("blocked");
  expect(await listProducts(db, A)).toHaveLength(1);
  expect((await db.query("SELECT * FROM sync_log")).rows.length).toBeGreaterThan(0); // clear rolled back all deletes
  await expect(product()).rejects.toThrow("Base protegida");
  await claimLocal(db, A);
  await product("Recovered");
});

it("ACKed foreign caches are removed on adoption, while stale hydration and stale enqueue cannot repopulate them", async () => {
  await product(); ack(); await pushNow(db, A);
  await creditCache();
  await sealLocal(db);
  await claimLocal(db, B);
  expect((await db.query("SELECT * FROM customers")).rows).toEqual([]);
  expect((await db.query("SELECT * FROM credit_abonos")).rows).toEqual([]);
  expect(await listProducts(db, A)).toHaveLength(0);
  await expect(applyRehydratePage(db, A, { products: [], next_offset: null })).rejects.toThrow("tenant_mismatch");
  await expect(creditCache()).rejects.toThrow("tenant_mismatch");
  await expect(product("Stale handler")).rejects.toThrow("tenant_mismatch");
  await expect(mirrorOpenShift(db, A, { id: crypto.randomUUID(), status: "open" })).rejects.toThrow("tenant_mismatch");
  await expect(mirrorVoidedSale(db, A, { ticket_id: crypto.randomUUID(), stockdiary: [] })).rejects.toThrow("tenant_mismatch");
  expect(await listProducts(db, B)).toHaveLength(0);
});

it("legacy foreign shift-only cache cannot survive adoption even before the vault had an owner", async () => {
  await db.query("UPDATE local_vault SET tenant_id=NULL");
  await db.query("INSERT INTO shifts(id,tenant_id,client_uuid,status) VALUES($1,$2,$1,'open')", [crypto.randomUUID(), A]);
  await claimLocal(db, B);
  expect((await db.query("SELECT * FROM shifts")).rows).toHaveLength(0);
});
