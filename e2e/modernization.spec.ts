import { expect, test, type Page } from "@playwright/test";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const XLSX = createRequire(new URL("../apps/web/package.json", import.meta.url))("xlsx");

const evidence = "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";

async function modalKeyboard(page: Page, id: string, trigger: string, width: number) {
  const modal = page.getByTestId(id);
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAccessibleName(/.+/);
  for (let n = 0; n < 24; n++) {
    await page.keyboard.press(n % 3 === 0 ? "Shift+Tab" : "Tab");
    // Native modal traversal may visit browser chrome (activeElement=body),
    // but must never focus a background app control.
    expect(await modal.evaluate(el => document.activeElement === document.body || el.contains(document.activeElement))).toBe(true);
  }
  await page.setViewportSize({ width, height: 520 });
  const buttons = modal.locator("button:visible:enabled");
  await buttons.last().scrollIntoViewIfNeeded();
  await expect(buttons.last()).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  await page.screenshot({ path: `${evidence}/m9-${width}-${id}-short.png` });
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(page.getByTestId(trigger).and(page.locator(":enabled")).first()).toBeFocused();
  await page.setViewportSize({ width, height: 1000 });
}
async function authenticate(page: Page) {
  wipeSalesAndCatalog();
  dbOne("DELETE FROM cash_movements; DELETE FROM credit_abonos; DELETE FROM customers");
  const org = dbOne("SELECT id FROM organization WHERE slug='tienda-demo'");
  expect((await page.request.post("/api/auth/sign-in/email", { data: { email: "owner@demo.test", password: "demo12345" } })).ok()).toBe(true);
  expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: org } })).ok()).toBe(true);
  return org;
}
async function openAccount(page: Page, width: number) {
  if (width < 768) await page.getByLabel("Cuenta y caja", { exact: true }).click();
}

for (const width of [1440, 375]) {
  test.describe(`M4 shell ${width}`, () => {
    test.use({ viewport: { width, height: 1000 } });
    test("seven destinations, local fonts, real identity, empty alert keyboard boundaries and offline role", async ({ page, context }) => {
      await authenticate(page);
      const external: string[] = [];
      page.on("request", request => { if (!new URL(request.url()).hostname.match(/^(localhost|127\.0\.0\.1)$/)) external.push(request.url()); });
      await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/]).*/, route => route.abort());
      await page.goto("/");
      await expect(page.getByTestId("tab-sale")).toHaveClass(/active/);
      await openAccount(page, width);
      await expect(page.getByTestId("member-role")).toHaveText("Dueño");
      const session = await (await page.request.get("/api/auth/get-session")).json();
      await expect(page.getByTestId("shell-account")).toContainText(session.user.name);
      await expect(page.getByTestId("shell-account")).not.toContainText("Carlos Arango");
      if (width < 768) await page.getByLabel("Cuenta y caja", { exact: true }).click();
      await page.evaluate(async () => {
        await document.fonts.load('600 16px "Plus Jakarta Sans"', "Café, niño, Ő");
        await document.fonts.load('600 16px "JetBrains Mono"', "Café, niño, Ő");
        await document.fonts.ready;
      });
      expect(await page.evaluate(() => [...document.fonts].filter(font => font.status === "loaded").map(font => font.family))).toEqual(expect.arrayContaining(["Plus Jakarta Sans", "JetBrains Mono"]));
      // Self-hosted faces must carry the full design-rules weight ranges, not
      // a single static weight that the browser would fake-bold.
      const faces = await page.evaluate(() => [...document.fonts].filter(f => f.status === "loaded").map(f => ({ family: f.family, weight: f.weight })));
      expect(faces).toEqual(expect.arrayContaining([
        { family: "Plus Jakarta Sans", weight: "300 800" },
        { family: "JetBrains Mono", weight: "400 600" },
      ]));
      // Spanish glyphs resolve through the loaded local files (no fallback).
      expect(await page.evaluate(() => document.fonts.check('700 16px "Plus Jakarta Sans"', "Café ñ Ñ Ő"))).toBe(true);
      expect(external).toEqual([]);
      await expect(page.getByTestId("shell-shift")).not.toContainText("Consultando");
      await page.screenshot({ path: `${evidence}/m4-${width}-shell.png`, fullPage: true });
      if (width === 1440) {
        expect((await page.locator(".shell-sidebar").boundingBox())?.width).toBe(256);
        expect((await page.locator(".app-header").boundingBox())?.height).toBe(64);
        const before = await page.locator(".shell-clock").innerText();
        await expect.poll(() => page.locator(".shell-clock").innerText()).not.toBe(before);
      } else expect((await page.locator(".shell-sidebar").boundingBox())!.height).toBeLessThan(90);
      for (const tab of ["sale", "arqueo", "tickets", "catalog", "dashboard", "reports", "credito"]) {
        await page.getByTestId(`tab-${tab}`).click();
        await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-current", "page");
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      }
      await expect(page.getByTestId("customer-accounts")).toContainText("Todavía no hay clientes activos");
      await page.getByTestId("notifications").click();
      await expect(page.getByTestId("notification-panel")).toContainText("Sin alertas");
      await expect(page.getByTestId("notification-count")).toHaveCount(0);
      await page.keyboard.press("Control+k");
      await expect(page.getByTestId("palette-input")).toHaveCount(0);
      await page.screenshot({ path: `${evidence}/m4-${width}-empty-alerts.png`, fullPage: true });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("notifications")).toBeFocused();
      await page.keyboard.press("Control+k");
      await page.getByTestId("palette-input").fill("Clientes");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("tab-credito")).toHaveClass(/active/);
      await context.setOffline(true);
      await openAccount(page, width);
      await expect(page.getByTestId("member-role")).toHaveText("Dueño");
      await page.screenshot({ path: `${evidence}/m4-${width}-offline-account.png`, fullPage: true });
    });

    test("real payment and threshold alerts navigate with context; poison retry preserves data; toast pauses and closes", async ({ page }) => {
      const org = await authenticate(page);
      const product = await page.request.post("/api/catalog/products", { data: { name: "Café ñ", icon_key: "coffee", variant: { name: "Único", price: 3000, stock: 8, low_stock_threshold: 9 } } });
      expect(product.status()).toBe(201);
      dbOne(`UPDATE product_variants SET low_stock_threshold=9 WHERE tenant_id='${org}'`);
      dbOne(`INSERT INTO tickets (id,tenant_id,client_uuid,ticket_no,status,total) VALUES ('11111111-1111-4111-8111-111111111111','${org}','11111111-1111-4111-8111-111111111111',901,'transfer_pending',3000), ('22222222-2222-4222-8222-222222222222','${org}','22222222-2222-4222-8222-222222222222',902,'transfer_pending',3000)`);
      dbOne(`INSERT INTO payments (id,tenant_id,client_uuid,ticket_id,method,amount,status) SELECT gen_random_uuid(),'${org}',gen_random_uuid(),id,'transfer',3000,'pending' FROM tickets WHERE tenant_id='${org}'`);
      await page.goto("/");
      await expect(page.getByTestId("notification-count")).toHaveText("3");
      await page.getByTestId("notifications").click();
      await expect(page.locator(".notification-action")).toHaveCount(3);
      await page.screenshot({ path: `${evidence}/m4-${width}-alerts.png`, fullPage: true });
      await page.getByRole("button", { name: /Transferencia pendiente · #901/ }).click();
      await expect(page.getByTestId("ticket-detail")).toContainText("#901");
      await page.getByTestId("receipt-close").click();
      await page.getByTestId("notifications").click();
      await page.getByRole("button", { name: /Stock bajo · Café ñ/ }).click();
      await expect(page.getByTestId("tab-catalog")).toHaveClass(/active/);
      await expect(page.getByTestId("product-item").filter({ hasText: "Café ñ" })).toContainText("Único");
      await expect(page.getByTestId("product-modal")).toBeVisible();
      await page.getByRole("button", { name: "Cancelar", exact: true }).click();
      await page.getByTestId("product-new").click();
      await page.getByTestId("product-name").fill("Guardado local");
      await page.getByTestId("variant-name").fill("Único");
      await page.getByTestId("variant-price").fill("1000");
      await page.getByTestId("variant-stock").fill("20");
      await page.getByTestId("product-create").click();
      const toast = page.getByTestId("toast");
      await expect(toast).toHaveClass(/toast-success/);
      await expect(toast).toContainText("pendiente de sync");
      await toast.getByLabel("Cerrar aviso").focus();
      await page.waitForTimeout(3700); // proves focus pauses the 3500ms lifetime
      await expect(toast).toBeVisible();
      await toast.getByLabel("Cerrar aviso").click();
      await expect(toast).toHaveCount(0);
      await page.evaluate(async () => {
        const { getLocalDb } = await import("/src/db/instance.ts");
        const { refreshSyncStatus } = await import("/src/sync/queue.ts");
        const h = (await getLocalDb())!;
        const { activeOrgId, authClient } = await import("/src/auth.ts");
        const tenantId = activeOrgId((await authClient.getSession()).data)!;
        await h.db.query("UPDATE sync_log SET status='poison',attempts=3 WHERE entity='product' AND tenant_id=$1", [tenantId]);
        await refreshSyncStatus(h.db, tenantId);
      });
      await expect(page.getByTestId("sync-poison")).toBeVisible();
      await page.getByTestId("notifications").click();
      await page.getByRole("button", { name: /cambios requieren revisión · Reintentar tras corregir/ }).click();
      await expect(page.getByTestId("sync-poison")).toHaveCount(0);
      await expect(page.getByTestId("notification-panel")).not.toBeVisible();
      await expect.poll(() => dbOne(`SELECT count(*) FROM products WHERE tenant_id='${org}' AND name='Guardado local'`)).toBe("1");
    });
  });

  /* ── M5 (12.1–12.5): POS grilla, modal de cobro, recibo e historial ── */
  test.describe(`M5 flow ${width}`, () => {
    test.use({ viewport: { width, height: 1000 } });

    test("POS grid: category chips AND search, SKU hit, empty state, long name", async ({ page }) => {
      await authenticate(page);
      /* categories are NOT part of the hermetic wipe (M4 keeps them) —
       * clear them here so this seed is deterministic across runs
       * (categories_tenant_name_uq rejects duplicate names). */
      dbOne("DELETE FROM categories");
      const cat1 = await (await page.request.post("/api/catalog/categories", { data: { name: "Bebidas" } })).json();
      const cat2 = await (await page.request.post("/api/catalog/categories", { data: { name: "Snacks" } })).json();
      expect((await page.request.post("/api/catalog/products", { data: { name: "Café M5", category_id: cat1.category.id, variant: { name: "250g", price: 12000, stock: 15, code: "BEB-001" } } })).status()).toBe(201);
      expect((await page.request.post("/api/catalog/products", { data: { name: "Papas M5", category_id: cat2.category.id, variant: { name: "Sal", price: 4500, stock: 28, code: "SNK-010" } } })).status()).toBe(201);
      expect((await page.request.post("/api/catalog/products", { data: { name: "Producto con un nombre extremadamente largo para verificar que la grilla del POS no se rompe ni desborda el layout", variant: { name: "Único", price: 9900, stock: 3 } } })).status()).toBe(201);

      await page.goto("/");
      await expect(page.getByTestId("tab-sale")).toHaveClass(/active/);
      await expect(page.getByTestId("sale-item")).toHaveCount(3);
      await expect(page.getByTestId("category-chip-all")).toBeVisible();
      await expect(page.getByTestId("category-chip")).toHaveCount(2);
      /* grid follows design-rules posColumns: 2 base / 3 sm / 4 xl */
      const cols = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="sale-grid"]')!).gridTemplateColumns.split(" ").length);
      expect(cols).toBe(width >= 1280 ? 4 : width >= 640 ? 3 : 2);

      /* category filter ANDs with the search; «Todos» keeps the search text */
      await page.getByTestId("category-chip").filter({ hasText: "Bebidas" }).click();
      await expect(page.getByTestId("sale-item")).toHaveCount(1);
      await expect(page.getByTestId("sale-item")).toContainText("Café M5");
      await page.getByTestId("sale-search").fill("SNK-010");
      await expect(page.getByTestId("sale-item")).toHaveCount(0);
      await expect(page.getByTestId("empty-sale-search")).toBeVisible();
      await page.getByTestId("category-chip-all").click();
      await expect(page.getByTestId("sale-item")).toHaveCount(1);
      await expect(page.getByTestId("sale-search")).toHaveValue("SNK-010");

      /* SKU search finds the right variant; empty search has an empty state */
      await page.getByTestId("sale-search").fill("BEB-001");
      await expect(page.getByTestId("sale-item")).toHaveCount(1);
      await page.getByTestId("sale-search").fill("zzz-no-existe");
      await expect(page.getByTestId("empty-sale-search")).toBeVisible();
      await page.getByTestId("sale-search").fill("");
      await expect(page.getByTestId("sale-item")).toHaveCount(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: `${evidence}/m5-${width}-pos-grid.png`, fullPage: true });
    });

    test("payment modal 3 states, receipt print/CSS, tickets table filters + preview", async ({ page }) => {
      await authenticate(page);
      /* seed a product + an over-limit customer (rehydrate pulls both) */
      expect((await page.request.post("/api/catalog/products", { data: { name: "Cobro M5", variant: { name: "Único con nombre de variante deliberadamente largo para el recibo térmico", price: 12000, stock: 5 } } })).status()).toBe(201);
      const org = dbOne("SELECT id FROM organization WHERE slug='tienda-demo'");
      dbOne(`INSERT INTO customers (id,tenant_id,client_uuid,name,credit_limit,active) VALUES (gen_random_uuid(),'${org}',gen_random_uuid(),'Cliente Límite',5000,TRUE)`);

      await page.goto("/");
      await page.getByTestId("tab-sale").click();
      await page.getByTestId("sale-item").filter({ hasText: "Cobro M5" }).click();
      await page.getByTestId("checkout-open").click();
      await expect(page.getByTestId("payment-modal")).toBeVisible();

      /* state 1 — efectivo: empty tendered + presets + change */
      await expect(page.getByTestId("checkout-total")).toContainText("12.000");
      await expect(page.getByTestId("tendered")).toHaveValue("");
      await expect(page.getByTestId("quick-cash-exact")).toBeVisible();
      await page.screenshot({ path: `${evidence}/m5-${width}-payment-cash.png`, fullPage: true });

      /* state 2 — transferencia: honest pending note, no cash controls */
      await page.getByTestId("pay-transfer").click();
      await expect(page.getByTestId("transfer-note")).toBeVisible();
      await expect(page.getByTestId("tendered")).toHaveCount(0);
      await page.screenshot({ path: `${evidence}/m5-${width}-payment-transfer.png`, fullPage: true });

      /* state 3 — fiado: required picker + amber note + limit BLOCK */
      await page.getByTestId("pay-fiado").click();
      await expect(page.getByTestId("fiado-section")).toBeVisible();
      await expect(page.getByTestId("fiado-note")).toBeVisible();
      await page.getByTestId("fiado-client").selectOption({ index: 1 });
      await expect(page.getByTestId("credit-limit-note")).toContainText("excede su límite de crédito");
      await expect(page.getByTestId("checkout-confirm")).toBeDisabled();
      await page.screenshot({ path: `${evidence}/m5-${width}-payment-fiado.png`, fullPage: true });

      /* cancel keeps the cart — reopen and complete a cash sale */
      await page.getByTestId("checkout-cancel").click();
      await expect(page.getByTestId("payment-modal")).toBeHidden();
      await expect(page.getByTestId("cart-total")).toContainText("12.000");
      await page.getByTestId("checkout-open").click();
      await page.getByTestId("quick-cash-exact").click();
      /* double-click gate (12.2): two synchronous clicks → ONE commit */
      await page.evaluate(() => {
        const btn = document.querySelector<HTMLButtonElement>('[data-testid="checkout-confirm"]');
        btn?.click();
        btn?.click();
      });
      await expect(page.getByTestId("sale-success")).toBeVisible();
      await expect
        .poll(() => dbOne("SELECT count(*) FROM tickets"), { timeout: 15_000 })
        .toBe("1");

      /* receipt: real data + REAL print path + 58/80 CSS (no printer claim) */
      await expect(page.getByTestId("receipt-preview")).toBeVisible();
      await expect(page.getByTestId("ticket-detail")).toContainText("#1");
      await expect(page.getByTestId("ticket-detail")).not.toContainText("IVA");
      await page.evaluate(() => {
        const w = window as unknown as { __prints: number; print: () => void };
        w.__prints = 0;
        w.print = () => { w.__prints += 1; };
      });
      await page.getByTestId("receipt-print").click();
      expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);
      const printRules = await page.evaluate(() => {
        let hits = 0;
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList;
          try { rules = sheet.cssRules; } catch { continue; }
          for (const rule of Array.from(rules)) {
            if (rule instanceof CSSMediaRule && /print/.test(rule.conditionText ?? rule.media.mediaText)) {
              const text = rule.cssText;
              if (text.includes("receipt-paper") && text.includes("58mm") && text.includes("80mm")) hits += 1;
            }
          }
        }
        return hits;
      });
      expect(printRules).toBeGreaterThan(0);
      await page.getByTestId("receipt-width-58").click();
      expect(await page.locator(".receipt-paper").getAttribute("data-print-width")).toBe("58");
      await page.getByTestId("receipt-width-80").click();
      await page.screenshot({ path: `${evidence}/m5-${width}-receipt.png`, fullPage: true });
      await page.getByTestId("receipt-close").click();

      /* history: prototype table + separated filters + preview + actions */
      await page.getByTestId("tab-tickets").click();
      await expect(page.getByTestId("tickets-table")).toBeVisible();
      const row = page.getByTestId("ticket-item").first();
      await expect(row).toContainText("#1");
      await expect(row).toContainText("Pagada");
      await expect(row).toContainText("Efectivo");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: `${evidence}/m5-${width}-tickets.png`, fullPage: true });

      /* status filter (separated from method) */
      await page.getByTestId("filter-status").selectOption("voided");
      await expect(page.getByTestId("no-ticket-results")).toBeVisible();
      await page.getByTestId("filter-status").selectOption("active");
      await expect(page.getByTestId("ticket-item")).toHaveCount(1);
      /* method filter: cash hits, credit does not (this sale is cash) */
      await page.getByTestId("filter-method").selectOption("credit");
      await expect(page.getByTestId("no-ticket-results")).toBeVisible();
      await page.getByTestId("filter-method").selectOption("cash");
      await expect(page.getByTestId("ticket-item")).toHaveCount(1);
      await page.getByTestId("filter-method").selectOption("all");
      /* search by product name */
      await page.getByTestId("ticket-search").fill("Cobro M5");
      await expect(page.getByTestId("ticket-item")).toHaveCount(1);
      await page.getByTestId("ticket-search").fill("zzz");
      await expect(page.getByTestId("no-ticket-results")).toBeVisible();
      await page.getByTestId("ticket-search").fill("");

      /* preview from the row → shared receipt + auditable actions */
      await row.click();
      await expect(page.getByTestId("ticket-detail")).toContainText("#1");
      await expect(page.getByTestId("void-sale")).toBeEnabled();
      await expect(page.getByTestId("receipt-close")).toBeEnabled();
      await page.screenshot({ path: `${evidence}/m5-${width}-tickets-preview.png`, fullPage: true });
      await page.getByTestId("receipt-close").click();
      await expect(page.getByTestId("receipt-preview")).toHaveCount(0);
    });
  });
}

test("unknown membership never displays owner; tenant change discards prior cached owner", async ({ page }) => {
  await authenticate(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("member-role")).toHaveText("Dueño");
  const other = await page.request.post("/api/auth/organization/create", { data: { name: "Otro tenant M4", slug: `m4-${Date.now()}` } });
  const next = await other.json();
  expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: next.id } })).ok()).toBe(true);
  await page.route("**/api/auth/organization/get-active-member-role**", route => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ message: "membership unavailable" }) }));
  await page.reload();
  await expect(page.getByTestId("member-role")).toHaveText("Rol sin verificar");
  expect(await page.evaluate(() => sessionStorage.getItem("pos:member-role"))).toBeNull();
});

for (const width of [1440, 375]) {
  test(`M9 cross-view/modal matrix ${width}: keyboard isolation, searchable credit, immutable collections and real detail`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const tenant = await authenticate(page);
    dbOne(`UPDATE shifts SET status='closed' WHERE tenant_id='${tenant}'`);
    const shift = randomUUID(), customer = randomUUID(), first = randomUUID(), second = randomUUID();
    dbOne(`INSERT INTO shifts(id,tenant_id,client_uuid,status,calculation_version,opening_cash) VALUES('${shift}','${tenant}','${shift}','open','drawer_cash_v2',10000)`);
    dbOne(`INSERT INTO customers(id,tenant_id,client_uuid,name,phone,credit_limit) SELECT gen_random_uuid(),'${tenant}',gen_random_uuid(),'A cliente ' || n,'300111' || n,100000 FROM generate_series(1,21) n`);
    dbOne(`INSERT INTO customers(id,tenant_id,client_uuid,name,phone,credit_limit) VALUES('${customer}','${tenant}','${customer}','Z Doña María con nombre largo para verificar el detalle de cuenta y su retorno de foco','+57 300 999 8877',100000)`);
    for (const [id, no, total, credit] of [[first, 901, 45000, 35000], [second, 902, 18000, 18000]] as const) {
      dbOne(`INSERT INTO tickets(id,tenant_id,client_uuid,shift_id,ticket_no,total,status,customer_id) VALUES('${id}','${tenant}','${id}','${shift}',${no},${total},'completed','${customer}'); INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,shift_id,method,amount,status) VALUES(gen_random_uuid(),'${tenant}',gen_random_uuid(),'${id}','${shift}','credit',${credit},'confirmed')`);
    }
    dbOne(`INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,shift_id,method,amount,status) VALUES(gen_random_uuid(),'${tenant}',gen_random_uuid(),'${first}','${shift}','cash',10000,'confirmed'); INSERT INTO credit_abonos(id,tenant_id,client_uuid,customer_id,shift_id,ticket_id,amount,method) VALUES(gen_random_uuid(),'${tenant}',gen_random_uuid(),'${customer}','${shift}','${first}',10000,'cash'),(gen_random_uuid(),'${tenant}',gen_random_uuid(),'${customer}','${shift}',NULL,5000,'transfer')`);
    expect((await page.request.post("/api/catalog/products", { data: { name: "Café M9 ñ", variant: { name: "Único", price: 12000, stock: 20, cost: 5000 } } })).status()).toBe(201);
    const external: string[] = [];
    page.on("request", r => { if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(r.url()).hostname)) external.push(r.url()); });
    await page.route(/^https?:\/\/(?!localhost[:/]|127\.0\.0\.1[:/]).*/, r => r.abort());
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    // Wait for rehydrate so the POS screenshot shows the real grid, not the
    // boot-race empty state (the product was created via API above).
    await expect(page.getByTestId("sale-item")).toHaveCount(1);
    for (const tab of ["sale", "arqueo", "tickets", "catalog", "dashboard", "reports", "credito"]) {
      await page.getByTestId(`tab-${tab}`).click();
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute("aria-current", "page");
      if (tab === "arqueo") await expect(page.locator(".cash-screen")).toHaveAttribute("aria-busy", "false");
      if (tab === "tickets") await expect(page.getByTestId("ticket-item")).toHaveCount(2);
      if (tab === "catalog") await expect(page.getByTestId("product-item")).toHaveCount(1);
      if (tab === "dashboard") await expect(page.getByTestId("kpi-revenue")).toContainText("63.000");
      if (tab === "reports") await expect(page.getByTestId("sales-total")).toContainText("63.000");
      if (tab === "credito") await expect(page.getByTestId("client-card")).toHaveCount(22);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.screenshot({ path: `${evidence}/m9-${width}-view-${tab}.png` });
    }
    await page.getByTestId("client-new").click();
    await modalKeyboard(page, "client-modal", "client-new", width);
    const card = page.getByTestId("client-card").filter({ hasText: "Z Doña" });
    await card.getByTestId("client-detail").click();
    await expect(page.getByTestId("detail-balance")).toContainText("38.000");
    const detail = page.getByTestId("detail-tickets");
    await expect(detail.locator("li").filter({ hasText: "#901" })).toContainText("Crédito: $ 35.000 · Abonos aplicados: $ 10.000 · Total venta: $ 45.000");
    await expect(page.getByTestId("detail-abonos")).toContainText("ticket #901");
    await expect(page.getByTestId("detail-abonos")).toContainText("cliente (sin aplicar)");
    await page.screenshot({ path: `${evidence}/m9-${width}-account-detail.png` });
    await page.keyboard.press("Escape");
    await card.getByTestId("client-abono").click();
    // This is the only debt-bearing account, so its trigger is unambiguous.
    await modalKeyboard(page, "abono-modal", "client-abono", width);
    await page.getByTestId("tab-arqueo").click();
    await page.getByTestId("cash-movement-open").click();
    await modalKeyboard(page, "cash-movement-modal", "cash-movement-open", width);
    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-new").click();
    await modalKeyboard(page, "product-modal", "product-new", width);
    await page.getByTestId("tab-sale").click();
    await page.getByTestId("sale-item").first().click();
    await page.getByTestId("sale-search").focus();
    await page.keyboard.press("Control+k");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.getByTestId("palette-input").fill("901");
    await expect(page.getByTestId("palette-item").filter({ hasText: "#901" })).toContainText("Mixto (efectivo + crédito)");
    await page.getByTestId("palette-input").fill("902");
    await expect(page.getByTestId("palette-item").filter({ hasText: "#902" })).toContainText("Crédito");
    await page.getByTestId("palette-input").fill("");
    await page.keyboard.press("F1");
    await page.keyboard.press("F2");
    await expect(page.getByTestId("payment-modal")).toBeHidden();
    for (let n = 0; n < 12; n++) {
      await page.keyboard.press("Tab");
      expect(await page.getByTestId("palette-backdrop").evaluate(el => document.activeElement === document.body || el.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sale-search")).toBeFocused();
    await page.getByTestId("checkout-open").click();
    await modalKeyboard(page, "payment-modal", "checkout-open", width);
    await page.getByTestId("checkout-open").click();
    await page.getByTestId("tendered").fill("12000.5");
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("cart-error")).toContainText("entero COP");
    await page.getByTestId("pay-fiado").click();
    // M9 defect fix: a cash validation error must not stay visible after
    // switching to the Fiado method (stale cross-method error).
    await expect(page.getByTestId("cart-error")).toHaveCount(0);
    await page.getByTestId("fiado-search").fill("maria");
    await expect(page.getByTestId("fiado-client").locator("option")).toHaveCount(2);
    await expect(page.getByTestId("fiado-client")).toContainText("+57 300 999 8877");
    await page.getByTestId("fiado-client").selectOption(customer);
    await page.screenshot({ path: `${evidence}/m9-${width}-searchable-fiado.png` });
    await page.getByTestId("fiado-search").fill("300999");
    await expect(page.getByTestId("fiado-client")).toHaveValue("");
    await page.getByTestId("fiado-client").selectOption(customer);
    for (const value of ["-500", "1000.5", "1000,5", "2147483648"]) {
      await page.getByTestId("fiado-cash").fill(value);
      await expect(page.getByTestId("fiado-cash")).toHaveValue(value);
      await expect(page.getByTestId("checkout-confirm")).toBeDisabled();
    }
    // M9 defect fix: the derived credit line must never render a negative
    // amount while the mixed-cash input is invalid.
    await expect(page.getByTestId("fiado-account")).toContainText(
      "Crédito en esta venta —",
    );
    await page.getByTestId("fiado-new-toggle").click();
    await page.getByTestId("fiado-new-name").fill("No convertir el límite");
    for (const value of ["-5", "1.5", "1,5", "2147483648"]) {
      await page.getByTestId("fiado-new-limit").fill(value);
      await page.getByTestId("fiado-new-save").click();
      await expect(page.getByTestId("fiado-new-error")).toBeVisible();
    }
    expect(dbOne("SELECT count(*) FROM customers WHERE name='No convertir el límite'")).toBe("0");
    await page.screenshot({ path: `${evidence}/m9-${width}-invalid-money.png` });
    await page.getByTestId("checkout-cancel").click();
    await page.keyboard.press("F1");
    await page.keyboard.press("F3");
    await expect(page.getByTestId("pay-cash")).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("receipt-preview")).toBeVisible();
    const ticketsAfterSale = dbOne("SELECT count(*) FROM tickets");
    await page.keyboard.press("F1");
    await page.keyboard.press("F2");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("payment-modal")).toBeHidden();
    expect(dbOne("SELECT count(*) FROM tickets")).toBe(ticketsAfterSale);
    await expect(page.getByTestId("receipt-preview")).not.toContainText(/IVA|NIT|Carlos Arango/);
    await page.screenshot({ path: `${evidence}/m9-${width}-receipt.png` });
    await page.keyboard.press("Escape");
    await page.getByTestId("view-receipt").click();
    await modalKeyboard(page, "receipt-preview", "view-receipt", width);
    await page.getByTestId("tab-tickets").click();
    await page.getByTestId("ticket-item").filter({ hasText: "#901" }).getByTestId("ticket-preview").click();
    await expect(page.getByTestId("void-sale")).toBeDisabled();
    await expect(page.getByTestId("void-abonos-note")).toContainText("abonos registrados");
    const beforeVoid = dbOne("SELECT json_agg(a ORDER BY id)::text FROM credit_abonos a");
    const blocked = await page.request.post(`/api/sales/tickets/${first}/void`, { data: { reason: "Bloqueo cliente con abonos" } });
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toEqual({ error: "abonos_exist" });
    expect(dbOne("SELECT json_agg(a ORDER BY id)::text FROM credit_abonos a")).toBe(beforeVoid);
    expect(external).toEqual([]);
  });
}

for (const width of [1440, 375]) {
  test.describe(`M7 analytical gate ${width}`, () => {
    test.use({ viewport: { width, height: 1000 } });
    test("real KPI periods, applied range, XLSX cells, corte, invalid/empty/offline/error", async ({ page, context }) => {
      const tenant = await authenticate(page);
      await page.clock.setFixedTime(new Date("2026-11-03T18:00:00Z"));
      const customer = randomUUID(), tx = randomUUID(), ty = randomUUID();
      expect((await page.request.post("/api/catalog/products", { data: { name: "Café analítico", variant: { name: "Único", price: 35000, stock: 3, cost: 4000 } } })).status()).toBe(201);
      const variant = dbOne(`SELECT id FROM product_variants WHERE tenant_id='${tenant}' LIMIT 1`);
      dbOne(`INSERT INTO customers(id,tenant_id,client_uuid,name,credit_limit) VALUES('${customer}','${tenant}','${customer}','Cliente analítico',100000);
        INSERT INTO tickets(id,tenant_id,client_uuid,ticket_no,status,total,customer_id,created_at) VALUES
        ('${tx}','${tenant}','${tx}',701,'completed',35000,'${customer}','2026-11-03T15:00:00Z'),
        ('${ty}','${tenant}','${ty}',702,'completed',30000,'${customer}','2026-11-03T16:00:00Z');
        INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,method,amount,status,created_at) VALUES
        (gen_random_uuid(),'${tenant}',gen_random_uuid(),'${tx}','credit',35000,'confirmed','2026-11-03T15:00:00Z'),
        (gen_random_uuid(),'${tenant}',gen_random_uuid(),'${ty}','cash',10000,'confirmed','2026-11-03T16:00:00Z'),
        (gen_random_uuid(),'${tenant}',gen_random_uuid(),'${ty}','credit',20000,'confirmed','2026-11-03T16:00:00Z');
        INSERT INTO ticket_lines(id,tenant_id,client_uuid,ticket_id,variant_id,qty,unit_price,subtotal,unit_cost) VALUES
        (gen_random_uuid(),'${tenant}',gen_random_uuid(),'${tx}','${variant}',1,35000,35000,4000),
        (gen_random_uuid(),'${tenant}',gen_random_uuid(),'${ty}','${variant}',1,30000,30000,4000);
        INSERT INTO credit_abonos(id,tenant_id,client_uuid,customer_id,amount,method,created_at) VALUES
        (gen_random_uuid(),'${tenant}',gen_random_uuid(),'${customer}',5000,'cash','2026-11-03T17:00:00Z'),
        (gen_random_uuid(),'${tenant}',gen_random_uuid(),'${customer}',3000,'transfer','2026-11-03T17:00:00Z');`.replace(/\n/g, " "));
      await page.goto("/");
      await page.getByTestId("tab-dashboard").click();
      await expect(page.getByTestId("period-today")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("kpi-revenue")).toContainText("65.000");
      await expect(page.getByTestId("kpi-credit")).toContainText("55.000");
      await expect(page.getByTestId("kpi-abonos")).toContainText("8.000");
      await expect(page.getByTestId("kpi-cash")).toContainText("10.000");
      await expect(page.getByTestId("kpi-delta")).toContainText("sin dato previo");
      await expect(page.getByTestId("dash-hours")).toBeVisible();
      await expect(page.getByTestId("dash-top")).toContainText("2 ud");
      await page.screenshot({ path: `${evidence}/m7-${width}-dashboard.png`, fullPage: true });
      await page.getByTestId("dash-hours").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/m7-${width}-dashboard-details.png`, fullPage: true });
      await page.getByTestId("period-month").click();
      await expect(page.getByTestId("period-label")).toContainText("2026-11-01 — 2026-11-03");
      await expect(page.getByTestId("period-label")).toContainText("2026-10-01 — 2026-10-03");
      await page.getByTestId("period-7d").click();
      await expect(page.getByTestId("period-label")).toContainText("2026-10-28 — 2026-11-03");
      await page.getByTestId("tab-reports").click();
      await expect(page.getByTestId("sales-total")).toContainText("65.000");
      await page.getByTestId("report-from").fill("2026-11-03");
      await page.getByTestId("report-to").fill("2026-11-03");
      await page.getByTestId("report-apply").click();
      await expect(page.getByTestId("report-applied")).toContainText("2026-11-03 — 2026-11-03");
      await expect(page.getByTestId("report-count")).toHaveText("1 registros");
      await expect(page.getByTestId("sales-credit-total")).toContainText("55.000");
      await expect(page.getByTestId("sales-abonos-total")).toContainText("8.000");
      await page.screenshot({ path: `${evidence}/m7-${width}-reports.png`, fullPage: true });
      // Edit a valid empty range but do NOT apply: all outputs still use Nov3.
      await page.getByTestId("report-from").fill("2026-11-04");
      await page.getByTestId("report-to").fill("2026-11-04");
      await expect(page.getByTestId("report-draft")).toBeVisible();
      const downloadEvent = page.waitForEvent("download");
      await page.getByTestId("export-excel").click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toBe("nexora-ventas-2026-11-03_2026-11-03.xlsx");
      const book = XLSX.read(await readFile((await download.path())!), { type: "buffer" });
      const rows = XLSX.utils.sheet_to_json(book.Sheets.Ventas, { header: 1 }) as (string | number)[][];
      expect(rows).toEqual([
        ["Fecha", "Tickets", "Efectivo", "Transferencia", "Crédito", "Abonos (cobros)", "Pendiente", "Ingresos"],
        ["2026-11-03", 2, 10000, 0, 55000, 8000, 0, 65000],
        ["TOTAL", 2, 10000, 0, 55000, 8000, 0, 65000],
      ]);
      await download.saveAs(`${evidence}/m7-${width}-${download.suggestedFilename()}`);
      await page.evaluate(() => { window.print = () => { document.body.dataset.printCalled = String(document.body.classList.contains("printing-corte")); }; });
      await page.getByTestId("corte-print").click();
      expect(await page.locator("body").getAttribute("data-print-called")).toBe("true");
      const corte = page.getByTestId("print-corte");
      await expect(corte).toContainText("3/11/2026 — 3/11/2026");
      for (const [label, amount] of [["Crédito", "55.000"], ["Abonos (cobros)", "8.000"], ["Ingresos", "65.000"]]) {
        await expect(corte.locator(".pc-row").filter({ hasText: label })).toContainText(amount);
      }
      await page.evaluate(() => document.body.classList.add("printing-corte"));
      await page.emulateMedia({ media: "print" });
      await expect(corte).toBeVisible();
      await expect(page.locator("#root")).toBeHidden();
      expect(await corte.locator("td").first().evaluate(el => getComputedStyle(el).display)).toBe("flex");
      await page.screenshot({ path: `${evidence}/m7-${width}-corte.png`, fullPage: true });
      await page.emulateMedia({ media: "screen" });
      await page.evaluate(() => document.body.classList.remove("printing-corte"));
      await page.getByTestId("report-from").fill("2026-11-05");
      await page.getByTestId("report-apply").click();
      await expect(page.locator("#report-range-error")).toBeVisible();
      await expect(page.getByTestId("sales-total")).toContainText("65.000");
      await page.screenshot({ path: `${evidence}/m7-${width}-invalid-range.png`, fullPage: true });
      await context.setOffline(true);
      await expect(page.getByTestId("reports-staleness")).toBeVisible();
      await page.getByTestId("report-from").fill("2026-11-04");
      await page.getByTestId("report-apply").click();
      await expect(page.getByTestId("empty-sales")).toBeVisible();
      await expect(page.getByTestId("report-count")).toHaveText("0 registros");
      await expect(page.getByTestId("export-excel")).toBeDisabled();
      await expect(page.getByTestId("corte-print")).toBeDisabled();
      await page.screenshot({ path: `${evidence}/m7-${width}-empty-offline.png`, fullPage: true });
      // Inject one local query failure, then retry: no incorrect applied label
      // or stale-data export after failure. Restore DB method before retry.
      await page.evaluate(async () => {
        const { getLocalDb } = await import("/src/db/instance.ts");
        const { db } = (await getLocalDb())!;
        const query = db.query.bind(db);
        let fail = true;
        db.query = (...args: Parameters<typeof db.query>) => {
          if (fail && String(args[0]).includes("WITH p AS")) { fail = false; return Promise.reject(new Error("M7 query failure")); }
          return query(...args);
        };
      });
      await page.getByTestId("report-from").fill("2026-11-03");
      await page.getByTestId("report-to").fill("2026-11-03");
      await page.getByTestId("report-apply").click();
      await expect(page.getByTestId("reports-error")).toBeVisible();
      await expect(page.getByTestId("report-applied")).toContainText("2026-11-04 — 2026-11-04");
      await expect(page.getByTestId("export-excel")).toBeDisabled();
      await page.getByTestId("report-apply").click();
      await expect(page.getByTestId("sales-total")).toContainText("65.000");
      await expect(page.getByTestId("reports-error")).toHaveCount(0);
      // Visible loading gate: delay the local query and ensure neither
      // duplicate Apply nor exports can race a new calculation.
      await page.evaluate(async () => {
        const { getLocalDb } = await import("/src/db/instance.ts");
        const { db } = (await getLocalDb())!;
        const query = db.query.bind(db);
        let delay = true;
        db.query = async (...args: Parameters<typeof db.query>) => {
          if (delay && String(args[0]).includes("WITH p AS")) { delay = false; await new Promise(resolve => setTimeout(resolve, 600)); }
          return query(...args);
        };
      });
      await page.getByTestId("report-apply").click();
      await expect(page.getByTestId("report-loading")).toBeVisible();
      await expect(page.getByTestId("report-apply")).toBeDisabled();
      await expect(page.getByTestId("export-excel")).toBeDisabled();
      await expect(page.getByTestId("corte-print")).toBeDisabled();
      await expect(page.getByTestId("report-loading")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    });
  });
}
