import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../src/db/pglite";
import { commitLocalSale, createLocalProduct, getLocalTicket, recountLocal, openLocalShift } from "../src/db/local";
import { mirrorVoidedSale } from "../src/db/void-sale";
import { annulTicket, AnnulError } from "../src/db/annul";
import { groupQueue } from "../src/sync/batch";
import { DASHBOARD_SUMMARY_SQL, EXPECTED_FROM_PAYMENTS_SQL, localDate } from "@pos/shared";

const tenant = "33333333-3333-4333-8333-333333333333";
let db: PGlite;
beforeEach(async () => { db = (await openLocalDb({ url: "memory://", locks: null }))!.db; });
afterEach(async () => { vi.unstubAllGlobals(); await db.close(); });

it("mirrors compensation once, keeps originals and later offline sale, preserves cost in variant queue", async () => {
  await openLocalShift(db, tenant);
  const product = await createLocalProduct(db, tenant, { name: "Café", variant: { name: "Único", price: 4000, cost: 1500, stock: 10 } });
  const variantId = product.variants[0].id;
  const first = await commitLocalSale(db, tenant, { lines: [{ variant_id: variantId, qty: 2, unit_price: 4000 }], tendered: 10000 });
  const second = await commitLocalSale(db, tenant, { lines: [{ variant_id: variantId, qty: 1, unit_price: 4000 }], tendered: 4000 });
  const originals = (await getLocalTicket(db, tenant, first.ticket.id))!;
  const snapshot = { ticket_id: first.ticket.id, stockdiary: [{ id: crypto.randomUUID(), variant_id: variantId, delta: 2, note: "Error de cobro", created_at: new Date().toISOString() }] };
  await mirrorVoidedSale(db, tenant, snapshot);
  await mirrorVoidedSale(db, tenant, snapshot);
  expect(await recountLocal(db, tenant, variantId)).toBe(9);
  expect((await db.query("SELECT stock FROM product_variants WHERE id=$1", [variantId])).rows[0]).toEqual({ stock: 9 });
  expect((await db.query("SELECT stock FROM stockcurrent WHERE variant_id=$1", [variantId])).rows[0]).toEqual({ stock: 9 });
  const after = (await getLocalTicket(db, tenant, first.ticket.id))!;
  expect(after.ticket).toMatchObject({ ...originals.ticket, status: "voided", void_reason: "Error de cobro", voided_at: expect.anything() });
  expect(after.lines).toEqual(originals.lines);
  expect((await getLocalTicket(db, tenant, second.ticket.id))?.ticket.status).toBe("completed");
  const queued = (await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM sync_log WHERE entity='variant' AND client_uuid=$1", [variantId])).rows[0].payload;
  expect(queued).toMatchObject({ cost: 1500, stock: 9, ref_ticket_id: second.ticket.id });
  const date = localDate();
  const dashboard = (await db.query<Record<string, unknown>>(DASHBOARD_SUMMARY_SQL, [tenant, date, date])).rows[0];
  expect(Number(dashboard.revenue)).toBe(4000);
  expect(Number(dashboard.cogs)).toBe(1500);
  const shiftId = (await db.query<{ shift_id: string }>("SELECT shift_id FROM tickets WHERE id=$1", [first.ticket.id])).rows[0].shift_id;
  const expected = (await db.query<Record<string, unknown>>(EXPECTED_FROM_PAYMENTS_SQL, [tenant, shiftId])).rows[0];
  expect(Number(expected.cash)).toBe(4000);
});

it("keeps two sales separate when queue ordering interleaves children, and preserves a sale larger than batch cap intact", () => {
  const row = (id: string, entity: string, payload: unknown) => ({ id, client_uuid: id, entity, payload });
  const input = [row("a", "ticket", {}), row("b", "ticket", {}), row("pay-b", "payment", { ticket_id: "b" }), row("pay-a", "payment", { ticket_id: "a" }), ...Array.from({ length: 52 }, (_, i) => row(`line-${i}`, "ticket_line", { ticket_id: "a" }))];
  const groups = groupQueue(input);
  expect(groups.map(g => g.length)).toEqual([54, 2]);
  expect(groups[0].some(r => r.id === "pay-b")).toBe(false);
  expect(groups[1].map(r => r.id)).toEqual(["b", "pay-b"]);
});

// roles-admin 4.5 · annulTicket passes the optional `code` in the body and
// maps the D3 403 table to the exact Spanish operator copy (design D3).
it("annulTicket sends `code` in the body only when provided", async () => {
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return Response.json({ error: "annul_code_required" }, { status: 403 });
  }));

  await expect(annulTicket(db, tenant, crypto.randomUUID(), "Error de cobro"))
    .rejects.toThrow("Ingresá el código de anulación para anular");
  expect(sent[0]).toEqual({ reason: "Error de cobro" });
  expect(sent[0]).not.toHaveProperty("code");

  await expect(annulTicket(db, tenant, crypto.randomUUID(), "Error de cobro", "K7QW2M9R"))
    .rejects.toThrow("Ingresá el código de anulación para anular");
  expect(sent[1]).toEqual({ reason: "Error de cobro", code: "K7QW2M9R" });
});

it("maps every D3 403 body to its exact Spanish copy (design D3 table)", async () => {
  const cases = [
    [{ error: "annul_code_required" }, "Ingresá el código de anulación para anular"],
    [{ error: "annul_code_invalid", detail: "expired" }, "El código de anulación venció; pedí uno nuevo en Administración"],
    [{ error: "annul_code_invalid", detail: "mismatch" }, "Código de anulación incorrecto"],
    [{ error: "owner_only" }, "Solo el dueño o un administrador puede anular ventas"],
  ] as const;
  for (const [payload, message] of cases) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload, { status: 403 })));
    await expect(
      annulTicket(db, tenant, crypto.randomUUID(), "Error de cobro", "ABCDEFGH"),
    ).rejects.toThrow(message);
  }
  // operator-facing copy stays an AnnulError (callers branch on it)
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "owner_only" }, { status: 403 })));
  await expect(annulTicket(db, tenant, crypto.randomUUID(), "Error de cobro")).rejects.toBeInstanceOf(AnnulError);
});

it("a 200 with the code supplied continues into the local mirror", async () => {
  const ticketId = crypto.randomUUID();
  vi.stubGlobal("fetch", vi.fn(async () =>
    Response.json({ ticket_id: ticketId, stockdiary: [] })));
  await expect(
    annulTicket(db, tenant, ticketId, "Error de cobro", "K7QW2M9R"),
  ).resolves.toBeUndefined();
});
