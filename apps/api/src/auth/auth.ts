import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { username as usernamePlugin } from "better-auth/plugins/username";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, PASSWORD_MIN, USERNAME_RE } from "@pos/shared";
import { pool } from "../db";
import { config } from "../config";
import { authLogger } from "./logger";

/**
 * Better-auth instance (task D1-3).
 *
 * - organizationPlugin → tenants are organizations, memberships carry the
 *   role `owner|member`, session carries `activeOrganizationId`.
 * - usernamePlugin (better-auth 1.7.19, official `better-auth/plugins/username`)
 *   → members sign in with `username` + password. `user.username` is a GLOBAL
 *   unique nullable column: owners/superadmins simply leave it null and keep
 *   signing in with their email. Login dispatch is decided by the client
 *   ("Usuario o correo": contains "@" → /sign-in/email, else → /sign-in/username).
 *   `displayUsername: false` keeps a single column (no displayUsername).
 * - `platformAdmin` is an additional user field: a platform admin is NOT a
 *   tenant owner — tenant roles can never satisfy requirePlatformAdmin
 *   (design §4).
 * - Auth tables are bootstrapped by better-auth itself (getMigrations →
 *   runMigrations, see db/bootstrap.ts). We deliberately do NOT mirror them
 *   into the Drizzle schema: business tables are drizzle-kit-managed, auth
 *   tables are better-auth-managed, both on the same Postgres. The username
 *   column is added by that same bootstrap as a nullable + unique column, so
 *   it is safe on an already populated `user` table.
 * - `database: pool` (raw pg Pool, kysely's structural PostgresPool) so
 *   better-auth runs its reference kysely adapter on the same connection
 *   pool drizzle uses for business tables.
 */
export const authOptions = {
  secret: config.betterAuthSecret,
  baseURL: config.betterAuthUrl,
  trustedOrigins: config.trustedOrigins,
  emailAndPassword: {
    enabled: true,
    // Global floor for every CREATION path (owner signup, founder API/CLI,
    // member creation, admin reset). Sign-in never validates it — better-auth
    // only calls assertPasswordNotTooShort from sign-up and reset-password —
    // so accounts created before the floor was raised still get in.
    minPasswordLength: PASSWORD_MIN,
  },
  // PII in logs (audit P1-5): better-auth prints through its OWN console
  // logger, not pino, so pino `redact` cannot reach it. `authLogger` pins the
  // level at "warn" (which already drops the `sign-up.mjs:194` info line that
  // interpolates the e-mail) and scrubs e-mail tokens from anything that does
  // get printed. See src/auth/logger.ts.
  logger: authLogger,
  database: pool,
  // Tenant ids are stored as uuid in every business table (design §2) —
  // better-auth must therefore generate uuid ids. A custom generator is used
  // instead of `generateId: "uuid"` because the latter relies on a column
  // DEFAULT that better-auth's own migrations do not create.
  advanced: {
    database: {
      generateId: () => randomUUID(),
    },
  },
  user: {
    additionalFields: {
      platformAdmin: {
        type: "boolean" as const,
        required: false,
        defaultValue: false,
        input: false,
      },
    },
  },
  plugins: [
    organization(),
    usernamePlugin({
      displayUsername: false,
      minUsernameLength: USERNAME_MIN_LENGTH,
      maxUsernameLength: USERNAME_MAX_LENGTH,
      usernameValidator: (value) => USERNAME_RE.test(value),
      // Normalise (lowercase) first, then validate: "Ana" is stored and
      // signed in as "ana", instead of being rejected for its capital.
      validationOrder: { username: "post-normalization" },
    }),
  ],
};

/**
 * LAZY instance (validated at first use, NOT at module import).
 *
 * `betterAuth()` eagerly starts its schema check at construction time — on a
 * fresh database that logs a scary "Database schema mismatch" error BEFORE
 * db/bootstrap.ts had any chance to create those tables. Building the
 * instance on first use keeps validation ON with the tables already present
 * (every entry point runs ensureAuthTables() first).
 */
let cached: ReturnType<typeof betterAuth<typeof authOptions>> | null = null;

export function getAuth(): ReturnType<typeof betterAuth<typeof authOptions>> {
  cached ??= betterAuth(authOptions);
  return cached;
}
