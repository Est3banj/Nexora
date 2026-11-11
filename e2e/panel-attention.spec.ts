import { expect, test } from "@playwright/test";
import { wipeSalesAndCatalog } from "./helpers-db";

/**
 * Panel UX #5 — métricas selectivas + atención:
 *  - hero Ingresos renders with delta chip (honest "sin dato previo" on fresh data)
 *  - pending transfer → "Requiere atención" card with count + navigate to Tickets
 *  - low stock → restock card with list + navigate to Catálogo
 *  - secondary KPIs + top products still render
 */

test.describe("Panel — attention metrics", () => {
  test("pending transfer + low stock surface in Requiere atención with working navigation", async ({
    page,
  }) => {
    wipeSalesAndCatalog();

    await page.goto("/");
    await page.getByTestId("login-email").fill("owner@demo.test");
    await page.getByTestId("login-password").fill("demo12345");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("tab-sale")).toBeVisible();

    /* catalog: one product at stock 3 (≤ default threshold 5) */
    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-name").fill("Panel Attention");
    await page.getByTestId("variant-name").fill("Único");
    await page.getByTestId("variant-price").fill("4000");
    await page.getByTestId("variant-stock").fill("3");
    await page.getByTestId("product-create").click();
    await expect(
      page.getByTestId("product-item").filter({ hasText: "Panel Attention" }),
    ).toBeVisible();

    /* transfer sale → pending payment */
    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Panel Attention" })
      .click();
    await page.getByTestId("checkout-open").click();
    await page.getByTestId("pay-transfer").click();
    await expect(page.getByTestId("transfer-note")).toBeVisible();
    await page.getByTestId("checkout-transfer").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();

    /* ── Panel: hero + attention section ── */
    await page.getByTestId("tab-dashboard").click();
    await expect(page.getByTestId("kpi-revenue")).toBeVisible();
    /* fresh local history → honest "sin dato previo", never a fake % */
    await expect(page.getByTestId("kpi-delta")).toContainText("sin dato previo");
    await expect(page.getByTestId("kpi-gross")).toBeVisible();
    await expect(page.getByTestId("kpi-cash")).toBeVisible();

    const attention = page.getByTestId("dash-attention-title");
    await expect(attention).toBeVisible();

    /* only a PENDING transfer exists → no confirmed hours → card hidden */
    await expect(page.getByTestId("dash-hours")).toHaveCount(0);

    const pendingCard = page.getByTestId("kpi-pending");
    await expect(pendingCard).toBeVisible();
    await expect(page.getByTestId("pending-count")).toContainText("1 pago");
    await expect(pendingCard).toContainText("4.000");

    const lowCard = page.getByTestId("kpi-low-stock");
    await expect(lowCard).toBeVisible();
    await expect(page.getByTestId("low-count")).toHaveText("1");
    await expect(page.getByTestId("dash-low-item")).toContainText(
      "Panel Attention · Único",
    );
    /* the transfer sale consumed 1 unit: stock 3 → 2 */
    await expect(page.getByTestId("dash-low-item")).toContainText("2/5");

    /* ── navigation shortcuts ── */
    await page.getByTestId("goto-tickets").click();
    await expect(page.getByTestId("tab-tickets")).toHaveClass(/active/);
    await expect(page.getByTestId("ticket-item").first()).toContainText(
      "Transf. pend.",
    );

    await page.getByTestId("tab-dashboard").click();
    await page.getByTestId("goto-catalog").click();
    await expect(page.getByTestId("tab-catalog")).toHaveClass(/active/);
    await expect(
      page.getByTestId("product-item").filter({ hasText: "Panel Attention" }),
    ).toBeVisible();
  });

  test("attention section hides when nothing needs action", async ({ page }) => {
    wipeSalesAndCatalog();

    await page.goto("/");
    await page.getByTestId("login-email").fill("owner@demo.test");
    await page.getByTestId("login-password").fill("demo12345");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("tab-sale")).toBeVisible();

    await page.getByTestId("tab-dashboard").click();
    await expect(page.getByTestId("kpi-revenue")).toBeVisible();
    await expect(page.getByTestId("dash-attention-title")).toHaveCount(0);
    await expect(page.getByTestId("kpi-pending")).toHaveCount(0);
    await expect(page.getByTestId("kpi-low-stock")).toHaveCount(0);
    await expect(page.getByTestId("dash-empty-top")).toBeVisible();
  });
});
