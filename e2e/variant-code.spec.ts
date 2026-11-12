import { expect, test } from "@playwright/test";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";

for (const width of [375, 1440]) {
  test(`variant codes and explicit scanner: offline sale and replay at ${width}px`, async ({ page, context }, testInfo) => {
    wipeSalesAndCatalog();
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await page.getByTestId("login-email").fill("owner@demo.test");
    await page.getByTestId("login-password").fill("demo12345");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("tab-sale")).toBeVisible();
    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-new").click();
    await page.getByTestId("product-name").fill("Cerveza scanner");
    await page.getByTestId("variant-name").fill("330 ml");
    await page.getByTestId("variant-code").fill("000330");
    await page.getByTestId("variant-price").fill("4000");
    await page.getByTestId("variant-cost").fill("2000");
    await page.getByTestId("variant-stock").fill("10");
    await page.getByTestId("product-create").click();
    const product = page.getByTestId("product-item").filter({ hasText: "Cerveza scanner" });
    await expect(product).toBeVisible();
    await product.getByTestId("product-edit").click();
    const modal = page.getByTestId("product-modal");
    await modal.getByTestId("add-variant").click();
    const extra = modal.getByTestId("variant-row").nth(1);
    await extra.getByTestId("variant-name").fill("600 ml");
    await extra.getByTestId("variant-price").fill("6000");
    await extra.getByTestId("variant-code").fill("000330");
    await modal.getByTestId("product-create").click();
    await expect(page.getByTestId("catalog-error")).toContainText("ya pertenece");
    await expect(modal.getByTestId("variant-row")).toHaveCount(2);
    await extra.getByTestId("variant-code").fill("000600");
    const v330 = modal.getByTestId("variant-row").first();
    await v330.getByTestId("variant-code").fill("0000330");
    await modal.getByTestId("product-create").click();
    await expect(modal).not.toBeVisible();
    await expect(product).toContainText("600 ml");
    await page.evaluate(async () => {
      await (window as unknown as { __pos: { pushNow(): Promise<void> } }).__pos.pushNow();
    });
    await expect(page.getByTestId("pending-badge")).toContainText("sinc.");
    await page.reload();
    await page.getByTestId("tab-catalog").click();
    await product.getByTestId("product-edit").click();
    await expect(v330.getByTestId("variant-code")).toHaveValue("0000330");
    await page.getByRole("button", { name: "Cancelar", exact: true }).click();
    await page.getByTestId("catalog-search").fill("000600");
    await expect(product).toBeVisible();
    await page.getByTestId("catalog-search").fill("Cerveza");
    await expect(product).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`catalog-code-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.getByTestId("tab-sale").click();
    await page.getByTestId("sale-search").fill("000600");
    await expect(page.getByTestId("sale-item")).toHaveCount(1);
    await expect(page.getByTestId("sale-item")).toContainText("600 ml");
    await page.getByTestId("sale-search").fill("Cerveza");
    await expect(page.getByTestId("sale-item")).toHaveCount(2);
    // Enter in a normal search input must neither add nor sell.
    await page.getByTestId("sale-search").press("Enter");
    await expect(page.getByTestId("cart-total")).toContainText("0");
    await page.getByTestId("sale-search").fill("");
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    /* Unified search/scan field (prototype POS): an exact code adds a unit */
    const scanner = page.getByTestId("sale-search");
    await scanner.fill("999999");
    await scanner.press("Enter");
    await expect(page.getByTestId("scan-message")).toContainText("Código no encontrado");
    await expect(page.getByTestId("cart-total")).toContainText("0");
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("0");
    await page.screenshot({ path: testInfo.outputPath(`scanner-unknown-${width}.png`), fullPage: true });
    await scanner.fill("0000330");
    await scanner.press("Enter");
    await expect(scanner).toHaveValue("");
    await expect(scanner).toBeFocused();
    await expect(page.getByTestId("scan-message")).toContainText("una unidad");
    await expect(page.getByTestId("cart-total")).toContainText("4.000");
    await scanner.press("Enter"); // empty suffix cannot add again or submit checkout
    await expect(page.getByTestId("cart-total")).toContainText("4.000");
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("0");
    await page.screenshot({ path: testInfo.outputPath(`scanner-added-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 375) {
      await page.getByTestId("checkout-open").click();
      await expect(page.getByTestId("checkout-summary")).toContainText("× 1");
    } else {
      await expect(page.getByTestId("order-qty")).toHaveText("1");
      /* M5: the desktop order panel opens the SAME shared payment modal */
      await page.getByTestId("checkout-open").click();
      await expect(page.getByTestId("checkout-summary")).toContainText("× 1");
    }
    await page.getByTestId("quick-cash-exact").click(); // tendered is never auto-filled
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("0");
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByTestId("pending-badge")).toContainText("sinc.");
    const replay = await page.evaluate(async () => {
      const hook = (window as unknown as { __pos: { repushSynced(): Promise<Array<{ status: string }>> } }).__pos;
      return hook.repushSynced();
    });
    expect(replay.every(r => r.status === "duplicate")).toBe(true);
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("1");
    expect(dbOne("SELECT qty FROM ticket_lines")).toBe("1");
    expect(dbOne("SELECT count(*) FROM payments")).toBe("1");
    expect(dbOne("SELECT code || ':' || cost || ':' || stock FROM product_variants WHERE name='330 ml'")).toBe("0000330:2000:9");
    await page.reload();
    await page.getByTestId("tab-catalog").click();
    await product.getByTestId("product-edit").click();
    await expect(v330.getByTestId("variant-code")).toHaveValue("0000330");
  });
}
