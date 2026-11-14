import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { dbOne } from "./helpers-db";

// Batch 6 regression slice; batch 8 will extend integration coverage.
// All credentials/codes captured here belong ONLY to disposable e2e accounts.
const evidence = "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";
async function tenant(page: Page) {
  const tag = randomUUID();
  expect((await page.request.post("/api/auth/sign-up/email", { data: {
    name: "Dueña de prueba B6", email: `b6-${tag}@test.dev`, password: "batch6-test-only-123",
  } })).ok()).toBe(true);
  const res = await page.request.post("/api/auth/organization/create", { data: { name: "Tienda de prueba B6", slug: `b6-${tag}` } });
  expect(res.ok()).toBe(true);
  const org = (await res.json()).id as string;
  expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: org } })).ok()).toBe(true);
  return org;
}
async function capture(page: Page, width: number, state: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  expect(await page.locator(".app-main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `${evidence}/batch6-${width}-${state}.png`, fullPage: true });
}
async function admin(page: Page) {
  await page.getByTestId("tab-admin").click();
  await expect(page.getByTestId("admin-screen")).toBeVisible();
}

for (const width of [1440, 375]) {
  test.describe(`Batch 6 Administración ${width}`, () => {
    test.use({ viewport: { width, height: 1000 } });
    test("employee lifecycle, tier navigation, session preservation and keyboard modal boundaries", async ({ page, browser }) => {
      const org = await tenant(page);
      const owner = (await (await page.request.get("/api/auth/get-session")).json()).user.id;
      await page.goto("/");
      await expect(page.locator(".tabbar button")).toHaveCount(8);
      await page.keyboard.press("Control+k");
      await page.getByTestId("palette-input").fill("Administración");
      await expect(page.getByTestId("palette-item")).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("admin-screen")).toBeVisible();
      await expect(page.getByTestId("admin-empty-sales")).toBeVisible();
      await expect(page.getByRole("tablist", { name: "Administración" }).getByRole("tab")).toHaveCount(4);
      await expect(page.getByTestId("admin-screen")).not.toContainText("Cuentas por Pagar");
      await page.getByTestId("admin-tab-empleados").click();
      await expect(page.getByTestId("admin-member")).toHaveCount(1);
      await expect(page.getByTestId("admin-member").first()).toContainText("Dueño");
      await expect(page.getByTestId("admin-member").first().locator("select,button")).toHaveCount(0);
      await capture(page, width, "empleados");
      const trigger = page.getByTestId("admin-user-new");
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Crear usuario", exact: true });
      await expect(page.getByTestId("admin-user-name")).toBeFocused();
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press(i % 3 ? "Tab" : "Shift+Tab");
        expect(await dialog.evaluate(el => document.activeElement === document.body || el.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
      await trigger.click();
      const email = `b6-staff-${randomUUID()}@test.dev`;
      await page.getByTestId("admin-user-name").fill("Ana de prueba B6");
      await page.getByTestId("admin-user-email").fill(email);
      await capture(page, width, "create-user");
      const createResponse = page.waitForResponse(r => r.url().endsWith("/api/admin/users") && r.request().method() === "POST");
      await page.getByTestId("admin-user-submit").click();
      expect((await createResponse).status()).toBe(201);
      const password = await page.getByTestId("admin-generated-password").textContent();
      expect(password!.length).toBeGreaterThanOrEqual(12);
      await capture(page, width, "generated-password");
      expect((await (await page.request.get("/api/auth/get-session")).json()).user.id).toBe(owner);
      await page.getByRole("button", { name: "Ya la guardé" }).click();
      await expect(page.getByTestId("admin-generated-password")).toHaveCount(0);
      await expect(page.getByTestId("admin-member")).toHaveCount(2);
      const row = page.getByTestId("admin-member").filter({ hasText: email });
      const staffContext = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width, height: 1000 } });
      try {
        const staff = await staffContext.newPage();
        await staff.goto("/");
        await staff.getByTestId("login-email").fill(email);
        await staff.getByTestId("login-password").fill(password!);
        await staff.getByTestId("login-submit").click();
        await expect(staff.locator(".tabbar button")).toHaveCount(5);
        await expect(staff.getByTestId("tab-admin")).toHaveCount(0);
        expect((await staff.request.get("/api/admin/members")).status()).toBe(403);
        await row.locator("select").selectOption("admin");
        await expect(row.locator("select")).toBeEnabled();
        await expect(row.locator("select")).toHaveValue("admin");
        await staff.reload();
        await expect(staff.locator(".tabbar button")).toHaveCount(8);
        await expect(staff.getByTestId("tab-admin")).toBeVisible();
        await row.locator("select").selectOption("member");
        await expect(row.locator("select")).toBeEnabled();
        await expect(row.locator("select")).toHaveValue("member");
        await staff.reload();
        await expect(staff.locator(".tabbar button")).toHaveCount(5);
        await row.getByRole("button", { name: "Quitar acceso" }).click();
        await page.getByRole("button", { name: "Cancelar", exact: true }).click();
        await expect(row).toBeVisible();
        await row.getByRole("button", { name: "Quitar acceso" }).click();
        await page.getByTestId("admin-user-submit").click();
        await expect(page.getByTestId("admin-member")).toHaveCount(1);
        const revoked = await staff.request.get("/api/catalog/products");
        expect(revoked.status()).toBe(403); expect(await revoked.json()).toEqual({ error: "no_active_tenant" });
      } finally { await staffContext.close(); }
      // Duplicate-email edge keeps the draft and reports an honest error.
      await trigger.click(); await page.getByTestId("admin-user-name").fill("Duplicado");
      await page.getByTestId("admin-user-email").fill(email);
      await page.getByTestId("admin-user-submit").click();
      await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Ese correo ya tiene una cuenta");
      await expect(page.getByTestId("admin-user-email")).toHaveValue(email);
      await page.keyboard.press("Escape");
      expect((await page.request.get("/api/auth/organization/get-active-member-role")).ok()).toBe(true);
      expect(dbOne(`SELECT count(*) FROM member WHERE "organizationId"='${org}'`)).toBe("1");
    });

    test("real summary/cash snapshots, settings propagation, one-time code and offline read-only", async ({ page, context }) => {
      const org = await tenant(page);
      const closedShift = await page.request.post("/api/shifts/open", { data: { opening_cash: 10000, calculation_version: "drawer_cash_v2" } });
      const closedId = (await closedShift.json()).shift.id;
      const movement = randomUUID();
      dbOne(`INSERT INTO cash_movements(id,tenant_id,client_uuid,shift_id,direction,amount,reason)
        VALUES ('${movement}','${org}','${movement}','${closedId}','in',500,'Reposición de prueba B6')`.replace(/\s+/g, " "));
      expect((await page.request.post(`/api/shifts/${closedId}/close`, { data: { counted: 10500, closing_note: "Cierre de prueba B6" } })).ok()).toBe(true);
      expect((await page.request.post("/api/shifts/open", { data: { opening_cash: 20000, calculation_version: "drawer_cash_v2" } })).ok()).toBe(true);
      expect((await page.request.post("/api/catalog/products", { data: { name: "Producto de prueba B6", variant: { name: "Único", price: 3000, cost: 1000, stock: 2, low_stock_threshold: 3 } } })).ok()).toBe(true);
      const snapshot = dbOne(`SELECT row_to_json(c) FROM closedcash c WHERE tenant_id='${org}'`);
      await page.goto("/");
      await page.getByTestId("sale-item").filter({ hasText: "Producto de prueba B6" }).click();
      await page.keyboard.press("F1"); await page.getByTestId("checkout-confirm").click();
      await expect(page.getByTestId("sale-success")).toBeVisible();
      await page.getByTestId("receipt-close").click();
      await admin(page);
      await expect(page.getByTestId("admin-revenue")).toContainText("3.000");
      await expect(page.getByTestId("admin-screen")).toContainText("Producto de prueba B6");
      await capture(page, width, "resumen");
      await page.getByTestId("admin-tab-resumen").focus();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByTestId("admin-tab-cajas")).toBeFocused();
      await expect(page.getByTestId("admin-cajas")).toContainText("Cierre de prueba B6");
      await expect(page.getByTestId("admin-cajas")).toContainText("20.000");
      await expect(page.getByTestId("admin-cajas")).toContainText("Reposición de prueba B6");
      await expect(page.getByTestId("admin-cajas").locator("button")).toHaveCount(0);
      await capture(page, width, "cajas");
      expect(dbOne(`SELECT row_to_json(c) FROM closedcash c WHERE tenant_id='${org}'`)).toBe(snapshot);
      await page.getByTestId("admin-tab-configuracion").click();
      await page.getByTestId("admin-setting-nit").fill("B6-TEST-NIT");
      await page.getByTestId("admin-setting-ticket_prefix").fill("NX");
      await expect(page.getByTestId("admin-prefix-example")).toHaveText("NX-123");
      await page.getByTestId("admin-setting-iva_pct").fill("19");
      await page.getByTestId("admin-setting-default_credit_limit").fill("150000");
      await page.getByTestId("admin-setting-require_annul_code").check();
      await page.getByTestId("admin-settings-save").click();
      await expect(page.getByTestId("admin-settings-save")).toBeEnabled();
      const settings = await (await page.request.get("/api/settings")).json();
      expect(settings.settings).toMatchObject({ nit: "B6-TEST-NIT", ticket_prefix: "NX", iva_pct: 19, default_credit_limit: 150000, require_annul_code: true });
      await page.getByTestId("admin-setting-enable_fiado").uncheck();
      await page.getByTestId("admin-settings-save").click();
      await expect(page.getByTestId("tab-credito")).toHaveCount(0);
      await page.getByTestId("admin-setting-enable_fiado").check();
      await page.getByTestId("admin-settings-save").click();
      await expect(page.getByTestId("tab-credito")).toHaveCount(1);
      await page.locator(".app-main").evaluate(el => { el.scrollTop = 0; });
      await capture(page, width, "configuracion");
      await page.getByTestId("admin-setting-store_name").fill("Borrador sin guardar");
      await page.getByTestId("admin-code-generate").click();
      await expect(page.getByTestId("admin-generated-code")).toHaveText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
      const first = await page.getByTestId("admin-generated-code").textContent();
      await expect(page.getByTestId("admin-code-status")).toContainText("Vence:");
      await expect(page.getByTestId("admin-setting-store_name")).toHaveValue("Borrador sin guardar");
      await capture(page, width, "code-generated");
      await page.getByTestId("admin-code-generate").click();
      await expect(page.getByTestId("admin-generated-code")).not.toHaveText(first!);
      const rotated = await page.getByTestId("admin-generated-code").textContent();
      const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
      expect(stored.includes(first!)).toBe(false); expect(stored.includes(rotated!)).toBe(false);
      await capture(page, width, "code-rotated");
      await page.getByTestId("admin-tab-resumen").click();
      await page.getByTestId("admin-tab-configuracion").click();
      await expect(page.getByTestId("admin-generated-code")).toHaveCount(0);
      await page.reload(); await admin(page); await page.getByTestId("admin-tab-configuracion").click();
      await expect(page.getByTestId("admin-generated-code")).toHaveCount(0);
      await expect(page.getByTestId("admin-setting-nit")).toHaveValue("B6-TEST-NIT");
      await capture(page, width, "code-hidden");
      await page.getByTestId("tab-tickets").click();
      await page.getByTestId("ticket-preview").first().click();
      await expect(page.getByTestId("receipt-nit")).toHaveText("NIT: B6-TEST-NIT");
      await expect(page.getByTestId("receipt-preview")).toContainText("NX-1");
      await expect(page.getByTestId("receipt-preview")).not.toContainText(/IVA|19%/i);
      await page.getByTestId("receipt-close").click();
      expect(dbOne(`SELECT ticket_no FROM tickets WHERE tenant_id='${org}'`)).toBe("1");
      await admin(page); await page.getByTestId("admin-tab-empleados").click();
      await context.setOffline(true);
      await expect(page.getByTestId("admin-employees-offline")).toBeVisible();
      await page.getByTestId("admin-tab-configuracion").click();
      await expect(page.getByTestId("admin-settings-offline")).toBeVisible();
      await expect(page.getByTestId("admin-setting-nit")).toHaveValue("B6-TEST-NIT");
      await expect(page.getByTestId("admin-setting-nit")).toBeDisabled();
      await expect(page.getByTestId("admin-settings-save")).toBeDisabled();
      await expect(page.getByTestId("admin-code-generate")).toBeDisabled();
      await capture(page, width, "offline-settings");
      await context.setOffline(false);
      await expect(page.getByTestId("admin-setting-nit")).toBeEnabled();
      await page.getByTestId("admin-setting-nit").fill("Borrador no cacheado");
      await context.setOffline(true);
      await expect(page.getByTestId("admin-setting-nit")).toBeDisabled();
      await expect(page.getByTestId("admin-setting-nit")).toHaveValue("B6-TEST-NIT");
      await context.setOffline(false);
    });
  });
}

test("Batch 6 Resumen wires positive balances, pending transfers, recent voids and period fixtures", async ({ page }) => {
  const org = await tenant(page);
  const customer = randomUUID(), credit = randomUUID(), pending = randomUUID(), voided = randomUUID();
  // Real tenant-scoped reporting fixtures, persisted before first-boot rehydrate.
  dbOne(`INSERT INTO customers(id,tenant_id,client_uuid,name,credit_limit) VALUES ('${customer}','${org}','${customer}','Cliente de prueba B6',100000);
    INSERT INTO tickets(id,tenant_id,client_uuid,ticket_no,total,status,customer_id) VALUES
      ('${credit}','${org}','${credit}',11,5000,'completed','${customer}'),
      ('${pending}','${org}','${pending}',12,9000,'transfer_pending',null),
      ('${voided}','${org}','${voided}',77,1200,'voided',null);
    INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,method,amount,status)
      SELECT gen_random_uuid(),'${org}',gen_random_uuid(),id,
        CASE WHEN id='${credit}' THEN 'credit' WHEN id='${pending}' THEN 'transfer' ELSE 'cash' END,
        total,CASE WHEN id='${pending}' THEN 'pending' ELSE 'confirmed' END
      FROM tickets WHERE tenant_id='${org}';`.replace(/\s+/g, " "));
  await page.goto("/"); await admin(page);
  await expect(page.getByTestId("admin-revenue")).toContainText("5.000");
  await expect(page.getByTestId("admin-balances")).toContainText("5.000");
  await expect(page.getByTestId("admin-pending")).toContainText("9.000");
  const voids = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Anulaciones recientes" }) });
  await expect(voids).toContainText("#77"); await expect(voids).toContainText("1.200");
  await page.getByTestId("admin-period").selectOption("month");
  await expect(page.getByTestId("admin-revenue")).toContainText("5.000");
  await expect(page.getByTestId("admin-screen")).not.toContainText("Cuentas por Pagar");
});
