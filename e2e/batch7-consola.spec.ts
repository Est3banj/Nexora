import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { dbOne } from "./helpers-db";
import { makePlatformAdmin } from "./helpers-auth";

// Batch 7's own regression slice; 8.1/8.5 integration/refactor remain pending.
// Authorization is always real: flag is seeded like founder-api.test.ts.
const evidence = "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";
const keys = ["tenant_id", "name", "slug", "users", "pending", "last_sync", "errors", "last_error"].sort();
async function account(page: Page, platform = true, withOrg = true) {
  const tag = randomUUID(), email = `b7-${tag}@test.dev`, password = "batch7-test-only-123";
  const signup = await page.request.post("/api/auth/sign-up/email", { data: { name: "Operador B7", email, password } });
  expect(signup.ok()).toBe(true);
  const user = (await signup.json()).user.id as string;
  let org: string | null = null;
  if (withOrg) {
    const res = await page.request.post("/api/auth/organization/create", { data: { name: `Tienda B7 ${tag}`, slug: `b7-${tag}` } });
    expect(res.ok()).toBe(true); org = (await res.json()).id;
  }
  if (platform) makePlatformAdmin(email);
  expect((await page.request.post("/api/auth/sign-out")).ok()).toBe(true);
  // Actual UI login, so the session includes the server-controlled flag.
  await page.goto("/");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId(withOrg ? "tab-sale" : "no-tenant")).toBeVisible();
  return { user, org, email, password };
}
async function open(page: Page, width: number) {
  if (width < 768 && await page.getByLabel("Cuenta y caja", { exact: true }).count() && !await page.getByTestId("consola-entry").isVisible()) await page.getByLabel("Cuenta y caja", { exact: true }).click();
  await page.getByTestId("consola-entry").click();
  await expect(page.getByTestId("consola-screen")).toBeVisible();
  await expect(page.locator(".nexora-shell")).toHaveCount(0);
}
async function capture(page: Page, width: number, state: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  expect(await page.locator(".consola-main").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: `${evidence}/batch7-${width}-${state}.png`, fullPage: true });
}
async function localState(page: Page) {
  return page.evaluate(async () => {
    const { getLocalDb } = await import("/src/db/instance.ts");
    const h = (await getLocalDb())!;
    return { url: h.url, rows: (await h.db.query("SELECT client_uuid, tenant_id, entity, payload, status FROM sync_log WHERE status <> 'synced' ORDER BY client_uuid")).rows };
  });
}

for (const width of [1440, 375]) {
  test.describe(`Batch 7 Consola ${width}`, () => {
    test.use({ viewport: { width, height: 1000 } });
    test("platform login → metadata overview/list → create tenant; keyboard and app/tenant preserved", async ({ page, browser }) => {
      const actor = await account(page);
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(e.message));
      // Positive health fixture; no business content may cross founder boundary.
      const id = randomUUID();
      dbOne(`INSERT INTO sync_log(id,tenant_id,client_uuid,client_ts,entity,op,payload,status,last_error) VALUES('${id}','${actor.org}','${id}',1,'product','upsert','{"name":"PRODUCTO PRIVADO B7"}','failed','validation')`);
      const metadata = await page.request.get("/api/founder/sync-status");
      expect(metadata.status()).toBe(200); expect(metadata.headers()["cache-control"]).toBe("no-store");
      const body = await metadata.json(); expect(Object.keys(body)).toEqual(["tenants"]);
      for (const row of body.tenants) expect(Object.keys(row).sort()).toEqual(keys);
      expect(JSON.stringify(body)).not.toContain("PRODUCTO PRIVADO B7");
      await page.getByTestId("tab-catalog").click();
      await page.keyboard.press("Control+k");
      await page.getByTestId("palette-input").fill("Consola");
      await expect(page.getByTestId("palette-item")).toHaveCount(0); await page.keyboard.press("Escape");
      let showMetadata!: () => void;
      const metadataHeld = new Promise<void>(resolve => { showMetadata = resolve; });
      await page.route("**/api/founder/sync-status", async route => {
        const real = await route.fetch(); expect(real.status()).toBe(200);
        await metadataHeld; await route.fulfill({ response: real });
      });
      await open(page, width);
      await expect(page.locator(".consola-header h1")).toBeFocused();
      await expect(page.getByRole("status")).toHaveText("Consultando la plataforma…");
      await expect(page.getByTestId("consola-tenants")).toHaveCount(0);
      await capture(page, width, "loading");
      showMetadata();
      await expect(page.getByTestId("consola-tenants")).toHaveText(String(body.tenants.length));
      await page.unroute("**/api/founder/sync-status");
      await expect(page.getByTestId("consola-pending")).toHaveText(String(body.tenants.reduce((n: number, r: { pending: number }) => n + r.pending, 0)));
      await expect(page.getByTestId("consola-errors")).toHaveText(String(body.tenants.reduce((n: number, r: { errors: number }) => n + r.errors, 0)));
      await expect(page.getByRole("navigation", { name: "Consola de plataforma" }).getByRole("button")).toHaveCount(2);
      await capture(page, width, "overview");
      await page.getByTestId("consola-nav-overview").focus(); await page.keyboard.press("Tab");
      await expect(page.getByTestId("consola-nav-tenants")).toBeFocused(); await page.keyboard.press("Enter");
      await expect(page.locator(".consola-header h1")).toHaveText("Tiendas / Tenants");
      await expect(page.getByTestId("consola-tenant")).toHaveCount(body.tenants.length);
      const ownRow = page.getByTestId("consola-tenant").filter({ hasText: `b7-${actor.email.slice(3).split("@")[0]}` });
      await expect(ownRow).toContainText("validation");
      await capture(page, width, "tenants");
      const tag = randomUUID(), email = `b7-new-${tag}@test.dev`, name = `Tienda creada B7 ${tag}`, password = "b7-initial-test-only-123";
      await page.getByTestId("consola-create-name").fill(name);
      await page.getByTestId("consola-create-slug").fill(`b7-new-${tag}`);
      await page.getByTestId("consola-create-email").fill(email);
      await page.getByTestId("consola-create-password").fill(password);
      // Hold a real POST to verify busy state, without faking authorization.
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      await page.route("**/api/founder/tenants", async route => { await held; await route.continue(); });
      const response = page.waitForResponse(r => r.url().endsWith("/api/founder/tenants") && r.request().method() === "POST");
      await page.getByTestId("consola-create-submit").click();
      await expect(page.getByTestId("consola-create-submit")).toBeDisabled();
      await expect(page.getByTestId("consola-create-password")).toHaveValue(""); release();
      const created = await response; expect(created.status()).toBe(201);
      const result = await created.json();
      expect(Object.keys(result).sort()).toEqual(["audit", "first_user", "tenant"]);
      expect(Object.keys(result.tenant).sort()).toEqual(["id", "name", "slug"]);
      expect(Object.keys(result.first_user).sort()).toEqual(["email", "id"]);
      expect(Object.keys(result.audit)).toEqual(["id"]);
      await expect(page.getByTestId("consola-tenant").filter({ hasText: name })).toBeVisible();
      await expect(page.getByTestId("consola-create-password")).toHaveValue("");
      expect(await page.evaluate(secret => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret), password)).toBe(false);
      expect(page.url()).not.toContain(email); expect(page.url()).not.toContain(password);
      await capture(page, width, "created");
      // Duplicate-email error is real. Secret clears; non-secret fields survive.
      await page.getByTestId("consola-create-name").fill("Duplicado B7");
      await page.getByTestId("consola-create-email").fill(email);
      await page.getByTestId("consola-create-password").fill(password);
      await page.getByTestId("consola-create-submit").click();
      await expect(page.getByRole("alert")).toContainText("ya está en uso");
      await expect(page.getByTestId("consola-create-password")).toHaveValue("");
      await expect(page.getByTestId("consola-create-email")).toHaveValue(email);
      await page.getByTestId("consola-back").click();
      await expect(page.getByTestId("consola-entry")).toBeFocused();
      await expect(page.getByTestId("tab-catalog")).toHaveAttribute("aria-current", "page");
      const session = await (await page.request.get("/api/auth/get-session")).json();
      expect(session.user.id).toBe(actor.user); expect(session.session.activeOrganizationId).toBe(actor.org);
      const customer = await browser.newContext({ baseURL: test.info().project.use.baseURL });
      try {
        expect((await customer.request.post("/api/auth/sign-in/email", { data: { email, password } })).ok()).toBe(true);
        const orgs = await (await customer.request.get("/api/auth/organization/list")).json();
        expect(orgs.map((o: { id: string }) => o.id)).toEqual([result.tenant.id]);
        expect((await customer.request.post("/api/auth/organization/set-active", { data: { organizationId: result.tenant.id } })).ok()).toBe(true);
        expect((await (await customer.request.get("/api/catalog/products")).json()).products).toEqual([]);
      } finally { await customer.close(); }
      expect(errors).toEqual([]);
    });

    test("offline clears metadata/secrets and preserves pending work; retry/error/empty/revocation fail closed", async ({ page }) => {
      const actor = await account(page);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
        window.dispatchEvent(new Event("offline"));
      });
      await page.evaluate(async org => {
        const { getLocalDb } = await import("/src/db/instance.ts");
        const { createLocalProduct } = await import("/src/db/local.ts");
        await createLocalProduct((await getLocalDb())!.db, org!, { name: "Trabajo offline B7", variant: { name: "Único", price: 500 } });
      }, actor.org);
      const pending = await localState(page); expect(pending.rows.length).toBeGreaterThan(0);
      await open(page, width);
      await expect(page.getByRole("alert")).toHaveText("La consola requiere conexión");
      await expect(page.getByTestId("consola-tenants")).toHaveCount(0);
      await capture(page, width, "offline");
      await page.getByTestId("consola-back").click();
      expect(await localState(page)).toEqual(pending);
      await open(page, width);
      // Keep pending work offline even while the founder network is available.
      await page.route("**/api/sync/**", route => route.abort());
      await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true }); window.dispatchEvent(new Event("online")); });
      await expect(page.getByTestId("consola-tenants")).toBeVisible();
      await page.getByTestId("consola-nav-tenants").click();
      await page.getByTestId("consola-create-password").fill("discard-test-secret");
      await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }); window.dispatchEvent(new Event("offline")); });
      await expect(page.getByTestId("consola-tenant")).toHaveCount(0);
      await expect(page.getByTestId("consola-create-password")).toHaveCount(0);
      await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true }); window.dispatchEvent(new Event("online")); });
      await expect(page.getByTestId("consola-create-password")).toHaveValue("");
      // Transport/empty fixtures only AFTER a real founder authorization check.
      await page.route("**/api/founder/sync-status", async route => {
        const real = await route.fetch(); expect(real.status()).toBe(200);
        await route.fulfill({ response: real, status: 503, body: "{}" });
      });
      await page.getByTestId("consola-refresh").click();
      await expect(page.getByRole("alert")).toContainText("No se pudo consultar");
      await expect(page.getByTestId("consola-tenant")).toHaveCount(0);
      await capture(page, width, "error");
      await page.unroute("**/api/founder/sync-status");
      await page.route("**/api/founder/sync-status", async route => {
        const real = await route.fetch(); expect(real.status()).toBe(200);
        await route.fulfill({ response: real, json: { tenants: [] } });
      });
      await page.getByTestId("consola-retry").click();
      await expect(page.getByTestId("consola-empty")).toBeVisible();
      await capture(page, width, "empty");
      await page.unroute("**/api/founder/sync-status");
      await page.getByTestId("consola-refresh").click();
      await expect(page.getByTestId("consola-tenant").first()).toBeVisible();
      // REAL revocation while client still has the previous session flag.
      dbOne(`UPDATE "user" SET "platformAdmin"=false WHERE id='${actor.user}'`);
      await page.getByTestId("consola-refresh").click();
      await expect(page.getByRole("alert")).toContainText("revocado");
      await expect(page.getByTestId("consola-tenant")).toHaveCount(0);
      await expect(page.getByTestId("consola-create-submit")).toHaveCount(0);
      await capture(page, width, "revoked");
      expect((await page.request.post("/api/founder/tenants", { data: { name: "No permitido", email: "denied@test.dev", password: "secret1234" } })).status()).toBe(403);
      // Expired session cannot expose the formerly visible metadata either.
      dbOne(`DELETE FROM session WHERE "userId"='${actor.user}'`);
      await page.getByTestId("consola-retry").click();
      await expect(page.getByRole("alert")).toContainText("La sesión venció");
      await expect(page.getByTestId("consola-tenant")).toHaveCount(0);
    });
  });
}

test("ordinary owner has no account entry and founder denies owner403/unauth401", async ({ page, browser }) => {
  await account(page, false);
  await page.getByLabel("Cuenta y caja", { exact: true }).click();
  await expect(page.getByTestId("consola-entry")).toHaveCount(0);
  for (const endpoint of ["sync-status", "tenants"]) {
    const result = endpoint === "tenants" ? await page.request.post(`/api/founder/${endpoint}`, { data: { name: "No permitido", email: "denied@test.dev", password: "secret1234" } }) : await page.request.get(`/api/founder/${endpoint}`);
    expect(result.status()).toBe(403); expect(await result.json()).toEqual({ error: "forbidden" });
  }
  const anonymous = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    expect((await anonymous.request.get("/api/founder/sync-status")).status()).toBe(401);
    expect((await anonymous.request.post("/api/founder/tenants", { data: { name: "No permitido", email: "denied@test.dev", password: "secret1234" } })).status()).toBe(401);
  } finally { await anonymous.close(); }
});

test("platform admin without tenant can use console and return without choosing an org", async ({ page }) => {
  const actor = await account(page, true, false);
  await open(page, 375);
  await expect(page.getByTestId("consola-tenants")).toBeVisible();
  await page.getByTestId("consola-back").click();
  await expect(page.getByTestId("no-tenant")).toBeVisible();
  const session = await (await page.request.get("/api/auth/get-session")).json();
  expect(session.user.id).toBe(actor.user); expect(session.session.activeOrganizationId ?? null).toBeNull();
});

test("revoked POST clears the loaded list and form; switching views discards unsent secrets", async ({ page }) => {
  const actor = await account(page);
  await open(page, 375);
  await expect(page.getByTestId("consola-tenants")).toBeVisible();
  await page.getByTestId("consola-nav-tenants").click();
  await page.getByTestId("consola-create-password").fill("unsent-secret-test");
  await page.getByTestId("consola-nav-overview").click();
  await page.getByTestId("consola-nav-tenants").click();
  await expect(page.getByTestId("consola-create-password")).toHaveValue("");
  await page.getByTestId("consola-create-name").fill("Revocada B7");
  await page.getByTestId("consola-create-email").fill(`b7-revoked-${randomUUID()}@test.dev`);
  await page.getByTestId("consola-create-password").fill("unsent-secret-test");
  const count = dbOne("SELECT count(*) FROM organization");
  dbOne(`UPDATE "user" SET "platformAdmin"=false WHERE id='${actor.user}'`);
  await page.getByTestId("consola-create-submit").click();
  await expect(page.getByRole("alert")).toContainText("revocado");
  await expect(page.getByTestId("consola-tenant")).toHaveCount(0);
  await expect(page.getByTestId("consola-create-password")).toHaveCount(0);
  expect(dbOne("SELECT count(*) FROM organization")).toBe(count);
});
