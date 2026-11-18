import { expect, test, type Locator } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createTenantViaFounder } from "./helpers-auth";

async function fullyExposed(control: Locator, footer: Locator, gap = 0) {
  const bounds = (await control.boundingBox())!;
  const actions = (await footer.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(actions.y - gap + 1);
  // Bounding boxes alone miss clipping by a scrollport or a painted overlay.
  expect(await control.evaluate(el => {
    const r = el.getBoundingClientRect();
    return [r.top + 2, r.bottom - 2].every(y =>
      [r.left + r.width / 4, r.right - r.width / 4].every(x => el.contains(document.elementFromPoint(x, y))),
    );
  })).toBe(true);
}

test("payment fields stay fully above actions while editing and scrolling", async ({ page }, testInfo) => {
  const id = randomUUID();
  // P0-1: founder plane only — /api/auth/organization/create is closed.
  await createTenantViaFounder(page.request, {
    name: "Cobro layout", slug: `payment-${id}`, email: `payment-${id}@test.dev`, password: "payment-test-123",
  });
  expect((await page.request.post("/api/catalog/products", { data: {
    name: "Café cobro", variant: { name: "Único", price: 12000, stock: 100 },
  } })).ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByTestId("sale-item")).toHaveCount(1);
  await page.getByTestId("sale-item").click();
  await page.getByTestId("checkout-open").click();
  const dialog = page.getByTestId("payment-modal");
  const footer = dialog.locator(".pay-footer");
  const measurements: object[] = [];
  for (const [width, height] of [[1440, 900], [1440, 600], [1440, 480], [640, 600], [375, 812], [639, 812]]) {
    console.log(`Payment geometry ${width}x${height}`);
    await page.setViewportSize({ width, height });
    await page.getByTestId("pay-cash").click();
    await page.getByTestId("checkout-confirm").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("tendered")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("20000");
    await expect(page.getByTestId("change-display")).toContainText("8.000");
    if (width >= 640) await fullyExposed(dialog.locator(".cash-pair"), footer, 16);
    // Scroll to the end, then repeat keyboard focus from the primary action.
    await dialog.evaluate(el => {
      const scroller = el.querySelector(".payment-body");
      const target = scroller && getComputedStyle(scroller).display !== "contents" ? scroller : el;
      target.scrollTop = target.scrollHeight;
    });
    await page.getByTestId("checkout-confirm").focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByTestId("tendered")).toBeFocused();
    const fields = dialog.locator(".cash-pair");
    measurements.push({ width, height, fields: await fields.boundingBox(), footer: await footer.boundingBox() });
    await page.screenshot({ path: testInfo.outputPath(`cash-${width}x${height}.png`) });
    await fullyExposed(fields, footer, width >= 640 ? 16 : 0);
    await page.getByTestId("pay-transfer").click();
    await page.getByTestId("transfer-note").scrollIntoViewIfNeeded();
    await fullyExposed(page.getByTestId("transfer-note"), footer);
    await expect(page.getByTestId("checkout-transfer")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`transfer-${width}x${height}.png`) });
    await page.getByTestId("pay-fiado").click();
    await expect(page.getByTestId("fiado-search")).toBeFocused();
    await page.getByTestId("fiado-mixed-toggle").check();
    await page.getByTestId("fiado-mixed-toggle").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("fiado-cash")).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type("1000");
    await fullyExposed(page.getByTestId("fiado-cash"), footer);
    await expect(page.getByTestId("checkout-confirm")).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`credit-${width}x${height}.png`) });
  }
  await testInfo.attach("payment-geometry", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  await page.getByTestId("checkout-cancel").click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("cart-total")).toContainText("12.000");
});
