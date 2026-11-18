import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { announcePwaUpdate } from "./pwa";
import "./app.css";
import "./nexora.css";
import "./responsive.css";

// P1-6 · `registerType: "prompt"` (vite.config.ts): a new service worker is
// NEVER activated behind the cashier's back — an auto-reload would abort a
// sale mid-ticket. When a version is waiting, the plugin calls
// `onNeedRefresh` → the toast in App.tsx; its button runs this `updateSW`
// (skipWaiting) and the plugin reloads once the new worker takes control.
// Under `vite dev` (e2e) the plugin serves its no-op register module, so
// this stays inert where no service worker exists.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh: () => announcePwaUpdate(() => void updateSW(true)),
});

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    {/* P1-3 · outside <App> so it also covers App's own early returns. */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
