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
 *   legacy_v1 = confirmed cash + confirmed transfers + cash abonos
 *   drawer_cash_v2 = fixed opening base + cash + cash abonos + income − withdrawals
 *   The persisted SHIFT version chooses the policy, never a client close payload.
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
        ), 0) AS abonos,
        COALESCE((SELECT s.calculation_version FROM shifts s WHERE s.tenant_id=$1 AND s.id=$2), 'legacy_v1') AS calculation_version,
        COALESCE((SELECT s.opening_cash FROM shifts s WHERE s.tenant_id=$1 AND s.id=$2), 0) AS opening_cash,
        COALESCE((SELECT SUM(m.amount) FROM cash_movements m WHERE m.tenant_id=$1 AND m.shift_id=$2 AND m.direction='in'), 0) AS income,
        COALESCE((SELECT SUM(m.amount) FROM cash_movements m WHERE m.tenant_id=$1 AND m.shift_id=$2 AND m.direction='out'), 0) AS withdrawals
FROM payments
WHERE tenant_id = $1 AND shift_id = $2
  AND NOT EXISTS (SELECT 1 FROM tickets tk WHERE tk.tenant_id=payments.tenant_id AND tk.id=payments.ticket_id AND tk.status='voided')`;

export type ExpectedBreakdown = {
  calculation_version?: "drawer_cash_v2";
  opening_cash?: number;
  income?: number;
  withdrawals?: number;
  /** confirmed cash in the drawer */
  cash: number;
  /** confirmed bank transfers (included only in legacy expected) */
  transfers: number;
  /** pending transfers — excluded from expected, reported separately */
  pending: number;
  /** cash abonos of the shift (drawer money) — transfer abonos excluded */
  abonos: number;
  /** Derived using the shift's policy; may be negative after withdrawals. */
  expected: number;
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

export function parseExpectedRow(row: Record<string, unknown> | undefined): ExpectedBreakdown {
  const cash = num(row?.cash);
  const transfers = num(row?.transfers);
  const pending = num(row?.pending);
  const abonos = num(row?.abonos);
  if (row?.calculation_version === "drawer_cash_v2") {
    const opening_cash = num(row.opening_cash), income = num(row.income), withdrawals = num(row.withdrawals);
    return { cash, transfers, pending, abonos, opening_cash, income, withdrawals, calculation_version: "drawer_cash_v2",
      expected: opening_cash + cash + abonos + income - withdrawals };
  }
  return { cash, transfers, pending, abonos, expected: cash + transfers + abonos };
}

/** diff = counted − expected (cash-close spec §Counted entry and diff). */
export function arqueoDiff(counted: number, expected: number): number {
  return counted - expected;
}

/** Non-negative integer pesos — negative counted is rejected (spec). */
export const countedSchema = z.number().int().nonnegative().max(2147483647);
