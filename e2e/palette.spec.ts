import { expect, test } from "@playwright/test";
import { wipeSalesAndCatalog } from "./helpers-db";

/**
 * Batch C — command palette (Ctrl/Cmd+K or "/"):
 *  - product search → pick → lands in the Venta cart
 *  - section navigation without the mouse
 *  - ticket search → pick → opens the ticket detail
 *  - "/" opens from body but NEVER while typing in an input
 *  - Esc closes
 */

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("login-email").fill("owner@demo.test");
  await page.getByTestId("login-password").fill("demo12345");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("tab-sale")).toBeVisible();
}

test.describe("Batch C — command palette", () => {
  test("Ctrl+K: add product, navigate, open ticket; slash guard", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page);

    /* seed a product + one sale for ticket search */
    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-new").click();
    await page.getByTestId("product-name").fill("Paleta E2E");
    await page.getByTestId("variant-name").fill("Único");
    await page.getByTestId("variant-price").fill("3000");
    await page.getByTestId("variant-stock").fill("10");
    await page.getByTestId("product-create").click();
    await expect(
      page.getByTestId("product-item").filter({ hasText: "Paleta E2E" }),
    ).toBeVisible();

    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Paleta E2E" })
      .click();
    await page.keyboard.press("F1");
    await expect(page.getByTestId("checkout-confirm")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("sale-success")).toBeVisible();
    await page.getByTestId("receipt-close").click();
    await page.getByTestId("new-sale").click();

    /* ── product search → cart ── */
    await page.keyboard.press("Control+k");
    const input = page.getByTestId("palette-input");
    await expect(input).toBeFocused();
    await input.fill("paleta");
    await expect(
      page.getByTestId("palette-item").filter({ hasText: "Paleta E2E" }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tab-sale")).toHaveClass(/active/);
    await expect(page.getByTestId("cart-count")).toContainText("1 ítems");

    /* ── section navigation ── */
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("reportes");
    /* wait for the re-render before Enter — under load a premature Enter
     * would act on the stale (empty-query) entries and pick the first NAV */
    await expect(
      page.getByTestId("palette-item").filter({ hasText: "Reportes" }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tab-reports")).toHaveClass(/active/);

    /* ── 7th nav entry: Clientes & Fiados (M4 shell / old 5.9 + 5.11) ── */
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("fiado");
    await expect(
      page.getByTestId("palette-item").filter({ hasText: "Clientes & Fiados" }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("tab-credito")).toHaveClass(/active/);

    /* ── "/" opens from body, Esc closes ── */
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("/");
    await expect(page.getByTestId("palette-input")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("palette-input")).toHaveCount(0);

    /* ── "/" while typing in an input must NOT open ── */
    await page.getByTestId("tab-sale").click();
    await page.getByTestId("sale-search").fill("/");
    await expect(page.getByTestId("palette-input")).toHaveCount(0);

    /* ── ticket search → shared receipt preview ── */
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("1");
    const ticketEntry = page
      .getByTestId("palette-item")
      .filter({ hasText: "#1" });
    await expect(ticketEntry).toBeVisible();
    await ticketEntry.click();
    await expect(page.getByTestId("tab-tickets")).toHaveClass(/active/);
    await expect(page.getByTestId("ticket-detail")).toContainText("#1");
    await page.getByTestId("receipt-close").click();
  });
});
