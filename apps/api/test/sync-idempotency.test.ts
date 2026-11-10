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

/**
 * D2-4 · Double-push / idempotency integration tests [MERGE GATE]
 * AC (sync spec + sales spec):
 *  - §Double-push creates one row; duplicate after response loss
 *  - §Same UUID cannot be replayed as different content
 *  - §LWW: later write wins, no duplicate record
 *  - §Push requires auth; tenant-scoped
 *  - poison (invalid) entry doesn't fail the batch
 *  - group tx rolls back wholesale on mid-group failure
 *  - §Order: batch ≤50
 * CI red = D2 gate red.
 */

let app: FastifyInstance;
let owner: Actor;
let other: Actor;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "sync@tenant.test", orgSlug: "org-sync" });
  other = await createTenant(app, { email: "sync-b@tenant.test", orgSlug: "org-sync-b" });
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

function push(actor: Actor, mutations: unknown[]) {
  return app.inject({
    method: "POST",
    url: "/api/sync/mutations",
    headers: authHeaders(actor),
    payload: { mutations },
  });
}

function ticketPayload(ticket_no: number, total = 8000) {
  return { shift_id: null, ticket_no, status: "completed", total };
}

function saleGroup(opts: { ticket_no?: number; ts?: number } = {}) {
  const ts = opts.ts ?? 1_700_000_000_000;
  const ticketId = randomUUID();
  const lineId = randomUUID();
  const paymentId = randomUUID();
  return {
    ticketId,
    lineId,
    paymentId,
    envelopes: [
      env("ticket", ticketPayload(opts.ticket_no ?? 1), {
        client_uuid: ticketId,
        client_ts: ts,
      }),
      env(
        "ticket_line",
        {
          ticket_id: ticketId,
          variant_id: randomUUID(),
          qty: 2,
          unit_price: 4000,
          subtotal: 8000,
        },
        { client_uuid: lineId, client_ts: ts + 1 },
      ),
      env(
        "payment",
        {
          ticket_id: ticketId,
          method: "cash",
          amount: 8000,
          tendered: 10000,
          vuelto: 2000,
          status: "confirmed",
          shift_id: null,
        },
        { client_uuid: paymentId, client_ts: ts + 2 },
      ),
    ],
  };
}

async function count(table: keyof typeof t, tenantId?: string): Promise<number> {
  const rows = await db
    .select({ n: sql<string>`count(*)` })
    .from(t[table])
    .where(tenantId ? sql`tenant_id = ${tenantId}` : sql`true`);
  return Number(rows[0]?.n ?? 0);
}

describe("double push → exactly one row", () => {
  it("pushing the same sale envelope twice yields one ticket and two acks", async () => {
    const group = saleGroup();

    const first = await push(owner, group.envelopes);
    expect(first.statusCode).toBe(200);
    expect(first.json().results.map((r: { status: string }) => r.status)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);

    // response lost in transit → client re-pushes the IDENTICAL batch
    const second = await push(owner, group.envelopes);
    expect(second.statusCode).toBe(200);
    expect(second.json().results.map((r: { status: string }) => r.status)).toEqual([
      "duplicate",
      "duplicate",
      "duplicate",
    ]);

    expect(await count("tickets", owner.orgId)).toBe(1);
    expect(await count("ticketLines", owner.orgId)).toBe(1);
    expect(await count("payments", owner.orgId)).toBe(1);
    // one ledger row per pushed uuid — the applied ledger never duplicates
    expect(await count("syncLog", owner.orgId)).toBe(3);
  });

  it("a third and fourth push still acknowledge without error (N pushes → 1 row)", async () => {
    const group = saleGroup();
    for (let i = 0; i < 4; i++) {
      const res = await push(owner, group.envelopes);
      expect(res.statusCode).toBe(200);
    }
    expect(await count("tickets", owner.orgId)).toBe(1);
  });
});

describe("same UUID cannot be replayed as different content", () => {
  it("different payload with the SAME client_ts → rejected conflict_hash_mismatch, still one row, audited", async () => {
    const ticketId = randomUUID();
    const ts = 1_700_000_000_000;
    const original = env("ticket", ticketPayload(1, 8000), {
      client_uuid: ticketId,
      client_ts: ts,
    });
    const first = await push(owner, [original]);
    expect(first.json().results[0].status).toBe("applied");

    const tampered = env("ticket", ticketPayload(1, 999_999), {
      client_uuid: ticketId,
      client_ts: ts,
    });
    const second = await push(owner, [tampered]);
    expect(second.statusCode).toBe(200);
    expect(second.json().results[0]).toEqual({
      client_uuid: ticketId,
      status: "rejected",
      reason: "conflict_hash_mismatch",
    });

    // never a second row, original content untouched
    expect(await count("tickets", owner.orgId)).toBe(1);
    const rows = await db.select().from(t.tickets).where(eq(t.tickets.client_uuid, ticketId));
    expect(rows[0].total).toBe(8000);

    // discrepancy surfaced in audit_log (design §3 rule 2)
    const audits = await db
      .select()
      .from(t.auditLog)
      .where(eq(t.auditLog.action, "sync.conflict_hash_mismatch"));
    expect(audits).toHaveLength(1);
    expect(audits[0].tenant_id).toBe(owner.orgId);
  });

  it("older client_ts with different content is also rejected (stale write loses)", async () => {
    const ticketId = randomUUID();
    await push(owner, [
      env("ticket", ticketPayload(1, 8000), { client_uuid: ticketId, client_ts: 2_000 }),
    ]);
    const stale = await push(owner, [
      env("ticket", ticketPayload(1, 5000), { client_uuid: ticketId, client_ts: 1_000 }),
    ]);
    expect(stale.json().results[0].status).toBe("rejected");
    expect(stale.json().results[0].reason).toBe("conflict_hash_mismatch");
    const rows = await db.select().from(t.tickets).where(eq(t.tickets.client_uuid, ticketId));
    expect(rows[0].total).toBe(8000);
  });
});

describe("LWW — later single-device write wins", () => {
  it("newer client_ts with different content updates IN PLACE (still one row)", async () => {
    const ticketId = randomUUID();
    await push(owner, [
      env("ticket", ticketPayload(1, 8000), { client_uuid: ticketId, client_ts: 1_000 }),
    ]);
    const newer = await push(owner, [
      env("ticket", ticketPayload(1, 12_000), { client_uuid: ticketId, client_ts: 2_000 }),
    ]);
    expect(newer.json().results[0].status).toBe("applied");
    expect(await count("tickets", owner.orgId)).toBe(1);
    const rows = await db.select().from(t.tickets).where(eq(t.tickets.client_uuid, ticketId));
    expect(rows[0].total).toBe(12_000);
  });

  it("price edit twice on the device → later write wins, no crash, one row (sync §LWW)", async () => {
    const variantId = randomUUID();
    const productId = randomUUID();
    await push(owner, [env("product", { name: "Granizado", active: true }, { client_uuid: productId, client_ts: 500 })]);
    const base = {
      product_id: productId,
      name: "Grande",
      stock: 10,
      low_stock_threshold: null,
      active: true,
    };
    await push(owner, [
      env("variant", { ...base, price: 4000 }, { client_uuid: variantId, client_ts: 1_000 }),
    ]);
    await push(owner, [
      env("variant", { ...base, price: 4500 }, { client_uuid: variantId, client_ts: 2_000 }),
    ]);
    const rows = await db
      .select()
      .from(t.productVariants)
      .where(eq(t.productVariants.client_uuid, variantId));
    expect(rows[0].price).toBe(4500);
    expect(await count("productVariants", owner.orgId)).toBe(1);
  });
});

describe("batch semantics (poison never fails the batch)", () => {
  it("one invalid envelope → rejected validation, the other five still apply", async () => {
    const good = Array.from({ length: 5 }, (_, i) =>
      env("product", { name: `Producto ${i}`, active: true }),
    );
    const poison = env("variant", {
      product_id: randomUUID(),
      name: "Roto",
      price: -4000, // negative money — rejected by the SHARED schema
      stock: 1,
      low_stock_threshold: null,
      active: true,
    });

    const res = await push(owner, [...good, poison]);
    expect(res.statusCode).toBe(200);
    const results = res.json().results;
    expect(results).toHaveLength(6);
    expect(results.slice(0, 5).every((r: { status: string }) => r.status === "applied")).toBe(true);
    expect(results[5]).toEqual({
      client_uuid: poison.client_uuid,
      status: "rejected",
      reason: "validation",
    });
    expect(await count("products", owner.orgId)).toBe(5);
    expect(await count("productVariants", owner.orgId)).toBe(0);
  });

  it("group tx rolls back wholesale on mid-group failure (no partial sale)", async () => {
    // group 1: clean sale with ticket_no 7
    const first = saleGroup({ ticket_no: 7 });
    const r1 = await push(owner, first.envelopes);
    expect(r1.json().results.every((r: { status: string }) => r.status === "applied")).toBe(true);
    expect(await count("tickets", owner.orgId)).toBe(1);
    expect(await count("ticketLines", owner.orgId)).toBe(1);
    expect(await count("payments", owner.orgId)).toBe(1);

    // group 2: a DIFFERENT ticket claiming the same ticket_no → unique violation
    // mid-group (after its line/payment may already be staged) → full rollback
    const second = saleGroup({ ticket_no: 7 });
    const r2 = await push(owner, second.envelopes);
    expect(r2.statusCode).toBe(200);
    expect(
      r2.json().results.every(
        (r: { status: string; reason?: string }) =>
          r.status === "rejected" && r.reason === "db_error",
      ),
    ).toBe(true);

    // nothing from group 2 landed — no partial sale on the server
    expect(await count("tickets", owner.orgId)).toBe(1);
    expect(await count("ticketLines", owner.orgId)).toBe(1);
    expect(await count("payments", owner.orgId)).toBe(1);
    const lines = await db.select().from(t.ticketLines);
    expect(lines[0].client_uuid).toBe(first.lineId);
  });
});

describe("batch limits and auth", () => {
  it("more than 50 mutations in one batch → 400", async () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      env("product", { name: `P${i}`, active: true }),
    );
    const res = await push(owner, many);
    expect(res.statusCode).toBe(400);
    expect(await count("products", owner.orgId)).toBe(0);
  });

  it("unauthenticated push is rejected and nothing persists", async () => {
    const group = saleGroup();
    const res = await app.inject({
      method: "POST",
      url: "/api/sync/mutations",
      payload: { mutations: group.envelopes },
    });
    expect(res.statusCode).toBe(401);
    expect(await count("tickets")).toBe(0);
  });
});

describe("tenant scoping", () => {
  it("tenant B replaying tenant A's exact queue is rejected — A untouched, B gets nothing", async () => {
    const group = saleGroup();
    await push(owner, group.envelopes);

    // Same client_uuids under B's session: ids are GLOBAL primary keys
    // (design §2: PK = client uuid), so B's replay collides and the whole
    // group rolls back as db_error. Key isolation property holds: A's rows
    // are never overwritten and B never receives A's data.
    const res = await push(other, group.envelopes);
    expect(res.statusCode).toBe(200);
    expect(
      res.json().results.every(
        (r: { status: string; reason?: string }) =>
          r.status === "rejected" && r.reason === "db_error",
      ),
    ).toBe(true);

    expect(await count("tickets", owner.orgId)).toBe(1);
    expect(await count("tickets", other.orgId)).toBe(0);
    expect(await count("syncLog", other.orgId)).toBe(0);

    const rows = await db.select().from(t.tickets);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(owner.orgId);
    expect(rows[0].client_uuid).toBe(group.ticketId);
  });

  it("a forged tenant_id inside the payload cannot escape the session tenant", async () => {
    const res = await push(owner, [
      env("product", {
        name: "Hackeado",
        active: true,
        tenant_id: other.orgId, // must be stripped by the shared schema
      }),
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].status).toBe("applied");
    const rows = await db.select().from(t.products);
    expect(rows).toHaveLength(1);
    expect(rows[0].tenant_id).toBe(owner.orgId);
    expect(await count("products", other.orgId)).toBe(0);
  });

  it("sync status rows are tenant-scoped (each tenant sees only its own ledger)", async () => {
    await push(owner, [env("product", { name: "A1", active: true })]);
    await push(other, [
      env("product", { name: "B1", active: true }),
      env("product", { name: "B2", active: true }),
    ]);
    expect(await count("syncLog", owner.orgId)).toBe(1);
    expect(await count("syncLog", other.orgId)).toBe(2);
  });
});
