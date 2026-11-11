import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

/**
 * D3-1 · catalog §Overselling (the UI half of the AC):
 *  - warn BEFORE checkout completes (warning banner, non-blocking)
 *  - completing is ALLOWED (negative balance is legal)
 *  - balance lands at −2 on both server derived stores after sync
 *
 * The allow/flag halves are covered by api test/stock-sale.test.ts and
 * web test/local-sale.test.ts; this spec proves the "warn" rendering.
 */

const E2E_DB = "postgres://esteban@127.0.0.1:5432/pos_piloto_e2e";

function dbOne(sql: string): string {
  return execSync(`psql "${E2E_DB}" -tA -c ${JSON.stringify(sql)}`, {
    encoding: "utf8",
  }).trim();
}

test.describe("D3-1 — oversell warning", () => {
  test("warns at checkout, allows the sale, balance ends at −2", async ({
    page,
  }) => {
    /* same hermetic wipe as d2-airplane: a fresh browser context restarts
       the local ticket sequence at 1, which would collide with earlier
       specs' pushed tickets on unique(tenant_id, ticket_no) */
    dbOne("DELETE FROM ticket_lines");
    dbOne("DELETE FROM payments");
    dbOne("DELETE FROM tickets");

    await page.goto("/");
    await page.getByTestId("login-email").fill("owner@demo.test");
    await page.getByTestId("login-password").fill("demo12345");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("tab-sale")).toBeVisible();

    /* catalog: a variant with stock 1 */
    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-name").fill("Oversell E2E");
    await page.getByTestId("variant-name").fill("Único");
    await page.getByTestId("variant-price").fill("2000");
    await page.getByTestId("variant-stock").fill("1");
    await page.getByTestId("product-create").click();
    await expect(
      page.getByTestId("product-item").filter({ hasText: "Oversell E2E" }),
    ).toBeVisible();

    /* tap the tile 3× → qty 3 > stock 1 */
    await page.getByTestId("tab-sale").click();
    const tile = page
      .getByTestId("sale-item")
      .filter({ hasText: "Oversell E2E" });
    await tile.click();
    await tile.click();
    await tile.click();
    await page.getByTestId("checkout-open").click();

    /* WARN shown at checkout — before the sale completes */
    const warn = page.getByTestId("oversell-warning");
    await expect(warn).toBeVisible();
    await expect(warn).toContainText("negativo");

    /* ALLOW: completing is not blocked by the warning */
    await page.getByTestId("quick-cash-exact").click();
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();

    /* after the online auto-push the server holds the negative balance
       on BOTH derived stores (sum(stockdiary) == variants == stockcurrent) */
    const variantSql = `SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.name = 'Oversell E2E'`;
    await expect.poll(() => dbOne(variantSql), { timeout: 15_000 }).not.toBe("");
    const variantId = dbOne(variantSql);
    await expect
      .poll(() => dbOne(`SELECT stock FROM product_variants WHERE id = '${variantId}'`), {
        timeout: 15_000,
      })
      .toBe("-2");
    expect(dbOne(`SELECT stock FROM stockcurrent WHERE variant_id = '${variantId}'`)).toBe(
      "-2",
    );
    expect(
      dbOne(
        `SELECT coalesce(sum(delta), 0) FROM stockdiary WHERE variant_id = '${variantId}'`,
      ),
    ).toBe("-2");
  });
});
