import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  acquireSingleTabLock,
  datadirUrl,
  DATA_DIR_VERSION,
  localTx,
  openLocalDb,
  type LockManagerLike,
} from "../src/db/pglite";

/**
 * D1-6 · PGlite versioned wrapper
 * AC: app opens local DB and creates tables; second tab shows refusal
 * notice; local tx helper commits atomically.
 */

const handles: Array<() => void> = [];
const dbs: PGlite[] = [];

afterEach(async () => {
  for (const release of handles.splice(0)) release();
  for (const db of dbs.splice(0)) await db.close();
});

function fakeLocks(): LockManagerLike & { holders: number } {
  const state = { holders: 0 };
  return {
    get holders() {
      return state.holders;
    },
    async request(_name, options, callback) {
      if (state.holders > 0 && options.ifAvailable) {
        return callback(null);
      }
      state.holders += 1;
      try {
        return await callback({ name: _name });
      } finally {
        state.holders -= 1;
      }
    },
  };
}

async function tableNames(db: PGlite): Promise<string[]> {
  const res = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  return res.rows.map((r) => r.tablename);
}

describe("openLocalDb", () => {
  it("opens the local DB and creates every local table", async () => {
    const handle = await openLocalDb({ url: "memory://", locks: null });
    expect(handle).not.toBeNull();
    handles.push(handle!.release);
    dbs.push(handle!.db);

    const tables = await tableNames(handle!.db);
    expect(tables).toEqual(
      expect.arrayContaining([
        "products",
        "product_variants",
        "shifts",
        "tickets",
        "ticket_lines",
        "payments",
        "closedcash",
        "stockcurrent",
        "stockdiary",
        "sync_log",
      ]),
    );
  });

  it("datadir is versioned (idb://pos_v{N}) and follows DATA_DIR_VERSION", () => {
    expect(datadirUrl()).toBe(`idb://pos_v${DATA_DIR_VERSION}`);
    expect(datadirUrl(DATA_DIR_VERSION + 1)).toBe(
      `idb://pos_v${DATA_DIR_VERSION + 1}`,
    );
    expect(DATA_DIR_VERSION).toBeGreaterThanOrEqual(2); // bumped to 2 by D2-8 rehydrate
  });
});

describe("single-tab guard (navigator.locks)", () => {
  it("refuses a second tab with the notice callback", async () => {
    const locks = fakeLocks();
    let denied = false;

    const first = await openLocalDb({
      url: "memory://",
      locks,
      onSecondTab: () => {
        denied = false;
      },
    });
    expect(first).not.toBeNull();
    handles.push(first!.release);
    dbs.push(first!.db);

    const second = await openLocalDb({
      url: "memory://",
      locks,
      onSecondTab: () => {
        denied = true;
      },
    });
    expect(second).toBeNull();
    expect(denied).toBe(true);
  });

  it("after release a new tab may open again", async () => {
    const locks = fakeLocks();
    const first = await acquireSingleTabLock(locks);
    expect(first.granted).toBe(true);
    const busy = await acquireSingleTabLock(locks);
    expect(busy.granted).toBe(false);
    first.release();
    // release resolves the hold; the fake lock frees on callback settle
    await new Promise((r) => setTimeout(r, 0));
    const third = await acquireSingleTabLock(locks);
    expect(third.granted).toBe(true);
    third.release();
  });
});

describe("localTx helper", () => {
  it("commits on success", async () => {
    const handle = await openLocalDb({ url: "memory://", locks: null });
    handles.push(handle!.release);
    dbs.push(handle!.db);

    await localTx(handle!.db, async (tx) => {
      await tx.query(
        `INSERT INTO products (id, tenant_id, client_uuid, name) VALUES ($1, $2, $1, $3)`,
        [crypto.randomUUID(), crypto.randomUUID(), "Probado"],
      );
    });
    const res = await handle!.db.query<{ n: string }>(`SELECT count(*) AS n FROM products`);
    expect(Number(res.rows[0]?.n)).toBe(1);
  });

  it("rolls back the whole transaction on throw (partial write impossible)", async () => {
    const handle = await openLocalDb({ url: "memory://", locks: null });
    handles.push(handle!.release);
    dbs.push(handle!.db);

    const tenant = crypto.randomUUID();
    await expect(
      localTx(handle!.db, async (tx) => {
        await tx.query(
          `INSERT INTO products (id, tenant_id, client_uuid, name) VALUES ($1, $2, $1, $3)`,
          [crypto.randomUUID(), tenant, "No debe quedar"],
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const res = await handle!.db.query<{ n: string }>(
      `SELECT count(*) AS n FROM products WHERE tenant_id = $1`,
      [tenant],
    );
    expect(Number(res.rows[0]?.n)).toBe(0);
  });
});
