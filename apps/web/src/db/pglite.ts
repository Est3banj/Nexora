import { PGlite } from "@electric-sql/pglite";
import { LOCAL_SCHEMA_SQL, SALE_OUTBOX_MIGRATION_SQL } from "@pos/shared";
import { PRESERVATION_SQL, assertWritable } from "./preservation";

/**
 * Versioned local datadir (task D1-6, design §12; rehydrate flow D2-8).
 *
 * - `idb://pos_v{N}`: on a datadir version bump (D2-8) the app opens a NEW
 *   empty datadir and rehydrates from the server; the old one is flushed
 *   first (see db/instance.ts planBoot/switchToCurrentDatadir). Version
 *   lives in code; PGlite itself is PINNED (exact version in package.json).
 * - Single-tab guard: `navigator.locks` with `ifAvailable` — a second tab
 *   gets refused with a notice instead of corrupting the cache (PGlite is
 *   single-connection; design §12 risk "PGlite single-connection").
 */

export const DATA_DIR_VERSION = 3;

export function datadirUrl(version: number = DATA_DIR_VERSION): string {
  return `idb://pos_v${version}`;
}

/** Structural type of navigator.locks — injectable for tests. */
export type LockManagerLike = {
  request: (
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: unknown) => Promise<unknown>,
  ) => Promise<unknown>;
};

export type OpenOptions = {
  /** Test override. Defaults to idb://pos_v1 in the browser, memory:// in Node. */
  url?: string;
  /** Test override. Defaults to navigator.locks when available. */
  locks?: LockManagerLike | null;
  onSecondTab?: () => void;
};

export type LocalHandle = {
  db: PGlite;
  url: string;
  /** Releases the single-tab lock (also auto-released on pagehide). */
  release: () => void;
};

/**
 * Holds the single-tab lock for the lifetime of the page. Exported so tests
 * can drive the guard with a fake LockManager.
 */
export async function acquireSingleTabLock(
  locks: LockManagerLike,
  onDenied?: () => void,
  lockName = "nexora/single-tab",
): Promise<{ granted: boolean; release: () => void }> {
  let releaseHold: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });

  // IMPORTANT: `locks.request(...)` only settles when the callback settles,
  // and the callback holds the lock for the page lifetime. So the grant/deny
  // decision must be resolved FROM INSIDE the callback, not by awaiting
  // the request promise.
  const granted = await new Promise<boolean>((resolve) => {
    const request = locks.request(
      lockName,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          resolve(false);
          return;
        }
        resolve(true);
        await hold; // hold until release() — keeps the lock across the page life
      },
    );
    void Promise.resolve(request).catch(() => resolve(false));
  });

  if (!granted) {
    onDenied?.();
    return { granted: false, release: () => {} };
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => releaseHold(), { once: true });
  }
  return { granted: true, release: releaseHold };
}

export async function openLocalDb(opts: OpenOptions = {}): Promise<LocalHandle | null> {
  const url =
    opts.url ??
    (typeof indexedDB !== "undefined" ? datadirUrl() : "memory://");

  const locks =
    opts.locks !== undefined
      ? opts.locks
      : typeof navigator !== "undefined" && "locks" in navigator
        ? (navigator.locks as unknown as LockManagerLike)
        : null;

  let release: () => void = () => {};
  if (locks) {
    const lock = await acquireSingleTabLock(locks, opts.onSecondTab);
    if (!lock.granted) return null;
    release = lock.release;
  }

  const db = new PGlite(url);
  try {
    await db.exec(LOCAL_SCHEMA_SQL);
    await db.exec(SALE_OUTBOX_MIGRATION_SQL);
    await db.exec(PRESERVATION_SQL);
  } catch (error) {
    await db.close().catch(() => {});
    release();
    throw error;
  }

  return { db, url, release };
}

export type LocalQueryable = {
  query: <R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: R[] }>;
};

/**
 * Runs `fn` inside ONE local transaction — commit on success, full rollback
 * on throw (sales spec: "partial write impossible", D1-8 AC).
 */
export async function localTx<T>(
  db: PGlite,
  fn: (tx: LocalQueryable) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await assertWritable(tx);
    return fn(tx as unknown as LocalQueryable);
  });
}
