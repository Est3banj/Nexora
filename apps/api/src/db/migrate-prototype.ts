import { PROTOTYPE_MIGRATION_SQL } from "@pos/shared";
import { pool } from "./index";

export async function migratePrototype(): Promise<void> {
  await pool.query(PROTOTYPE_MIGRATION_SQL);
}
