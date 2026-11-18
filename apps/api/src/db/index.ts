import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { config } from "../config";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

/**
 * P1-4 · an IDLE client error (server restart, TCP blip, an admin
 * `pg_terminate_backend`) is emitted on the pool with no request in flight.
 * Without a listener Node treats it as an unhandled `error` event and kills
 * the process with a stack that says nothing about which pool died. Log it
 * with context instead: the next checkout retries on a fresh connection, so a
 * transient drop stays transient. Errors attached to a specific query still
 * reject that query's promise and reach the route/error handler as before.
 */
pool.on("error", (err) => {
  console.error("[db] idle client error:", err);
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}
