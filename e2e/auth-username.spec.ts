import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { destinations, navigate } from "./helpers-navigation";

/**
 * Username identity for members (better-auth `username` plugin).
 *
 * Covered HERE, not duplicated elsewhere:
 *  · create an employee with USERNAME + PASSWORD from the Admin dialog,
 *    log the owner out, and enter as the EMPLOYEE with the username;
 *  · the owner still enters with their email (unchanged path);
 *  · the four credential errors a user can actually hit, each with the exact
 *    Spanish copy the app must show;
 *  · duplicate username → honest dialog error (batch6-admin covers it inside
 *    the wider lifecycle test as well).
 *
 * Not repeated: employee lifecycle / role changes (batch6-admin), owner email
 * login happy path (every other spec).
 */
async function tenant(page: Page) {
  const tag = randomUUID();
  const email = `auth-${tag}@test.dev`;
  const password = "auth-test-only-123";
  expect((await page.request.post("/api/auth/sign-up/email", { data: {
    name: "Dueña de prueba AUTH", email, password,
  } })).ok()).toBe(true);
  const res = await page.request.post("/api/auth/organization/create", { data: { name: "Tienda de prueba AUTH", slug: `auth-${tag}` } });
  expect(res.ok()).toBe(true);
  const org = (await res.json()).id as string;
  expect((await page.request.post("/api/auth/organization/set-active", { data: { organizationId: org } })).ok()).toBe(true);
  return { org, email, password };
}

async function signOut(page: Page) {
  // The shell must be rendered before we probe the account affordance:
  // `count()` is a single synchronous read and would otherwise skip the
  // mobile <details> toggle while the app is still booting.
  await expect(page.getByTestId("sign-out")).toBeAttached();
  const account = page.getByLabel("Cuenta y caja", { exact: true });
  if (await account.count() && !await page.getByTestId("sign-out").isVisible()) await account.click();
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("login-submit")).toBeVisible();
}

async function attemptLogin(page: Page, identifier: string, password: string) {
  await page.getByTestId("login-identifier").fill(identifier);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
}

test("employee created with username+password enters with the USERNAME; the owner keeps the email path", async ({ page }) => {
  const owner = await tenant(page);
  await page.goto("/");
  await navigate(page, "admin");
  await expect(page.getByTestId("admin-screen")).toBeVisible();
  await page.getByTestId("admin-tab-empleados").click();

  const username = `e2euser${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const staffPassword = "empleado-username-123";
  await page.getByTestId("admin-user-new").click();
  await page.getByTestId("admin-user-name").fill("Empleado Username E2E");
  await page.getByTestId("admin-user-username").fill(username);
  await page.getByTestId("admin-user-password").fill(staffPassword);
  await page.getByTestId("admin-user-submit").click();
  await expect(page.getByTestId("admin-created-username")).toHaveText(username);
  await page.getByRole("button", { name: "Listo" }).click();
  await expect(page.getByTestId("admin-member").filter({ hasText: username })).toBeVisible();

  // Duplicate username keeps the draft and reports the server's honest error.
  await page.getByTestId("admin-user-new").click();
  await page.getByTestId("admin-user-name").fill("Duplicado");
  await page.getByTestId("admin-user-username").fill(username);
  await page.getByTestId("admin-user-password").fill("otro-password-123456");
  await page.getByTestId("admin-user-submit").click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Ese usuario ya está en uso. Elegí otro.");
  await expect(page.getByTestId("admin-user-username")).toHaveValue(username);
  await page.keyboard.press("Escape");

  // Owner logs out, EMPLOYEE enters with the username (never an email).
  await signOut(page);
  await attemptLogin(page, username, staffPassword);
  await expect(destinations(page)).toHaveCount(6);
  await expect(page.getByTestId("tab-admin")).toHaveCount(0);
  await expect(page.getByTestId("login-error")).toHaveCount(0);

  // Owner logs back in with the email — that path is untouched.
  await signOut(page);
  await attemptLogin(page, owner.email, owner.password);
  await expect(destinations(page)).toHaveCount(9);
  await expect(page.getByTestId("login-error")).toHaveCount(0);
});

test("login errors are specific: bad '@' address, invalid username, wrong credentials", async ({ page }) => {
  const owner = await tenant(page);
  await page.goto("/");
  await signOut(page);

  // Contains "@" → email path → better-auth rejects the malformed address.
  await attemptLogin(page, "no-es@correo", "cualquiera-123");
  await expect(page.getByTestId("login-error"))
    .toHaveText("Ingresá un correo válido (algo@algo.com) o un usuario sin arroba.");

  // No "@" → username path → too short.
  await attemptLogin(page, "ab", "cualquiera-123");
  await expect(page.getByTestId("login-error")).toHaveText("El usuario debe tener al menos 3 caracteres.");

  // Well sized but illegal characters (space).
  await attemptLogin(page, "ana rapido", "cualquiera-123");
  await expect(page.getByTestId("login-error"))
    .toHaveText("El usuario solo admite minúsculas, números y . _ - (sin arroba ni espacios).");

  // Well formed but unknown → wrong credentials, not a generic failure.
  await attemptLogin(page, "no.existe", "cualquiera-123");
  await expect(page.getByTestId("login-error")).toHaveText("Usuario o contraseña incorrectos.");

  // Owner still gets in with email + password after all those failures.
  await attemptLogin(page, owner.email, owner.password);
  await expect(destinations(page)).toHaveCount(9);
  await expect(page.getByTestId("login-error")).toHaveCount(0);
});
