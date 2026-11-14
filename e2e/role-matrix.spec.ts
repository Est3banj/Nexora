import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { dbOne } from "./helpers-db";
import { createOrgUser } from "./helpers-auth";

/**
 * Batch 8 · 8.2 — role matrix e2e (REUSE, not duplicate):
 * covered elsewhere and NOT repeated here: 5/8 tab counts + employee
 * lifecycle (batch6-admin.spec), member `client-abono` + void/transfer
 * absence with toggle OFF (fiado.spec M6), owner palette path
 * (palette.spec), member traversal (modernization.spec). This spec only
 * fills the gaps: palette == nav for the member, the screen guard on a
 * forced Panel navigation, member read-only catalog, and the member
 * abono happy path + overpay edge.
 *
 * Screenshots are captured for the HUMAN visual audit only — never read
 * back by the suite.
 */
const evidence =
  "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";

async function tenant(page: Page) {
  const tag = randomUUID();
  expect((await page.request.post("/api/auth/sign-up/email", { data: {
    name: "Dueña de prueba RM", email: `rm-${tag}@test.dev`, password: "roles-test-only-123",
  } })).ok()).toBe(true);
  const res = await page.request.post("/api/auth/organization/create", { data: { name: "Tienda de prueba RM", slug: `rm-${tag}` } });
  expect(res.ok()).toBe(true);
  const org = (await res.json()).id as string;
  expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: org } })).ok()).toBe(true);
  return org;
}

test("member palette mirrors the five-tab nav and catalog is browse-only", async ({ page, browser }) => {
  const org = await tenant(page);
  // Catalog exists server-side BEFORE the member's first boot (rehydrate).
  expect((await page.request.post("/api/catalog/products", { data: {
    name: "Café roles E2E", variant: { name: "Único", price: 2500, cost: 1000, stock: 5 },
  } })).ok()).toBe(true);
  const staffContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 375, height: 812 },
  });
  try {
    const staff = await staffContext.newPage();
    await createOrgUser(staffContext.request, org, "member", "rm-member");
    await staff.goto("/");
    await expect(staff.getByTestId("tab-sale")).toBeVisible();
    await expect(staff.locator(".tabbar button")).toHaveCount(5);
    for (const id of ["tab-dashboard", "tab-reports", "tab-admin"]) {
      await expect(staff.getByTestId(id)).toHaveCount(0);
    }
    /* palette agrees with nav: the five member destinations are listed,
     * no protected destination ever appears (menu-visibility §Nav and palette agree) */
    await staff.keyboard.press("Control+k");
    const texts = await staff.getByTestId("palette-item").allTextContents();
    expect(texts.filter(t => /Panel|Reportes|Administración/.test(t))).toEqual([]);
    for (const label of ["Venta", "Caja", "Tickets", "Catálogo", "Fiados"]) {
      expect(texts.some(t => t.includes(label))).toBe(true);
    }
    await staff.keyboard.press("Escape");
    await expect(staff.getByTestId("palette-input")).toHaveCount(0);
    /* catalog: visible + browsable, zero write affordances (read-only) */
    await staff.getByTestId("tab-catalog").click();
    await expect(staff.getByTestId("product-item").filter({ hasText: "Café roles E2E" })).toBeVisible();
    await staff.getByTestId("catalog-search").fill("Café roles");
    await expect(staff.getByTestId("product-item")).toHaveCount(1);
    for (const id of ["product-new", "toggle-active", "product-edit", "new-category-name", "category-create"]) {
      await expect(staff.getByTestId(id)).toHaveCount(0);
    }
    /* human-visual-audit evidence (1440 + 375) — captured, never read */
    await staff.setViewportSize({ width: 1440, height: 1000 });
    await staff.screenshot({ path: `${evidence}/batch8-role-matrix-1440-member-menu.png`, fullPage: true });
    await staff.setViewportSize({ width: 375, height: 812 });
    await staff.screenshot({ path: `${evidence}/batch8-role-matrix-375-member-menu.png`, fullPage: true });
  } finally {
    await staffContext.close();
  }
});

test("forced Panel navigation falls back after demotion; stale owner hint never grants the API", async ({ page, context }) => {
  const org = await tenant(page);
  const session = await (await page.request.get("/api/auth/get-session")).json();
  const ownerUserId = session.user.id as string;
  await page.goto("/");
  await expect(page.getByTestId("tab-sale")).toBeVisible();
  /* owner deep-link renders the real Panel (menu-visibility §Owner deep-links) */
  await page.getByTestId("tab-dashboard").click();
  await expect(page.getByTestId("kpi-revenue")).toBeVisible();
  /* demote server-side while the owner hint is still cached client-side */
  dbOne(`UPDATE member SET role='member' WHERE "userId"='${ownerUserId}' AND "organizationId"='${org}'`);
  const hint = JSON.parse(await page.evaluate(() => sessionStorage.getItem("pos:member-role") ?? "null")) as { role?: string } | null;
  expect(hint?.role).toBe("owner"); // the hint is now STALE
  /* the server's current role decides — a stale hint cannot grant writes */
  const forged = await page.request.post("/api/catalog/products", { data: {
    name: "No debe crearse", variant: { name: "Único", price: 1, cost: 0, stock: 1 },
  } });
  expect(forged.status()).toBe(403);
  expect(await forged.json()).toEqual({ error: "forbidden", detail: "dueño_only" });
  /* refresh the role hint without losing the forced navigation:
   * offline → online re-runs the role effect (deps include sync.online) */
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  /* guard follows the matrix: access-denied fallback, zero protected data */
  await expect(page.getByTestId("tab-blocked")).toBeVisible();
  await expect(page.getByTestId("kpi-revenue")).toHaveCount(0);
  await page.getByTestId("tab-blocked-back").click();
  await expect(page.getByTestId("tab-sale")).toHaveClass(/active/);
});

test("member registers a cash abono; overpay never commits", async ({ page, browser }) => {
  const org = await tenant(page);
  const customer = randomUUID(), sale = randomUUID();
  /* debt fixture + open shift BEFORE the member's first boot (rehydrate) */
  dbOne(`INSERT INTO customers (id,tenant_id,client_uuid,name,credit_limit,active)
      VALUES ('${customer}','${org}','${customer}','Deudora Roles',100000,TRUE);
    INSERT INTO tickets (id,tenant_id,client_uuid,ticket_no,status,total,customer_id)
      VALUES ('${sale}','${org}','${sale}',501,'completed',50000,'${customer}');
    INSERT INTO payments (id,tenant_id,client_uuid,ticket_id,method,amount,status)
      VALUES (gen_random_uuid(),'${org}',gen_random_uuid(),'${sale}','credit',50000,'confirmed');
    INSERT INTO shifts (id,tenant_id,client_uuid,status)
      VALUES (gen_random_uuid(),'${org}',gen_random_uuid(),'open');`.replace(/\s+/g, " "));
  const staffContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 375, height: 812 },
  });
  try {
    const staff = await staffContext.newPage();
    await createOrgUser(staffContext.request, org, "member", "rm-abono");
    await staff.goto("/");
    await expect(staff.getByTestId("tab-sale")).toBeVisible();
    await staff.getByTestId("tab-credito").click();
    const debt = staff.getByTestId("client-card").filter({ hasText: "Deudora Roles" });
    await expect(debt.getByTestId("client-balance")).toContainText("50.000");
    await debt.getByTestId("client-abono").click();
    await expect(staff.getByTestId("abono-modal")).toBeVisible();
    /* edge: amount > balance is rejected — never clamped, never committed */
    await staff.getByTestId("abono-amount").fill("60000");
    await expect(staff.getByTestId("abono-overpay")).toContainText("50.000");
    await expect(staff.getByTestId("abono-confirm")).toBeDisabled();
    /* happy path: the member registers a cash abono (decision #1 flip) */
    await staff.getByTestId("abono-amount").fill("20000");
    await expect(staff.getByTestId("abono-confirm")).toBeEnabled();
    await staff.getByTestId("abono-confirm").click();
    await expect(staff.getByTestId("receipt-preview")).toBeVisible();
    await expect(staff.getByTestId("abono-detail")).toContainText("Deudora Roles");
    await expect(staff.getByTestId("abono-detail")).toContainText("20.000");
    await staff.getByTestId("receipt-close").click();
    await staff.evaluate(() =>
      (window as unknown as { __pos: { pushNow: () => Promise<void> } }).__pos.pushNow(),
    );
    await expect
      .poll(() => dbOne(`SELECT count(*) FROM credit_abonos WHERE tenant_id='${org}'`), { timeout: 15_000 })
      .toBe("1");
    expect(dbOne(`SELECT amount FROM credit_abonos WHERE tenant_id='${org}'`)).toBe("20000");
    /* an abono is never a sale: payments/tickets stay untouched */
    expect(dbOne(`SELECT count(*) FROM payments WHERE tenant_id='${org}'`)).toBe("1");
    expect(dbOne(`SELECT count(*) FROM tickets WHERE tenant_id='${org}'`)).toBe("1");
  } finally {
    await staffContext.close();
  }
});
