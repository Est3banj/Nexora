import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";
import { navigate } from "./helpers-navigation";

const evidence = "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";

/**
 * Rolling periods + custom range (design: ventana de N días vs. N previos):
 *  - presets live in a single native select (same pattern as Administración)
 *  - Personalizado prefills the last 7 days and auto-applies
 *  - a valid Desde/Hasta fetches that range (KPI reflects it)
 *  - desde > hasta → inline role=alert error, last valid range kept (no fetch)
 */

test.describe("Dashboard — períodos", () => {
  test("custom range auto-applies; invalid range errors without fetching", async ({ page }) => {
    wipeSalesAndCatalog();
    const org = dbOne("SELECT id FROM organization WHERE slug='tienda-demo'");
    expect((await page.request.post("/api/auth/sign-in/email", { data: { email: "owner@demo.test", password: "demo1234567890" } })).ok()).toBe(true);
    expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: org } })).ok()).toBe(true);

    /* known sale inside every range we assert (Bogotá 2026-11-03) */
    const ticket = randomUUID();
    dbOne(`INSERT INTO tickets(id,tenant_id,client_uuid,ticket_no,status,total,created_at)
      VALUES('${ticket}','${org}','${ticket}',801,'completed',50000,'2026-11-03T15:00:00Z');
      INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,method,amount,status,created_at)
      VALUES(gen_random_uuid(),'${org}',gen_random_uuid(),'${ticket}','cash',50000,'confirmed','2026-11-03T15:00:00Z');`.replace(/\s+/g, " "));

    await page.clock.setFixedTime(new Date("2026-11-03T18:00:00Z"));
    await page.goto("/");
    await navigate(page, "dashboard");

    /* preset structure: one native select with the seven rolling options */
    const select = page.getByTestId("period-select");
    await expect(select).toHaveValue("today");
    await expect(page.getByTestId("period-month")).toHaveCount(0);
    expect(await select.locator("option").evaluateAll(opts => opts.map(o => o.value)))
      .toEqual(["today", "7d", "30d", "90d", "180d", "365d", "custom"]);

    /* activation prefills the last 7 days and auto-applies (no apply button) */
    await select.selectOption("custom");
    await expect(page.getByTestId("period-custom-from")).toHaveValue("2026-10-28");
    await expect(page.getByTestId("period-custom-to")).toHaveValue("2026-11-03");
    await expect(page.getByTestId("period-custom-error")).toHaveCount(0);
    await expect(page.getByTestId("period-label")).toContainText("Rango: 2026-10-28 — 2026-11-03");
    await expect(page.getByTestId("period-label")).toContainText("los 7 días anteriores");

    /* valid custom range → fetch with that range (Nov 3 sale shows up) */
    await page.getByTestId("period-custom-from").fill("2026-11-01");
    await page.getByTestId("period-custom-to").fill("2026-11-03");
    await expect(page.getByTestId("period-label")).toContainText("Rango: 2026-11-01 — 2026-11-03");
    await expect(page.getByTestId("period-label")).toContainText("los 3 días anteriores");
    await expect(page.getByTestId("kpi-revenue")).toContainText("50.000");
    await expect(page.getByTestId("period-custom-error")).toHaveCount(0);

    /* no horizontal scroll with the select + custom row open (375 viewport) */
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);

    /* edge: desde > hasta → inline error; last valid range + KPI kept (no fetch) */
    await page.getByTestId("period-custom-from").fill("2026-11-05");
    const error = page.getByTestId("period-custom-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("role", "alert");
    await expect(page.getByTestId("period-custom-from")).toHaveAttribute("aria-describedby", "dash-custom-error");
    await expect(page.getByTestId("period-label")).toContainText("Rango: 2026-11-01 — 2026-11-03");
    await expect(page.getByTestId("kpi-revenue")).toContainText("50.000");

    /* edge: hasta in the future → same error, same kept range */
    await page.getByTestId("period-custom-from").fill("2026-11-01");
    await page.getByTestId("period-custom-to").fill("2026-11-10");
    await expect(error).toBeVisible();
    await expect(page.getByTestId("period-label")).toContainText("Rango: 2026-11-01 — 2026-11-03");
    await expect(page.getByTestId("kpi-revenue")).toContainText("50.000");

    await page.screenshot({ path: `${evidence}/dashboard-period-custom.png`, fullPage: true });
  });
});
