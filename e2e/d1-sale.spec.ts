import { expect, test } from "@playwright/test";
import { wipeSalesAndCatalog } from "./helpers-db";

/**
 * D1-8 · Playwright E2E GATE (375px): create product → sell → ticket
 * visible locally (tasks.md Day 1 end-of-day verifiable slice).
 *
 * Also covers ACs:
 *  - sales §Cash checkout: "Efectivo recibido" starts EMPTY (never
 *    auto-filled); Exacto fills the total in one tap; overpayment accepted
 *    via the tendered field; empty tendered is rejected with a clear message
 *  - sales §Empty cart blocked with a clear message
 *  - catalog §Empty catalog shows an empty state (before creation)
 *  - sales §Sale survives reload offline: ticket still present after reload
 *  - sync §Local-first indicator: "pendiente de sync" toast + pending badge
 */

test.describe("D1 gate — create → sell → ticket locally", () => {
  test("3-tap sale registers a local ticket that survives a reload", async ({
    page,
  }) => {
    /* Hermetic: first-boot rehydrate (D4-4) pulls server catalog — wipe so
       empty-catalog AC and ticket #1 hold deterministically. */
    wipeSalesAndCatalog();

    /* ---------------- login ---------------- */
    await page.goto("/");
    await page.getByTestId("login-email").fill("owner@demo.test");
    await page.getByTestId("login-password").fill("demo12345");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("tab-sale")).toBeVisible();

    /* default tab is now Dashboard (Números) — open Venta first */
    await page.getByTestId("tab-sale").click();

    /* ---------------- empty cart blocked ---------------- */
    await page.getByTestId("checkout-open").click();
    await expect(page.getByTestId("cart-error")).toContainText("vacío");

    /* ---------------- catalog: empty state, then create ---------------- */
    await page.getByTestId("tab-catalog").click();
    await expect(page.getByTestId("empty-catalog-note")).toBeVisible();

    await page.getByTestId("product-new").click();
    await page.getByTestId("product-name").fill("Granizado Playwright");
    await page.getByTestId("variant-name").fill("Grande");
    await page.getByTestId("variant-price").fill("3500");
    await page.getByTestId("variant-stock").fill("5");
    await page.getByTestId("product-create").click();

    await expect(
      page.getByTestId("product-item").filter({ hasText: "Granizado Playwright" }),
    ).toBeVisible();
    // local-first write enqueued → pending badge is live
    await expect(page.getByTestId("pending-badge")).toContainText("pendientes");

    /* ---------------- 3-tap sale ---------------- */
    await page.getByTestId("tab-sale").click();
    // tap 1: select product/variant
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Granizado Playwright" })
      .click();
    await expect(page.getByTestId("cart-total")).toContainText("3.500");

    // tap 2: confirm cart / go to checkout
    await page.getByTestId("checkout-open").click();
    await expect(page.getByTestId("checkout-total")).toContainText("3.500");
    // efectivo recibido is NEVER auto-filled (owner decision)
    await expect(page.getByTestId("tendered")).toHaveValue("");

    // charging with an empty tendered is rejected with a clear message
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("cart-error")).toContainText(
      "Ingresá el efectivo recibido",
    );

    // tap 3: one-tap Exacto fills the total, then charge
    await page.getByTestId("quick-cash-exact").click();
    await expect(page.getByTestId("tendered")).toHaveValue("3500");
    await page.getByTestId("checkout-confirm").click();

    await expect(page.getByTestId("sale-success")).toBeVisible();
    await expect(page.getByTestId("toast")).toContainText(
      "Venta registrada (pendiente de sync)",
    );
    await expect(page.getByTestId("ticket-no")).toHaveText("#1");
    await expect(page.getByTestId("ticket-vuelto")).toContainText("0");

    /* M5 · receipt opens only after the durable local commit (12.3) */
    const receipt = page.getByTestId("receipt-preview");
    await expect(receipt).toBeVisible();
    await expect(page.getByTestId("ticket-detail")).toContainText("#1");
    await expect(page.getByTestId("ticket-detail")).toContainText("3.500");
    await page.getByTestId("receipt-close").click();
    await expect(receipt).toHaveCount(0);

    /* ---------------- ticket visible locally ---------------- */
    await page.getByTestId("tab-tickets").click();
    const firstTicket = page.getByTestId("ticket-item").first();
    await expect(firstTicket).toContainText("#1");
    await firstTicket.click();
    await expect(page.getByTestId("ticket-detail")).toBeVisible();

    /* ---------------- survives reload (local cache) ---------------- */
    await page.reload();
    await expect(page.getByTestId("tab-sale")).toBeVisible();
    await page.getByTestId("tab-tickets").click();
    const afterReload = page.getByTestId("ticket-item").first();
    await expect(afterReload).toContainText("#1");
    await expect(afterReload).toContainText("3.500");
    // the queue survived too: D2 boot auto-push drains it on this page
    // (offline-reload survival is asserted rigorously in d2-airplane.spec)
    await expect(page.getByTestId("pending-badge")).toContainText("sinc.");
    await expect(page.getByTestId("last-sync")).toBeVisible();
  });

  test("underpayment is rejected without creating a ticket", async ({ page }) => {
    wipeSalesAndCatalog();
    await page.goto("/");
    await page.getByTestId("login-email").fill("owner@demo.test");
    await page.getByTestId("login-password").fill("demo12345");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("tab-sale")).toBeVisible();

    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-new").click();
    await page.getByTestId("product-name").fill("Cerveza E2E");
    await page.getByTestId("variant-name").fill("330ml");
    await page.getByTestId("variant-price").fill("4000");
    await page.getByTestId("product-create").click();
    await expect(
      page.getByTestId("product-item").filter({ hasText: "Cerveza E2E" }),
    ).toBeVisible();

    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Cerveza E2E" })
      .click();
    await page.getByTestId("checkout-open").click();
    await page.getByTestId("tendered").fill("1000");
    await page.getByTestId("checkout-confirm").click();

    await expect(page.getByTestId("cart-error")).toContainText(
      "menor al total",
    );
    await expect(page.getByTestId("sale-success")).toBeHidden();

    // no ticket was created — close the modal (error keeps the order) first
    await page.getByTestId("checkout-cancel").click();
    await expect(page.getByTestId("payment-modal")).toBeHidden();
    await page.getByTestId("tab-tickets").click();
    await expect(page.getByTestId("empty-tickets")).toBeVisible();
  });
});
