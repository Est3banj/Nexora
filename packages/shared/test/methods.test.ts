import { expect, it } from "vitest";
import { paymentMethodLabel } from "../src/methods";

it.each([
  ["cash", "Efectivo"], ["transfer", "Transferencia"], ["credit", "Crédito"],
  [null, "—"], ["unknown", "—"], ["cash,credit", "Mixto (efectivo + crédito)"],
] as const)("labels %s honestly", (method, expected) => expect(paymentMethodLabel(method)).toBe(expected));
