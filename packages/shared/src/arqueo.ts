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
 *   expected = confirmed cash + confirmed transfers
 *   pending  = transfers still `pending` → reported separately, NEVER counted
 *   diff     = counted - expected (derived, never entered)
 *
 * $1 = tenant_id · $2 = shift_id
 */
export const EXPECTED_FROM_PAYMENTS_SQL = /* sql */ `
SELECT COALESCE(SUM(amount) FILTER (WHERE method = 'cash' AND status = 'confirmed'), 0) AS cash,
       COALESCE(SUM(amount) FILTER (WHERE method = 'transfer' AND status = 'confirmed'), 0) AS transfers,
       COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending
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
  /** cash + transfers */
  expected: number;
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

export function parseExpectedRow(row: Record<string, unknown> | undefined): ExpectedBreakdown {
  const cash = num(row?.cash);
  const transfers = num(row?.transfers);
  const pending = num(row?.pending);
  return { cash, transfers, pending, expected: cash + transfers };
}

/** diff = counted − expected (cash-close spec §Counted entry and diff). */
export function arqueoDiff(counted: number, expected: number): number {
  return counted - expected;
}

/** Non-negative integer pesos — negative counted is rejected (spec). */
export const countedSchema = z.number().int().nonnegative();
