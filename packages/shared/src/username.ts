/**
 * Username identity for tenant members (empleados y administradores).
 *
 * better-auth's `username` plugin stores `user.username`: a GLOBAL unique
 * column, because better-auth users are global while `member` rows are the
 * per-organization layer. Owners and superadmins keep their email identity.
 *
 * The rules below are the single source of truth for BOTH sides:
 *  - apps/api → zod schema of POST /api/admin/users and the better-auth
 *    `usernameValidator` (server is authoritative).
 *  - apps/web → client-side validation in the "Crear usuario" dialog and the
 *    "Usuario o correo" login field.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

/**
 * Single password floor for every CREATION path: better-auth sign-up,
 * founder tenant creation (API + CLI), admin "Crear usuario" and admin
 * "Restablecer contraseña".
 *
 * Sign-IN deliberately does NOT validate this — an account created before
 * the floor was raised must keep working (better-auth only calls
 * `assertPasswordNotTooShort` from sign-up and reset-password, never from
 * sign-in). Raising the floor must never lock existing users out.
 */
export const PASSWORD_MIN = 12;

/** Lowercase letters, digits and . _ - — never "@" and never spaces. */
export const USERNAME_PATTERN = "^[a-z0-9._-]+$";

/**
 * Shared RegExp for the rule above. Deliberately has NO `g` flag: `lastIndex`
 * stays 0, so `.test()` is safe to call repeatedly from both apps.
 */
export const USERNAME_RE = new RegExp(USERNAME_PATTERN);

export function isValidUsername(value: string): boolean {
  return (
    value.length >= USERNAME_MIN_LENGTH &&
    value.length <= USERNAME_MAX_LENGTH &&
    USERNAME_RE.test(value)
  );
}

/**
 * better-auth's base user schema declares `email` as required + unique, and
 * the `username` plugin does not relax it. This app NEVER sends email: there
 * is no verification, reset-password, magic-link or invitation flow
 * (grep: sendResetPassword / sendVerificationEmail / smtp → no matches).
 *
 * So a member created with a username gets a synthetic, non-routable address
 * derived from the username. It is an internal key only — the UI shows the
 * username, login goes through `POST /api/auth/sign-in/username`, and nothing
 * ever resolves this address over the network.
 */
export const MEMBER_EMAIL_DOMAIN = "nexora.local";

export function memberEmailFromUsername(username: string): string {
  return `${username.trim().toLowerCase()}@${MEMBER_EMAIL_DOMAIN}`;
}
