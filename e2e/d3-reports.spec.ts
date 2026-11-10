import { expect, test } from "@playwright/test";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";

/**
 * D3-5 · Reports UI + offline staleness (reports spec):
 *  - §Empty period / empty catalog render empty state, no crash
 *  - §Offline report shows staleness indicator, clears after sync
 *  - report renders FROM LOCAL DATA while offline (exact local numbers)
 *
 * The three report QUERIES are gated by D3-6 (reports-fixtures.test.ts,
 * exact numbers, cross-tenant, PGlite parity). This spec proves the UI
 * half: empty states + the "may be incomplete" banner lifecycle.
 */

const OFFLINE_FLAG = "pos:e2e-offline";
const SYNC_GLOB = "**/api/sync/**";
/** Unique price for this spec → local report assertion is unambiguous. */
const PRICE = 4500;

test.describe("D3-5 — reports UI + offline staleness", () => {
  test("empty states render; offline report shows staleness banner and clears after sync", async ({
    page,
    context,
  }) => {
    /* Hermetic: wipe sales AND catalog — first-boot rehydrate would
       otherwise load seed/prior products and break empty-low (stock ≤ 5
       leftovers from earlier specs). */
    wipeSalesAndCatalog();

    await context.addInitScript((flag: string) => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => localStorage.getItem(flag) !== "1",
      });
    }, OFFLINE_FLAG);

    /* ---------------- login (online) ---------------- */
    await page.goto("/");
    await page.getByTestId("login-email").fill("owner@demo.test");
    await page.getByTestId("login-password").fill("demo12345");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("tab-sale")).toBeVisible();

    /* ---------------- empty states (fresh local cache) ---------------- */
    await page.getByTestId("tab-reports").click();
    await expect(page.getByTestId("empty-sales")).toBeVisible();
    /* no pending mutations yet → NO staleness banner */
    await expect(page.getByTestId("reports-staleness")).toHaveCount(0);

    await page.getByTestId("tab-report-top").click();
    await expect(page.getByTestId("empty-top")).toBeVisible();
    await page.getByTestId("tab-report-low").click();
    await expect(page.getByTestId("empty-low")).toBeVisible();
    await page.getByTestId("tab-report-sales").click();

    /* ---------------- baseline: drain the queue ---------------- */
    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-name").fill("Reporte E2E");
    await page.getByTestId("variant-name").fill("Único");
    await page.getByTestId("variant-price").fill(String(PRICE));
    await page.getByTestId("variant-stock").fill("5");
    await page.getByTestId("product-create").click();
    await expect(
      page.getByTestId("product-item").filter({ hasText: "Reporte E2E" }),
    ).toBeVisible();

    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const w = window as unknown as {
              __pos?: { pushNow: () => Promise<void> };
            };
            if (!w.__pos) return "no-hook";
            await w.__pos.pushNow();
            return document.querySelector(
              '[data-testid="pending-badge"]',
            )?.textContent ?? "";
          }),
        { timeout: 15_000 },
      )
      .toContain("sinc.");

    /* queue clean → banner stays away */
    await page.getByTestId("tab-reports").click();
    await expect(page.getByTestId("reports-staleness")).toHaveCount(0);

    /* ---------------- offline: local sale → stale report ---------------- */
    await context.route(SYNC_GLOB, (route) => route.abort());
    await page.evaluate((f: string) => localStorage.setItem(f, "1"), OFFLINE_FLAG);
    await context.setOffline(true);
    await expect(page.getByTestId("net-status")).toContainText("sin conexión");

    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Reporte E2E" })
      .click();
    await page.getByTestId("checkout-open").click();
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();

    /* report renders from LOCAL data with a visible staleness banner */
    await page.getByTestId("tab-reports").click();
    const banner = page.getByTestId("reports-staleness");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("incompletos");
    await expect(page.getByTestId("sales-total")).toContainText("4.500");
    await expect(page.getByTestId("sales-day")).toContainText("4.500");

    /* ---------------- reconnect: drain → banner clears ---------------- */
    await context.unroute(SYNC_GLOB);
    await page.evaluate((f: string) => localStorage.removeItem(f), OFFLINE_FLAG);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect(page.getByTestId("pending-badge")).toContainText("sinc.", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("reports-staleness")).toHaveCount(0);
    /* numbers survive the sync (local-first data, now confirmed) */
    await expect(page.getByTestId("sales-total")).toContainText("4.500");

    /* server received the sale exactly once */
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("1");
  });
});
