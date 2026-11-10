import { z } from "zod";

/** All money is integer Colombian pesos. Floats are forbidden (design §12). */
export const moneySchema = z.number().int().nonnegative();

const lineSchema = z.object({
  price: moneySchema,
  qty: z.number().int().positive(),
});

export const cartLineSchema = lineSchema.extend({
  subtotal: moneySchema,
});

export type CartLine = z.infer<typeof lineSchema>;

export function lineSubtotal(price: number, qty: number): number {
  const parsed = lineSchema.parse({ price, qty });
  return parsed.price * parsed.qty;
}

export function cartTotal(lines: readonly { price: number; qty: number }[]): number {
  let total = 0;
  for (const line of lines) total += lineSubtotal(line.price, line.qty);
  return total;
}

export function assertNonEmptyCart(lines: readonly { price: number; qty: number }[]): void {
  if (lines.length === 0) {
    throw new Error("EMPTY_CART");
  }
}

export function assertCheckoutable(lines: readonly { price: number; qty: number }[]): number {
  assertNonEmptyCart(lines);
  return cartTotal(lines);
}

/** tendered >= total required; returns vuelto. Underpayment throws UNDERPAYMENT. */
export function computeVuelto(total: number, tendered: number): number {
  const t = moneySchema.parse(total);
  const d = moneySchema.parse(tendered);
  if (d < t) throw new Error("UNDERPAYMENT");
  return d - t;
}
