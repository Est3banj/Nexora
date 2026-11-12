import { expect, test, type Page } from "@playwright/test";
import { dbOne, wipeSalesAndCatalog } from "./helpers-db";

/**
 * M5 · Fiado en el cobro único (tasks 12.2 / 12.4 gate):
 *  - alta de cliente DESDE el modal (límite COP entero obligatorio)
 *  - required picker + amber note + client-side limit BLOCK (no write)
 *  - mixed = cash part + credit remainder → payments[] exact split (M2)
 *  - success copy shows the credit owed (credit-sales spec)
 *  - abono NEVER becomes a sale/income (own table, receipts untouched)
 *
 * M6 · Clientes & Fiados (tasks 13.1 / 13.2 gate) live in the describes
 * below: accounts grid (Al Día incluida), alta 0/null/límite explícito,
 * búsqueda teléfono/acentos, Por Cobrar sigue filtrando balance > 0,
 * abono owner-only + recibo real + offline/replay.
 */

const evidence =
  "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode";

async function login(page: Page) {
  await page.goto("/");
  await page.getByTestId("login-email").fill("owner@demo.test");
  await page.getByTestId("login-password").fill("demo12345");
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

async function openCobro(page: Page, productName: string) {
  await page.getByTestId("tab-sale").click();
  await page
    .getByTestId("sale-item")
    .filter({ hasText: productName })
    .click();
  await page.getByTestId("checkout-open").click();
  await expect(page.getByTestId("payment-modal")).toBeVisible();
}

async function createClientInModal(
  page: Page,
  name: string,
  limit: string,
) {
  await page.getByTestId("fiado-new-toggle").click();
  await page.getByTestId("fiado-new-name").fill(name);
  await page.getByTestId("fiado-new-limit").fill(limit);
  await page.getByTestId("fiado-new-save").click();
  await expect(page.getByTestId("fiado-client")).not.toHaveValue("");
}

test.describe("M5 · cobro Fiado (modal único)", () => {
  test("full credit sale: alta desde el cobro, recibo y claim confirmado", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    dbOne("DELETE FROM credit_abonos; DELETE FROM customers");
    await login(page);
    await seedProduct(page, "Fiado E2E", 35000);
    await openCobro(page, "Fiado E2E");

    await page.getByTestId("pay-fiado").click();
    await expect(page.getByTestId("fiado-section")).toBeVisible();
    await expect(page.getByTestId("fiado-note")).toContainText(
      "saldo pendiente de la cuenta",
    );
    /* required picker blocks BEFORE any write */
    await expect(page.getByTestId("credit-limit-note")).toContainText(
      "Seleccioná un cliente",
    );
    await expect(page.getByTestId("checkout-confirm")).toBeDisabled();

    await createClientInModal(page, "Doña María", "100000");
    await expect(page.getByTestId("credit-limit-note")).toHaveCount(0);
    await expect(page.getByTestId("credit-split")).toContainText("35.000");
    await expect(page.getByTestId("checkout-confirm")).toBeEnabled();

    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();

    /* receipt opens after the durable commit and shows the REAL claim */
    await expect(page.getByTestId("receipt-preview")).toBeVisible();
    await expect(page.getByTestId("ticket-detail")).toContainText("Doña María");
    await expect(page.getByTestId("ticket-detail")).toContainText("Crédito");
    await expect(page.getByTestId("ticket-detail")).toContainText("35.000");
    await page.getByTestId("receipt-close").click();

    /* success copy states the credit owed (credit-sales spec §Success) */
    await expect(page.getByTestId("ticket-credit")).toContainText("35.000");

    /* local-first: poll the server copy through the sync queue */
    await expect
      .poll(() => dbOne("SELECT count(*) FROM payments"), { timeout: 15_000 })
      .toBe("1");
    await expect
      .poll(() => dbOne("SELECT method || ':' || status FROM payments"), {
        timeout: 15_000,
      })
      .toBe("credit:confirmed");
    await expect
      .poll(() => dbOne("SELECT status FROM tickets"), { timeout: 15_000 })
      .toBe("completed");
    await expect
      .poll(() => dbOne("SELECT customer_id IS NOT NULL FROM tickets"), {
        timeout: 15_000,
      })
      .toBe("t");
    // Credit without abonos follows the same auditable owner command.
    await page.getByTestId("tab-tickets").click();
    await page.getByTestId("ticket-preview").first().click();
    await expect(page.getByTestId("void-sale")).toBeEnabled();
    await page.getByTestId("void-sale").click();
    await page.getByTestId("void-reason").fill("Anulación crédito sin abonos");
    await page.getByTestId("void-confirm").click();
    await expect.poll(() => dbOne("SELECT status FROM tickets")).toBe("voided");
    expect(dbOne("SELECT count(*) FROM credit_abonos")).toBe("0");
  });

  test("credit limit blocks client-side: no ticket, visible reason", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    dbOne("DELETE FROM credit_abonos; DELETE FROM customers");
    await login(page);
    await seedProduct(page, "Limite E2E", 6000);
    await openCobro(page, "Limite E2E");

    await page.getByTestId("pay-fiado").click();
    await createClientInModal(page, "Cliente Límite", "5000");

    /* 6000 > 5000 → blocked with the prototype's limit copy */
    await expect(page.getByTestId("credit-limit-note")).toContainText(
      "excede su límite de crédito",
    );
    await expect(page.getByTestId("checkout-confirm")).toBeDisabled();
    await page.screenshot({
      path: "/var/folders/zq/6h6qz_616b371m8v3q93wklh0000gn/T/opencode/m5-375-credit-limit-blocked.png",
      fullPage: true,
    });

    /* cash part equal to the total is not a mixed sale */
    await page.getByTestId("fiado-cash").fill("6000");
    await expect(page.getByTestId("credit-limit-note")).toContainText(
      "usá Efectivo",
    );
    await expect(page.getByTestId("checkout-confirm")).toBeDisabled();
    await page.getByTestId("fiado-cash").fill("");

    /* cancel keeps the order, writes nothing */
    await page.getByTestId("checkout-cancel").click();
    await expect(page.getByTestId("payment-modal")).toBeHidden();
    await expect(page.getByTestId("cart-total")).toContainText("6.000");
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("0");
    expect(dbOne("SELECT count(*) FROM payments")).toBe("0");
  });

  test("mixed sale splits payments[] exactly: cash + credit == total", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    dbOne("DELETE FROM credit_abonos; DELETE FROM customers");
    await login(page);
    await seedProduct(page, "Mixto E2E", 35000);
    await openCobro(page, "Mixto E2E");

    await page.getByTestId("pay-fiado").click();
    await createClientInModal(page, "Rodrigo Silva", "150000");
    await page.getByTestId("fiado-cash").fill("10000");
    await expect(page.getByTestId("credit-split")).toContainText(
      "en efectivo ahora",
    );
    await expect(page.getByTestId("credit-split")).toContainText(
      "25.000 quedan a crédito",
    );
    await page.getByTestId("checkout-confirm").click();

    await expect(page.getByTestId("sale-success")).toBeVisible();
    await expect(page.getByTestId("ticket-credit")).toContainText("25.000");
    await page.getByTestId("receipt-close").click();

    /* EXACT split (M2): two confirmed payments summing to the total */
    await expect
      .poll(() => dbOne("SELECT count(*) FROM payments"), { timeout: 15_000 })
      .toBe("2");
    await expect
      .poll(
        () =>
          dbOne(
            "SELECT string_agg(method || ':' || amount, ',' ORDER BY method) FROM payments",
          ),
        { timeout: 15_000 },
      )
      .toBe("cash:10000,credit:25000");
    expect(dbOne("SELECT sum(amount) FROM payments")).toBe("35000");
    await expect
      .poll(() => dbOne("SELECT status FROM tickets"), { timeout: 15_000 })
      .toBe("completed");

    /* the ticket shows up under BOTH method filters (credit-sales H3) */
    await page.getByTestId("tab-tickets").click();
    await page.getByTestId("filter-method").selectOption("credit");
    await expect(page.getByTestId("ticket-item")).toHaveCount(1);
    await page.getByTestId("filter-method").selectOption("mixed");
    await expect(page.getByTestId("ticket-item")).toHaveCount(1);
    await page.getByTestId("filter-method").selectOption("cash");
    await expect(page.getByTestId("ticket-item")).toHaveCount(1);
    await page.getByTestId("filter-method").selectOption("all");
  });

  test("abono is never income: no ticket, no payment, revenue unchanged", async ({
    page,
  }) => {
    wipeSalesAndCatalog();
    dbOne("DELETE FROM credit_abonos; DELETE FROM customers");
    const org = dbOne("SELECT id FROM organization WHERE slug='tienda-demo'");
    dbOne(`UPDATE shifts SET status='closed' WHERE tenant_id='${org}'`);
    dbOne(
      `INSERT INTO shifts(id,tenant_id,client_uuid,status) VALUES(gen_random_uuid(),'${org}',gen_random_uuid(),'open')`,
    );
    await login(page);
    await seedProduct(page, "Abono E2E", 20000);
    await openCobro(page, "Abono E2E");
    await page.getByTestId("pay-fiado").click();
    await createClientInModal(page, "Cobro Test", "50000");
    await page.getByTestId("checkout-confirm").click();
    await expect(page.getByTestId("sale-success")).toBeVisible();
    await page.getByTestId("receipt-close").click();

    /* record a real abono against the same customer (owner path, 9.6) */
    await page.evaluate(async () => {
      const { getLocalDb } = await import("/src/db/instance.ts");
      const { listLocalCustomers, registerLocalAbono } = await import(
        "/src/db/local.ts"
      );
      const { activeOrgId, authClient } = await import("/src/auth.ts");
      const h = (await getLocalDb())!;
      const tenant = activeOrgId((await authClient.getSession()).data)!;
      const [customer] = await listLocalCustomers(h.db, tenant);
      await registerLocalAbono(h.db, tenant, {
        customer_id: customer.id,
        amount: 5000,
        method: "cash",
      });
    });

    /* history: still ONE ticket — an abono is not a sale */
    await page.getByTestId("tab-tickets").click();
    await expect(page.getByTestId("ticket-item")).toHaveCount(1);
    await expect
      .poll(() => dbOne("SELECT count(*) FROM tickets"), { timeout: 15_000 })
      .toBe("1");
    /* abonos live in their own table — payments stays at the sale's one row */
    expect(dbOne("SELECT count(*) FROM payments")).toBe("1");
    await expect
      .poll(() => dbOne("SELECT count(*) FROM credit_abonos"), {
        timeout: 15_000,
      })
      .toBe("1");

    /* revenue = the sale only (20.000), never sale + abono (25.000) */
    await page.getByTestId("tab-dashboard").click();
    await expect(page.getByTestId("kpi-revenue")).toContainText("20.000");
    await expect(page.getByTestId("kpi-revenue")).not.toContainText("25.000");
    // M8: collection reaches Caja and closes with its own stored note; it
    // remains separate from sales revenue and from credit claims.
    await page.getByTestId("tab-arqueo").click();
    await expect(page.getByTestId("expected-abonos")).toContainText("5.000");
    await expect(page.getByTestId("expected-total")).toContainText("5.000");
    await expect(page.getByTestId("counted")).toHaveValue("");
    await page.getByTestId("counted").fill("5000");
    await page.getByTestId("closing-note").fill("Cierre con abono real");
    await page.getByTestId("close-shift").click();
    await expect(page.getByTestId("no-open-shift")).toBeVisible();
    await expect(page.getByTestId("history-diff")).toContainText("Exacto");
    expect(dbOne("SELECT closing_note FROM closedcash")).toBe("Cierre con abono real");
    // Preserve later specs' open-shift seed precondition.
    await page.getByTestId("opening-cash").fill("0");
    await page.getByTestId("open-shift").click();
    await expect(page.getByTestId("shift-card")).toBeVisible();
  });
});

/* ── M6 · 13.1 — tarjetas, alta, búsqueda y reporte Por Cobrar ─────── */

async function seedAccounts(_page: Page) {
  wipeSalesAndCatalog();
  dbOne("DELETE FROM credit_abonos; DELETE FROM customers");
  const org = dbOne("SELECT id FROM organization WHERE slug='tienda-demo'");
  /* legacy null limit (Al Día + «Sin configurar») */
  dbOne(
    `INSERT INTO customers (id,tenant_id,client_uuid,name,phone,credit_limit,active,created_at) VALUES (gen_random_uuid(),'${org}',gen_random_uuid(),'Legacy Sin Límite','320 555 6677',NULL,TRUE,now())`,
  );
  /* real debt → the ONLY row the Por Cobrar report may list */
  dbOne(
    `INSERT INTO customers (id,tenant_id,client_uuid,name,phone,credit_limit,active,created_at) VALUES (gen_random_uuid(),'${org}',gen_random_uuid(),'Deudora Real','+57 300 999 8877',100000,TRUE,now())`,
  );
  dbOne(
    `INSERT INTO tickets (id,tenant_id,client_uuid,ticket_no,status,total,customer_id) SELECT gen_random_uuid(),'${org}',gen_random_uuid(),960,'completed',50000,(SELECT id FROM customers WHERE tenant_id='${org}' AND name='Deudora Real')`,
  );
  dbOne(
    `INSERT INTO payments (id,tenant_id,client_uuid,ticket_id,method,amount,status) SELECT gen_random_uuid(),'${org}',gen_random_uuid(),id,'credit',50000,'confirmed' FROM tickets WHERE tenant_id='${org}' AND ticket_no=960`,
  );
  // Sync-created customers use one UUID as both identity and replay key.
  dbOne(`UPDATE customers SET client_uuid=id WHERE tenant_id='${org}'`);
  return org;
}

test.describe("M6 · Clientes & Fiados (13.1)", () => {
  test("editing preserves notes and newer untouched fields through save, reload and reactivation", async ({ page }) => {
    const org = await seedAccounts(page);
    dbOne(`UPDATE customers SET notes='Entregar después de las 18' WHERE tenant_id='${org}' AND name='Deudora Real'`);
    await login(page);
    await page.getByTestId("tab-credito").click();
    const card = page.getByTestId("client-card").filter({ hasText: "Deudora Real" });
    await card.getByTestId("client-edit").click();
    await expect(page.getByTestId("client-notes")).toHaveValue("Entregar después de las 18");
    // A different local writer updates unrelated fields while the draft is open.
    await page.evaluate(async () => {
      const { getLocalDb } = await import("/src/db/instance.ts");
      const { listLocalCustomers, updateLocalCustomer } = await import("/src/db/local.ts");
      const { activeOrgId, authClient } = await import("/src/auth.ts");
      const { db } = (await getLocalDb())!;
      const tenant = activeOrgId((await authClient.getSession()).data)!;
      const customer = (await listLocalCustomers(db, tenant)).find(c => c.name === "Deudora Real")!;
      await updateLocalCustomer(db, tenant, customer.id, { notes: "Nueva referencia vigente", credit_limit: 150000 });
    });
    await page.getByTestId("client-phone").fill("3001234567");
    await page.getByTestId("client-save").click();
    await card.getByTestId("client-edit").click();
    await expect(page.getByTestId("client-notes")).toHaveValue("Nueva referencia vigente");
    await expect(page.getByTestId("client-limit")).toHaveValue("150000");
    await page.getByTestId("client-active").uncheck();
    await page.getByTestId("client-save").click();
    await expect(card).toHaveCount(0);
    await page.getByTestId("clients-inactive-toggle").check();
    await page.getByTestId("client-reactivate").click();
    await expect(card).toBeVisible();
    await page.evaluate(async () => {
      await (window as unknown as { __pos: { pushNow: () => Promise<void> } }).__pos.pushNow();
    });
    await expect.poll(() => dbOne(`SELECT notes || ':' || phone || ':' || credit_limit || ':' || active FROM customers WHERE tenant_id='${org}' AND name='Deudora Real'`)).toBe("Nueva referencia vigente:3001234567:150000:true");
    await page.reload();
    await page.getByTestId("tab-credito").click();
    await card.getByTestId("client-edit").click();
    await expect(page.getByTestId("client-notes")).toHaveValue("Nueva referencia vigente");
    await page.keyboard.press("Escape");
    await expect(card.getByTestId("client-edit")).toBeFocused();
  });

  test("unverified role never exposes collection controls", async ({ page }) => {
    await seedAccounts(page);
    await page.route("**/api/auth/organization/get-active-member-role**", route => route.fulfill({ status: 503, body: JSON.stringify({ message: "Unavailable" }), contentType: "application/json" }));
    await login(page);
    await page.getByTestId("tab-credito").click();
    await expect(page.getByTestId("client-card")).toHaveCount(2);
    await expect(page.getByTestId("client-abono")).toHaveCount(0);
    await page.getByTestId("tab-tickets").click();
    await page.getByTestId("ticket-preview").first().click();
    await expect(page.getByTestId("void-sale")).toHaveCount(0);
    await expect(page.getByTestId("confirm-transfer")).toHaveCount(0);
  });

  test("accounts grid: alta límite 0, null legacy, búsqueda y Por Cobrar positivo", async ({
    page,
  }) => {
    const org = await seedAccounts(page);
    await login(page);
    await page.getByTestId("tab-credito").click();

    /* ALL active accounts incl. zero-balance «Al Día» (9.2 accounts, not
     * the positive-only Por Cobrar report) — seeded: Legacy + Deudora */
    await expect(page.getByTestId("client-card")).toHaveCount(2);
    const legacy = page.getByTestId("client-card").filter({ hasText: "Legacy Sin Límite" });
    await expect(legacy.getByTestId("client-badge")).toHaveText("Al Día");
    await expect(legacy.getByTestId("client-limit-value")).toContainText("Sin configurar");
    const debt = page.getByTestId("client-card").filter({ hasText: "Deudora Real" });
    await expect(debt.getByTestId("client-badge")).toHaveText("Con Deuda");
    await expect(debt.getByTestId("client-balance")).toContainText("50.000");
    /* banner total = Σ positive balances (50.000 — zeros add nothing) */
    await expect(page.getByTestId("total-debt")).toContainText("50.000");

    /* alta: empty name rejected BEFORE any write */
    await page.getByTestId("client-new").click();
    await expect(page.getByTestId("client-modal")).toBeVisible();
    await page.getByTestId("client-save").click();
    await expect(page.getByTestId("client-error")).toContainText("nombre");
    expect(dbOne(`SELECT count(*) FROM customers WHERE tenant_id='${org}' AND name=''`)).toBe("0");

    /* missing limit rejected — no silent 0 || 100000 fallback (prototype bug) */
    await page.getByTestId("client-name").fill("Doña María");
    await page.getByTestId("client-phone").fill("+57 300 111 2233");
    await page.getByTestId("client-save").click();
    await expect(page.getByTestId("client-error")).toContainText("límite");
    await expect(page.getByTestId("client-modal")).toBeVisible();

    /* explicit limit 0 = no new credit, NOT unlimited, NOT null */
    await page.getByTestId("client-modal").getByTestId("client-limit").fill("0");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({
      path: `${evidence}/m6-1440-client-modal.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.screenshot({
      path: `${evidence}/m6-375-client-modal.png`,
      fullPage: true,
    });
    await page.getByTestId("client-save").click();
    await expect(page.getByTestId("client-modal")).toBeHidden();

    const maria = page.getByTestId("client-card").filter({ hasText: "Doña María" });
    await expect(maria.getByTestId("client-badge")).toHaveText("Al Día");
    await expect(maria.getByTestId("client-limit-value")).toContainText("$ 0");

    /* search: accent-insensitive name + phone digits; total NEVER rewrites */
    await page.getByTestId("clients-search").fill("maria");
    await expect(page.getByTestId("client-card")).toHaveCount(1);
    await expect(page.getByTestId("total-debt")).toContainText("50.000");
    await page.getByTestId("clients-search").fill("300999");
    await expect(page.getByTestId("client-card")).toHaveCount(1);
    await expect(page.getByTestId("client-card")).toContainText("Deudora Real");
    await page.getByTestId("clients-search").fill("zzz-no-existe");
    await expect(page.getByTestId("no-client-results")).toBeVisible();
    await expect(page.getByTestId("total-debt")).toContainText("50.000");
    await page.getByTestId("clients-search").fill("");
    await expect(page.getByTestId("client-card")).toHaveCount(3);

    /* server truth: limit 0 stored as 0, legacy NULL untouched.
     * Customer creates only ENQUEUE (9.6) — force the drain like a reconnect. */
    await page.evaluate(async () => {
      const w = window as unknown as { __pos?: { pushNow: () => Promise<void> } };
      await w.__pos?.pushNow();
    });
    await expect
      .poll(
        () =>
          dbOne(
            `SELECT credit_limit FROM customers WHERE tenant_id='${org}' AND name='Doña María'`,
          ),
        { timeout: 15_000 },
      )
      .toBe("0");
    expect(
      dbOne(
        `SELECT credit_limit IS NULL FROM customers WHERE tenant_id='${org}' AND name='Legacy Sin Límite'`,
      ),
    ).toBe("t");

    /* Por Cobrar report keeps balance > 0 — Al Día cards are NOT listed */
    const balances = await (
      await page.request.get("/api/reports/customer-balances")
    ).json();
    expect(balances.rows.map((r: { name: string }) => r.name)).toEqual([
      "Deudora Real",
    ]);

    /* screenshots 1440 + 375 (M6 gate) */
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `${evidence}/m6-1440-clientes.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.screenshot({ path: `${evidence}/m6-375-clientes.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  });

  test("member session sees balances but NO abono affordance", async ({ page }) => {
    const org = await seedAccounts(page);
    ensureOpenShift(org);
    /* real membership (role member) — server keeps the per-item gate (D4),
     * the UI pre-gate must hide the form entirely (abonos spec §Member) */
    const email = `member-m6-${Date.now()}@test.dev`;
    const signup = await page.request.post("/api/auth/sign-up/email", {
      data: { email, password: "member12345", name: "Cajera M6" },
    });
    expect(signup.ok()).toBe(true);
    const userId = (await signup.json()).user.id as string;
    dbOne(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('${crypto.randomUUID()}', '${org}', '${userId}', 'member', now())`,
    );
    expect(
      (
        await page.request.post("/api/auth/organization/set-active", {
          data: { organizationId: org },
        })
      ).ok(),
    ).toBe(true);

    await page.goto("/");
    await expect(page.getByTestId("tab-sale")).toBeVisible();
    /* prove the session really carries role=member (not an unverified role) */
    await page.getByLabel("Cuenta y caja", { exact: true }).click();
    await expect(page.getByTestId("member-role")).toHaveText("Miembro");
    await page.getByLabel("Cuenta y caja", { exact: true }).click();
    await page.getByTestId("tab-credito").click();
    /* balances visible to every role … */
    await expect(page.getByTestId("client-card")).toHaveCount(2);
    await expect(page.getByTestId("total-debt")).toContainText("50.000");
    /* … but NO abono registration affordance at all */
    await expect(page.getByTestId("client-abono")).toHaveCount(0);
    await expect(page.getByTestId("client-new")).toBeVisible();
    await page.getByTestId("tab-tickets").click();
    await expect(page.getByTestId("ticket-void-row")).toHaveCount(0);
    await page.getByTestId("ticket-preview").first().click();
    await expect(page.getByTestId("void-sale")).toHaveCount(0);
    await expect(page.getByTestId("confirm-transfer")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByTestId("tab-arqueo").click();
    await expect(page.getByTestId("cash-movement-open")).toBeEnabled();
  });
});

/* ── M6 · 13.2 — modal Abono + recibo + offline/replay ──────────────── */

/** Same gate as a sale: an OPEN shift must exist (SHIFT_REQUIRED, ABN). */
function ensureOpenShift(org: string) {
  dbOne(`UPDATE shifts SET status='closed' WHERE tenant_id='${org}'`);
  dbOne(
    `INSERT INTO shifts(id,tenant_id,client_uuid,status) VALUES(gen_random_uuid(),'${org}',gen_random_uuid(),'open')`,
  );
}

test.describe("M6 · Abono modal + recibo (13.2)", () => {
  test("no open shift: clear error, draft retained, Escape and close restore focus without writes", async ({ page }) => {
    const org = await seedAccounts(page);
    dbOne(`UPDATE shifts SET status='closed' WHERE tenant_id='${org}'`);
    await login(page);
    await page.getByTestId("tab-credito").click();
    const trigger = page.getByTestId("client-card").filter({ hasText: "Deudora Real" }).getByTestId("client-abono");
    await trigger.click();
    await expect(page.getByTestId("abono-amount")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("abono-modal")).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByTestId("abono-amount").fill("5000");
    await page.getByTestId("abono-note").fill("Conservar borrador");
    await page.getByTestId("abono-confirm").click();
    await expect(page.getByTestId("abono-error")).toContainText("Abrí una caja");
    await expect(page.getByTestId("abono-amount")).toHaveValue("5000");
    await expect(page.getByTestId("abono-note")).toHaveValue("Conservar borrador");
    await page.setViewportSize({ width: 375, height: 520 });
    await page.getByTestId("abono-confirm").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("abono-confirm")).toBeInViewport();
    await page.screenshot({ path: `${evidence}/m6-375-abono-no-shift-short-viewport.png`, fullPage: true });
    await expect(page.getByTestId("receipt-preview")).toHaveCount(0);
    expect(dbOne("SELECT count(*) FROM credit_abonos")).toBe("0");
    const localCounts = await page.evaluate(async () => {
      const { getLocalDb } = await import("/src/db/instance.ts");
      const { db } = (await getLocalDb())!;
      return (await db.query("SELECT (SELECT count(*) FROM credit_abonos)::int AS abonos, (SELECT count(*) FROM sync_log WHERE entity='credit_abono')::int AS queued")).rows[0];
    });
    expect(localCounts).toEqual({ abonos: 0, queued: 0 });
    await page.getByTestId("abono-close").click();
    await expect(trigger).toBeFocused();
  });

  test("cash + transfer abonos: recibo real, saldo vivo, pagos intactos, overpay y cero", async ({
    page,
  }) => {
    const org = await seedAccounts(page);
    ensureOpenShift(org);
    await login(page);
    await page.getByTestId("tab-credito").click();

    const debt = page.getByTestId("client-card").filter({ hasText: "Deudora Real" });
    await expect(debt.getByTestId("client-balance")).toContainText("50.000");

    /* zero-balance card: disabled with a visible reason (never a trap) */
    const legacy = page.getByTestId("client-card").filter({ hasText: "Legacy Sin Límite" });
    await expect(legacy.getByTestId("client-abono")).toBeDisabled();
    await expect(legacy.getByTestId("client-abono-reason")).toContainText(
      "no hay nada por cobrar",
    );

    /* open the modal from the card with debt */
    await debt.getByTestId("client-abono").click();
    await expect(page.getByTestId("abono-modal")).toBeVisible();
    await expect(page.getByTestId("abono-client")).toHaveText("Deudora Real");
    await expect(page.getByTestId("abono-balance")).toContainText("50.000");
    await expect(page.getByTestId("abono-cash")).toHaveClass(/active/);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `${evidence}/m6-1440-abono-modal.png`, fullPage: true });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.screenshot({ path: `${evidence}/m6-375-abono-modal.png`, fullPage: true });

    /* overpayment rejected with the balance — never clamped */
    await page.getByTestId("abono-amount").fill("60000");
    await expect(page.getByTestId("abono-overpay")).toContainText("50.000");
    await expect(page.getByTestId("abono-confirm")).toBeDisabled();

    for (const invalid of ["-500", "1000.5", "1000,5", "2147483648"]) {
      await page.getByTestId("abono-amount").fill(invalid);
      await expect(page.getByTestId("abono-amount")).toHaveValue(invalid);
      await expect(page.getByTestId("abono-confirm")).toBeDisabled();
    }
    /* zero is not a valid abono */
    await page.getByTestId("abono-amount").fill("0");
    await expect(page.getByTestId("abono-error")).toContainText("mayor a 0");
    await expect(page.getByTestId("abono-confirm")).toBeDisabled();

    /* real cash abono 20.000 → one own-table row, receipt, live balance */
    await page.getByTestId("abono-amount").fill("20000");
    await page.getByTestId("abono-ticket").selectOption({ index: 1 });
    await expect(page.getByTestId("abono-confirm")).toBeEnabled();
    await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="abono-confirm"]');
      btn?.click();
      btn?.click(); // double click → ONE write (busyRef)
    });
    await expect(page.getByTestId("receipt-preview")).toBeVisible();
    await expect(page.getByTestId("abono-detail")).toContainText("Deudora Real");
    await expect(page.getByTestId("abono-detail")).toContainText("20.000");
    await expect(page.getByTestId("abono-detail")).toContainText("Efectivo");
    await expect(page.getByTestId("abono-detail")).toContainText("30.000");
    await expect(page.getByTestId("abono-detail")).toContainText("no es una venta");
    const abonoId = (await page.getByTestId("abono-receipt-id").innerText()).trim();
    expect(abonoId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: `${evidence}/m6-1440-abono-receipt.png`, fullPage: true });
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.screenshot({ path: `${evidence}/m6-375-abono-receipt.png`, fullPage: true });
    await page.keyboard.press("Escape");
    await expect(debt.getByTestId("client-abono")).toBeFocused();

    /* balance + banner update IMMEDIATELY (local-first, offline included) */
    await expect(debt.getByTestId("client-balance")).toContainText("30.000");
    await expect(page.getByTestId("total-debt")).toContainText("30.000");

    /* an abono never creates a sale or a payment row */
    expect(dbOne("SELECT count(*) FROM payments")).toBe("1");
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("1");

    /* second abono via TRANSFERENCIA (settled decision #1: both methods) */
    await debt.getByTestId("client-abono").click();
    await page.getByTestId("abono-transfer").click();
    await page.getByTestId("abono-amount").fill("10000");
    await page.getByTestId("abono-note").fill("Pago por Nequi");
    await page.getByTestId("abono-confirm").click();
    await expect(page.getByTestId("abono-detail")).toContainText("Transferencia");
    await expect(page.getByTestId("abono-detail")).toContainText("20.000");
    await page.getByTestId("receipt-close").click();
    await expect(debt.getByTestId("client-balance")).toContainText("20.000");
    await expect(page.getByTestId("total-debt")).toContainText("20.000");

    /* drain the queue → exactly two own-table rows, payments untouched */
    await page.evaluate(async () => {
      const w = window as unknown as { __pos?: { pushNow: () => Promise<void> } };
      await w.__pos?.pushNow();
    });
    await expect
      .poll(() => dbOne("SELECT count(*) FROM credit_abonos"), { timeout: 15_000 })
      .toBe("2");
    expect(dbOne("SELECT count(*) FROM payments")).toBe("1");
    expect(dbOne("SELECT sum(amount) FROM credit_abonos")).toBe("30000");
    expect(dbOne(`SELECT amount || ':' || (ticket_id IS NOT NULL) FROM credit_abonos WHERE id='${abonoId}'`)).toBe("20000:true");
    expect(dbOne("SELECT note FROM credit_abonos WHERE method='transfer'")).toBe("Pago por Nequi");
    expect(
      dbOne(
        `SELECT count(*) FROM credit_abonos WHERE tenant_id='${org}' AND method='transfer'`,
      ),
    ).toBe("1");
  });

  test("offline abono survives reload and syncs exactly once (replay is idempotent)", async ({
    page,
    context,
  }) => {
    const OFFLINE_FLAG = "pos:e2e-offline-m6";
    await context.addInitScript((flag: string) => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => localStorage.getItem(flag) !== "1",
      });
    }, OFFLINE_FLAG);
    const org = await seedAccounts(page);
    ensureOpenShift(org);
    await login(page);
    await page.getByTestId("tab-credito").click();

    /* offline: sync endpoint unreachable, app believes it has no network */
    await context.route("**/api/sync/**", (route) => route.abort());
    await page.evaluate((f: string) => localStorage.setItem(f, "1"), OFFLINE_FLAG);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));

    const debt = page.getByTestId("client-card").filter({ hasText: "Deudora Real" });
    await debt.getByTestId("client-abono").click();
    await page.getByTestId("abono-amount").fill("5000");
    await page.getByTestId("abono-confirm").click();
    await expect(page.getByTestId("abono-detail")).toContainText("45.000");
    const offlineId = (await page.getByTestId("abono-receipt-id").innerText()).trim();
    await page.getByTestId("receipt-close").click();
    await expect(debt.getByTestId("client-balance")).toContainText("45.000");
    /* nothing reached the server while offline */
    expect(dbOne("SELECT count(*) FROM credit_abonos")).toBe("0");

    /* reload (still offline): the abono and its UUID survive locally */
    await page.reload();
    await expect(page.getByTestId("tab-sale")).toBeVisible();
    await page.getByTestId("tab-credito").click();
    const afterReload = page
      .getByTestId("client-card")
      .filter({ hasText: "Deudora Real" });
    await expect(afterReload.getByTestId("client-balance")).toContainText("45.000");
    expect(dbOne("SELECT count(*) FROM credit_abonos")).toBe("0");

    /* reconnect → drain; replaying the queue must stay idempotent */
    await context.unroute("**/api/sync/**");
    await page.evaluate((f: string) => localStorage.removeItem(f), OFFLINE_FLAG);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect
      .poll(() => dbOne("SELECT count(*) FROM credit_abonos"), { timeout: 15_000 })
      .toBe("1");
    const replay = await page.evaluate(async () => {
      const w = window as unknown as {
        __pos: { pushNow: () => Promise<void>; repushSynced: () => Promise<Array<{ client_uuid: string; status: string }>> };
      };
      await w.__pos.pushNow();
      return w.__pos.repushSynced();
    });
    expect(replay).toContainEqual(expect.objectContaining({ client_uuid: offlineId, status: "duplicate" }));
    expect(dbOne("SELECT count(*) FROM credit_abonos")).toBe("1");
    expect(dbOne("SELECT amount FROM credit_abonos")).toBe("5000");
    expect(dbOne("SELECT id FROM credit_abonos")).toBe(offlineId);
    expect(dbOne("SELECT count(*) FROM payments")).toBe("1");
    /* server balance converges: 50000 − 5000 */
    await expect
      .poll(
        () =>
          dbOne(
            `SELECT (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN tickets t ON t.id=p.ticket_id WHERE p.tenant_id='${org}' AND p.method='credit' AND p.status='confirmed' AND t.status<>'voided') - (SELECT COALESCE(SUM(amount),0) FROM credit_abonos WHERE tenant_id='${org}')`,
          ),
        { timeout: 15_000 },
      )
      .toBe("45000");
  });
});
