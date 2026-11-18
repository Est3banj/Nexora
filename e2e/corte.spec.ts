import { expect, test } from "@playwright/test";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";
import { navigate } from "./helpers-navigation";

const evidence =
  "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";

/**
 * Batch D — Corte de caja imprimible (térmica 58/80mm):
 *  - button disabled while there are no sales, enabled after a sale
 *  - the print section always lives on document.body (portal) with the
 *    totals of the selected range
 *  - print-media contract: body.printing-corte hides #root and shows ONLY
 *    the corte — ticket/success prints keep their own chrome-hiding rules
 */

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("login-identifier").fill("owner@demo.test");
  await page.getByTestId("login-password").fill("demo1234567890");
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("tab-sale")).toBeVisible();
}

test.describe("Batch D — corte de caja", () => {
  test("print button gates on data; print media shows only the corte", async ({
    page,
  }, testInfo) => {
    wipeSalesAndCatalog();
    await login(page);

    /* no sales yet → button exists but is disabled */
    await navigate(page, "reports");
    await expect(page.getByTestId("corte-print")).toBeDisabled();
    await expect(page.getByTestId("export-excel")).toBeDisabled();

    /* one cash sale → both exports enable */
    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-new").click();
    await page.getByTestId("product-name").fill("Corte E2E");
    await page.getByTestId("variant-name").fill("Único");
    await page.getByTestId("variant-price").fill("4000");
    await page.getByTestId("variant-stock").fill("10");
    await page.getByTestId("product-create").click();
    await expect(
      page.getByTestId("product-item").filter({ hasText: "Corte E2E" }),
    ).toBeVisible();

    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Corte E2E" })
      .click();
    await page.getByTestId("checkout-open").click();
    await page.getByTestId("quick-cash-exact").click();
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();
    await page.getByTestId("receipt-close").click();

    await navigate(page, "reports");
    const corte = page.getByTestId("corte-print");
    await expect(corte).toBeEnabled();
    /* headless print() is a no-op — must not crash or hang */
    await corte.click();

    /* the portal section carries the range totals (display:none on screen) */
    const text = await page.getByTestId("print-corte").textContent();
    expect(text).toContain("CORTE DE CAJA");
    expect(text).toContain("4.000");
    expect(text).toContain("Excluye tickets anulados");

    /* print-media contract */
    await page.evaluate(() => document.body.classList.add("printing-corte"));
    await page.emulateMedia({ media: "print" });
    await expect(page.getByTestId("print-corte")).toBeVisible();
    await expect(page.locator("#root")).toBeHidden();
    await page.screenshot({
      path: testInfo.outputPath("corte-print-media.png"),
      fullPage: true,
    });
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() =>
      document.body.classList.remove("printing-corte"),
    );
    /* screen mode: corte hidden again, app visible */
    await expect(page.getByTestId("print-corte")).toBeHidden();
    await expect(page.getByTestId("corte-print")).toBeVisible();
  });
});

test.describe("Batch D — cierre de turno con mesas (Fase 2 gate)", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  /* This test CLOSES the shared seed shift (that's its point). Later specs
   * (fiado's void needs an OPEN shift on the ticket) inherit that
   * precondition — restore it exactly like cash-movements.spec's afterEach
   * does after ITS close tests. */
  test.afterEach(async () => {
    const org = dbOne("SELECT id FROM organization WHERE slug='tienda-demo'");
    if (
      dbOne(
        `SELECT count(*) FROM shifts WHERE tenant_id='${org}' AND status='open'`,
      ) === "0"
    ) {
      dbOne(
        `INSERT INTO shifts(id,tenant_id,client_uuid,status) VALUES(gen_random_uuid(),'${org}',gen_random_uuid(),'open')`,
      );
    }
  });

  test("cerrar turno con comandas abiertas queda bloqueado; al liberarlas cierra", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    await login(page);

    /* producto + mesa + comanda guardada (una sola línea) */
    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-new").click();
    await page.getByTestId("product-name").fill("Gate E2E");
    await page.getByTestId("variant-name").fill("Único");
    await page.getByTestId("variant-price").fill("4000");
    await page.getByTestId("variant-stock").fill("10");
    await page.getByTestId("product-create").click();
    await expect(
      page.getByTestId("product-item").filter({ hasText: "Gate E2E" }),
    ).toBeVisible();

    await navigate(page, "mesas");
    await page.getByTestId("table-add").click();
    await page.getByTestId("table-name").fill("Mesa Gate");
    await page.getByTestId("table-submit").click();
    await expect(page.getByTestId("table-modal")).toBeHidden();
    await page
      .getByTestId("table-card")
      .filter({ hasText: "Mesa Gate" })
      .getByTestId("table-open")
      .click();
    await page.getByTestId("sale-item").filter({ hasText: "Gate E2E" }).click();
    await page.getByTestId("save-to-table").click();
    await expect(page.getByTestId("toast")).toBeVisible();

    /* intento de cierre → bloqueado con el conteo exacto */
    await navigate(page, "arqueo");
    await expect(page.locator(".cash-screen")).toHaveAttribute("aria-busy", "false");
    await page.getByTestId("counted").fill("4000");
    await page.getByTestId("close-shift").click();
    await expect(page.getByTestId("arqueo-error")).toHaveText(
      "Hay 1 mesa con comanda abierta — cobralas o libralas antes de cerrar",
    );
    /* el turno sigue abierto: nada se cerró a medias */
    await expect(page.getByTestId("shift-card")).toBeVisible();
    await expect(page.getByTestId("no-open-shift")).toHaveCount(0);
    await page.screenshot({
      path: `${evidence}/corte-1440-gate-mesas.png`,
      fullPage: true,
    });

    /* liberar la comanda → el gate deja pasar y el turno cierra */
    await navigate(page, "mesas");
    const card = page.getByTestId("table-card").filter({ hasText: "Mesa Gate" });
    await card.getByTestId("table-release").click();
    await page.getByTestId("release-confirm-yes").click();
    await expect(page.getByTestId("release-confirm")).toBeHidden();

    await navigate(page, "arqueo");
    await page.getByTestId("counted").fill("4000");
    await page.getByTestId("close-shift").click();
    await expect(page.getByTestId("no-open-shift")).toBeVisible();
    await expect(page.getByTestId("close-history-row")).toHaveCount(1);
  });
});
