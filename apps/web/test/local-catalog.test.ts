import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../src/db/pglite";
import {
  adjustLocalStock,
  createLocalProduct,
  listProducts,
  listSaleItems,
  pendingCount,
  recountLocal,
  updateLocalProduct,
  createLocalCategory,
  updateLocalCategory,
  listCategories,
  saveLocalCatalogProduct,
  commitLocalSale,
} from "../src/db/local";

/**
 * D1-7 · Catalog vertical slice against the LOCAL cache (offline-capable).
 * AC (catalog spec): create/deactivate/tenant-scoped locally, variants with
 * independent prices, manual adjustment auditable, recount == balance,
 * empty catalog no crash, local-first write + sync_log enqueue.
 */

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

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

describe("local catalog", () => {
  it("modal save rolls back metadata, variants, adjustments and queue on a duplicate second code", async () => {
    const p = await createLocalProduct(db, TENANT_A, { name: "Original", variant: { name: "Chico", code: "001", price: 10, cost: 4, stock: 8 } });
    const before = await db.query("SELECT * FROM sync_log ORDER BY id");
    await expect(saveLocalCatalogProduct(db, TENANT_A, { id: p.id, product: { name: "Must roll back", icon_key: "coffee" }, variants: [
      { id: p.variants[0].id, name: "Chico editado", code: "001", price: 20, cost: null, stock: -2, reason: "rotura", note: "dos unidades" },
      { name: "Grande", code: "001", price: 30, cost: 8, stock: 3 },
    ] })).rejects.toMatchObject({ code: "23505" });
    expect(await listProducts(db, TENANT_A)).toEqual([p]);
    expect((await db.query("SELECT * FROM sync_log ORDER BY id")).rows).toEqual(before.rows);
    expect(await recountLocal(db, TENANT_A, p.variants[0].id)).toBe(8);
    await expect(saveLocalCatalogProduct(db, TENANT_A, { product: { name: "New duplicate" }, variants: [
      { name: "Primera", code: "002", price: 1, cost: null, stock: 2 }, { name: "Segunda", code: "001", price: 1, cost: null, stock: 2 },
    ] })).rejects.toMatchObject({ code: "23505" });
    expect(await listProducts(db, TENANT_A)).toHaveLength(1);
  });

  it("modal edits retain photos, sibling variants and historical costs; delta applies after an intervening sale", async () => {
    const category = await createLocalCategory(db, TENANT_A, { name: "Bebidas reales" });
    const id = await saveLocalCatalogProduct(db, TENANT_A, { product: { name: "Café", category_id: category.id, photo: "data:image/png;base64,AA==", icon_key: "coffee" }, variants: [
      { name: "Chico", code: "001", price: 100, cost: 40, stock: 8 }, { name: "Grande", code: "002", price: 200, cost: 80, stock: 10 },
    ] });
    const p = (await listProducts(db, TENANT_A))[0];
    const v = p.variants.find(v => v.code === "001")!;
    const sale = await commitLocalSale(db, TENANT_A, { lines: [{ variant_id: v.id, qty: 1, unit_price: 100 }], tendered: 100 });
    await saveLocalCatalogProduct(db, TENANT_A, { id, product: { name: "Café nuevo", active: false }, variants: [
      { id: v.id, name: v.name, code: "0001", price: 120, cost: null, stock: -2, reason: "rotura", note: "Control físico" },
    ] });
    const edited = (await listProducts(db, TENANT_A))[0];
    expect(edited).toMatchObject({ name: "Café nuevo", category_id: category.id, photo: p.photo, icon_key: "coffee", active: false });
    expect(edited.variants.find(row => row.id === v.id)).toMatchObject({ stock: 5, cost: null, price: 120, code: "0001" });
    expect(edited.variants.find(row => row.code === "002")).toEqual(p.variants.find(row => row.code === "002"));
    expect(await recountLocal(db, TENANT_A, v.id)).toBe(5);
    expect((await db.query("SELECT unit_cost FROM ticket_lines WHERE tenant_id=$1 AND ticket_id=$2", [TENANT_A, sale.ticket.id])).rows).toEqual([{ unit_cost: 40 }]);
    expect((await db.query("SELECT delta,reason,note FROM stockdiary WHERE tenant_id=$1 AND reason='rotura'", [TENANT_A])).rows).toEqual([{ delta: -2, reason: "rotura", note: "Control físico" }]);
  });

  it("modal rejects missing audit evidence and cross-product/tenant variant IDs without partial edits", async () => {
    const p = await createLocalProduct(db, TENANT_A, { name: "Original", variant: { name: "Único", price: 10, stock: 8 } });
    const v = { id: p.variants[0].id, name: "Único", code: null, price: 10, cost: null, stock: 2 };
    await expect(saveLocalCatalogProduct(db, TENANT_A, { id: p.id, product: { name: "Invalid" }, variants: [v] })).rejects.toThrow();
    await expect(saveLocalCatalogProduct(db, TENANT_B, { product: { name: "Foreign" }, variants: [v] })).rejects.toThrow("Variante no encontrada");
    expect(await listProducts(db, TENANT_B)).toEqual([]);
    expect((await listProducts(db, TENANT_A))[0].name).toBe("Original");
    expect(await recountLocal(db, TENANT_A, v.id)).toBe(8);
    await expect(saveLocalCatalogProduct(db, TENANT_B, { id: p.id, product: { name: "Foreign edit" }, variants: [v] })).rejects.toThrow("Producto no encontrado");
    const sibling = await createLocalProduct(db, TENANT_A, { name: "Otro producto", variant: { name: "Otro", price: 3, stock: 2 } });
    await expect(saveLocalCatalogProduct(db, TENANT_A, { id: p.id, product: { name: "Cross-product edit" }, variants: [{ ...v, id: sibling.variants[0].id }] })).rejects.toThrow("Variante no encontrada en este producto");
    expect((await listProducts(db, TENANT_A)).find(row => row.id === p.id)?.name).toBe("Original");
  });
  it("icon metadata survives legacy edits and rehydrate, explicit null clears without losing stock or queued work", async () => {
    const category = await createLocalCategory(db, TENANT_A, { name: "Bebidas", icon_key: "bottle-water" });
    const product = await createLocalProduct(db, TENANT_A, { name: "Café", category_id: category.id, icon_key: "coffee", variant: { name: "Único", price: 3000, stock: 8 } });
    await updateLocalProduct(db, TENANT_A, product.id, { name: "Café ñ" });
    await updateLocalCategory(db, TENANT_A, category.id, { name: "Bebidas ñ" });
    expect((await listProducts(db, TENANT_A))[0]).toMatchObject({ icon_key: "coffee", variants: [{ stock: 8 }] });
    expect((await listSaleItems(db, TENANT_A))[0].icon_key).toBe("coffee");
    expect((await listCategories(db, TENANT_A))[0].icon_key).toBe("bottle-water");
    const before = await pendingCount(db, TENANT_A);
    const { applyRehydratePage } = await import("../src/sync/rehydrate");
    await applyRehydratePage(db, TENANT_A, { products: [{ id: product.id, name: "Servidor viejo", active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }], next_offset: null });
    expect((await listProducts(db, TENANT_A))[0].icon_key).toBe("coffee");
    expect(await pendingCount(db, TENANT_A)).toBe(before);
    await updateLocalProduct(db, TENANT_A, product.id, { icon_key: null });
    await updateLocalCategory(db, TENANT_A, category.id, { icon_key: null });
    expect((await listProducts(db, TENANT_A))[0].icon_key).toBeNull();
    expect((await listCategories(db, TENANT_A))[0].icon_key).toBeNull();
    expect((await listProducts(db, TENANT_B))).toEqual([]);
  });
  it("create → listed + selectable in sale flow + enqueued", async () => {
    const created = await createLocalProduct(db, TENANT_A, {
      name: "Granizado de Fresa",
      variant: { name: "Mediano", price: 3000, stock: 10 },
    });
    expect(created.variants[0].price).toBe(3000);

    const products = await listProducts(db, TENANT_A);
    expect(products).toHaveLength(1);

    const saleItems = await listSaleItems(db, TENANT_A);
    expect(saleItems).toHaveLength(1);

    // product + variant + stockdiary(initial) enqueued as pending
    expect(await pendingCount(db, TENANT_A)).toBe(3);
  });

  it("is tenant-partitioned: tenant B sees an empty catalog", async () => {
    await createLocalProduct(db, TENANT_A, {
      name: "Cerveza",
      variant: { name: "330ml", price: 4000 },
    });
    expect(await listProducts(db, TENANT_B)).toEqual([]);
    expect(await listSaleItems(db, TENANT_B)).toEqual([]);
    expect(await pendingCount(db, TENANT_B)).toBe(0);
  });

  it("deactivate hides from sale flow but not from history", async () => {
    const created = await createLocalProduct(db, TENANT_A, {
      name: "Gaseosa",
      variant: { name: "Personal", price: 2500 },
    });
    await updateLocalProduct(db, TENANT_A, created.id, { active: false });

    expect(await listSaleItems(db, TENANT_A)).toEqual([]);
    const products = await listProducts(db, TENANT_A);
    expect(products).toHaveLength(1);
    expect(products[0].active).toBe(false);
  });

  it("local-first edit REFRESHES the pending payload (no duplicate row)", async () => {
    const created = await createLocalProduct(db, TENANT_A, {
      name: "Agua",
      variant: { name: "600ml", price: 2000 },
    });
    const before = await pendingCount(db, TENANT_A);

    await updateLocalProduct(db, TENANT_A, created.id, { name: "Agua Mineral" });

    expect(await pendingCount(db, TENANT_A)).toBe(before); // no new row
    const res = await db.query<{ payload: { name: string } }>(
      `SELECT payload FROM sync_log WHERE tenant_id = $1 AND entity = 'product'`,
      [TENANT_A],
    );
    expect(res.rows[0]?.payload.name).toBe("Agua Mineral");
  });

  it("manual stock adjustment auditable + recount == balance", async () => {
    const created = await createLocalProduct(db, TENANT_A, {
      name: "Cerveza",
      variant: { name: "330ml", price: 4000, stock: 50 },
    });
    const variantId = created.variants[0].id;

    for (const delta of [-2, -3, 10]) {
      const res = await adjustLocalStock(db, TENANT_A, {
        variant_id: variantId,
        delta,
        reason: "movement",
        note: `delta ${delta}`,
      });
      expect(res?.stock).toBeGreaterThanOrEqual(-Infinity);
    }

    const products = await listProducts(db, TENANT_A);
    expect(products[0].variants[0].stock).toBe(55);
    expect(await recountLocal(db, TENANT_A, variantId)).toBe(55);

    const diary = await db.query<{ reason: string; note: string }>(
      `SELECT reason, note FROM stockdiary WHERE tenant_id = $1 AND variant_id = $2`,
      [TENANT_A, variantId],
    );
    expect(diary.rows).toHaveLength(4); // initial + 3 adjustments
    expect(diary.rows.every((r) => r.reason && r.note)).toBe(true);
  });

  it("empty catalog → empty lists, no crash", async () => {
    expect(await listProducts(db, TENANT_A)).toEqual([]);
    expect(await listSaleItems(db, TENANT_A)).toEqual([]);
  });
});
