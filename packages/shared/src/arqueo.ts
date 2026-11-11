import { z } from "zod";

/**
 * Arqueo math (task D3-2 / D3-3, design §7, cash-close spec).
 *
 * `expected` is ALWAYS derived from the payments table — never from UI
 * totals or carts. The SAME SQL runs server-side (close endpoint) and
 * locally (offline close), so the reconciliation property
 * (local expected == server recomputation) holds by construction and is
 * proven by the property test.
 *
 *   expected = confirmed cash + confirmed transfers + cash abonos of the
 *              shift (fiado — the ONE additive component, design §4.1)
 *   pending  = transfers still `pending` → reported separately, NEVER counted
 *   diff     = counted - expected (derived, never entered)
 *
 * Credit payments and transfer abonos enter NEITHER expected nor pending.
 * Params stay `$1/$2` ONLY: the naive splitter in sync-apply.ts and the
 * positional binding in local.ts rewrite this text by hand — adding a third
 * param would break the closedcash recompute.
 *
 * $1 = tenant_id · $2 = shift_id
 */
export const EXPECTED_FROM_PAYMENTS_SQL = /* sql */ `
SELECT COALESCE(SUM(amount) FILTER (WHERE method = 'cash' AND status = 'confirmed'), 0) AS cash,
       COALESCE(SUM(amount) FILTER (WHERE method = 'transfer' AND status = 'confirmed'), 0) AS transfers,
       COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending,
       COALESCE((
         SELECT SUM(a.amount) FROM credit_abonos a
         WHERE a.tenant_id = $1 AND a.shift_id = $2 AND a.method = 'cash'
       ), 0) AS abonos
FROM payments
WHERE tenant_id = $1 AND shift_id = $2
  AND NOT EXISTS (SELECT 1 FROM tickets tk WHERE tk.tenant_id=payments.tenant_id AND tk.id=payments.ticket_id AND tk.status='voided')`;

export type ExpectedBreakdown = {
  /** confirmed cash in the drawer */
  cash: number;
  /** confirmed bank transfers (included in expected per spec) */
  transfers: number;
  /** pending transfers — excluded from expected, reported separately */
  pending: number;
  /** cash abonos of the shift (drawer money) — transfer abonos excluded */
  abonos: number;
  /** cash + transfers + abonos */
  expected: number;
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

export function parseExpectedRow(row: Record<string, unknown> | undefined): ExpectedBreakdown {
  const cash = num(row?.cash);
  const transfers = num(row?.transfers);
  const pending = num(row?.pending);
  const abonos = num(row?.abonos);
  return { cash, transfers, pending, abonos, expected: cash + transfers + abonos };
}

/** diff = counted − expected (cash-close spec §Counted entry and diff). */
export function arqueoDiff(counted: number, expected: number): number {
  return counted - expected;
}

/** Non-negative integer pesos — negative counted is rejected (spec). */
export const countedSchema = z.number().int().nonnegative();
