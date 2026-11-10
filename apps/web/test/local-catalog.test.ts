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
