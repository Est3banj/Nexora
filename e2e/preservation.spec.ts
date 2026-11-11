import { expect, test, type Page } from "@playwright/test";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";

const flag = "pos:e2e-preservation-offline";
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(runtimeErrors.get(page)).toEqual([]); });
async function localState(page: Page) {
  return page.evaluate(async () => {
    const { getLocalDb } = await import("/src/db/instance.ts");
    const h = (await getLocalDb())!;
    const count = async (table: string, where = "") => Number((await h.db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} ${where}`)).rows[0].n);
    return { url: h.url, tickets: await count("tickets"), work: await count("sync_log", "WHERE status<>'synced'"), products: await count("products"), snapshots: await count("sync_sale_outbox") };
  });
}
async function setup(page: Page) {
  wipeSalesAndCatalog();
  dbOne("DELETE FROM sync_sale_operations");
  dbOne("UPDATE shifts SET status='closed'");
  const org = dbOne("SELECT id FROM organization WHERE slug='tienda-demo'");
  dbOne(`INSERT INTO shifts(id,tenant_id,client_uuid,status) VALUES(gen_random_uuid(),'${org}',gen_random_uuid(),'open')`);
  expect((await page.request.post("/api/auth/sign-in/email", { data: { email: "owner@demo.test", password: "demo12345" } })).ok()).toBe(true);
  expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: org } })).ok()).toBe(true);
  return org;
}
async function seed(page: Page) {
  expect((await page.request.post("/api/catalog/products", { data: { name: "Venta protegida", variant: { name: "Único", price: 100, cost: 40, code: "SAFE-1", stock: 10 } } })).status()).toBe(201);
  await page.goto("/");
  await page.getByTestId("tab-sale").click();
  await expect(page.getByTestId("sale-item")).toHaveCount(1);
}
async function sell(page: Page) {
  await page.getByTestId("sale-item").click();
  if ((page.viewportSize()?.width ?? 375) < 1024) await page.getByTestId("checkout-open").click();
  await page.getByTestId("quick-cash-exact").click(); // tendered is never auto-filled
  await page.getByTestId("checkout-confirm").click();
  await expect(page.getByTestId("sale-success")).toBeVisible();
}
async function login(page: Page, email = "owner@demo.test", password = "demo12345") {
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
}

for (const width of [375, 1440]) {
  test.describe(`preservation ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("logout waits for ACK; signOut failure keeps data, retry clears after session closes", async ({ page }, info) => {
      await setup(page);
      await seed(page);
      let release!: () => void;
      let sent!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { sent = resolve; });
      await page.route("**/api/sync/mutations", async route => { sent(); await held; await route.continue(); });
      await sell(page);
      await started;
      await page.route("**/api/auth/sign-out", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "auth temporarily unavailable" }) }));
      await page.getByTestId("sign-out").click();
      await expect(page.getByTestId("logout-busy")).toBeVisible();
      await expect(page.getByTestId("transition-retry")).toBeDisabled();
      expect((await localState(page)).tickets).toBe(1);
      release();
      await expect(page.getByTestId("logout-blocked")).toBeVisible();
      expect((await localState(page)).tickets).toBe(1);
      expect((await localState(page)).work).toBe(0);
      await page.screenshot({ path: info.outputPath(`logout-auth-failure-${width}.png`), fullPage: true });
      await page.unroute("**/api/auth/sign-out");
      await page.getByTestId("transition-retry").click();
      await expect(page.getByTestId("login-submit")).toBeVisible();
      expect(await localState(page)).toMatchObject({ tickets: 0, work: 0, products: 0, snapshots: 0 });
      await expect(page.getByTestId("recovery-note")).toHaveCount(0);
      expect(dbOne("SELECT count(*) FROM tickets")).toBe("1");
      await page.screenshot({ path: info.outputPath(`logout-complete-${width}.png`), fullPage: true });
    });

    test("offline logout survives reload, expired auth and foreign login; original tenant recovers exactly once", async ({ page, context }, info) => {
      await setup(page);
      await context.addInitScript(f => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => localStorage.getItem(f) !== "1" }), flag);
      await seed(page);
      await page.evaluate(f => localStorage.setItem(f, "1"), flag);
      await context.setOffline(true);
      await sell(page);
      await page.getByTestId("sign-out").click();
      await expect(page.getByTestId("logout-blocked")).toBeVisible();
      expect(await localState(page)).toMatchObject({ tickets: 1, work: 5 });
      await page.screenshot({ path: info.outputPath(`logout-offline-${width}.png`), fullPage: true });
      await context.setOffline(false); // dev shell reachable; navigator remains offline
      await page.reload();
      await expect(page.getByTestId("tab-tickets")).toBeVisible();
      expect(await localState(page)).toMatchObject({ tickets: 1, work: 5 });
      // Expire the server-side session while keeping the browser/local DB.
      dbOne("DELETE FROM session WHERE \"userId\"=(SELECT id FROM \"user\" WHERE email='owner@demo.test')");
      await page.reload();
      await expect(page.getByTestId("login-submit")).toBeVisible();
      await expect(page.getByTestId("recovery-note")).toBeVisible();
      expect(await localState(page)).toMatchObject({ tickets: 1, work: 5 });
      await page.evaluate(f => localStorage.removeItem(f), flag);
      const email = `other-${width}@recovery.test`;
      expect((await page.request.post("/api/auth/sign-up/email", { data: { email, password: "other12345", name: "Otro comercio" } })).ok()).toBe(true);
      const created = await page.request.post("/api/auth/organization/create", { data: { name: "Comercio ajeno", slug: `other-${width}` } });
      expect(created.ok()).toBe(true);
      const org = await created.json();
      expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: org.id } })).ok()).toBe(true);
      await page.reload();
      await expect(page.getByTestId("access-blocked")).toContainText("otro comercio");
      await expect(page.getByTestId("tab-tickets")).toHaveCount(0);
      expect(await localState(page)).toMatchObject({ tickets: 1, work: 5 });
      expect(dbOne(`SELECT count(*) FROM tickets WHERE tenant_id='${org.id}'`)).toBe("0");
      await page.screenshot({ path: info.outputPath(`tenant-blocked-${width}.png`), fullPage: true });
      await page.getByTestId("reauthenticate").click();
      await expect(page.getByTestId("recovery-note")).toBeVisible();
      await page.screenshot({ path: info.outputPath(`recovery-login-${width}.png`), fullPage: true });
      await login(page);
      await expect(page.getByTestId("tab-tickets")).toBeVisible();
      await expect.poll(async () => (await localState(page)).work).toBe(0);
      expect(dbOne("SELECT count(*) FROM tickets")).toBe("1");
      expect(dbOne("SELECT sum(amount) FROM payments")).toBe("100");
      await page.getByTestId("sign-out").click();
      await expect(page.getByTestId("login-submit")).toBeVisible();
      expect(await localState(page)).toMatchObject({ tickets: 0, products: 0, work: 0 });
    });

    test("old datadir blocks upgrade without skip; retry online ACKs then switches and rehydrates", async ({ page, context }, info) => {
      const tenant = await setup(page);
      await context.addInitScript(f => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => localStorage.getItem(f) !== "1" }), flag);
      // Same-origin non-app document lets us seed a real old IndexedDB before
      // App opens the singleton. This is a migration, not a DB deletion.
      await page.goto("/favicon.svg");
      await page.evaluate(async ({ tenant, flag }) => {
        const { openLocalDb } = await import("/src/db/pglite.ts");
        const { createLocalProduct } = await import("/src/db/local.ts");
        const old = (await openLocalDb({ url: "idb://pos_v2", locks: null }))!;
        await createLocalProduct(old.db, tenant, { name: "Pendiente anterior", variant: { name: "Único", price: 100, code: "OLD-SAFE", stock: 4 } });
        await old.db.close();
        localStorage.setItem("pos:datadir-version", "2");
        localStorage.setItem(flag, "1");
      }, { tenant, flag });
      await page.goto("/");
      await expect(page.getByTestId("upgrade-blocked")).toBeVisible();
      await expect(page.getByTestId("upgrade-continue")).toHaveCount(0);
      expect((await localState(page)).url).toBe("idb://pos_v2");
      expect(await page.evaluate(() => localStorage.getItem("pos:datadir-version"))).toBe("2");
      await page.screenshot({ path: info.outputPath(`upgrade-blocked-${width}.png`), fullPage: true });
      await page.evaluate(f => localStorage.removeItem(f), flag);
      await page.getByTestId("transition-retry").click();
      await expect(page.getByTestId("tab-sale")).toBeVisible();
      await page.getByTestId("tab-sale").click();
      await expect(page.getByTestId("sale-item")).toContainText("Pendiente anterior");
      expect((await localState(page)).url).toBe("idb://pos_v3");
      expect(await page.evaluate(() => localStorage.getItem("pos:datadir-version"))).toBe("3");
      expect(await page.evaluate(async () => (await indexedDB.databases()).some(d => d.name?.includes("pos_v2")))).toBe(true);
      await page.screenshot({ path: info.outputPath(`upgrade-complete-${width}.png`), fullPage: true });
    });
  });
}
