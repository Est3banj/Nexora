/**
 * Payment-method labels — the H3 fix vehicle (credit-sales spec §Method
 * labels render "Crédito").
 *
 * ONE map from method code → operator-facing Spanish, so no surface can
 * ever swallow `credit` behind a hardcoded "efectivo" fallback again
 * (CommandPalette today does exactly that) or render "—" for a known
 * method (Tickets today does that for anything but cash/transfer).
 *
 * Accepts a single code, an array, or a `string_agg(DISTINCT method)`
 * string ("cash,credit"); null / empty / unknown → "—". Several distinct
 * methods compose as "Mixto (…)" with the same vocabulary, lowercased.
 */
const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  transfer: "Transferencia",
  credit: "Crédito",
};

export function paymentMethodLabel(methods: string | string[] | null): string {
  const codes = (
    Array.isArray(methods) ? methods : String(methods ?? "").split(",")
  )
    .map((code) => code.trim())
    .filter(Boolean);

  const labels: string[] = [];
  for (const code of codes) {
    const label = METHOD_LABELS[code];
    if (label && !labels.includes(label)) labels.push(label);
  }

  if (labels.length === 0) return "—";
  if (labels.length === 1) return labels[0];
  return `Mixto (${labels.map((label) => label.toLowerCase()).join(" + ")})`;
}
