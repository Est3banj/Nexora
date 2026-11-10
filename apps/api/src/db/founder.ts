import { pool } from "./index";

/**
 * Founder control-plane queries (tasks D4-1 / D4-2, founder-control spec
 * §Per-tenant sync status + §Tenant isolation applies to founder queries).
 *
 * Lives in src/db/ because it reads the better-auth `organization`/`member`
 * tables (auth tables are better-auth-managed, NOT in the Drizzle schema —
 * see db/bootstrap.ts). The D1-4 lint gate allows raw SQL here only.
 *
 * ISOLATION BY CONSTRUCTION: every per-tenant number is a correlated
 * subquery bound to ONE organization row (`tenant_id = o.id`) — rows are
 * never merged, so A=7 + B=2 can never surface as 9 (spec §Counts do not
 * bleed across tenants). Returns METADATA ONLY: no product names, ticket
 * contents or payment amounts ever cross this boundary (spec §Founder
 * plane exposes no tenant business data).
 */

export type FounderSyncStatus = {
  tenant_id: string;
  name: string;
  users: number;
  pending: number;
  last_sync: Date | null;
  errors: number;
  last_error: string | null;
};

/**
 * One row per tenant: user count, pending mutation count (queue drain
 * metric), last successful sync, current error count + latest error.
 * `pending` = statuses the drain loop still owns (pending/in_flight/failed);
 * `errors` = failed/poison rows (visible, not auto-retried once poisoned).
 */
const SYNC_STATUS_SQL = `
  SELECT
    o.id::text AS tenant_id,
    o.name,
    (SELECT count(*)
       FROM member m
      WHERE m."organizationId" = o.id)::int AS users,
    (SELECT count(*)
       FROM sync_log s
      WHERE s.tenant_id::text = o.id
        AND s.status IN ('pending', 'in_flight', 'failed'))::int AS pending,
    (SELECT max(s.updated_at)
       FROM sync_log s
      WHERE s.tenant_id::text = o.id
        AND s.status = 'synced') AS last_sync,
    (SELECT count(*)
       FROM sync_log s
      WHERE s.tenant_id::text = o.id
        AND s.status IN ('failed', 'poison'))::int AS errors,
    (SELECT s.last_error
       FROM sync_log s
      WHERE s.tenant_id::text = o.id
        AND s.status IN ('failed', 'poison')
      ORDER BY s.updated_at DESC
      LIMIT 1) AS last_error
  FROM organization o
  ORDER BY o.name
`;

export async function founderSyncStatus(): Promise<FounderSyncStatus[]> {
  const res = await pool.query<FounderSyncStatus>(SYNC_STATUS_SQL);
  return res.rows;
}
