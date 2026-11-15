import { useCallback, useMemo, useState } from "react";
import { cartTotal, lineSubtotal } from "@pos/shared";
import {
  commitLocalSale,
  type CommittedSale,
  type SaleCommitInput,
  type SaleItem,
} from "../db/local";
import { commitTableSale } from "../db/local-orders";
import { pushNow } from "../sync/queue";
import type { PGlite } from "@electric-sql/pglite";

export type CartLine = {
  variantId: string;
  label: string;
  price: number;
  qty: number;
  /** stock at add time — drives the oversell warning (D3-1 / catalog spec) */
  stock: number;
};

/** Checkout options for `commit` — the cart lines come from the hook. */
export type SaleCommitOpts =
  | { method?: "cash"; tendered: number }
  | { method: "transfer" }
  | { method: "credit"; customerId: string; cashAmount: number };

/** Mesas: the table the comanda settles (Flujo C — ticket carries its name). */
export type SaleCommitTable = { id: string; name?: string };

/**
 * Cart + commit for the 3-tap sale (task D1-8, extended by D2-6).
 * Money math is integer-only via @pos/shared (fast-check tested).
 *
 * D2-5 wiring: right after the local commit, push the queue when the
 * device is online (offline commits wait for the `online` event).
 *
 * Mesas (Fase 1): `commit(db, tenant, opts, table)` routes through
 * `commitTableSale`, which refuses to write a ticket when the table has no
 * OPEN order (ORDER_NOT_OPEN) — that pre-check is the data-layer guard
 * against charging the same comanda twice — and closes the order right
 * after the ticket lands. The stock/ticket invariant of `commitLocalSale`
 * is untouched: stock is debited inside that same transaction, never before.
 */
export function useSale() {
  const [lines, setLines] = useState<CartLine[]>([]);

  const addItem = useCallback((item: SaleItem) => {
    setLines((prev) => {
      const existing = prev.find((l) => l.variantId === item.id);
      if (existing) {
        return prev.map((l) =>
          l.variantId === item.id ? { ...l, qty: l.qty + 1 } : l,
        );
      }
      return [
        ...prev,
        {
          variantId: item.id,
          label: `${item.product_name} ${item.name}`,
          price: item.price,
          qty: 1,
          stock: item.stock,
        },
      ];
    });
  }, []);

  const setQty = useCallback((variantId: string, qty: number) => {
    setLines((prev) =>
      qty <= 0
        ? prev.filter((l) => l.variantId !== variantId)
        : prev.map((l) => (l.variantId === variantId ? { ...l, qty } : l)),
    );
  }, []);

  const clear = useCallback(() => setLines([]), []);

  /** Replaces the whole cart — used to resume a comanda from a mesa. */
  const loadLines = useCallback((next: CartLine[]) => setLines(next), []);

  const total = useMemo(
    () => lines.reduce((acc, l) => acc + lineSubtotal(l.price, l.qty), 0),
    [lines],
  );

  /**
   * Commits the sale locally in ONE tx (throws EMPTY_CART / UNDERPAYMENT —
   * the UI surfaces the message and no ticket is created), then drains the
   * queue when online (D2-5: `useSale().commit() → pushNow()`).
   */
  const commit = useCallback(
    async (
      db: PGlite,
      tenantId: string,
      opts: SaleCommitOpts,
      table?: SaleCommitTable,
    ): Promise<CommittedSale> => {
      const cartLines = lines.map((l) => ({
        variant_id: l.variantId,
        qty: l.qty,
        unit_price: l.price,
      }));
      const tableName = table?.name ?? null;
      const input: SaleCommitInput = { ...opts, lines: cartLines, table_name: tableName };
      const committed = table
        ? (await commitTableSale(db, tenantId, table.id, input)).committed
        : await commitLocalSale(db, tenantId, input);
      setLines([]);
      if (typeof navigator === "undefined" || navigator.onLine !== false) {
        void pushNow(db, tenantId);
      }
      return committed;
    },
    [lines],
  );

  return {
    lines,
    addItem,
    setQty,
    clear,
    loadLines,
    total,
    commit,
    cartTotal: cartTotal,
  };
}
