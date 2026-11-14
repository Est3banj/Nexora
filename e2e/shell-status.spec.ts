import { expect, test, type Page } from "@playwright/test";

const evidence = "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";

// Mount the production shell and styles with read-only local-query responses.
// State fixtures exercise the real external store without touching any database.
async function mountShell(page: Page) {
  page.on("pageerror", error => { throw error; });
  await page.route("**/__shell-status", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `
    <meta charset="utf-8"><div id="root"></div><script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script><script type="module">
      import React from '/node_modules/.vite/deps/react.js';
      import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
      import { AppShell } from '/src/components/AppShell.tsx';
      import { visibleNav } from '/src/components/navigation.ts';
      import '/src/app.css'; import '/src/nexora.css'; import '/src/responsive.css';
      import { patchSync } from '/src/sync/store.ts';
      window.setShellSync = patchSync;
      const nav = visibleNav('owner').map(item => item.tab === 'reports'
        ? { ...item, title: 'Reportes de ventas y movimientos del comercio' } : item);
      function Fixture() {
        const [tab, setTab] = React.useState('sale');
        return React.createElement(AppShell, {
          db: { query: async () => ({ rows: [] }) }, tenantId: 'fixture',
          user: { id: 'fixture', name: 'Operador POS', email: 'fixture@test.dev' },
          nav, tab, role: 'owner', refreshToken: 0, onNavigate: setTab,
          onTicket() {}, onVariant() {}, onSignOut: async () => {}, onConsola() {}
        }, React.createElement('main', { className: 'app-main' }, 'Contenido POS'));
      }
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Fixture));
    </script>` }));
  await page.goto("/__shell-status");
  await expect(page.getByTestId("shell-status")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const states = [
  { name: "idle", patch: {}, label: "Sin pendientes de sinc." },
  { name: "offline", patch: { online: false, pending: 23 }, label: "23 pendientes" },
  { name: "syncing", patch: { syncing: true, pending: 12, inFlight: 3 }, label: "Sincronizando" },
  { name: "pending", patch: { pending: 123456789 }, label: "123456789 pendientes" },
  { name: "error", patch: { error: "Servidor no disponible", pending: 5, failed: 2 }, label: "Error de sinc." },
  { name: "failed", patch: { failed: 1, pending: 1 }, label: "Error de sinc." },
  { name: "review", patch: { poison: 3 }, label: "3 en revisión" },
  { name: "offline-empty", patch: { online: false }, label: "Sin pendientes de sinc." },
];

for (const width of [320, 375, 415, 639, 640, 768, 1023, 1024, 1440]) {
  test(`integrated shell status preserves states and usable header at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mountShell(page);
    for (const state of states) {
      await page.evaluate(patch => {
        (window as unknown as { setShellSync: (patch: object) => void }).setShellSync({
          online: true, pending: 0, failed: 0, poison: 0, syncing: false, inFlight: 0, error: null, ...patch,
        });
      }, state.patch);
      const rail = page.getByTestId("shell-status");
      await expect(page.getByTestId("pending-badge")).toHaveText(state.label);
      await expect(page.getByTestId("net-status")).toHaveText("online" in state.patch && !state.patch.online ? "sin conexión" : "en línea");
      await expect(rail).toHaveAccessibleName(new RegExp(state.label.replaceAll(".", "\\.")));
      await expect(rail).toHaveAttribute("title", /cambios pendientes.*fallidos.*requieren revisión.*en envío/);
      // Every visible piece stays inside the header, and no pair overlaps.
      const geometry = await page.locator(".app-header").evaluate(header => {
        const h = header.getBoundingClientRect();
        const elements = [...header.querySelectorAll('h1, .header-logo, .shell-status, .notification-trigger, .mobile-account > summary, .shell-clock')]
          .filter(el => el.getBoundingClientRect().width > 0);
        const rects = elements.map(el => el.getBoundingClientRect());
        return {
          contained: rects.every(r => r.x >= h.x && r.right <= h.right && r.y >= h.y && r.bottom <= h.bottom),
          separated: rects.every((a, i) => rects.slice(i + 1).every(b => a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y)),
          titleWidth: header.querySelector('h1')!.getBoundingClientRect().width,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(geometry).toMatchObject({ contained: true, separated: true, overflow: false });
      expect(geometry.titleWidth).toBeGreaterThanOrEqual(100);
      for (const target of await page.locator('.notification-trigger, .mobile-account > summary, .tabbar button').all()) {
        const box = (await target.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(await target.evaluate(el => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        })).toBe(true);
      }
      await page.screenshot({ path: `${evidence}/shell-status-${width}-${state.name}.png` });
    }
    await page.getByTestId("notifications").click();
    await expect(page.getByTestId("notification-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("notifications")).toBeFocused();
    if (width < 1024) {
      await page.getByLabel("Cuenta y caja", { exact: true }).click();
      await expect(page.getByTestId("shell-account")).toBeVisible();
      await page.getByLabel("Cuenta y caja", { exact: true }).click();
    }
    if (width < 640) await page.getByTestId("nav-more").click();
    await page.getByTestId("tab-reports").click();
    await expect(page.locator(".app-header h1")).toHaveText("Reportes de ventas y movimientos del comercio");
    await expect(page.locator(".app-header h1")).toHaveAttribute("title", "Reportes de ventas y movimientos del comercio");
    await page.screenshot({ path: `${evidence}/shell-status-${width}-long-title.png` });
  });
}
