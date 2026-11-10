/**
 * Sync status store (task D2-5): a tiny external store so queue transitions
 * (drain, retry, poison) update the badge UI LIVE without a page refresh
 * (sync spec §Visible sync status).
 */

export type SyncState = {
  /** pending + failed + in_flight — the badge count */
  pending: number;
  failed: number;
  poison: number;
  inFlight: number;
  online: boolean;
  /** epoch ms of the last successful push (localStorage-persisted) */
  lastSync: number | null;
  /** last transport/server error — surfaced with a retry affordance */
  error: string | null;
  syncing: boolean;
};

const LAST_SYNC_KEY = "pos:last-sync";

function readLastSync(): number | null {
  try {
    const v = localStorage.getItem(LAST_SYNC_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

let state: SyncState = {
  pending: 0,
  failed: 0,
  poison: 0,
  inFlight: 0,
  online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
  lastSync: readLastSync(),
  error: null,
  syncing: false,
};

const listeners = new Set<() => void>();

export function getSyncState(): SyncState {
  return state;
}

export function subscribeSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function patchSync(patch: Partial<SyncState>): void {
  const changed = (Object.keys(patch) as Array<keyof SyncState>).some(
    (k) => state[k] !== patch[k],
  );
  if (!changed) return;
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

/**
 * Last-successful-sync timestamp (D2-5): persisted to localStorage so it
 * survives reloads, AND patched into the live store so the UI timestamp
 * updates immediately after a successful push — no refresh required
 * (sync spec §Visible sync status).
 */
export function writeLastSync(ts: number = Date.now()): void {
  try {
    localStorage.setItem(LAST_SYNC_KEY, String(ts));
  } catch {
    /* private mode / SSR — last-sync is best-effort */
  }
  patchSync({ lastSync: ts });
}

export { readLastSync };
