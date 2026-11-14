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
}

export const destinations = (page: Page) => page.locator('.shell-sidebar [data-testid^="tab-"]');
