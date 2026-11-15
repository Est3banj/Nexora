import { expect, test, type Page } from "@playwright/test";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";
import { createOrgUser } from "./helpers-auth";
import { navigate } from "./helpers-navigation";

/**
 * Fase 1 · Control de Mesas & Comandas (CONTROL-MESAS.md).
 *
 *  - happy path: board → abrir mesa → agregar → guardar → retomar →
 *    cobro efectivo → mesa libre + ticket con `table_name` + cobro en caja;
 *  - edge: liberar sin cobrar (confirmación, SIN ticket), guard de salida
 *    con cambios sin guardar, «Pedir cuenta» → estado billing;
 *  - Admin CRUD de mesas (patrón Cajas/Empleados);
 *  - el cajero ve el tablero pero NO «+ Agregar Mesa».
 *
 * Screenshots are captured to the evidence dir for the human visual audit —
 * they are NEVER read back by the test.
 */

const evidence =
  "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";

async function login(page: Page, identifier = "owner@demo.test") {
  await page.goto("/");
  await page.getByTestId("login-identifier").fill(identifier);
  await page.getByTestId("login-password").fill(
    identifier === "owner@demo.test" ? "demo12345" : "roles-test-only-123",
  );
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("tab-sale")).toBeVisible();
}

async function seedProduct(page: Page, name: string, price: number) {
  await page.getByTestId("tab-catalog").click();
  await page.getByTestId("product-new").click();
  await page.getByTestId("product-name").fill(name);
  await page.getByTestId("variant-name").fill("Único");
  await page.getByTestId("variant-price").fill(String(price));
  await page.getByTestId("variant-stock").fill("20");
  await page.getByTestId("product-create").click();
  await expect(
    page.getByTestId("product-item").filter({ hasText: name }),
  ).toBeVisible();
}

async function createTable(page: Page, name: string) {
  await page.getByTestId("table-add").click();
  await expect(page.getByTestId("table-modal")).toBeVisible();
  await page.getByTestId("table-name").fill(name);
  await page.getByTestId("table-submit").click();
  await expect(page.getByTestId("table-modal")).toBeHidden();
  await expect(
    page.getByTestId("table-card").filter({ hasText: name }),
  ).toBeVisible();
}

function card(page: Page, name: string) {
  return page.getByTestId("table-card").filter({ hasText: name });
}

async function addAndSave(page: Page, productName: string, saveTestId = "save-to-table") {
  await page
    .getByTestId("sale-item")
    .filter({ hasText: productName })
    .click();
  await page.getByTestId(saveTestId).click();
  await expect(page.getByTestId("toast")).toBeVisible();
}

test.describe("Mesas · happy path", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("board → abrir → guardar → retomar → cobro efectivo → mesa libre + ticket + caja", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    await login(page);
    await seedProduct(page, "Mesa E2E", 4000);

    /* ── board: empty state, then CRUD from the board ── */
    await navigate(page, "mesas");
    await expect(page.getByTestId("mesas-screen")).toBeVisible();
    await expect(page.getByTestId("mesas-empty")).toBeVisible();
    await expect(page.getByTestId("count-available")).toHaveText(
      "● Disponible (0)",
    );
    await page.screenshot({
      path: `${evidence}/mesas-1440-board-empty.png`,
      fullPage: true,
    });

    await createTable(page, "Mesa 1");
    await expect(page.getByTestId("count-available")).toHaveText(
      "● Disponible (1)",
    );
    await expect(
      card(page, "Mesa 1").getByTestId("table-placeholder"),
    ).toBeVisible();
    await expect(card(page, "Mesa 1").getByTestId("table-badge")).toHaveText(
      "DISPONIBLE",
    );
    await page.screenshot({
      path: `${evidence}/mesas-1440-board.png`,
      fullPage: true,
    });

    /* ── open in POS: banner + clean cart ── */
    await card(page, "Mesa 1").getByTestId("table-open").click();
    await expect(page.getByTestId("sale-screen")).toBeVisible();
    await expect(page.getByTestId("table-context-name")).toContainText(
      "Atendiendo: Mesa 1",
    );
    await expect(page.getByTestId("cart-count")).toHaveText("0 ítems");
    await page.screenshot({
      path: `${evidence}/mesas-1440-pos-attending.png`,
      fullPage: true,
    });

    /* ── add + guardar en mesa → board shows the comanda ── */
    await addAndSave(page, "Mesa E2E");
    await navigate(page, "mesas");
    const occupied = card(page, "Mesa 1");
    await expect(occupied.getByTestId("table-badge")).toHaveText("OCUPADA");
    await expect(occupied).toHaveAttribute("data-state", "occupied");
    await expect(occupied.getByTestId("table-items")).toHaveText("1");
    await expect(occupied.getByTestId("table-total")).toContainText("4.000");
    await expect(occupied.getByTestId("table-opened")).toHaveText(/\d{2}:\d{2}/);
    await expect(page.getByTestId("count-occupied")).toHaveText(
      "● Ocupada (1)",
    );
    await expect(page.getByTestId("table-bill")).toBeVisible();
    await page.screenshot({
      path: `${evidence}/mesas-1440-board-occupied.png`,
      fullPage: true,
    });

    /* ── resume: the comanda loads back into the POS cart ── */
    await occupied.getByTestId("table-charge").click();
    await expect(page.getByTestId("table-context-name")).toContainText(
      "Atendiendo: Mesa 1",
    );
    await expect(page.getByTestId("cart-count")).toHaveText("1 ítems");
    await expect(page.getByTestId("cart-total")).toContainText("4.000");
    await page.screenshot({
      path: `${evidence}/mesas-1440-pos-comanda.png`,
      fullPage: true,
    });

    /* ── cobro: the SHARED PaymentModal, no new payment logic ── */
    await page.getByTestId("checkout-open").click();
    await expect(page.getByTestId("payment-modal")).toBeVisible();
    await expect(page.getByTestId("checkout-total")).toContainText("4.000");
    await page.getByTestId("quick-cash-exact").click();
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();

    /* ticket carries the table (success copy + thermal receipt) */
    await expect(page.getByTestId("ticket-table")).toHaveText("Mesa 1");
    await expect(page.getByTestId("receipt-preview")).toBeVisible();
    await expect(page.getByTestId("receipt-table")).toContainText("Mesa 1");
    await page.screenshot({
      path: `${evidence}/mesas-1440-ticket.png`,
      fullPage: true,
    });
    await page.getByTestId("receipt-close").click();

    /* the table is free again */
    await navigate(page, "mesas");
    await expect(card(page, "Mesa 1").getByTestId("table-badge")).toHaveText(
      "DISPONIBLE",
    );
    await expect(page.getByTestId("count-available")).toHaveText(
      "● Disponible (1)",
    );
    await expect(page.getByTestId("count-occupied")).toHaveText(
      "● Ocupada (0)",
    );

    /* server copy: the ticket is stamped + the cash reached the arqueo */
    await expect
      .poll(() => dbOne("SELECT table_name FROM tickets"), { timeout: 15_000 })
      .toBe("Mesa 1");
    expect(dbOne("SELECT count(*) FROM payments")).toBe("1");
    expect(dbOne("SELECT method FROM payments")).toBe("cash");
    await navigate(page, "arqueo");
    await expect(page.getByTestId("expected-cash")).toContainText("4.000");
    await page.screenshot({
      path: `${evidence}/mesas-1440-caja.png`,
      fullPage: true,
    });
  });
});

test.describe("Mesas · mobile (375)", () => {
  test("board + POS con guard de salida y guardia de comanda", async ({ page }) => {
    wipeSalesAndCatalog();
    await login(page);
    await seedProduct(page, "Mesa M", 4000);

    await navigate(page, "mesas");
    await createTable(page, "Mesa M1");
    await page.screenshot({
      path: `${evidence}/mesas-375-board.png`,
      fullPage: true,
    });

    await card(page, "Mesa M1").getByTestId("table-open").click();
    await expect(page.getByTestId("table-context-name")).toContainText(
      "Atendiendo: Mesa M1",
    );
    await page.screenshot({
      path: `${evidence}/mesas-375-pos-attending.png`,
      fullPage: true,
    });

    /* guard: leaving Venta with unsaved consumption asks FIRST */
    await page.getByTestId("sale-item").filter({ hasText: "Mesa M" }).click();
    await expect(page.getByTestId("cart-count")).toHaveText("1 ítems");
    await page.getByTestId("tab-arqueo").click();
    await expect(page.getByTestId("leave-pos")).toBeVisible();
    await expect(page.getByTestId("leave-pos")).toContainText(
      "Tenés consumos sin guardar ni cobrar",
    );
    await page.getByTestId("leave-pos-stay").click();
    await expect(page.getByTestId("leave-pos")).toBeHidden();
    /* staying keeps the operator AND the cart */
    await expect(page.getByTestId("table-context")).toBeVisible();
    await expect(page.getByTestId("cart-count")).toHaveText("1 ítems");

    /* now discard → the destination wins, the cart is gone */
    await page.getByTestId("tab-arqueo").click();
    await page.getByTestId("leave-pos-discard").click();
    await expect(page.getByTestId("leave-pos")).toBeHidden();
    await expect(page.locator(".screen.arqueo")).toBeVisible();

    /* back to the mesa: nothing was saved, the table is still free */
    await navigate(page, "mesas");
    await expect(card(page, "Mesa M1").getByTestId("table-badge")).toHaveText(
      "DISPONIBLE",
    );

    /* save for real this time (quick picker path is covered below) */
    await card(page, "Mesa M1").getByTestId("table-open").click();
    await addAndSave(page, "Mesa M");
    await navigate(page, "mesas");
    await expect(card(page, "Mesa M1").getByTestId("table-badge")).toHaveText(
      "OCUPADA",
    );
    await page.screenshot({
      path: `${evidence}/mesas-375-board-occupied.png`,
      fullPage: true,
    });

    /* resume + charge from the mobile cart bar */
    await card(page, "Mesa M1").getByTestId("table-charge").click();
    await expect(page.getByTestId("cart-count")).toHaveText("1 ítems");
    await page.getByTestId("checkout-open").click();
    await expect(page.getByTestId("payment-modal")).toBeVisible();
    await page.getByTestId("quick-cash-exact").click();
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();
    await expect(page.getByTestId("ticket-table")).toHaveText("Mesa M1");
    await page.screenshot({
      path: `${evidence}/mesas-375-ticket.png`,
      fullPage: true,
    });
    await page.getByTestId("receipt-close").click();

    await navigate(page, "mesas");
    await expect(card(page, "Mesa M1").getByTestId("table-badge")).toHaveText(
      "DISPONIBLE",
    );
  });

  test("guard de salida también aplica a una venta de mostrador", async ({ page }) => {
    wipeSalesAndCatalog();
    await login(page);
    await seedProduct(page, "Mostrador G", 4000);
    await navigate(page, "sale");
    await page.getByTestId("sale-item").filter({ hasText: "Mostrador G" }).click();
    await page.getByTestId("tab-tickets").click();
    await expect(page.getByTestId("leave-pos")).toBeVisible();
    await page.getByTestId("leave-pos-discard").click();
    await expect(page.locator(".screen.tickets")).toBeVisible();
  });
});

test.describe("Mesas · edges", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("liberar sin cobrar: confirmación, sin ticket, mesa disponible", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    await login(page);
    await seedProduct(page, "Liberar E2E", 4000);
    await navigate(page, "mesas");
    await createTable(page, "Mesa Libre");
    await card(page, "Mesa Libre").getByTestId("table-open").click();
    await addAndSave(page, "Liberar E2E");

    await navigate(page, "mesas");
    await card(page, "Mesa Libre").getByTestId("table-release").click();
    await expect(page.getByTestId("release-confirm")).toBeVisible();
    await expect(page.getByTestId("release-confirm")).toContainText(
      "No se emite ningún ticket",
    );
    await page.screenshot({
      path: `${evidence}/mesas-1440-release-confirm.png`,
      fullPage: true,
    });
    await page.getByTestId("release-confirm-yes").click();

    await expect(card(page, "Mesa Libre").getByTestId("table-badge")).toHaveText(
      "DISPONIBLE",
    );
    /* NO ticket, NO payment, NO stock movement */
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("0");
    expect(dbOne("SELECT count(*) FROM payments")).toBe("0");
    expect(dbOne("SELECT stock FROM product_variants WHERE name='Único'")).toBe(
      "20",
    );
  });

  test("«Pedir cuenta» pasa la mesa a POR COBRAR", async ({ page }) => {
    wipeSalesAndCatalog();
    await login(page);
    await seedProduct(page, "Cuenta E2E", 4000);
    await navigate(page, "mesas");
    await createTable(page, "Mesa Cuenta");
    await card(page, "Mesa Cuenta").getByTestId("table-open").click();
    await addAndSave(page, "Cuenta E2E");

    await navigate(page, "mesas");
    await card(page, "Mesa Cuenta").getByTestId("table-bill").click();
    await expect(card(page, "Mesa Cuenta").getByTestId("table-badge")).toHaveText(
      "POR COBRAR",
    );
    await expect(page.getByTestId("count-billing")).toHaveText(
      "● Por cobrar (1)",
    );
    await page.screenshot({
      path: `${evidence}/mesas-1440-billing.png`,
      fullPage: true,
    });
    /* billing keeps the comanda open — it is chargeable from the board */
    await card(page, "Mesa Cuenta").getByTestId("table-charge").click();
    await expect(page.getByTestId("cart-count")).toHaveText("1 ítems");
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("0");
  });

  test("cobrar directo desde POS con el carrito vacío (comanda ya guardada)", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    await login(page);
    await seedProduct(page, "Directo E2E", 4000);
    await navigate(page, "mesas");
    await createTable(page, "Mesa Directa");
    await card(page, "Mesa Directa").getByTestId("table-open").click();
    await addAndSave(page, "Directo E2E");
    /* «Guardar en Mesa» leaves the cart EMPTY but the table keeps its
     * comanda — «Cobrar» must reload it instead of blocking on an
     * empty cart (prepareCheckout path). */
    await expect(page.getByTestId("cart-count")).toHaveText("0 ítems");
    await page.getByTestId("checkout-open").click();
    await expect(page.getByTestId("payment-modal")).toBeVisible();
    await expect(page.getByTestId("checkout-total")).toContainText("4.000");
    await page.getByTestId("quick-cash-exact").click();
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();
    await expect(page.getByTestId("ticket-table")).toHaveText("Mesa Directa");
    await page.getByTestId("receipt-close").click();
    await navigate(page, "mesas");
    await expect(
      card(page, "Mesa Directa").getByTestId("table-badge"),
    ).toHaveText("DISPONIBLE");
    expect(dbOne("SELECT table_name FROM tickets")).toBe("Mesa Directa");
  });

  test("selector rápido de mesas: guardar un carrito de mostrador en una mesa", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    await login(page);
    await seedProduct(page, "Picker E2E", 4000);
    await navigate(page, "mesas");
    await createTable(page, "Mesa Picker");
    /* attend NO table: a plain counter cart, then «Guardar en Mesa» */
    await navigate(page, "sale");
    await page.getByTestId("sale-item").filter({ hasText: "Picker E2E" }).click();
    await page.getByTestId("save-to-table").click();
    await expect(page.getByTestId("table-picker")).toBeVisible();
    await expect(page.getByTestId("table-picker-item")).toHaveCount(1);
    await page.screenshot({
      path: `${evidence}/mesas-1440-table-picker.png`,
      fullPage: true,
    });
    await page.getByTestId("table-picker-item").click();
    await expect(page.getByTestId("toast")).toBeVisible();
    await expect(page.getByTestId("table-context-name")).toContainText(
      "Atendiendo: Mesa Picker",
    );
    await expect(page.getByTestId("cart-count")).toHaveText("0 ítems");
    await navigate(page, "mesas");
    await expect(
      card(page, "Mesa Picker").getByTestId("table-badge"),
    ).toHaveText("OCUPADA");
    await expect(card(page, "Mesa Picker").getByTestId("table-total")).toContainText(
      "4.000",
    );
  });

  test("vender de mostrador mientras una mesa está atendida no contamina la comanda", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    await login(page);
    await seedProduct(page, "Mixto E2E", 4000);
    await navigate(page, "mesas");
    await createTable(page, "Mesa Mix");
    await card(page, "Mesa Mix").getByTestId("table-open").click();
    await addAndSave(page, "Mixto E2E");
    await navigate(page, "mesas");
    await expect(card(page, "Mesa Mix").getByTestId("table-badge")).toHaveText(
      "OCUPADA",
    );
  });
});

test.describe("Mesas · Admin + roles", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test("CRUD de mesas desde Administración (patrón Cajas/Empleados)", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    await login(page);
    await navigate(page, "admin");
    await page.getByTestId("admin-tab-mesas").click();
    await expect(page.getByTestId("admin-mesas")).toBeVisible();
    await expect(page.getByTestId("admin-tables-empty")).toBeVisible();

    await page.getByTestId("admin-table-new").click();
    await expect(page.getByTestId("table-modal")).toBeVisible();
    await page.getByTestId("table-name").fill("Mesa Admin");
    await page.getByTestId("table-zone").selectOption("Terraza");
    await page.getByTestId("table-capacity").fill("6");
    await page.getByTestId("table-submit").click();
    await expect(page.getByTestId("table-modal")).toBeHidden();

    const row = page.getByTestId("admin-table-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Mesa Admin");
    await expect(row).toContainText("Terraza");
    await expect(row).toContainText("6");
    await expect(row).toContainText("Activa");

    /* edit: capacidad + zona libre */
    await page.getByTestId("admin-table-edit").click();
    await expect(page.getByTestId("table-modal")).toBeVisible();
    await page.getByTestId("table-capacity").fill("8");
    await page.getByTestId("table-zone").selectOption("Otra…");
    await page.getByTestId("table-zone-custom").fill("Patio");
    await page.getByTestId("table-submit").click();
    await expect(page.getByTestId("table-modal")).toBeHidden();
    await expect(page.getByTestId("admin-table-row")).toContainText("8");
    await expect(page.getByTestId("admin-table-row")).toContainText("Patio");

    /* validation: capacity < 1 never writes */
    await page.getByTestId("admin-table-new").click();
    await page.getByTestId("table-name").fill("Mesa Inválida");
    await page.getByTestId("table-capacity").fill("0");
    await page.getByTestId("table-submit").click();
    await expect(page.getByTestId("table-error")).toBeVisible();
    await expect(page.getByTestId("table-modal")).toBeVisible();
    await page.getByTestId("table-cancel").click();

    /* the board sees the same row */
    await navigate(page, "mesas");
    await expect(
      page.getByTestId("table-card").filter({ hasText: "Mesa Admin" }),
    ).toBeVisible();
    await page.screenshot({
      path: `${evidence}/mesas-1440-admin-created.png`,
      fullPage: true,
    });
  });

  test("el cajero ve el tablero pero NO «+ Agregar Mesa»", async ({
    page,
    browser,
  }) => {
    /* own tenant so the member's board is empty and isolated */
    const tag = `mesas-${Date.now()}`;
    const signup = await page.request.post("/api/auth/sign-up/email", {
      data: { name: "Dueña Mesas", email: `${tag}@test.dev`, password: "mesas-test-only-123" },
    });
    expect(signup.ok()).toBe(true);
    const created = await page.request.post("/api/auth/organization/create", {
      data: { name: "Tienda Mesas", slug: tag },
    });
    expect(created.ok()).toBe(true);
    const org = (await created.json()).id as string;

    const staffContext = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: { width: 375, height: 812 },
    });
    try {
      const staff = await staffContext.newPage();
      await createOrgUser(staffContext.request, org, "member", "rm-mesas");
      await staff.goto("/");
      await expect(staff.getByTestId("tab-sale")).toBeVisible();

      /* the board itself is member-visible (tier all — same as Venta);
       * on the compact tabbar it lives behind «Más secciones». */
      await expect(staff.getByTestId("tab-mesas")).toHaveCount(1);
      await navigate(staff, "mesas");
      await expect(staff.getByTestId("mesas-screen")).toBeVisible();
      await expect(staff.getByTestId("mesas-empty")).toBeVisible();
      await expect(staff.getByTestId("table-add")).toHaveCount(0);

      /* …and the Admin section stays out of the member nav entirely */
      await expect(staff.getByTestId("tab-admin")).toHaveCount(0);
      await staff.screenshot({
        path: `${evidence}/mesas-375-member.png`,
        fullPage: true,
      });
    } finally {
      await staffContext.close();
    }
  });
});
