import { pool } from "./index";
import { FIADO_MIGRATION_SQL } from "@pos/shared";

/** Additive: customers + credit_abonos + tickets.customer_id (design §2). */
export async function migrateFiado(): Promise<void> {
  await pool.query(FIADO_MIGRATION_SQL);
}
