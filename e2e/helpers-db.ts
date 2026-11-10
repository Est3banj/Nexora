import { execSync } from "node:child_process";

export const E2E_DB = "postgres://esteban@127.0.0.1:5432/pos_piloto_e2e";

export function dbOne(sql: string): string {
  return execSync(`psql "${E2E_DB}" -tA -c ${JSON.stringify(sql)}`, {
    encoding: "utf8",
  }).trim();
}

/**
 * Hermetic wipe for specs that assert EMPTY local/server state after login.
 * First-boot rehydrate (D4-4) pulls server truth into a fresh cache — so the
 * server must actually be empty for empty-* assertions to hold.
 * Wipes sales + catalog + stock + queue (keeps org/users/shift).
 */
export function wipeSalesAndCatalog(): void {
  dbOne("DELETE FROM ticket_lines");
  dbOne("DELETE FROM payments");
  dbOne("DELETE FROM tickets");
  dbOne("DELETE FROM stockdiary");
  dbOne("DELETE FROM stockcurrent");
  dbOne("DELETE FROM product_variants");
  dbOne("DELETE FROM products");
  dbOne("DELETE FROM sync_log");
  dbOne("DELETE FROM closedcash");
}

/** Sales-only wipe: keep catalog (specs that sell into existing products). */
export function wipeSales(): void {
  dbOne("DELETE FROM ticket_lines");
  dbOne("DELETE FROM payments");
  dbOne("DELETE FROM tickets");
}
