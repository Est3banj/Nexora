import { pool } from "./index";
import { VARIANT_CODE_MIGRATION_SQL } from "@pos/shared";

/** Safe on existing pilot databases, including auth tables. No schema push. */
export async function migrateCatalog(): Promise<void> {
  await pool.query(VARIANT_CODE_MIGRATION_SQL);
}
