import { expect, test } from "@playwright/test";
import { wipeSalesAndCatalog } from "./helpers-db";

/**
 * Batch D — Corte de caja imprimible (térmica 58/80mm):
 *  - button disabled while there are no sales, enabled after a sale
 *  - the print section always lives on document.body (portal) with the
 *    totals of the selected range
 *  - print-media contract: body.printing-corte hides #root and shows ONLY
 *    the corte — ticket/success prints keep their own chrome-hiding rules
 */

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("login-email").fill("owner@demo.test");
  await page.getByTestId("login-password").fill("demo12345");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("tab-sale")).toBeVisible();
}

test.describe("Batch D — corte de caja", () => {
  test("print button gates on data; print media shows only the corte", async ({
    page,
  }, testInfo) => {
    wipeSalesAndCatalog();
    await login(page);

    /* no sales yet → button exists but is disabled */
    await page.getByTestId("tab-reports").click();
    await expect(page.getByTestId("corte-print")).toBeDisabled();
    await expect(page.getByTestId("export-excel")).toBeDisabled();

    /* one cash sale → both exports enable */
    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-new").click();
    await page.getByTestId("product-name").fill("Corte E2E");
    await page.getByTestId("variant-name").fill("Único");
    await page.getByTestId("variant-price").fill("4000");
    await page.getByTestId("variant-stock").fill("10");
    await page.getByTestId("product-create").click();
    await expect(
      page.getByTestId("product-item").filter({ hasText: "Corte E2E" }),
    ).toBeVisible();

    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Corte E2E" })
      .click();
    await page.getByTestId("checkout-open").click();
    await page.getByTestId("quick-cash-exact").click();
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();
    await page.getByTestId("receipt-close").click();

    await page.getByTestId("tab-reports").click();
    const corte = page.getByTestId("corte-print");
    await expect(corte).toBeEnabled();
    /* headless print() is a no-op — must not crash or hang */
    await corte.click();

    /* the portal section carries the range totals (display:none on screen) */
    const text = await page.getByTestId("print-corte").textContent();
    expect(text).toContain("CORTE DE CAJA");
    expect(text).toContain("4.000");
    expect(text).toContain("Excluye tickets anulados");

    /* print-media contract */
    await page.evaluate(() => document.body.classList.add("printing-corte"));
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("print-corte")).toBeVisible();
    await expect(page.locator("#root")).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath("corte-print-media.png"),
      fullPage: true,
    });
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() =>
      document.body.classList.remove("printing-corte"),
    );
    /* screen mode: corte hidden again, app visible */
    await expect(page.getByTestId("print-corte")).toBeHidden();
    await expect(page.getByTestId("corte-print")).toBeVisible();
  });
});
