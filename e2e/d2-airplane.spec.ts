import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";

/**
 * D2-9 · Playwright airplane-mode E2E GATE (375px) — the sell-offline demo:
 * offline → 3-tap sale → reload (still offline) → reconnect → push →
 * server holds EXACTLY ONE copy → forced double-push → still one copy →
 * queue badge drains to 0.
 *
 * OFFLINE EMULATION METHOD (documented per task instructions):
 *  1. `context.setOffline(true)` for the sale phase — real network down.
 *  2. A page-init stub keeps `navigator.onLine === false` ACROSS the offline
 *     reload, driven by the localStorage flag `pos:e2e-offline`. True
 *     `setOffline` across a reload is impossible pre-PWA: the Vite dev shell
 *     itself must stay reachable to reload the SPA (the offline app shell
 *     lands in D4-4 with the service worker).
 *  3. Belt & braces: while the flag is up, `/api/sync/**` requests are
 *     aborted via `context.route` — even a broken onLine guard cannot push.
 *  4. Reconnect = clear flag + fire the real `online` window event a browser
 *     emits when connectivity returns → `initSync` force-drains the queue.
 *
 * Covers AC (tasks.md D2-9):
 *  - sync §Offline→online sale exactly one copy end-to-end (SC2)
 *  - sales §Sale survives reload offline; §Offline sale syncs to one copy
 *  - sales §Offline does not change the 3-tap flow + pending indicator
 *  - sync §Reconnect drains the queue (3 pending entries)
 *  - sync §Double-push creates one row (forced `repushSynced`)
 */

const E2E_DB = "postgres://esteban@127.0.0.1:5432/pos_piloto_e2e";
const OFFLINE_FLAG = "pos:e2e-offline";
const SYNC_GLOB = "**/api/sync/**";
/** Unique price for this spec → server copy assertions are unambiguous. */
const PRICE = 4500;

function dbOne(sql: string): string {
  const out = execSync(`psql "${E2E_DB}" -tA -c ${JSON.stringify(sql)}`, {
    encoding: "utf8",
  }).trim();
  return out;
}

test.describe("D2 gate — airplane mode → reload → reconnect → one copy", () => {
  test("offline sale survives reload offline and syncs to exactly one server copy", async ({
    page,
    context,
  }) => {
    /* --------------------------------------------------------------- */
    /* hermetic server state for this spec                              */
    /*                                                                  */
    /* start-api.sh drops the E2E DB ONCE per run, so specs share the   */
    /* server. The pilot is single-device with ONE continuous local     */
    /* ticket sequence; a fresh browser context starts a new sequence,  */
    /* so tickets pushed by earlier specs would collide on             */
    /* unique(tenant_id, ticket_no) (both get ticket_no=1). Wipe them:  */
    /* no later spec depends on rows created by an earlier one.         */
    /* (A real fresh device against a populated server needs           */
    /* empty-cache rehydrate — logged as a risk for D4-4.)             */
    /* --------------------------------------------------------------- */
    dbOne("DELETE FROM ticket_lines");
    dbOne("DELETE FROM payments");
    dbOne("DELETE FROM tickets");

    /* --------------------------------------------------------------- */
    /* offline signal: live navigator.onLine stub across reloads        */
    /* --------------------------------------------------------------- */
    await context.addInitScript((flag: string) => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => localStorage.getItem(flag) !== "1",
      });
    }, OFFLINE_FLAG);

    /* ---------------- login (online) + seed a local product ---------- */
    await page.goto("/");
    await page.getByTestId("login-email").fill("owner@demo.test");
    await page.getByTestId("login-password").fill("demo12345");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("tab-sale")).toBeVisible();

    await page.getByTestId("tab-catalog").click();
    await page.getByTestId("product-name").fill("Granizado Aereo");
    await page.getByTestId("variant-name").fill("Grande");
    await page.getByTestId("variant-price").fill(String(PRICE));
    await page.getByTestId("variant-stock").fill("5");
    await page.getByTestId("product-create").click();
    await expect(
      page.getByTestId("product-item").filter({ hasText: "Granizado Aereo" }),
    ).toBeVisible();
    await expect(page.getByTestId("pending-badge")).toContainText("pendientes");

    /* baseline: drain the catalog mutations so the offline queue starts
       empty and the badge is deterministic */
    await expect
      .poll(
        async () =>
          page.evaluate(async () => {
            const w = window as unknown as {
              __pos?: { pushNow: () => Promise<void> };
            };
            if (!w.__pos) return "no-hook";
            await w.__pos.pushNow();
            return document.querySelector(
              '[data-testid="pending-badge"]',
            )?.textContent ?? "";
          }),
        { timeout: 15_000 },
      )
      .toContain("sinc.");
    await expect(page.getByTestId("last-sync")).toBeVisible();

    /* --------------------------------------------------------------- */
    /* go offline: real network down + onLine flag + sync route aborted */
    /* --------------------------------------------------------------- */
    await context.route(SYNC_GLOB, (route) => route.abort());
    await page.evaluate((f: string) => localStorage.setItem(f, "1"), OFFLINE_FLAG);
    await context.setOffline(true);
    await expect(page.getByTestId("net-status")).toContainText("sin conexión");

    /* ---------------- 3-tap sale while offline ----------------------- */
    await page.getByTestId("tab-sale").click();
    await page
      .getByTestId("sale-item")
      .filter({ hasText: "Granizado Aereo" })
      .click();
    await expect(page.getByTestId("cart-total")).toContainText("4.500");
    await page.getByTestId("checkout-open").click();
    await page.getByTestId("quick-cash-exact").click(); // exact tendered (no auto-fill)
    await page.getByTestId("checkout-confirm").click();

    await expect(page.getByTestId("sale-success")).toBeVisible();
    await expect(page.getByTestId("pending-note")).toContainText(
      "Pendiente de sincronizar",
    );
    await expect(page.getByTestId("ticket-no")).toHaveText("#1");
    await expect(page.getByTestId("ticket-vuelto")).toContainText("0");

    /* queue = ticket + line + payment + stockdiary + variant stock refresh
       (D3-1 emits the −qty movement + absolute stock refresh with every
       sale) = exactly 5 pending */
    await expect(page.getByTestId("pending-badge")).toContainText(
      "5 pendientes",
    );
    await expect(page.getByTestId("net-status")).toContainText("sin conexión");

    /* --------------------------------------------------------------- */
    /* reload while still offline (shell reachable, sync flag stays up) */
    /* --------------------------------------------------------------- */
    await context.setOffline(false); // lets the SPA shell reload; flag keeps app offline
    await page.reload();
    await expect(page.getByTestId("tab-sale")).toBeVisible();
    await expect(page.getByTestId("net-status")).toContainText("sin conexión");

    /* sale + queue survive the offline reload with original content */
    await page.getByTestId("tab-tickets").click();
    const ticket = page.getByTestId("ticket-item").first();
    await expect(ticket).toContainText("#1");
    await expect(ticket).toContainText("4.500");
    await expect(page.getByTestId("pending-badge")).toContainText(
      "5 pendientes",
    );

    /* nothing reached the server while offline — EXACTLY zero copies */
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("0");

    /* --------------------------------------------------------------- */
    /* reconnect: clear flag + real `online` event → auto-push          */
    /* --------------------------------------------------------------- */
    await context.unroute(SYNC_GLOB);
    await page.evaluate((f: string) => localStorage.removeItem(f), OFFLINE_FLAG);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));

    await expect(page.getByTestId("net-status")).toContainText("en línea");
    await expect(page.getByTestId("pending-badge")).toContainText("sinc.", {
      timeout: 15_000,
    });
    await expect(page.getByTestId("last-sync")).toBeVisible();

    /* ---------------- server holds EXACTLY ONE copy ------------------ */
    expect(dbOne("SELECT count(*) FROM tickets")).toBe("1");
    const ticketId = dbOne(`SELECT id FROM tickets WHERE total = ${PRICE}`);
    expect(ticketId).not.toBe("");
    expect(
      dbOne(`SELECT count(*) FROM ticket_lines WHERE ticket_id = '${ticketId}'`),
    ).toBe("1");
    expect(
      dbOne(`SELECT count(*) FROM payments WHERE ticket_id = '${ticketId}'`),
    ).toBe("1");

    /* ---------------- D3-1: stock movement synced with the sale -------- */
    // the −qty diary is part of the sale group and the variant's absolute
    // stock (5 − 1 = 4) landed on BOTH derived stores
    expect(
      dbOne(`SELECT count(*) FROM stockdiary WHERE ref_ticket_id = '${ticketId}'`),
    ).toBe("1");
    const lineVariant = dbOne(
      `SELECT variant_id FROM ticket_lines WHERE ticket_id = '${ticketId}'`,
    );
    expect(lineVariant).not.toBe("");
    expect(
      dbOne(`SELECT stock FROM product_variants WHERE id = '${lineVariant}'`),
    ).toBe("4");
    expect(
      dbOne(`SELECT stock FROM stockcurrent WHERE variant_id = '${lineVariant}'`),
    ).toBe("4");

    /* ---------------- forced DOUBLE-PUSH → still one copy ------------- */
    const results = (await page.evaluate(async () => {
      const w = window as unknown as {
        __pos?: { repushSynced: () => Promise<unknown> };
      };
      if (!w.__pos) throw new Error("__pos hook missing");
      return (await w.__pos.repushSynced()) as Array<{ status: string }>;
    })) as Array<{ status: string }>;

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.status).toBe("duplicate");

    expect(dbOne("SELECT count(*) FROM tickets")).toBe("1");
    expect(
      dbOne(`SELECT count(*) FROM ticket_lines WHERE ticket_id = '${ticketId}'`),
    ).toBe("1");
    expect(
      dbOne(`SELECT count(*) FROM payments WHERE ticket_id = '${ticketId}'`),
    ).toBe("1");

    /* queue badge stays cleared after the replay */
    await expect(page.getByTestId("pending-badge")).toContainText("sinc.");
  });
});
