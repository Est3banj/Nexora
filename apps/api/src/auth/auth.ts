import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { pool } from "../db";
import { config } from "../config";

/**
 * Better-auth instance (task D1-3).
 *
 * - organizationPlugin → tenants are organizations, memberships carry the
 *   role `owner|member`, session carries `activeOrganizationId`.
 * - `platformAdmin` is an additional user field: a platform admin is NOT a
 *   tenant owner — tenant roles can never satisfy requirePlatformAdmin
 *   (design §4).
 * - Auth tables are bootstrapped by better-auth itself (getMigrations →
 *   runMigrations, see db/bootstrap.ts). We deliberately do NOT mirror them
 *   into the Drizzle schema: business tables are drizzle-kit-managed, auth
 *   tables are better-auth-managed, both on the same Postgres.
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
    minPasswordLength: 8,
  },
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
  plugins: [organization()],
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
