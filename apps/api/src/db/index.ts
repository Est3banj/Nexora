import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { config } from "../config";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export const db = drizzle(pool, { schema });

export type Db = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}
