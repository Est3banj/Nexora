import { expect, test } from "@playwright/test";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";

test("owner annulment: accessible confirmation, offline edge, replay mirror and responsive evidence", async ({ page, context }, testInfo) => {
  wipeSalesAndCatalog();
  await page.goto("/");
  await page.getByTestId("login-email").fill("owner@demo.test");
  await page.getByTestId("login-password").fill("demo12345");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("tab-sale")).toBeVisible();
  await page.getByTestId("tab-catalog").click();
  await page.getByTestId("product-new").click();
  await page.getByTestId("product-name").fill("Café anulación E2E");
  await page.getByTestId("variant-name").fill("Único");
  await page.getByTestId("variant-price").fill("4000");
  await page.getByTestId("variant-stock").fill("10");
  await page.getByTestId("product-create").click();
  await expect(page.getByTestId("product-item")).toBeVisible();
  await page.getByTestId("tab-sale").click();
  await page.getByTestId("sale-item").filter({ hasText: "Café anulación E2E" }).click();
  await page.getByTestId("checkout-open").click();
  await page.getByTestId("quick-cash-exact").click();
  await page.getByTestId("checkout-confirm").click();
  await expect(page.getByTestId("sale-success")).toBeVisible();
  // The badge can still display the catalog's previous zero while the sale
  // starts draining. Wait for its actual local receipt, not that stale badge.
  await expect.poll(() => page.evaluate(async () => {
    const { getLocalDb } = await import("/src/db/instance.ts");
    const local = await getLocalDb();
    const rows = await local!.db.query("SELECT id FROM sync_log WHERE entity='payment' AND status='synced'");
    return rows.rows.length;
  })).toBe(1);
  await expect(page.getByTestId("pending-badge")).toContainText("sinc.");
  /* dismiss the post-commit receipt before touching app chrome */
  await page.getByTestId("receipt-close").click();
  await page.getByTestId("tab-tickets").click();
  await page.getByTestId("ticket-item").click();
  await expect(page.getByTestId("ticket-detail")).toBeVisible();

  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByTestId("void-sale")).toBeDisabled();
  await expect(page.getByText("La anulación necesita conexión. Podés seguir vendiendo offline.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("void-offline-375.png"), fullPage: true });
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByTestId("void-sale").click();
  const dialog = page.getByRole("dialog", { name: "Anular venta #1" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("void-reason")).toBeFocused();
  await page.getByTestId("void-reason").fill("   ");
  await expect(page.getByTestId("void-confirm")).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("void-sale")).toBeFocused();
  await page.getByTestId("void-sale").click();
  await page.getByTestId("void-reason").fill("Venta cobrada por error");
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("void-confirm")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`void-confirm-${width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByTestId("void-confirm").click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("ticket-voided")).toContainText("Venta cobrada por error");
  await expect(page.getByTestId("ticket-detail")).toContainText("4.000");
  expect(dbOne("SELECT status FROM tickets")).toBe("voided");
  expect(dbOne("SELECT stock FROM product_variants")).toBe("10");
  expect(dbOne("SELECT count(*) FROM stockdiary WHERE reason='sale_void'")).toBe("1");
  // Simulate a stale device replay and require canonical ACK mirroring.
  await page.evaluate(async () => {
    const { getLocalDb } = await import("/src/db/instance.ts");
    const local = await getLocalDb();
    const db = local!.db;
    await db.query("UPDATE tickets SET status='completed'");
    await db.query("UPDATE sync_log SET status='pending' WHERE entity IN ('ticket','payment','ticket_line','stockdiary')");
    const { pushNow } = await import("/src/sync/queue.ts");
    const tenant = (await db.query<{ tenant_id: string }>("SELECT tenant_id FROM tickets LIMIT 1")).rows[0].tenant_id;
    await pushNow(db, tenant, { force: true });
  });
  await page.reload();
  await page.getByTestId("tab-tickets").click();
  await page.getByTestId("ticket-item").click();
  await expect(page.getByTestId("ticket-detail")).toBeVisible();
  await expect(page.getByTestId("ticket-voided")).toContainText("Venta cobrada por error");
  for (const width of [375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: testInfo.outputPath(`void-result-${width}.png`), fullPage: true });
  }
  expect(dbOne("SELECT count(*) FROM payments")).toBe("1");
  expect(dbOne("SELECT count(*) FROM ticket_lines")).toBe("1");
  expect(dbOne("SELECT stock FROM product_variants")).toBe("10");
});
