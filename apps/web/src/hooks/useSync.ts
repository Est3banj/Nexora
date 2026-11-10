import { useSyncExternalStore } from "react";
import { getSyncState, subscribeSync, type SyncState } from "../sync/store";

/** Live sync status (pending count, online, last sync, error, poison). */
export function useSync(): SyncState {
  return useSyncExternalStore(subscribeSync, getSyncState, getSyncState);
}
