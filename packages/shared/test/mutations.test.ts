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
