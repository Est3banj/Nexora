import {
  DATA_DIR_VERSION,
  datadirUrl,
  openLocalDb,
  type LocalHandle,
  type OpenOptions,
} from "./pglite";
import { sealLocal, unresolvedWork } from "./preservation";

/**
 * Module-level singleton for the local database.
 *
 * React StrictMode (dev) mounts → unmounts → remounts effects. Without a
 * singleton the first mount takes the single-tab lock, the cleanup never
 * releases it, and the remount immediately sees itself as a "second tab".
 * The lock is meant to live for the whole page lifetime anyway (released on
 * pagehide inside acquireSingleTabLock).
 *
 * D2-8 (versioned datadir rehydrate):
 *  - `planBoot()` resolves WHICH datadir to open: the stored/detected
 *    version. When it is older than DATA_DIR_VERSION the app is on an
 *    upgrade path — App.tsx flushes the old queue first, then calls
 *    `switchToCurrentDatadir()` (close old → open new → rehydrate).
 *  - The single-tab lock is acquired on the FIRST open and kept across the
 *    switch (the new open passes `locks: null`).
 */

const VERSION_KEY = "pos:datadir-version";

export type BootPlan = {
  /** datadir version to open now */
  version: number;
  /** set when version < DATA_DIR_VERSION → upgrade flow required */
  upgradeFrom: number | null;
};

let memoPlan: Promise<BootPlan> | null = null;
let instance: Promise<LocalHandle | null> | null = null;

export function readStoredVersion(): number | null {
  try {
    const raw = localStorage.getItem(VERSION_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeStoredVersion(version: number): void {
  try {
    localStorage.setItem(VERSION_KEY, String(version));
  } catch {
    /* best-effort */
  }
}

/**
 * Fallback for browsers without a stored version (fresh D2 install over an
 * existing D1 datadir): sniff IndexedDB for `pos_vN` databases.
 */
async function detectExistingVersion(): Promise<number | null> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") {
    return null;
  }
  try {
    const dbs = await indexedDB.databases();
    let max: number | null = null;
    for (const d of dbs) {
      const m = /pos_v(\d+)/.exec(d.name ?? "");
      if (m) {
        const v = Number(m[1]);
        if (max === null || v > max) max = v;
      }
    }
    return max;
  } catch {
    return null;
  }
}

export async function planBoot(): Promise<BootPlan> {
  if (!memoPlan) {
    memoPlan = (async () => {
      const stored = readStoredVersion();
      const detected = stored ?? (await detectExistingVersion());
      if (detected === null) {
        return { version: DATA_DIR_VERSION, upgradeFrom: null };
      }
      if (detected < DATA_DIR_VERSION) {
        return { version: detected, upgradeFrom: detected };
      }
      return { version: Math.max(detected, DATA_DIR_VERSION), upgradeFrom: null };
    })();
  }
  return memoPlan;
}

export function getLocalDb(opts: OpenOptions = {}): Promise<LocalHandle | null> {
  if (!instance) {
    instance = (async () => {
      const plan = await planBoot();
      const url =
        opts.url ??
        (typeof indexedDB !== "undefined" ? datadirUrl(plan.version) : "memory://");
      const handle = await openLocalDb({ ...opts, url });
      if (handle && readStoredVersion() === null) {
        writeStoredVersion(plan.version);
      }
      return handle;
    })().catch((err: unknown) => {
      console.error("[pglite] failed to open local database", err);
      instance = null;
      throw err;
    });
  }
  return instance;
}

/**
 * Closes the current (old-version) datadir and opens DATA_DIR_VERSION.
 * The single-tab lock stays held (acquired by the first open). Callers
 * rehydrate the fresh cache afterwards (App.tsx).
 */
export async function switchToCurrentDatadir(
  opts: OpenOptions & { prepare?: (handle: LocalHandle) => Promise<void> } = {},
): Promise<LocalHandle> {
  const old = await getLocalDb(opts);
  if (old) {
    await sealLocal(old.db);
    if (await unresolvedWork(old.db)) throw new Error("unacknowledged_local_work");
  }
  const url =
    opts.url ??
    (typeof indexedDB !== "undefined" ? datadirUrl(DATA_DIR_VERSION) : "memory://");
  if (old?.url === url && url !== "memory://") {
    await opts.prepare?.(old);
    return old;
  }
  const handle = await openLocalDb({ ...opts, url, locks: null });
  if (!handle) throw new Error("datadir_switch_failed");
  try {
    await opts.prepare?.(handle);
  } catch (error) {
    await handle.db.close();
    throw error;
  }
  // Open first: an open/migration failure leaves the OLD handle usable and
  // the version pointer unchanged. Never delete the previous datadir.
  if (old) await old.db.close();
  writeStoredVersion(DATA_DIR_VERSION);
  memoPlan = Promise.resolve({ version: DATA_DIR_VERSION, upgradeFrom: null });
  instance = Promise.resolve(handle);
  return handle;
}
