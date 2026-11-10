import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, sql } from "drizzle-orm";
import * as t from "../src/db/schema";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  resetTables,
  type Actor,
} from "./helpers";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";

/**
 * D3-1 · stockdiary on every sale + stockcurrent cache (server side).
 * AC (catalog spec + sales spec):
 *  - §Sale records stock movement: 10 − 2 = 8
 *  - §Stock truth survives recount: +50 −2 −3 +10 = 55
 *  - §Overselling: warn-allow → balance −2, flagged in low stock
 *  - §Atomic: the movement is part of the sale's group tx (rollback with it)
 *  - invariant: sum(stockdiary) == product_variants.stock == stockcurrent.stock
 */

let app: FastifyInstance;
let owner: Actor;
let repo: ReturnType<typeof scopedRepo>;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "stock@tenant.test", orgSlug: "org-stock" });
  repo = scopedRepo(db, owner.orgId);
});

type Envelope = {
  client_uuid: string;
  client_ts: number;
  entity: string;
  op: string;
  payload: Record<string, unknown>;
};

function env(
  entity: Envelope["entity"],
  payload: Record<string, unknown>,
  opts: { client_uuid?: string; client_ts?: number } = {},
): Envelope {
  return {
    client_uuid: opts.client_uuid ?? randomUUID(),
    client_ts: opts.client_ts ?? Date.now(),
    entity,
    op: "upsert",
    payload,
  };
}

function push(mutations: unknown[]) {
  return app.inject({
    method: "POST",
    url: "/api/sync/mutations",
    headers: authHeaders(owner),
    payload: { mutations },
  });
}

async function invariantOf(variantId: string) {
  const variants = await db
    .select({ stock: t.productVariants.stock })
    .from(t.productVariants)
    .where(eq(t.productVariants.id, variantId));
  const current = await db
    .select({ stock: t.stockcurrent.stock })
    .from(t.stockcurrent)
    .where(eq(t.stockcurrent.variant_id, variantId));
  const sum = await db
    .select({ sum: sql<string>`coalesce(sum(${t.stockdiary.delta}), 0)` })
    .from(t.stockdiary)
    .where(eq(t.stockdiary.variant_id, variantId));
  return {
    variants: variants[0]?.stock ?? null,
    current: current[0]?.stock ?? null,
    sum: Number(sum[0]?.sum ?? 0),
  };
}

/** Server-side product with an initial stock diary (same path the seed uses). */
async function seedVariant(name: string, stock: number) {
  const { variant } = await repo.catalog.createProduct({
    name,
    variant: { name: "Único", price: 4000, stock },
  });
  return variant;
}

/**
 * The exact group a client sale emits (D3-1): ticket + line + payment +
 * stockdiary(-qty, ref_ticket_id) + ABSOLUTE variant refresh(ref_ticket_id).
 */
function saleGroup(opts: {
  variant: { id: string; product_id: string; name: string; price: number; stock: number };
  qty: number;
  ticketNo: number;
  nextStock: number;
  ts?: number;
}) {
  const ts = opts.ts ?? 1_700_000_000_000;
  const ticketId = randomUUID();
  const lineId = randomUUID();
  const paymentId = randomUUID();
  const diaryId = randomUUID();
  const subtotal = opts.variant.price * opts.qty;
  return {
    ticketId,
    diaryId,
    envelopes: [
      env(
        "ticket",
        { shift_id: null, ticket_no: opts.ticketNo, status: "completed", total: subtotal },
        { client_uuid: ticketId, client_ts: ts },
      ),
      env(
        "ticket_line",
        {
          ticket_id: ticketId,
          variant_id: opts.variant.id,
          qty: opts.qty,
          unit_price: opts.variant.price,
          subtotal,
        },
        { client_uuid: lineId, client_ts: ts + 1 },
      ),
      env(
        "payment",
        {
          ticket_id: ticketId,
          method: "cash",
          amount: subtotal,
          tendered: subtotal,
          vuelto: 0,
          status: "confirmed",
          shift_id: null,
        },
        { client_uuid: paymentId, client_ts: ts + 2 },
      ),
      env(
        "stockdiary",
        {
          variant_id: opts.variant.id,
          delta: -opts.qty,
          reason: "sale",
          note: `Venta #${opts.ticketNo}`,
          ref_ticket_id: ticketId,
        },
        { client_uuid: diaryId, client_ts: ts + 3 },
      ),
      env(
        "variant",
        {
          product_id: opts.variant.product_id,
          name: opts.variant.name,
          price: opts.variant.price,
          stock: opts.nextStock,
          low_stock_threshold: null,
          active: true,
          ref_ticket_id: ticketId,
        },
        { client_uuid: opts.variant.id, client_ts: ts + 4 },
      ),
    ],
  };
}

describe("sale records a stock movement (catalog §Sale records a stock movement)", () => {
  it("10 − 2 = 8 on server: diary, variants.stock and stockcurrent stay in step", async () => {
    const variant = await seedVariant("Granizado", 10);
    expect(await invariantOf(variant.id)).toEqual({
      variants: 10,
      current: 10,
      sum: 10,
    });

    const group = saleGroup({ variant, qty: 2, ticketNo: 1, nextStock: 8 });
    const res = await push(group.envelopes);
    expect(res.statusCode).toBe(200);
    expect(
      res.json().results.every((r: { status: string }) => r.status === "applied"),
    ).toBe(true);

    expect(await invariantOf(variant.id)).toEqual({
      variants: 8,
      current: 8,
      sum: 8,
    });

    const diaries = await db
      .select()
      .from(t.stockdiary)
      .where(eq(t.stockdiary.variant_id, variant.id));
    expect(diaries).toHaveLength(2); // initial + sale
    const movement = diaries.find((d) => d.reason === "sale");
    expect(movement?.delta).toBe(-2);
    expect(movement?.ref_ticket_id).toBe(group.ticketId);
  });

  it("double-push does NOT double-subtract (duplicate ack, stock stays 8)", async () => {
    const variant = await seedVariant("Granizado", 10);
    const group = saleGroup({ variant, qty: 2, ticketNo: 1, nextStock: 8 });

    await push(group.envelopes);
    const again = await push(group.envelopes);
    expect(
      again.json().results.every((r: { status: string }) => r.status === "duplicate"),
    ).toBe(true);

    expect(await invariantOf(variant.id)).toEqual({
      variants: 8,
      current: 8,
      sum: 8,
    });
    const diaries = await db
      .select()
      .from(t.stockdiary)
      .where(eq(t.stockdiary.variant_id, variant.id));
    expect(diaries).toHaveLength(2);
  });

  it("recount survives mixed movements: +50 −2 −3 +10 = 55", async () => {
    const variant = await seedVariant("Recontada", 0);

    await repo.stock.adjust({
      variant_id: variant.id,
      delta: 50,
      reason: "reposition",
      note: "entrada de mercadería",
    });
    const group = saleGroup({ variant, qty: 2, ticketNo: 1, nextStock: 48 });
    await push(group.envelopes);
    await repo.stock.adjust({
      variant_id: variant.id,
      delta: -3,
      reason: "damage",
      note: "rotura",
    });
    await repo.stock.adjust({
      variant_id: variant.id,
      delta: 10,
      reason: "reposition",
      note: "reposición",
    });

    const inv = await invariantOf(variant.id);
    expect(inv.sum).toBe(55);
    expect(inv.variants).toBe(55);
    expect(inv.current).toBe(55);
  });
});

describe("overselling (catalog §Overselling)", () => {
  it("sell 3 from stock 1 → balance −2 and the variant is flagged low", async () => {
    const variant = await seedVariant("Ultima", 1);

    const group = saleGroup({ variant, qty: 3, ticketNo: 1, nextStock: -2 });
    const res = await push(group.envelopes);
    expect(res.statusCode).toBe(200);
    expect(
      res.json().results.every((r: { status: string }) => r.status === "applied"),
    ).toBe(true);

    expect(await invariantOf(variant.id)).toEqual({
      variants: -2,
      current: -2,
      sum: -2,
    });

    // flagged in the low-stock report (D3-4 shares this path)
    const low = await repo.reports.lowStock();
    expect(low.map((r) => r.variant_id)).toContain(variant.id);
    expect(low.find((r) => r.variant_id === variant.id)?.stock).toBe(-2);
  });
});

describe("sale + stock movement is one atomic group (sales §Atomic)", () => {
  it("a mid-group failure rolls the stock movement back with the sale", async () => {
    const variant = await seedVariant("Atomica", 10);

    // clean first sale (ticket_no 7)
    const ok = saleGroup({ variant, qty: 1, ticketNo: 7, nextStock: 9 });
    await push(ok.envelopes);
    expect(await invariantOf(variant.id)).toEqual({
      variants: 9,
      current: 9,
      sum: 9,
    });

    // second sale CLAIMING the same ticket_no → unique violation mid-group
    const clash = saleGroup({
      variant,
      qty: 2,
      ticketNo: 7,
      nextStock: 7,
      ts: 1_700_000_000_100,
    });
    const res = await push(clash.envelopes);
    expect(res.statusCode).toBe(200);
    expect(
      res.json().results.every(
        (r: { status: string; reason?: string }) =>
          r.status === "rejected" && r.reason === "db_error",
      ),
    ).toBe(true);

    // nothing from the failed group landed — no partial stock on the server
    expect(await invariantOf(variant.id)).toEqual({
      variants: 9,
      current: 9,
      sum: 9,
    });
    const diaries = await db
      .select()
      .from(t.stockdiary)
      .where(eq(t.stockdiary.variant_id, variant.id));
    expect(diaries.filter((d) => d.reason === "sale")).toHaveLength(1);
  });
});
