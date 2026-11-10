import { afterEach, beforeEach, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { LOCAL_SCHEMA_SQL, VARIANT_CODE_MIGRATION_SQL } from "@pos/shared";
import { openLocalDb } from "../src/db/pglite";
import { addLocalVariant, adjustLocalStock, catalogError, commitLocalSale, createLocalCategory, createLocalProduct, listProducts, listSaleItems, updateLocalVariant } from "../src/db/local";
import { applyRehydratePage } from "../src/sync/rehydrate";
import { pushNow } from "../src/sync/queue";
import { vi } from "vitest";
import { PRESERVATION_SQL } from "../src/db/preservation";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
beforeEach(async () => { db = (await openLocalDb({ url: "memory://", locks: null }))!.db; });
afterEach(async () => { vi.unstubAllGlobals(); await db.close(); });

it("stores separate variant codes, rejects local duplicates atomically, preserves metadata through edit/stock/sale", async () => {
  const cat = await createLocalCategory(db, a, { name: "Bebidas" });
  const p = await createLocalProduct(db, a, { name: "Cerveza", category_id: cat.id, photo: "data:image/png;base64,AA",
    variant: { name: "330", price: 4000, cost: 2000, stock: 10, code: " 00330 " } });
  const id = p.variants[0].id;
  await addLocalVariant(db, a, p.id, { name: "600", price: 6000, code: "00600" });
  await expect(addLocalVariant(db, a, p.id, { name: "Duplicado", price: 1, code: "00330" }))
    .rejects.toSatisfy((err: unknown) => catalogError(err).includes("ya pertenece"));
  expect((await listProducts(db, a))[0].variants).toHaveLength(2);
  await createLocalProduct(db, b, { name: "Otro comercio", variant: { name: "330", price: 1, code: "00330" } });
  await updateLocalVariant(db, a, id, { code: "000330" });
  await updateLocalVariant(db, a, id, { price: 4500 });
  await adjustLocalStock(db, a, { variant_id: id, delta: 2, reason: "recuento", note: "Dos más" });
  await commitLocalSale(db, a, { lines: [{ variant_id: id, qty: 1, unit_price: 4500 }], tendered: 4500 });
  expect((await listSaleItems(db, a)).find(v => v.id === id)).toMatchObject({ code: "000330", cost: 2000, stock: 11, category_id: cat.id, photo: p.photo });
  const queued = await db.query<{ payload: object }>("SELECT payload FROM sync_log WHERE client_uuid=$1", [id]);
  expect(queued.rows[0].payload).toMatchObject({ code: "000330", cost: 2000, stock: 11 });
  await updateLocalVariant(db, a, id, { code: " " });
  expect((await listSaleItems(db, a)).find(v => v.id === id)?.code).toBeNull();
});

it("rehydrates codes idempotently without queueing or overwriting local edits", async () => {
  const id = crypto.randomUUID(), vid = crypto.randomUUID();
  const stamp = new Date().toISOString();
  const page = { products: [{ id, name: "Cerveza", active: true, created_at: stamp, updated_at: stamp }],
    variants: [{ id: vid, product_id: id, name: "330", code: "000330", cost: 1000, price: 4000, stock: 5, active: true, created_at: stamp, updated_at: stamp }], next_offset: null };
  await applyRehydratePage(db, a, page);
  await updateLocalVariant(db, a, vid, { code: "LOCAL" });
  await applyRehydratePage(db, a, page);
  expect((await listSaleItems(db, a))[0]).toMatchObject({ code: "LOCAL", cost: 1000 });
  expect((await db.query("SELECT * FROM sync_log")).rows).toHaveLength(1);
});

it("upgrades an existing pre-code database in place without losing pending sales", async () => {
  const old = new PGlite("memory://");
  try {
    await old.exec(LOCAL_SCHEMA_SQL.replace(VARIANT_CODE_MIGRATION_SQL, ""));
    const id = crypto.randomUUID();
    await old.query("INSERT INTO tickets(id,tenant_id,client_uuid,ticket_no,total) VALUES($1,$2,$1,1,4000)", [id, a]);
    await old.query("INSERT INTO sync_log(id,tenant_id,client_uuid,entity,op,payload,status,client_ts) VALUES($1,$2,$1,'ticket','upsert','{}','pending',1)", [id, a]);
    await old.exec(LOCAL_SCHEMA_SQL);
    await old.exec(LOCAL_SCHEMA_SQL);
    await old.exec(PRESERVATION_SQL);
    expect((await old.query("SELECT total FROM tickets")).rows).toEqual([{ total: 4000 }]);
    expect((await old.query("SELECT status FROM sync_log")).rows).toEqual([{ status: "pending" }]);
    await createLocalProduct(old, a, { name: "Nuevo", variant: { name: "330", price: 1, code: "001" } });
    expect((await listSaleItems(old, a))[0].code).toBe("001");
  } finally { await old.close(); }
});

it("duplicate-code sync rejects terminate retries and an edit requeues a corrected payload", async () => {
  const p = await createLocalProduct(db, a, { name: "Cerveza", variant: { name: "330", price: 1, code: "001" } });
  await db.query("UPDATE sync_log SET status='synced' WHERE entity='product'");
  const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ results: [{ client_uuid: p.variants[0].id, status: "rejected", reason: "duplicate_code" }] }) }));
  vi.stubGlobal("fetch", fetcher);
  for (let i = 0; i < 5; i++) await pushNow(db, a, { force: true });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect((await db.query("SELECT status,last_error FROM sync_log WHERE entity='variant'")).rows[0]).toEqual({ status: "poison", last_error: "duplicate_code" });
  await updateLocalVariant(db, a, p.variants[0].id, { code: "002" });
  expect((await db.query("SELECT status,attempts FROM sync_log WHERE entity='variant'")).rows[0]).toEqual({ status: "pending", attempts: 0 });
});

it("an old in-flight ACK cannot swallow a newer code edit", async () => {
  const p = await createLocalProduct(db, a, { name: "Cerveza", variant: { name: "330", price: 1, code: "001" } });
  const id = p.variants[0].id;
  await db.query("UPDATE sync_log SET status='synced' WHERE entity='product'");
  let release!: () => void;
  let started!: () => void;
  const flight = new Promise<void>(resolve => { release = resolve; });
  const sent = new Promise<void>(resolve => { started = resolve; });
  const fetcher = vi.fn(async () => {
    started();
    await flight;
    return { ok: true, json: async () => ({ results: [{ client_uuid: id, status: "applied" }] }) };
  });
  vi.stubGlobal("fetch", fetcher);
  const push = pushNow(db, a, { force: true });
  await sent;
  await updateLocalVariant(db, a, id, { code: "002" });
  release();
  await push;
  expect((await db.query<{ status: string; payload: { code: string } }>("SELECT status,payload FROM sync_log WHERE entity='variant'")).rows[0])
    .toMatchObject({ status: "pending", payload: { code: "002" } });
  await pushNow(db, a, { force: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await db.query("SELECT status FROM sync_log WHERE entity='variant'")).rows[0]).toEqual({ status: "synced" });
});
