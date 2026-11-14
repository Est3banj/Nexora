import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { dbOne } from "./helpers-db";
import { createOrgUser } from "./helpers-auth";

/**
 * Batch 8 · 8.4 — annul-code e2e (D3 lifecycle end-to-end):
 * owner generates the code (shown once) → toggle ON → void without code
 * blocked (UI disabled + server 403) → wrong code rejected → correct code
 * annuls and restores stock; member context sees the void affordance ONLY
 * with the toggle ON and annuls with the code end-to-end; toggle OFF hides
 * the affordance again. Panel generate/rotate/once-only states live in
 * batch6-admin.spec (REUSE — not duplicated here).
 *
 * Screenshots are captured for the HUMAN visual audit only — never read
 * back by the suite.
 */
const evidence =
  "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

async function tenant(page: Page) {
  const tag = randomUUID();
  expect((await page.request.post("/api/auth/sign-up/email", { data: {
    name: "Dueña de prueba AC", email: `ac-${tag}@test.dev`, password: "roles-test-only-123",
  } })).ok()).toBe(true);
  const res = await page.request.post("/api/auth/organization/create", { data: { name: "Tienda de prueba AC", slug: `ac-${tag}` } });
  expect(res.ok()).toBe(true);
  const org = (await res.json()).id as string;
  expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: org } })).ok()).toBe(true);
  return org;
}

async function seedProductAndShift(page: Page, org: string) {
  expect((await page.request.post("/api/shifts/open", { data: { opening_cash: 10000, calculation_version: "drawer_cash_v2" } })).ok()).toBe(true);
  expect((await page.request.post("/api/catalog/products", { data: {
    name: "Café anulación código", variant: { name: "Único", price: 4000, cost: 1500, stock: 10 },
  } })).ok()).toBe(true);
  expect(dbOne(`SELECT count(*) FROM product_variants WHERE tenant_id='${org}'`)).toBe("1");
}

async function sellOne(page: Page, org: string, expectedTickets: number) {
  await page.getByTestId("tab-sale").click();
  await page.getByTestId("sale-item").filter({ hasText: "Café anulación código" }).click();
  await page.getByTestId("checkout-open").click();
  await page.getByTestId("quick-cash-exact").click();
  await page.getByTestId("checkout-confirm").click();
  await expect(page.getByTestId("sale-success")).toBeVisible();
  await page.getByTestId("receipt-close").click();
  await page.getByTestId("new-sale").click(); // back to the grid for the next sale
  await page.evaluate(() =>
    (window as unknown as { __pos: { pushNow: () => Promise<void> } }).__pos.pushNow(),
  );
  await expect
    .poll(() => dbOne(`SELECT count(*) FROM tickets WHERE tenant_id='${org}'`), { timeout: 15_000 })
    .toBe(String(expectedTickets));
}

test("owner: toggle ON blocks raw voids, wrong code rejected, correct code annuls with stock restored", async ({ page }) => {
  const org = await tenant(page);
  await seedProductAndShift(page, org);
  await page.goto("/");
  await expect(page.getByTestId("tab-sale")).toBeVisible();
  await sellOne(page, org, 1);

  /* toggle ON from the panel (operator flow, 8.8 docs) */
  await page.getByTestId("tab-admin").click();
  await page.getByTestId("admin-tab-configuracion").click();
  await page.getByTestId("admin-setting-require_annul_code").check();
  await page.getByTestId("admin-settings-save").click();
  await expect(page.getByTestId("admin-settings-save")).toBeEnabled();
  const settings = await (await page.request.get("/api/settings")).json();
  expect(settings.settings.require_annul_code).toBe(true);
  expect(JSON.stringify(settings)).not.toContain("annul_code_hash");

  /* generate: plaintext shown ONCE (never in GET, never in storage) */
  await page.getByTestId("admin-code-generate").click();
  const code = (await page.getByTestId("admin-generated-code").textContent()) ?? "";
  expect(code).toMatch(CODE_RE);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored.includes(code)).toBe(false);
  const afterGenerate = await (await page.request.get("/api/settings")).json();
  expect(JSON.stringify(afterGenerate)).not.toContain(code);

  /* server authority: NOBODY annuls without the code — owner included */
  const ticketId = dbOne(`SELECT id FROM tickets WHERE tenant_id='${org}'`);
  const raw = await page.request.post(`/api/sales/tickets/${ticketId}/void`, { data: { reason: "Sin código alguno" } });
  expect(raw.status()).toBe(403);
  expect(await raw.json()).toEqual({ error: "annul_code_required" });
  expect(dbOne(`SELECT status FROM tickets WHERE id='${ticketId}'`)).toBe("completed");

  /* UI: code field visible, confirm blocked until a code is typed */
  await page.getByTestId("tab-tickets").click();
  await page.getByTestId("ticket-item").click();
  await expect(page.getByTestId("ticket-detail")).toBeVisible();
  await page.getByTestId("void-sale").click();
  const dialog = page.getByRole("dialog", { name: "Anular venta #1" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("void-code")).toBeVisible();
  await page.getByTestId("void-reason").fill("Anulación de prueba con código");
  await expect(page.getByTestId("void-confirm")).toBeDisabled();

  /* wrong code → honest error, ticket untouched */
  await page.getByTestId("void-code").fill("ZZZZZZZZ");
  await page.getByTestId("void-confirm").click();
  await expect(page.getByTestId("void-error")).toContainText("Código de anulación incorrecto");
  expect(dbOne(`SELECT status FROM tickets WHERE id='${ticketId}'`)).toBe("completed");
  expect(dbOne(`SELECT stock FROM product_variants WHERE tenant_id='${org}'`)).toBe("9");
  /* human-visual-audit evidence (1440 + 375) — captured, never read */
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${evidence}/batch8-annul-code-${width}-dialog-error.png`, fullPage: true });
  }

  /* correct code → annulment + stock restored (evidence chain intact) */
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId("void-code").fill(code);
  await page.getByTestId("void-confirm").click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId("ticket-voided")).toContainText("Anulación de prueba con código");
  expect(dbOne(`SELECT status FROM tickets WHERE id='${ticketId}'`)).toBe("voided");
  expect(dbOne(`SELECT stock FROM product_variants WHERE tenant_id='${org}'`)).toBe("10");
  expect(dbOne(`SELECT count(*) FROM stockdiary WHERE tenant_id='${org}' AND reason='sale_void'`)).toBe("1");
});

test("member annuls with the code only while the toggle is ON; toggle OFF hides the affordance", async ({ page, browser }) => {
  const org = await tenant(page);
  await seedProductAndShift(page, org);
  await page.goto("/");
  await expect(page.getByTestId("tab-sale")).toBeVisible();
  /* BOTH tickets exist BEFORE the member's first boot — devices do not
   * pull each other's sales (rehydrate is first-boot only), so the
   * member's local history must already contain the completed ticket
   * that stays completed after the void. */
  await sellOne(page, org, 1);
  await sellOne(page, org, 2);

  /* toggle ON + code via the owner session (panel UI flow lives in test 1) */
  expect((await page.request.put("/api/settings", { data: { require_annul_code: true } })).ok()).toBe(true);
  const gen = await (await page.request.post("/api/settings/annul-code", { data: {} })).json();
  expect(gen.code).toMatch(CODE_RE);

  const staffContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 375, height: 812 },
  });
  try {
    const staff = await staffContext.newPage();
    await createOrgUser(staffContext.request, org, "member", "ac-member");
    await staff.goto("/");
    /* wait for first-boot rehydrate to land (Sale re-queries on the
     * refreshToken bump) BEFORE navigating — the member's local history
     * must contain both tickets by then */
    await expect(staff.getByTestId("sale-item").filter({ hasText: "Café anulación código" })).toBeVisible();
    await staff.getByTestId("tab-tickets").click();
    await expect(staff.getByTestId("ticket-item").first()).toBeVisible();
    await staff.getByTestId("ticket-item").first().click(); // #2 = newest = completed
    await expect(staff.getByTestId("ticket-detail")).toBeVisible();
    await expect(staff.getByTestId("ticket-voided")).toHaveCount(0);
    /* toggle ON → the cashier SEES the affordance and the code field */
    await expect(staff.getByTestId("void-sale")).toBeEnabled();
    await staff.getByTestId("void-sale").click();
    await expect(staff.getByRole("dialog", { name: "Anular venta #2" })).toBeVisible();
    await expect(staff.getByTestId("void-code")).toBeVisible();
    await staff.getByTestId("void-reason").fill("Cobro anulado por el cajero");
    await staff.getByTestId("void-code").fill(gen.code);
    /* human-visual-audit evidence (1440 + 375) — captured, never read */
    for (const width of [1440, 375]) {
      await staff.setViewportSize({ width, height: 900 });
      await staff.screenshot({ path: `${evidence}/batch8-annul-code-${width}-member-dialog.png`, fullPage: true });
    }
    await staff.setViewportSize({ width: 375, height: 812 });
    await staff.getByTestId("void-confirm").click();
    await expect(staff.getByTestId("ticket-voided")).toContainText("Cobro anulado por el cajero");
    expect(dbOne(`SELECT status FROM tickets WHERE tenant_id='${org}' AND ticket_no=2`)).toBe("voided");
    expect(dbOne(`SELECT status FROM tickets WHERE tenant_id='${org}' AND ticket_no=1`)).toBe("completed");
    expect(dbOne(`SELECT stock FROM product_variants WHERE tenant_id='${org}'`)).toBe("9");

    /* toggle OFF → the same member loses the affordance on a completed ticket */
    expect((await page.request.put("/api/settings", { data: { require_annul_code: false } })).ok()).toBe(true);
    await staff.reload();
    await expect(staff.getByTestId("sale-item").filter({ hasText: "Café anulación código" })).toBeVisible();
    await staff.getByTestId("tab-tickets").click();
    await expect(staff.getByTestId("ticket-item").nth(1)).toBeVisible(); // #1 = completed (list is newest-first)
    await staff.getByTestId("ticket-item").nth(1).click();
    await expect(staff.getByTestId("ticket-detail")).toBeVisible();
    await expect(staff.getByTestId("ticket-voided")).toHaveCount(0); // really on #1…
    await expect(staff.getByTestId("void-sale")).toHaveCount(0); // …and OFF hides it
    expect(dbOne(`SELECT stock FROM product_variants WHERE tenant_id='${org}'`)).toBe("9");
    expect(dbOne(`SELECT count(*) FROM tickets WHERE tenant_id='${org}' AND status='voided'`)).toBe("1");
  } finally {
    await staffContext.close();
  }
});
