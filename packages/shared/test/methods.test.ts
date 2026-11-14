import { expect, it } from "vitest";
import { formatTicketNo, paymentMethodLabel } from "../src/methods";

it.each([
  ["cash", "Efectivo"], ["transfer", "Transferencia"], ["credit", "Crédito"],
  [null, "—"], ["unknown", "—"], ["cash,credit", "Mixto (efectivo + crédito)"],
] as const)("labels %s honestly", (method, expected) => expect(paymentMethodLabel(method)).toBe(expected));

/* roles-admin 5.7 · formatTicketNo is the ONE display composer for the
 * receipt TICKET row, the Tickets list cell and receipt hosts. The stored
 * integer sequence is never touched — only the label changes. */
it.each([
  [null, 1, "1"],
  ["", 12, "12"],
  ["   ", 12, "12"],
  ["NX", 1, "NX-1"],
  ["NX", 123, "NX-123"],
  ["  NX  ", 7, "NX-7"],
] as const)("formats %p + %s as %s", (prefix, no, expected) =>
  expect(formatTicketNo(prefix, no)).toBe(expected));

it("never mutates the sequence semantics (pure string composition)", () => {
  expect(formatTicketNo("NX", 999)).toBe("NX-999");
  expect(formatTicketNo(undefined, 0)).toBe("0");
});
