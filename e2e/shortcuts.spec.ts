import { expect, test } from "@playwright/test";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";
import { navigate } from "./helpers-navigation";

/**
 * Batch B — peak-hour shortcuts + quick annul from Venta:
 *  - F1 = efectivo exacto (fills tendered, focuses the charge button)
 *  - F2 = transferencia
 *  - Enter = cobra (native on the focused button; never double-fires —
 *    the global handler skips BUTTON targets)
 *  - "Anular última venta" in the desktop order panel → same auditable
 *    core as Tickets (reason required, server role-check, stock restitution)
 *  - "Anular esta venta" on the success screen (both platforms)
 */

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("login-identifier").fill("owner@demo.test");
  await page.getByTestId("login-password").fill("demo1234567890");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("tab-sale")).toBeVisible();
}

async function createProduct(page: import("@playwright/test").Page, name: string, price: string) {
  await page.getByTestId("tab-catalog").click();
  await page.getByTestId("product-new").click();
  await page.getByTestId("product-name").fill(name);
  await page.getByTestId("variant-name").fill("Único");
  await page.getByTestId("variant-price").fill(price);
  await page.getByTestId("variant-stock").fill("10");
  await page.getByTestId("product-create").click();
  await expect(
    page.getByTestId("product-item").filter({ hasText: name }),
  ).toBeVisible();
}

test.describe("Batch B — shortcuts + quick annul", () => {
  test("F1 exacto + Enter cobra; F2 transferencia + Enter registra", async ({ page }) => {
    wipeSalesAndCatalog();
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await createProduct(page, "Atajo E2E", "3500");

    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Atajo E2E" })
      .click();

    /* F1 → exact tendered + focus on the charge button */
    await page.keyboard.press("F1");
    await expect(page.getByTestId("tendered")).toHaveValue("3500");
    await expect(page.getByTestId("checkout-confirm")).toBeFocused();

    /* Enter → native activation of the focused button → one charge */
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sale-success")).toBeVisible();
    /* local-first: the server receives the sale async — poll, don't race */
    await expect
      .poll(() => dbOne("SELECT count(*) FROM tickets"), { timeout: 15_000 })
      .toBe("1");
    await expect
      .poll(() => dbOne("SELECT status FROM payments"), { timeout: 15_000 })
      .toBe("confirmed");
    /* M5: receipt opened after the durable commit — dismiss before chrome */
    await page.getByTestId("receipt-close").click();

    /* confirmed cash sale → Panel shows the hour-of-day profile */
    await navigate(page, "dashboard");
    await expect(page.getByTestId("dash-hours")).toBeVisible();
    await expect(page.locator(".hour-bar.peak")).toHaveCount(1);

    /* F2 flow: back to a fresh Sale (tab remount resets view + cart) */
    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Atajo E2E" })
      .click();
    await page.keyboard.press("F2");
    await expect(page.getByTestId("transfer-note")).toBeVisible();
    await expect(page.getByTestId("checkout-transfer")).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sale-success")).toBeVisible();
    await expect
      .poll(() => dbOne("SELECT count(*) FROM tickets"), { timeout: 15_000 })
      .toBe("2");
    await expect
      .poll(
        () =>
          dbOne(
            "SELECT method || ':' || status FROM payments WHERE method='transfer'",
          ),
        { timeout: 15_000 },
      )
      .toBe("transfer:pending");
  });

  test("Anular esta venta from the success screen (desktop)", async ({ page }) => {
    wipeSalesAndCatalog();
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);
    await createProduct(page, "Anulación Rápida", "4000");

    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Anulación Rápida" })
      .click();
    await page.keyboard.press("F1");
    /* wait for the rAF focus — Enter must hit the button, not a tile */
    await expect(page.getByTestId("checkout-confirm")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sale-success")).toBeVisible();
    await page.getByTestId("receipt-close").click();

    /* quick-void lives ONLY on the success screen now (user removed it
     * from the order panel — the cart stays a cart) */
    const quick = page.getByTestId("void-last-sale");
    await expect(quick).toBeVisible();
    await quick.click();

    await page.getByTestId("void-quick-reason").fill("Cobro duplicado por error");
    await page.getByTestId("void-quick-confirm").click();

    await expect(page.getByTestId("toast")).toContainText("Venta anulada");
    expect(dbOne("SELECT status FROM tickets")).toBe("voided");
    /* stock was10, sold 1 → 9; annulment restores → 10 */
    expect(dbOne("SELECT stock FROM product_variants")).toBe("10");
    /* annulment clears lastSale → success screen and its trigger are gone */
    await expect(page.getByTestId("sale-success")).toHaveCount(0);
    await expect(quick).toHaveCount(0);
  });

  test("Anular esta venta from the success screen (mobile)", async ({ page }) => {
    wipeSalesAndCatalog();
    await login(page); /* viewport is 375 by config */
    await createProduct(page, "Éxito Anulable", "2500");

    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Éxito Anulable" })
      .click();
    await page.getByTestId("checkout-open").click();
    await page.getByTestId("quick-cash-exact").click();
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();
    await page.getByTestId("receipt-close").click();

    await page.getByTestId("void-last-sale").click();
    await page.getByTestId("void-quick-reason").fill("Cliente se llevó el producto equivocado");
    await page.getByTestId("void-quick-confirm").click();

    await expect(page.getByTestId("toast")).toContainText("Venta anulada");
    expect(dbOne("SELECT status FROM tickets")).toBe("voided");
    expect(dbOne("SELECT stock FROM product_variants")).toBe("10");
    /* success screen is gone (lastSale cleared → browse view) */
    await expect(page.getByTestId("void-last-sale")).toHaveCount(0);
    await expect(page.getByTestId("sale-success")).toHaveCount(0);
  });
});
