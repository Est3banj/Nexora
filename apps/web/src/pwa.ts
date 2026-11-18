/**
 * P1-6 · PWA update prompt (vite-plugin-pwa `registerType: "prompt"`).
 *
 * `main.tsx` owns the `virtual:pwa-register` call. When the service worker
 * reports a NEW version is waiting, the plugin fires `onNeedRefresh`, which
 * announces it here; `App.tsx` listens and renders the toast.
 *
 * The restart callback travels in the event detail: reloading alone would
 * boot the SAME waiting worker, so the button must ask the waiting service
 * worker to take over first (skipWaiting → the plugin reloads on
 * `controlling`).
 */
export const PWA_UPDATE_EVENT = "nexora:pwa-update-available";

/** Verbatim copy the task asks the toast to show. */
export const PWA_UPDATE_MESSAGE = "Hay una versión nueva — Reiniciar la caja";

export type PwaUpdateDetail = { restart: () => void };

export function announcePwaUpdate(restart: () => void): void {
  window.dispatchEvent(
    new CustomEvent<PwaUpdateDetail>(PWA_UPDATE_EVENT, { detail: { restart } }),
  );
}
