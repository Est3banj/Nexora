import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { dbOne } from "./helpers-db";
import { createTenantViaFounder } from "./helpers-auth";
import { navigate } from "./helpers-navigation";

const evidence = "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";

async function tenant(page: Page, displayName?: string) {
  const id = randomUUID();
  const email = `ui-${id}@test.dev`;
  // P0-1: founder plane only — /api/auth/organization/create is closed.
  const org = await createTenantViaFounder(page.request, {
    name: "Comercio UI", slug: `ui-${id}`, email, password: "ui-test-only-123",
  });
  // The founder route derives the first user's name from the email local
  // part; a spec that stresses LONG actor names (shift-actor layout) renames
  // the row before page.goto — get-session joins the user table fresh, so the
  // session the app mounts with already carries the new name.
  if (displayName) {
    dbOne(`UPDATE "user" SET name='${displayName.replaceAll("'", "''")}' WHERE email='${email}'`);
  }
  return org;
}

async function noPageOverflow(page: Page) {
  expect(await page.locator(".app-main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("responsive boundaries, compact navigation, long POS data and reserved action regions", async ({ page }) => {
  const org = await tenant(page);
  const customer = randomUUID(), ticket = randomUUID();
  dbOne(`INSERT INTO customers(id,tenant_id,client_uuid,name,phone,credit_limit) VALUES('${customer}','${org}','${customer}','${"C".repeat(120)}','${"3".repeat(40)}',2147483647);
    INSERT INTO tickets(id,tenant_id,client_uuid,ticket_no,status,total,customer_id) VALUES('${ticket}','${org}','${ticket}',901,'completed',50000,'${customer}');
    INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,method,amount,status) VALUES(gen_random_uuid(),'${org}',gen_random_uuid(),'${ticket}','credit',50000,'confirmed')`.replace(/\n/g, " "));
  const categories: string[] = [];
  for (let i = 0; i < 8; i++) {
    const response = await page.request.post("/api/catalog/categories", { data: { name: `Categoría ${i} con nombre largo para filtros` } });
    expect(response.ok()).toBe(true);
    categories.push((await response.json()).category.id);
  }
  for (let i = 0; i < 24; i++) {
    expect((await page.request.post("/api/catalog/products", { data: {
      name: `${String(i).padStart(2, "0")} Producto ${"L".repeat(90)}`,
      category_id: categories[i % categories.length],
      variant: { name: `Presentación ${"V".repeat(60)}`, code: `UI-${i}-${"S".repeat(90)}`, price: 12000, stock: 100 },
    } })).ok()).toBe(true);
  }
  await page.goto("/");
  await expect(page.getByTestId("sale-item")).toHaveCount(24);
  for (const width of [320, 375, 639, 640, 768, 1023, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await navigate(page, "sale");
    const nav = page.getByRole("navigation", { name: "Navegación principal", exact: true });
    await expect(nav).toBeVisible();
    // Wait for matchMedia's React update at both navigation boundaries.
    await expect(nav.locator("button")).toHaveCount(width < 640 ? 5 : 9);
    expect(await nav.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const n = (await nav.boundingBox())!;
    if (width < 1024) expect(n.y).toBeGreaterThan(900);
    else {
      expect((await page.locator(".shell-sidebar").boundingBox())!.width).toBe(256);
      await expect(nav.locator(".nav-group-title")).toHaveText(["Operación", "Gestión"]);
    }
    for (const button of await nav.locator("button").all()) {
      const r = (await button.boundingBox())!;
      expect(r.width).toBeGreaterThanOrEqual(44);
      expect(r.height).toBeGreaterThanOrEqual(44);
      await expect(button).toHaveAccessibleName(/.+/);
      await expect(button).toHaveAttribute("title", /.+/);
      if (width < 640) await expect(button.locator("span")).toBeHidden();
      else await expect(button.locator("span")).toBeVisible();
    }
    if (width < 640) {
      await page.getByTestId("nav-more").click();
      const dialog = page.getByRole("dialog", { name: "Más secciones", exact: true });
      await expect(page.getByTestId("nav-more")).toHaveAttribute("aria-expanded", "true");
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate(el => document.activeElement === document.body || el.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("nav-more")).toBeFocused();
      await navigate(page, "reports");
      await expect(page.getByTestId("nav-more")).toHaveAttribute("aria-current", "page");
      await navigate(page, "sale");
      await expect(page.getByTestId("nav-more")).not.toHaveAttribute("aria-current");
    }
    await expect(page.getByTestId("sale-item")).toHaveCount(24);
    await page.evaluate(() => document.fonts.ready);
    await noPageOverflow(page);
    const header = (await page.locator(".app-header").boundingBox())!;
    const title = (await page.locator(".app-header h1").boundingBox())!;
    expect(title.y).toBeGreaterThanOrEqual(header.y);
    expect(title.y + title.height).toBeLessThanOrEqual(header.y + header.height);
    await page.locator(".app-main").evaluate(el => { el.scrollTop = el.scrollHeight; });
    const last = (await page.getByTestId("sale-item").last().boundingBox())!;
    if (width < 1024) {
      const bar = (await page.getByTestId("cart-bar").boundingBox())!;
      expect(bar.y + bar.height).toBeLessThanOrEqual(n.y + 1);
      expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
    } else {
      const panel = (await page.getByTestId("order-panel").boundingBox())!;
      expect(panel.y + panel.height).toBeLessThanOrEqual(1000);
      expect(await page.getByTestId("order-panel").evaluate(el => getComputedStyle(el).overflowY)).toBe("hidden");
    }
    await page.screenshot({ path: `${evidence}/ui-applied-${width}-pos.png` });
    await navigate(page, "credito");
    await expect(page.getByTestId("client-card")).toHaveCount(1);
    await noPageOverflow(page);
    await page.screenshot({ path: `${evidence}/ui-applied-${width}-credit.png` });
    await navigate(page, "tickets");
    await expect(page.getByTestId("ticket-item")).toHaveCount(1);
    const table = page.getByRole("region", { name: "Historial de comprobantes, desplazamiento horizontal" });
    await expect(table).toHaveAttribute("tabindex", "0");
    await table.evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await noPageOverflow(page);
    const wrapper = (await table.boundingBox())!;
    const action = (await page.getByTestId("ticket-preview").boundingBox())!;
    expect(action.x).toBeGreaterThanOrEqual(wrapper.x);
    expect(action.x + action.width).toBeLessThanOrEqual(wrapper.x + wrapper.width);
    await page.screenshot({ path: `${evidence}/ui-applied-${width}-tickets.png` });
  }
});

test("client cupo preserves invalid money, toast does not intercept checkout, and payment respects settings", async ({ page }) => {
  const org = await tenant(page);
  expect((await page.request.post("/api/catalog/products", { data: { name: "Café UI cobro", variant: { name: "Único", price: 12000, stock: 0 } } })).ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByTestId("sale-item")).toHaveCount(1);
  await navigate(page, "credito");
  await page.getByTestId("client-new").click();
  await page.getByTestId("client-name").fill("Cliente UI");
  for (const value of ["1.5", "1,5", "-5", "2147483648"]) {
    await page.getByTestId("client-limit").fill(value);
    await expect(page.getByTestId("client-limit")).toHaveValue(value);
    await page.getByTestId("client-save").click();
    await expect(page.getByTestId("client-error")).toBeVisible();
    await expect(page.getByTestId("client-modal")).toBeVisible();
    expect(dbOne(`SELECT count(*) FROM customers WHERE tenant_id='${org}'`)).toBe("0");
  }
  await page.getByTestId("client-limit").fill("100000");
  await page.getByTestId("client-save").click();
  await expect(page.getByTestId("toast")).toBeVisible();
  // Holding focus keeps the real toast visible while geometry is measured.
  await page.getByLabel("Cerrar aviso").focus();
  await navigate(page, "sale");
  await page.getByLabel("Cerrar aviso").focus();
  for (const width of [375, 639, 640, 1023]) {
    await page.setViewportSize({ width, height: 812 });
    const bar = (await page.getByTestId("cart-bar").boundingBox())!;
    const toast = (await page.getByTestId("toast").boundingBox())!;
    expect(toast.y + toast.height).toBeLessThanOrEqual(bar.y);
    expect(await page.getByTestId("checkout-open").evaluate(el => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    })).toBe(true);
    await page.screenshot({ path: `${evidence}/ui-applied-${width}-toast-checkout.png` });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByLabel("Cerrar aviso").click();
  await page.getByTestId("sale-item").click();
  await page.getByTestId("checkout-open").click();
  await expect(page.getByRole("group", { name: "Método de pago" })).toBeVisible();
  await expect(page.getByTestId("pay-cash")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("pay-transfer").click();
  await expect(page.getByTestId("pay-transfer")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("pay-fiado").click();
  await expect(page.getByTestId("fiado-mixed-toggle")).not.toBeChecked();
  await expect(page.getByTestId("fiado-cash")).toHaveCount(0);
  expect(await page.getByTestId("checkout-summary").evaluate(el => getComputedStyle(el).flexShrink)).toBe("0");
  await page.screenshot({ path: `${evidence}/ui-applied-375-payment.png` });
  await page.getByTestId("checkout-cancel").click();
  await navigate(page, "admin");
  await page.getByTestId("admin-tab-configuracion").click();
  await page.getByTestId("admin-setting-enable_fiado").uncheck();
  await page.getByTestId("admin-setting-allow_negative_stock").uncheck();
  await page.getByTestId("admin-settings-save").click();
  await expect(page.getByTestId("tab-credito")).toHaveCount(0);
  await navigate(page, "sale");
  await page.getByTestId("sale-item").click();
  await page.getByTestId("checkout-open").click();
  await expect(page.getByTestId("pay-fiado")).toHaveCount(0);
  await expect(page.getByTestId("oversell-warning")).toContainText("no permite ventas sin stock");
  await expect(page.getByTestId("checkout-confirm")).toBeDisabled();
});

test("failed local queries are retryable errors, never false empty catalog or history", async ({ page }) => {
  await tenant(page);
  await page.goto("/");
  await expect(page.getByTestId("empty-catalog")).toBeVisible();
  await navigate(page, "catalog");
  await expect(page.getByTestId("empty-catalog-note")).toBeVisible();
  await page.evaluate(async () => {
    const { getLocalDb } = await import("/src/db/instance.ts");
    const { db } = (await getLocalDb())!;
    const query = db.query.bind(db);
    (window as unknown as { restoreUiQuery: () => void }).restoreUiQuery = () => { db.query = query; };
    db.query = (...args: Parameters<typeof db.query>) => {
      if (String(args[0]).includes("p.name AS product_name")) return Promise.reject(new Error("UI query fixture"));
      return query(...args);
    };
  });
  await navigate(page, "sale");
  await expect(page.getByTestId("sale-catalog-error")).toBeVisible();
  await expect(page.getByTestId("empty-catalog")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { restoreUiQuery: () => void }).restoreUiQuery());
  await page.getByRole("button", { name: "Reintentar catálogo", exact: true }).click();
  await expect(page.getByTestId("empty-catalog")).toBeVisible();
  await page.evaluate(async () => {
    const { getLocalDb } = await import("/src/db/instance.ts");
    const { db } = (await getLocalDb())!;
    const query = db.query.bind(db);
    (window as unknown as { restoreUiQuery: () => void }).restoreUiQuery = () => { db.query = query; };
    db.query = (...args: Parameters<typeof db.query>) => {
      if (String(args[0]).includes("ORDER BY t.created_at DESC")) return Promise.reject(new Error("UI history fixture"));
      return query(...args);
    };
  });
  await navigate(page, "tickets");
  await expect(page.getByRole("alert")).toContainText("No se pudieron consultar los comprobantes");
  await expect(page.getByTestId("empty-tickets")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { restoreUiQuery: () => void }).restoreUiQuery());
  await page.getByRole("button", { name: "Reintentar comprobantes" }).click();
  await expect(page.getByTestId("empty-tickets")).toBeVisible();
});

test("Caja uses available space across opening, count, close and long history without page overflow", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  // Long actor name on purpose: shift-actor must render it without overflow.
  const name = `Cajero ${"Apellido".repeat(16)}`;
  await tenant(page, name);
  await page.goto("/");
  await navigate(page, "arqueo");
  await expect(page.getByTestId("opening-cash")).toBeVisible();
  await expect(page.getByTestId("close-history")).toContainText("Sin cierres aún.");
  const widths = [320, 375, 640, 768, 1023, 1024, 1440, 1850];
  const measurements: object[] = [];
  async function measure(state: string) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 955 });
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("navigation", { name: "Navegación principal", exact: true }).locator("button")).toHaveCount(width < 640 ? 5 : 9);
      await page.locator(".app-main").evaluate(el => { el.scrollTop = 0; });
      await noPageOverflow(page);
      const screen = page.locator(".cash-screen");
      // Check intrinsic overflow too: hiding a clipped CTA is not a layout fix.
      for (const control of await screen.locator("button, input, textarea").all()) {
        const r = (await control.boundingBox())!;
        expect(r.height).toBeGreaterThanOrEqual(44);
        expect(r.width).toBeGreaterThanOrEqual(44);
        expect(await control.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
      for (const block of await screen.locator(".cash-banner, .cash-grid, .cash-form, .cash-metrics, .cash-expected").all()) {
        expect(await block.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      }
      const bounds = await screen.evaluate(el => {
        const rect = (selector: string) => {
          const node = el.querySelector(selector);
          if (!node) return null;
          const { x, y, width, height } = node.getBoundingClientRect();
          return { x, y, width, height };
        };
        return { screen: el.getBoundingClientRect().width, opening: rect(".cash-opening"), history: rect(".cash-history"), system: rect('[data-testid="expected-card"]'), count: rect(".cash-count") };
      });
      if (bounds.system) {
        if (bounds.screen >= 1000) {
          expect(bounds.count!.y).toBeCloseTo(bounds.system.y, 0);
          expect(bounds.count!.x).toBeGreaterThan(bounds.system.x + bounds.system.width);
        } else {
          expect(bounds.count!.y).toBeGreaterThanOrEqual(bounds.system.y + bounds.system.height);
        }
        expect(bounds.history!.width).toBeCloseTo(bounds.screen, 0);
      } else if (bounds.screen < 1200) {
        expect(bounds.history!.width).toBeCloseTo(bounds.screen, 0);
      }
      const main = (await page.locator(".app-main").boundingBox())!;
      if (width < 1024) {
        const nav = (await page.locator(".shell-sidebar").boundingBox())!;
        expect(main.y + main.height).toBeLessThanOrEqual(nav.y + 1);
        expect(nav.y + nav.height).toBeLessThanOrEqual(955);
      }
      measurements.push({ state, width, ...bounds });
      if (width === 1850) console.log(`Caja ${state}: ${JSON.stringify(bounds)}`);
      await page.screenshot({ path: `${evidence}/cash-layout-${state}-${width}.png` });
      if (width === 375 || width === 1440) {
        for (const selector of [".cash-count", ".cash-ledger", ".cash-history"]) {
          const block = screen.locator(selector);
          if (await block.count()) {
            await block.scrollIntoViewIfNeeded();
            await page.screenshot({ path: `${evidence}/cash-layout-${state}-${width}-${selector.slice(6)}.png` });
          }
        }
      }
      if (width === 1850) {
        if (bounds.opening) {
          expect(bounds.opening.width).toBeLessThanOrEqual(400);
          expect(bounds.history!.y).toBeCloseTo(bounds.opening.y, 0);
          expect(bounds.history!.x).toBeGreaterThan(bounds.opening.x + bounds.opening.width);
        } else {
          expect(bounds.count!.y).toBeCloseTo(bounds.system!.y, 0);
          expect(bounds.count!.width).toBeLessThanOrEqual(440);
          expect(bounds.history!.width).toBeCloseTo(bounds.screen, 0);
        }
      }
    }
  }
  await measure("empty");
  for (const value of ["-1", "1.5", "2147483648"]) {
    await page.getByTestId("opening-cash").fill(value);
    await expect(page.getByTestId("opening-cash")).toHaveValue(value);
    await expect(page.getByTestId("opening-cash")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("open-shift")).toBeDisabled();
  }
  await page.getByTestId("opening-cash").fill("2000000000");
  await page.getByTestId("open-shift").click();
  await expect(page.getByTestId("expected-total")).toContainText("2.000.000.000");
  await expect(page.getByTestId("shift-actor")).toHaveText(name);
  await measure("active");
  await page.getByTestId("cash-movement-open").click();
  await page.getByTestId("movement-amount").fill("10000");
  await page.getByTestId("movement-reason").fill("Motivo".repeat(20));
  await page.getByTestId("movement-note").fill("Nota".repeat(125));
  await page.getByTestId("movement-save").click();
  await expect(page.getByTestId("cash-movement-row")).toHaveCount(1);
  await expect(page.getByTestId("expected-total")).toContainText("2.000.010.000");
  for (const value of ["-1", "1.5", "2147483648"]) {
    await page.getByTestId("counted").fill(value);
    await expect(page.getByTestId("counted")).toHaveValue(value);
    await expect(page.getByTestId("counted")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByTestId("close-shift")).toBeDisabled();
    await expect(page.locator("#count-help")).toBeVisible();
  }
  await page.getByTestId("counted").fill("2000010000");
  await expect(page.getByTestId("cash-difference")).toContainText("Cuadre Exacto");
  await page.getByTestId("counted").fill("2000000000");
  await expect(page.getByTestId("cash-difference")).toContainText("Faltante");
  await page.getByTestId("closing-note").fill("Observación".repeat(45));
  await measure("count-difference-ledger");
  await page.setViewportSize({ width: 375, height: 955 });
  await page.locator(".cash-close-focus").click();
  await expect(page.getByTestId("counted")).toBeFocused();
  const close = page.getByTestId("close-shift");
  await close.scrollIntoViewIfNeeded();
  expect(await close.evaluate(el => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
  await page.getByTestId("close-shift").click();
  await expect(page.getByTestId("no-open-shift")).toBeVisible();
  await expect(page.getByTestId("close-history-row")).toHaveCount(1);
  await expect(page.getByTestId("history-diff")).toContainText("10.000");
  await expect(page.getByTestId("history-diff")).toContainText("Faltante");
  await expect(page.getByTestId("close-history-row")).toContainText("Gaveta v2 · físico");
  await expect(page.getByTestId("close-history-row")).toContainText("Observación".repeat(45));
  await measure("closed-history");
  await page.getByTestId("opening-cash").fill("0");
  await page.getByTestId("open-shift").click();
  await expect(page.getByTestId("expected-total")).toContainText("$ 0");
  await measure("active-history");
  const history = page.getByRole("region", { name: "Historial de cierres", exact: true });
  await expect(history).toHaveAttribute("tabindex", "0");
  await page.setViewportSize({ width: 320, height: 955 });
  await history.scrollIntoViewIfNeeded();
  await history.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => history.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  await history.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await noPageOverflow(page);
  const main = (await page.locator(".app-main").boundingBox())!;
  const nav = (await page.locator(".shell-sidebar").boundingBox())!;
  expect(main.y + main.height).toBeLessThanOrEqual(nav.y + 1);
  await testInfo.attach("cash-layout-measurements", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
});
