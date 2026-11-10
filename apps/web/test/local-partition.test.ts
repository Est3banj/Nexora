import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../src/db/pglite";
import {
  clearLocalBusinessData,
  createLocalProduct,
  isLocalCacheEmpty,
  listProducts,
  pendingCount,
} from "../src/db/local";

/**
 * D4-4 · Local partitioning (tenancy-auth §Session data is tenant-partitioned):
 *  - sign-out wipe clears every business table
 *  - empty-cache detection drives first-boot rehydrate (ticket_no hole)
 *  - tenant partitioning still holds after partial data
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

async function tableCount(table: string): Promise<number> {
  const res = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(res.rows[0]?.n ?? 0);
}

describe("D4-4 · clearLocalBusinessData", () => {
  it("wipes every business table (products, tickets, sync_log, …)", async () => {
    await createLocalProduct(db, TENANT_A, {
      name: "Granizado",
      variant: { name: "Grande", price: 3500, stock: 5 },
    });
    // minimal ticket + payment + shift so wipe is non-trivial
    await db.query(
      `INSERT INTO shifts (id, tenant_id, client_uuid, status) VALUES ($1, $1, $1, 'open')`,
      [TENANT_A],
    );
    await db.query(
      `INSERT INTO tickets (id, tenant_id, client_uuid, ticket_no, total)
       VALUES ($1, $1, $1, 1, 3500)`,
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    );

    expect(await tableCount("products")).toBeGreaterThan(0);
    expect(await tableCount("sync_log")).toBeGreaterThan(0);
    expect(await tableCount("tickets")).toBe(1);

    await clearLocalBusinessData(db);

    for (const t of [
      "products",
      "product_variants",
      "tickets",
      "ticket_lines",
      "payments",
      "shifts",
      "closedcash",
      "stockcurrent",
      "stockdiary",
      "sync_log",
    ]) {
      expect(await tableCount(t), t).toBe(0);
    }

    // schema still intact — can create again after wipe
    const again = await createLocalProduct(db, TENANT_B, {
      name: "Post-logout",
      variant: { name: "Chico", price: 2000 },
    });
    expect(again.id).toBeTruthy();
    expect(await listProducts(db, TENANT_A)).toEqual([]);
    expect(await listProducts(db, TENANT_B)).toHaveLength(1);
  });

  it("does not leave tenant A rows readable after wipe (partition + wipe)", async () => {
    await createLocalProduct(db, TENANT_A, {
      name: "A-secret",
      variant: { name: "X", price: 1000 },
    });
    expect(await listProducts(db, TENANT_A)).toHaveLength(1);
    await clearLocalBusinessData(db);
    expect(await listProducts(db, TENANT_A)).toEqual([]);
    expect(await pendingCount(db, TENANT_A)).toBe(0);
  });
});

describe("D4-4 · isLocalCacheEmpty (first-boot rehydrate trigger)", () => {
  it("true on a fresh cache", async () => {
    expect(await isLocalCacheEmpty(db, TENANT_A)).toBe(true);
  });

  it("false once products exist (do NOT rehydrate over local truth)", async () => {
    await createLocalProduct(db, TENANT_A, {
      name: "Local only",
      variant: { name: "Único", price: 5000 },
    });
    expect(await isLocalCacheEmpty(db, TENANT_A)).toBe(false);
    // other tenant still empty → its first boot may rehydrate independently
    expect(await isLocalCacheEmpty(db, TENANT_B)).toBe(true);
  });

  it("false once tickets exist even with empty catalog", async () => {
    await db.query(
      `INSERT INTO tickets (id, tenant_id, client_uuid, ticket_no, total)
       VALUES ($1, $1, $1, 1, 100)`,
      [TENANT_A],
    );
    expect(await isLocalCacheEmpty(db, TENANT_A)).toBe(false);
    expect(await isLocalCacheEmpty(db, TENANT_B)).toBe(true);
  });

  it("true again after clearLocalBusinessData (post sign-out)", async () => {
    await createLocalProduct(db, TENANT_A, {
      name: "X",
      variant: { name: "Y", price: 1 },
    });
    expect(await isLocalCacheEmpty(db, TENANT_A)).toBe(false);
    await clearLocalBusinessData(db);
    expect(await isLocalCacheEmpty(db, TENANT_A)).toBe(true);
  });
});
