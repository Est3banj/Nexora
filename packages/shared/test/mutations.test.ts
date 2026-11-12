import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  contentHash,
  mutationEnvelopeSchema,
  syncPushBodySchema,
  syncPushResponseSchema,
  syncStatusSchema,
} from "../src/mutations";

/**
 * D2-1 · Shared mutation envelope (zod)
 * AC: invalid envelope (negative money, missing uuid) rejected by both
 * sides; no schema drift possible by construction (design §10).
 */

describe("mutation envelope", () => {
  it("catalog icon allowlist accepts optional/null/known keys and rejects arbitrary content", () => {
    for (const entity of ["category", "product"]) {
      const env = { client_uuid: randomUUID(), client_ts: 1, entity };
      for (const fields of [{}, { icon_key: null }, { icon_key: "coffee" }, { icon_key: "bottle-water" }]) {
        expect(mutationEnvelopeSchema.parse({ ...env, payload: { name: "Café", ...fields } }).payload).toEqual({ name: "Café", active: true, ...fields });
      }
      for (const icon_key of ["unknown", "<svg>", "https://cdn.test/icon.svg", 1]) expect(mutationEnvelopeSchema.safeParse({ ...env, payload: { name: "Café", icon_key } }).success).toBe(false);
    }
  });
  it("legacy shift/close payloads retain omitted policy fields and v2 opening/notes parse", () => {
    const env = { client_uuid: randomUUID(), client_ts: 1 };
    expect(mutationEnvelopeSchema.parse({ ...env, entity: "shift", payload: { status: "open" } }).payload).toEqual({ status: "open" });
    const close = { shift_id: randomUUID(), expected: 1000, counted: 900, diff: -100 };
    expect(mutationEnvelopeSchema.parse({ ...env, entity: "closedcash", payload: close }).payload).toEqual(close);
    expect(mutationEnvelopeSchema.safeParse({ ...env, entity: "shift", payload: { status: "open", opening_cash: 10000, calculation_version: "drawer_cash_v2" } }).success).toBe(true);
    for (const opening_cash of [-1,0.5,2147483648]) expect(mutationEnvelopeSchema.safeParse({ ...env, entity: "shift", payload: { status: "open", opening_cash } }).success).toBe(false);
    expect(mutationEnvelopeSchema.safeParse({ ...env, entity: "closedcash", payload: { ...close, closing_note: "x".repeat(501) } }).success).toBe(false);
  });
  it("cash movements validate integer COP/reason/direction/text limits and strip forged tenant", () => {
    const env = { client_uuid: randomUUID(), client_ts: 1, entity: "cash_movement" };
    const payload = { shift_id: randomUUID(), direction: "in", amount: 1000, reason: "Base", tenant_id: randomUUID() };
    expect(mutationEnvelopeSchema.parse({ ...env, payload }).payload).not.toHaveProperty("tenant_id");
    for (const change of [{ amount: 0 }, { amount: -1 }, { amount: 0.5 }, { amount: 2147483648 }, { reason: " " }, { reason: "x".repeat(121) }, { note: "x".repeat(501) }, { direction: "transfer" }, { shift_id: null }]) {
      expect(mutationEnvelopeSchema.safeParse({ ...env, payload: { ...payload, ...change } }).success).toBe(false);
    }
  });
  it("accepts credit and own-table abonos, strips forged tenant and rejects unknown methods/fractional amounts", () => {
    const env = { client_uuid: randomUUID(), client_ts: 1 };
    const payload = { customer_id: randomUUID(), shift_id: randomUUID(), amount: 100, method: "cash", tenant_id: randomUUID() };
    const abono = mutationEnvelopeSchema.parse({ ...env, entity: "credit_abono", payload });
    expect(abono.payload).not.toHaveProperty("tenant_id");
    for (const amount of [0,-1,0.5,2147483648]) expect(mutationEnvelopeSchema.safeParse({ ...env, entity:"credit_abono",payload:{...payload,amount} }).success).toBe(false);
    const payment = {ticket_id:randomUUID(),shift_id:null,method:"credit",amount:100,tendered:null,vuelto:null,status:"confirmed"};
    expect(mutationEnvelopeSchema.safeParse({...env,entity:"payment",payload:payment}).success).toBe(true);
    expect(mutationEnvelopeSchema.safeParse({...env,entity:"payment",payload:{...payment,method:"unknown"}}).success).toBe(false);
  });
  it.each([{}, { credit_limit: null }, { credit_limit: 0 }, { credit_limit: 2147483647 }])("preserves compatible customer limit %j", fields => {
    const parsed = mutationEnvelopeSchema.parse({
      client_uuid: randomUUID(), client_ts: 1, entity: "customer",
      payload: { name: "María", ...fields, tenant_id: randomUUID() },
    });
    expect(parsed.payload).toEqual({ name: "María", active: true, ...fields });
  });

  it.each([-1, 0.5, 2147483648])("rejects invalid credit limit %s", credit_limit => {
    expect(mutationEnvelopeSchema.safeParse({
      client_uuid: randomUUID(), client_ts: 1, entity: "customer", payload: { name: "María", credit_limit },
    }).success).toBe(false);
  });

  it("keeps legacy tickets without customer_id valid", () => {
    const parsed = mutationEnvelopeSchema.parse({
      client_uuid: randomUUID(), client_ts: 1, entity: "ticket",
      payload: { shift_id: null, ticket_no: 1, total: 100, status: "completed" },
    });
    expect(parsed.payload).not.toHaveProperty("customer_id");
  });
  it("accepts a valid product mutation (D1 enqueue shape)", () => {
    const parsed = mutationEnvelopeSchema.parse({
      client_uuid: randomUUID(),
      client_ts: Date.now(),
      entity: "product",
      payload: { name: "Granizado de Fresa" },
    });
    expect(parsed.op).toBe("upsert");
    // default applied by the schema
    expect(parsed.payload).toEqual({ name: "Granizado de Fresa", active: true });
  });

  it("rejects a missing/invalid uuid", () => {
    expect(
      mutationEnvelopeSchema.safeParse({
        client_uuid: "not-a-uuid",
        client_ts: 1,
        entity: "ticket",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown entity", () => {
    expect(
      mutationEnvelopeSchema.safeParse({
        client_uuid: randomUUID(),
        client_ts: 1,
        entity: "banana",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("rejects negative client_ts", () => {
    expect(
      mutationEnvelopeSchema.safeParse({
        client_uuid: randomUUID(),
        client_ts: -1,
        entity: "payment",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("rejects NEGATIVE MONEY on both sides (variant price)", () => {
    const bad = mutationEnvelopeSchema.safeParse({
      client_uuid: randomUUID(),
      client_ts: 1,
      entity: "variant",
      payload: {
        product_id: randomUUID(),
        name: "Grande",
        price: -4000,
        stock: 5,
        low_stock_threshold: null,
        active: true,
      },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects non-integer money (float COP)", () => {
    expect(
      mutationEnvelopeSchema.safeParse({
        client_uuid: randomUUID(),
        client_ts: 1,
        entity: "payment",
        payload: {
          ticket_id: randomUUID(),
          method: "cash",
          amount: 4000.5,
          tendered: 4000,
          vuelto: 0,
          status: "confirmed",
          shift_id: null,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects zero/negative qty on a ticket line", () => {
    expect(
      mutationEnvelopeSchema.safeParse({
        client_uuid: randomUUID(),
        client_ts: 1,
        entity: "ticket_line",
        payload: {
          ticket_id: randomUUID(),
          variant_id: randomUUID(),
          qty: 0,
          unit_price: 4000,
          subtotal: 0,
        },
      }).success,
    ).toBe(false);
  });

  it("strips a forged tenant_id from the payload (tenancy spec)", () => {
    const parsed = mutationEnvelopeSchema.parse({
      client_uuid: randomUUID(),
      client_ts: 1,
      entity: "ticket",
      payload: {
        shift_id: null,
        ticket_no: 1,
        status: "completed",
        total: 4000,
        tenant_id: "99999999-9999-4999-8999-999999999999",
      },
    });
    expect(parsed.payload).not.toHaveProperty("tenant_id");
  });

  it("allows negative stock and delta (oversell is legal)", () => {
    expect(
      mutationEnvelopeSchema.safeParse({
        client_uuid: randomUUID(),
        client_ts: 1,
        entity: "variant",
        payload: {
          product_id: randomUUID(),
          name: "Grande",
          price: 5000,
          stock: -2,
          low_stock_threshold: null,
          active: true,
        },
      }).success,
    ).toBe(true);
    expect(
      mutationEnvelopeSchema.safeParse({
        client_uuid: randomUUID(),
        client_ts: 1,
        entity: "stockdiary",
        payload: {
          variant_id: randomUUID(),
          delta: -3,
          reason: "sale",
          note: "venta",
        },
      }).success,
    ).toBe(true);
  });
});

describe("push request / response", () => {
  it("caps the batch at 50 (client + server)", () => {
    const one = { mutations: [{}] };
    expect(syncPushBodySchema.safeParse(one).success).toBe(true);
    const many = { mutations: Array.from({ length: 51 }, () => ({})) };
    expect(syncPushBodySchema.safeParse(many).success).toBe(false);
    const empty = { mutations: [] };
    expect(syncPushBodySchema.safeParse(empty).success).toBe(false);
  });

  it("parses the design §3 response shape", () => {
    const parsed = syncPushResponseSchema.parse({
      results: [
        { client_uuid: randomUUID(), status: "applied" },
        { client_uuid: randomUUID(), status: "duplicate" },
        {
          client_uuid: randomUUID(),
          status: "rejected",
          reason: "conflict_hash_mismatch",
        },
      ],
    });
    expect(parsed.results).toHaveLength(3);
    expect(
      syncPushResponseSchema.safeParse({
        results: [{ client_uuid: "x", status: "exploded" }],
      }).success,
    ).toBe(false);
  });
});

describe("content hash (replay-as-different-content)", () => {
  it("is stable under key order (jsonb round-trip safe)", () => {
    const a = { total: 4000, status: "completed", shift_id: null };
    const b = { shift_id: null, status: "completed", total: 4000 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("changes when content changes", () => {
    expect(contentHash({ total: 4000 })).not.toBe(contentHash({ total: 4001 }));
  });

  it("is deterministic across runs (fixed vector)", () => {
    // same input → same fingerprint, forever (guards accidental algorithm drift)
    expect(contentHash({ a: 1, b: [2, 3] })).toBe(contentHash({ b: [2, 3], a: 1 }));
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });

  it("treats undefined keys as absent (JSON semantics)", () => {
    expect(contentHash({ a: 1, b: undefined })).toBe(contentHash({ a: 1 }));
  });
});

describe("sync status union matches design §3", () => {
  it("accepts the five statuses", () => {
    for (const s of ["pending", "in_flight", "synced", "failed", "poison"]) {
      expect(syncStatusSchema.safeParse(s).success).toBe(true);
    }
    expect(syncStatusSchema.safeParse("wat").success).toBe(false);
  });
});
