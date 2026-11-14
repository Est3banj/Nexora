import { createAuthClient } from "better-auth/react";
import { organizationClient, usernameClient } from "better-auth/client/plugins";

/**
 * Better-auth browser client. Same-origin via the Vite dev proxy
 * (/api → API server), so cookies are first-party and the PWA keeps
 * working behind Caddy in D4 without CORS.
 *
 * `usernameClient({ displayUsername: false })` mirrors the server plugin
 * exactly — members sign in with username + password, owners with email.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient(), usernameClient({ displayUsername: false })],
  fetchOptions: { timeout: 15_000 },
});

export type SessionLike = {
  session: {
    id: string;
    activeOrganizationId?: string | null;
  };
  user: { id: string; email: string; name: string };
};

/** Spanish copy for every credential error the two sign-in paths can return. */
const LOGIN_ERRORS: Record<string, string> = {
  INVALID_EMAIL: "Ingresá un correo válido (algo@algo.com) o un usuario sin arroba.",
  INVALID_EMAIL_OR_PASSWORD: "Usuario o contraseña incorrectos.",
  INVALID_USERNAME_OR_PASSWORD: "Usuario o contraseña incorrectos.",
  USERNAME_TOO_SHORT: "El usuario debe tener al menos 3 caracteres.",
  USERNAME_TOO_LONG: "El usuario no puede superar los 20 caracteres.",
  INVALID_USERNAME: "El usuario solo admite minúsculas, números y . _ - (sin arroba ni espacios).",
  USERNAME_IS_ALREADY_TAKEN: "Ese usuario ya está en uso.",
  EMAIL_NOT_VERIFIED: "Esa cuenta necesita verificar su correo antes de ingresar.",
};

export function loginErrorMessage(code?: string): string {
  return (code && LOGIN_ERRORS[code]) ?? "No se pudo ingresar. Revisá el usuario o correo, la contraseña y la conexión.";
}

/** better-auth 1.7 does not type activeOrganizationId (see apps/api auth.ts). */
export function activeOrgId(sessionData: unknown): string | null {
  const s = sessionData as { session?: { activeOrganizationId?: string | null } } | null;
  return s?.session?.activeOrganizationId ?? null;
}
