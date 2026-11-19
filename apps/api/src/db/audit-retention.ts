import { pool } from "./index";

/**
 * AUDIT_LOG RETENTION (plan de estabilidad · disco del servidor).
 *
 * POLICY: audit rows are kept for AUDIT_RETENTION_DAYS (180 days) and then
 * deleted. `audit_log` is insert-only (scope.ts) with no read path in the
 * product — nothing renders it, nothing aggregates it — so unbounded growth
 * only buys a full table + a seq scan on every future maintenance query and
 * a disk bill at the months scale. 180 days covers dispute/chargeback
 * windows, the DEPLOY.md `SELECT … FROM audit_log ORDER BY created_at DESC`
 * debugging query and any audit review the pilot actually does; older rows
 * are outside every real window.
 *
 * PLACEMENT: boot step of the API (server.ts), AFTER initBaseline — the
 * baseline is what guarantees `audit_log` exists on a fresh database — and
 * after the additive migrations, so it always runs against a complete
 * schema. It is idempotent (a DELETE over a timestamp cutoff) and cheap at
 * pilot scale: one statement, once per boot.
 *
 * COST NOTE (why a single global DELETE, not a per-tenant loop): the only
 * index is `audit_log_tenant_created_idx (tenant_id, created_at)`, whose
 * leading column the global `created_at < …` predicate cannot use — so this
 * is one seq scan over a table that is small by construction (audit rows,
 * one per mutation/void/tenant event). A per-tenant loop would trade that
 * single pass for N round trips + N index scans and a chunk of loop code,
 * for no measurable win at this size. Revisit ONLY if audit_log grows to
 * millions of rows; at that point the right fix is a `created_at` index (or
 * partitioning), not a loop.
 *
 * FAILURE MODE: retention is housekeeping, never a gate. A failed prune is
 * logged loudly and the boot continues (the next boot retries — the DELETE
 * is idempotent); taking the POS down because a cleanup statement failed
 * would be the wrong trade.
 */
export const AUDIT_RETENTION_DAYS = 180;

/**
 * Deletes audit rows older than the retention policy. Returns how many rows
 * were removed (0 when nothing crossed the cutoff — the idempotent path).
 */
export async function pruneAuditLog(): Promise<number> {
  const res = await pool.query(
    `DELETE FROM audit_log WHERE created_at < now() - ($1::int * interval '1 day')`,
    [AUDIT_RETENTION_DAYS],
  );
  return res.rowCount ?? 0;
}
