import { expect, type Page } from "@playwright/test";

/** Exercise the same compact-navigation affordance as an operator. */
export async function navigate(page: Page, tab: string) {
  const destination = page.getByTestId(`tab-${tab}`);
  await expect(destination).toBeAttached();
  if ((page.viewportSize()?.width ?? 1024) < 640 && !await destination.isVisible()) {
    await page.getByTestId("nav-more").click();
    await expect(page.getByRole("dialog", { name: "Más secciones", exact: true })).toBeVisible();
  }
  await destination.click();
  /* Mesas · leave-POS guard: leaving Venta with a dirty cart asks for
   * confirmation. The helper plays the operator and confirms «Descartar»
   * so navigation behaves as it did before the guard existed. */
  if (await page.locator('[data-testid="leave-pos"][open]').count()) {
    await page.getByTestId("leave-pos-discard").click();
  }
}

export const destinations = (page: Page) => page.locator('.shell-sidebar [data-testid^="tab-"]');
