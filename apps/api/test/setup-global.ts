import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "..");

const TEST_DB = "pos_piloto_test";
export const TEST_DATABASE_URL = `postgres://esteban@127.0.0.1:5432/${TEST_DB}`;

/**
 * Vitest global setup (runs once, main process):
 * 1. drop + recreate the test database (clean slate every run)
 * 2. export DATABASE_URL to every worker BEFORE any app module is imported
 * 3. `drizzle-kit push` — the exact same path as D1-2 AC / dev / prod boot
 * 4. better-auth tables via ensureAuthTables (same path as API boot)
 */
export default async function globalSetup(): Promise<void> {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  process.env.BETTER_AUTH_SECRET ??= "test-secret-0123456789abcdef0123456789";
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

  const admin = new Client({
    connectionString: "postgres://esteban@127.0.0.1:5432/postgres",
  });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DB],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();

  execFileSync("pnpm", ["exec", "drizzle-kit", "push"], {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });

  const { ensureAuthTables } = await import("../src/db/bootstrap");
  await ensureAuthTables();
  const { closeDb } = await import("../src/db");
  await closeDb();
}
