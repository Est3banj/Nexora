import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "../auth/auth";

/**
 * Creates better-auth tables (user/session/account/verification/organization/
 * member/invitation + session.activeOrganizationId + user.platformAdmin) when
 * missing. Idempotent: introspects first, creates only what does not exist.
 *
 * Runs on API boot and in test setup — same code path in both cases.
 *
 * NOTE: the migration runs with `validateSchema: false`. On a fresh database
 * better-auth's schema check would (correctly!) report "missing tables"
 * BEFORE the very CREATE statements it is about to execute — a chicken-and-
 * egg log that looks like a boot failure. The real auth instance keeps
 * validation ON, so genuine drift is still caught at runtime.
 */
export async function ensureAuthTables(): Promise<void> {
  const migrationOptions = {
    ...authOptions,
    advanced: {
      ...authOptions.advanced,
      database: {
        ...authOptions.advanced.database,
        validateSchema: false,
      },
    },
  };

  const plan = await getMigrations(migrationOptions, { throwOnUnsafe: false });
  if (plan.unsafeChanges.length > 0) {
    console.warn(
      "[auth-bootstrap] unsafe changes detected:",
      plan.unsafeChanges.join(" | "),
    );
  }
  await plan.runMigrations();
}
