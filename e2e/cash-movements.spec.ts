import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { dbOne as query, wipeSalesAndCatalog } from "./helpers-db";

const evidence = "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";
// helpers-db shells its SQL argument; keep fixture SQL on a single line.
const dbOne = (sql: string) => query(sql.replace(/\s+/g, " "));

async function setup(page: Page) {
  wipeSalesAndCatalog();
  dbOne("DELETE FROM cash_movements; DELETE FROM credit_abonos; DELETE FROM customers; DELETE FROM shifts");
  const org = dbOne("SELECT id FROM organization WHERE slug='tienda-demo'");
  expect((await page.request.post("/api/auth/sign-in/email", { data: { email: "owner@demo.test", password: "demo12345" } })).ok()).toBe(true);
  expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: org } })).ok()).toBe(true);
  return org;
}
async function caja(page: Page) {
  await page.goto("/");
  await page.getByTestId("tab-arqueo").click();
  await expect(page.locator(".cash-screen")).toHaveAttribute("aria-busy", "false");
}
async function pull(page: Page, org: string) {
  await page.evaluate(async tenant => {
    const { getLocalDb } = await import("/src/db/instance.ts");
    const { rehydrateFromServer } = await import("/src/sync/rehydrate.ts");
    await rehydrateFromServer((await getLocalDb())!.db, tenant);
  }, org);
  await page.getByTestId("tab-sale").click();
  await page.getByTestId("tab-arqueo").click();
}
async function doubleClick(page: Page, id: string) {
  await page.getByTestId(id).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
}
async function shot(page: Page, width: number, state: string) {
  await expect(page.locator(".cash-screen")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${evidence}/m8-${width}-${state}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
}

// Other regression specs inherit an open legacy seed shift. Restore that
// precondition explicitly so the new close tests cannot poison later specs.
test.afterEach(() => {
  const org = dbOne("SELECT id FROM organization WHERE slug='tienda-demo'");
  if (dbOne(`SELECT count(*) FROM shifts WHERE tenant_id='${org}' AND status='open'`) === "0")
    dbOne(`INSERT INTO shifts(id,tenant_id,client_uuid,status) VALUES(gen_random_uuid(),'${org}',gen_random_uuid(),'open')`);
});

for (const width of [1440, 375]) {
  test(`M8 Caja ${width}: explicit base, v2 ledger, manual count, notes, canonical close and stored history`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const org = await setup(page);
    const legacy = randomUUID(), oldV2 = randomUUID();
    // Stored snapshots intentionally differ from later evidence. UI MUST NOT
    // recompute them, or silently upgrade a legacy close to physical drawer.
    for (const [id, version, expected, counted] of [[legacy, "legacy_v1", 24000, 23000], [oldV2, "drawer_cash_v2", 500, 400]] as const) {
      dbOne(`INSERT INTO shifts(id,tenant_id,client_uuid,status,calculation_version,opening_cash) VALUES('${id}','${org}','${id}','closed','${version}',150000);
        INSERT INTO closedcash(id,tenant_id,client_uuid,shift_id,expected,counted,diff,calculation_version,closing_note,created_at)
        VALUES(gen_random_uuid(),'${org}',gen_random_uuid(),'${id}',${expected},${counted},${counted - expected},'${version}','Snapshot histórico','2026-01-01T12:00:00Z')`);
    }
    const historical = dbOne("SELECT json_agg(c ORDER BY shift_id)::text FROM closedcash c");
    await caja(page);
    await expect(page.getByTestId("opening-cash")).toHaveValue("");
    await expect(page.getByTestId("open-shift")).toBeDisabled();
    await expect(page.getByTestId("cash-movement-open")).toBeDisabled();
    await expect(page.getByTestId("close-history")).toContainText("Legacy v1 · consolidado");
    await expect(page.getByTestId("close-history")).toContainText("24.000");
    await shot(page, width, "no-shift");
    for (const invalid of ["-10", "1.5", "1,5", "2147483648", "abc"]) {
      await page.getByTestId("opening-cash").fill(invalid);
      await expect(page.getByTestId("open-shift")).toBeDisabled();
    }
    await page.getByTestId("opening-cash").fill("150000");
    await doubleClick(page, "open-shift");
    await expect(page.getByTestId("shift-card")).toBeVisible();
    const shift = dbOne(`SELECT id FROM shifts WHERE tenant_id='${org}' AND status='open'`);
    expect(dbOne(`SELECT opening_cash || ':' || calculation_version FROM shifts WHERE id='${shift}'`)).toBe("150000:drawer_cash_v2");
    expect(dbOne("SELECT count(*) FROM shifts WHERE status='open'")).toBe("1");
    const session = await (await page.request.get("/api/auth/get-session")).json();
    await expect(page.getByTestId("shift-actor")).toContainText(session.user.name);
    for (const [method, amount] of [["cash", 185000], ["transfer", 72000]] as const) {
      const ticket = randomUUID();
      dbOne(`INSERT INTO tickets(id,tenant_id,client_uuid,shift_id,ticket_no,total,status) VALUES('${ticket}','${org}','${ticket}','${shift}',${amount},${amount},'completed');
        INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,shift_id,method,amount,status) VALUES(gen_random_uuid(),'${org}',gen_random_uuid(),'${ticket}','${shift}','${method}',${amount},'confirmed')`);
    }
    await pull(page, org);
    await expect(page.getByTestId("expected-total")).toContainText("335.000");
    await expect(page.getByTestId("expected-transfers")).toContainText("72.000");
    await expect(page.getByTestId("counted")).toHaveValue("");
    await expect(page.getByTestId("close-shift")).toBeDisabled();
    await expect(page.getByTestId("cash-difference")).toContainText("Ingresá un valor");
    await shot(page, width, "open");

    const trigger = page.getByTestId("cash-movement-open");
    await trigger.click();
    await expect(page.getByTestId("movement-amount")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(page.getByTestId("movement-save")).toBeDisabled();
    await page.getByTestId("movement-reason").fill("Reposición de cambio");
    for (const invalid of ["0", "-2", "3.5", "2147483648"]) {
      await page.getByTestId("movement-amount").fill(invalid);
      await expect(page.getByTestId("movement-save")).toBeDisabled();
    }
    await page.getByTestId("movement-amount").fill("10000");
    await page.getByTestId("movement-note").fill("Entrega documentada");
    await shot(page, width, "movement");
    if (width === 375) {
      await page.setViewportSize({ width, height: 520 });
      await page.getByTestId("movement-save").scrollIntoViewIfNeeded();
      await expect(page.getByTestId("movement-save")).toBeInViewport();
      await shot(page, width, "movement-short-viewport");
      await page.setViewportSize({ width, height: 1000 });
    }
    await doubleClick(page, "movement-save");
    await expect(page.getByTestId("expected-total")).toContainText("345.000");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByTestId("movement-out").click();
    await page.getByTestId("movement-amount").fill("3000");
    await page.getByTestId("movement-reason").fill("Pago a proveedor");
    await page.getByTestId("movement-save").click();
    await expect(page.getByTestId("expected-total")).toContainText("342.000");
    await expect(page.getByTestId("cash-movement-row")).toHaveCount(2);
    await page.getByRole("button", { name: "Cerrar Turno Actual" }).click();
    await expect(page.getByTestId("counted")).toBeFocused();
    for (const invalid of ["-3000", "342000.5", "342000,5", "2147483648", ""]) {
      await page.getByTestId("counted").fill(invalid);
      await expect(page.getByTestId("close-shift")).toBeDisabled();
    }
    for (const [value, label] of [["341999", "Faltante"], ["342001", "Sobrante"], ["342000", "Cuadre Exacto"]]) {
      await page.getByTestId("counted").fill(value);
      await expect(page.getByTestId("cash-difference")).toContainText(label);
    }
    await page.getByTestId("closing-note").fill("Contado manualmente, sin diferencias. ñ");
    const toastClose = page.getByRole("button", { name: "Cerrar aviso", exact: true });
    if (await toastClose.isVisible()) await toastClose.click();
    await page.getByTestId("counted").scrollIntoViewIfNeeded();
    await shot(page, width, "count");
    let closes = 0;
    page.on("request", request => { if (request.method() === "POST" && /\/api\/shifts\/.*\/close$/.test(request.url())) closes++; });
    await doubleClick(page, "close-shift");
    await expect(page.getByTestId("no-open-shift")).toBeVisible();
    expect(closes).toBe(1);
    expect(dbOne(`SELECT expected || ':' || counted || ':' || diff || ':' || closing_note || ':' || calculation_version FROM closedcash WHERE shift_id='${shift}'`)).toBe("342000:342000:0:Contado manualmente, sin diferencias. ñ:drawer_cash_v2");
    expect(dbOne("SELECT count(*) FROM cash_movements")).toBe("2");
    expect(dbOne("SELECT count(*) FROM payments")).toBe("2");
    expect(dbOne(`SELECT json_agg(c ORDER BY shift_id)::text FROM closedcash c WHERE shift_id<>'${shift}'`)).toBe(historical);
    await page.reload();
    await page.getByTestId("tab-arqueo").click();
    await expect(page.getByTestId("close-history")).toContainText("Contado manualmente, sin diferencias. ñ");
    await expect(page.getByTestId("close-history-row")).toHaveCount(3);
    await expect(page.getByTestId("close-history")).toContainText("Guardado en servidor");
    await page.getByTestId("close-history").scrollIntoViewIfNeeded();
    await shot(page, width, "closed-history");
    await page.getByRole("region", { name: "Historial de cierres" }).evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await shot(page, width, "history-details");
  });
}

test("M8 offline: opening, withdrawal, close note survive reload; dependency replay ACK preserves snapshots", async ({ page, context }) => {
  const flag = "pos:e2e-offline-m8";
  await context.addInitScript(f => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => localStorage.getItem(f) !== "1" }), flag);
  const org = await setup(page);
  await caja(page);
  await context.route("**/api/sync/**", route => route.abort());
  await page.evaluate(f => { localStorage.setItem(f, "1"); window.dispatchEvent(new Event("offline")); }, flag);
  await page.getByTestId("opening-cash").fill("10000");
  await page.getByTestId("open-shift").click();
  await page.getByTestId("cash-movement-open").click();
  await page.getByTestId("movement-out").click();
  await page.getByTestId("movement-amount").fill("3000");
  await page.getByTestId("movement-reason").fill("Retiro offline");
  await page.getByTestId("movement-save").click();
  await expect(page.getByTestId("expected-total")).toContainText("7.000");
  await page.reload(); await page.getByTestId("tab-arqueo").click();
  await expect(page.getByTestId("expected-total")).toContainText("7.000");
  await expect(page.getByTestId("cash-movement-row")).toContainText("Retiro offline");
  await expect(page.getByTestId("counted")).toHaveValue("");
  await page.getByTestId("counted").fill("7000");
  await page.getByTestId("closing-note").fill("Cierre offline revisado");
  await doubleClick(page, "close-shift");
  await expect(page.getByTestId("close-history")).toContainText("Pendiente de sincronización");
  expect(dbOne("SELECT count(*) FROM closedcash")).toBe("0");
  await page.reload(); await page.getByTestId("tab-arqueo").click();
  await expect(page.getByTestId("close-history")).toContainText("Cierre offline revisado");
  await expect(page.getByTestId("cash-movement-open")).toBeDisabled();
  await expect(page.getByTestId("cash-staleness")).toContainText("Sin conexión");
  await page.getByTestId("close-history").scrollIntoViewIfNeeded();
  await page.getByRole("region", { name: "Historial de cierres" }).evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await shot(page, 375, "offline-history");
  await context.unroute("**/api/sync/**");
  await page.evaluate(f => { localStorage.removeItem(f); window.dispatchEvent(new Event("online")); }, flag);
  await expect.poll(() => dbOne("SELECT count(*) FROM closedcash"), { timeout: 20000 }).toBe("1");
  const before = dbOne("SELECT row_to_json(c)::text FROM closedcash c");
  expect(dbOne("SELECT expected || ':' || diff || ':' || closing_note FROM closedcash")).toBe("7000:0:Cierre offline revisado");
  expect(dbOne("SELECT count(*) FROM cash_movements")).toBe("1");
  const replay = await page.evaluate(async () => {
    const w = window as unknown as { __pos: { pushNow: () => Promise<void>; repushSynced: () => Promise<{ status: string }[]> } };
    await w.__pos.pushNow(); return w.__pos.repushSynced();
  });
  expect(replay.every(r => r.status === "duplicate")).toBe(true);
  expect(dbOne("SELECT row_to_json(c)::text FROM closedcash c")).toBe(before);
  expect(dbOne("SELECT count(*) FROM payments")).toBe("0");
  await pull(page, org);
  await expect(page.getByTestId("close-history")).toContainText("Guardado en servidor");
});

test("M8 existing open legacy keeps consolidated semantics with transfers, base and movements disclosed", async ({ page }) => {
  const org = await setup(page), shift = randomUUID();
  dbOne(`INSERT INTO shifts(id,tenant_id,client_uuid,status,opening_cash) VALUES('${shift}','${org}','${shift}','open',10000);
    INSERT INTO tickets(id,tenant_id,client_uuid,shift_id,ticket_no,total,status) VALUES(gen_random_uuid(),'${org}',gen_random_uuid(),'${shift}',1,5000,'completed'),(gen_random_uuid(),'${org}',gen_random_uuid(),'${shift}',2,9000,'completed');
    INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,shift_id,method,amount,status) SELECT gen_random_uuid(),'${org}',gen_random_uuid(),id,'${shift}',CASE WHEN ticket_no=1 THEN 'cash' ELSE 'transfer' END,total,'confirmed' FROM tickets WHERE shift_id='${shift}'`);
  await caja(page);
  await expect(page.getByTestId("expected-total")).toContainText("14.000");
  await expect(page.getByTestId("expected-card")).toContainText("NO es efectivo físico");
  await expect(page.locator(".cash-count")).toContainText("no solo la gaveta");
  await expect(page.getByTestId("shift-actor")).toHaveText("No registrado");
  await page.getByTestId("cash-movement-open").click();
  await page.getByTestId("movement-amount").fill("1000");
  await page.getByTestId("movement-reason").fill("Legacy registrado, no sumado");
  await page.getByTestId("movement-save").click();
  await expect(page.getByTestId("expected-income")).toContainText("1.000");
  await expect(page.getByTestId("expected-total")).toContainText("14.000");
  await shot(page, 375, "legacy-open");
  await page.getByRole("button", { name: "Cerrar aviso", exact: true }).click();
  await page.locator(".cash-count").scrollIntoViewIfNeeded();
  await shot(page, 375, "legacy-policy");
  await page.getByTestId("counted").fill("14000");
  await page.getByTestId("closing-note").fill("Consolidado legacy conservado");
  await page.getByTestId("close-shift").click();
  await expect(page.getByTestId("no-open-shift")).toBeVisible();
  expect(dbOne("SELECT expected || ':' || calculation_version FROM closedcash")).toBe("14000:legacy_v1");
});
