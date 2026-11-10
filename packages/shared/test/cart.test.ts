import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  assertCheckoutable,
  cartTotal,
  computeVuelto,
  lineSubtotal,
} from "../src/cart";

describe("lineSubtotal", () => {
  it("2 × 4000 = 8000 and 3 × 7000 = 21000 (sales spec cart arithmetic)", () => {
    expect(lineSubtotal(4000, 2)).toBe(8000);
    expect(lineSubtotal(7000, 3)).toBe(21000);
  });

  it("rejects negative or non-integer money", () => {
    expect(() => lineSubtotal(-1, 1)).toThrow();
    expect(() => lineSubtotal(4000.5, 1)).toThrow();
    expect(() => lineSubtotal(4000, 0)).toThrow();
    expect(() => lineSubtotal(4000, 1.5)).toThrow();
  });
});

describe("cartTotal", () => {
  it("2×4000 + 3×7000 = 29000 exactly", () => {
    expect(
      cartTotal([
        { price: 4000, qty: 2 },
        { price: 7000, qty: 3 },
      ]),
    ).toBe(29000);
  });

  it("property: total equals exact integer sum of line subtotals", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            price: fc.integer({ min: 0, max: 1_000_000 }),
            qty: fc.integer({ min: 1, max: 50 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (lines) => {
          const expected = lines.reduce((acc, l) => acc + l.price * l.qty, 0);
          expect(cartTotal(lines)).toBe(expected);
          expect(Number.isInteger(cartTotal(lines))).toBe(true);
        },
      ),
    );
  });
});

describe("empty cart", () => {
  it("empty cart is not checkoutable (sales spec)", () => {
    expect(() => assertCheckoutable([])).toThrow("EMPTY_CART");
  });
});

describe("computeVuelto", () => {
  it("exact payment → vuelto 0", () => {
    expect(computeVuelto(12000, 12000)).toBe(0);
  });

  it("overpayment → 8000", () => {
    expect(computeVuelto(12000, 20000)).toBe(8000);
  });

  it("underpayment rejected", () => {
    expect(() => computeVuelto(12000, 10000)).toThrow("UNDERPAYMENT");
  });

  it("property: vuelto = tendered - total whenever tendered >= total", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (total, extra) => {
          expect(computeVuelto(total, total + extra)).toBe(extra);
        },
      ),
    );
  });
});
