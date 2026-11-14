import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getAuth } from "../src/auth/auth";
import * as t from "../src/db/schema";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  joinOrg,
  resetTables,
  signIn,
  type Actor,
} from "./helpers";
import { closeDb, db } from "../src/db";
import { scopedRepo } from "../src/db/scope";

/**
 * D2-6 · Transfer confirmation endpoint (Dueño-tier, strict transition)
 * AC (sales spec §Bank-transfer + tenancy §Owner confirms + auth-roles):
 *  - created pending → owner confirms → confirmed + confirmed_at
 *  - admin confirms too (roles-admin 2.3 tier parity)
 *  - member CANNOT confirm (403 owner_only — regression, body UNCHANGED)
 *  - no silent revert: confirming twice / un-confirming → rejected
 *  - unauthenticated → 401, unknown id → 404
 */

let app: FastifyInstance;
let owner: Actor;
let admin: Actor;
let member: Actor;
let repo: ReturnType<typeof scopedRepo>;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

/** Signs up a second user, adds them to the org as `member`, activates the org. */
async function createMember(orgId: string): Promise<Actor> {
  const email = "member@tenant.test";
  const password = "password1234";
  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { email, password, name: "Member" },
  });
  expect(signUp.statusCode).toBe(200);
  const userId = signUp.json().data?.user?.id ?? signUp.json().user?.id;

  const add = await getAuth().api.addMember({
    body: { organizationId: orgId, userId, role: "member" },
    headers: new Headers({ cookie: owner.cookie }),
  });
  expect(add).toBeTruthy();

  const cookie = await signIn(app, { email, password });
  const setActive = await app.inject({
    method: "POST",
    url: "/api/auth/organization/set-active",
    headers: { cookie },
    payload: { organizationId: orgId },
  });
  expect(setActive.statusCode).toBe(200);
  return { email, password, userId, orgId, cookie };
}

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "pay@tenant.test", orgSlug: "org-pay" });
  member = await createMember(owner.orgId);
  admin = await joinOrg(app, owner, "admin", "pay-admin@test.dev");
  repo = scopedRepo(db, owner.orgId);
});

/** Seeds a ticket + a PENDING transfer payment directly through the repo. */
async function seedPendingTransfer(): Promise<{ ticketId: string; paymentId: string }> {
  const ticketId = randomUUID();
  await repo.tickets.upsert({
    client_uuid: ticketId,
    shift_id: null,
    ticket_no: 1,
    total: 18_000,
    status: "transfer_pending",
  });
  const paymentId = randomUUID();
  await repo.payments.upsert({
    client_uuid: paymentId,
    ticket_id: ticketId,
    method: "transfer",
    amount: 18_000,
    status: "pending",
  });
  return { ticketId, paymentId };
}

function confirm(paymentId: string, actor: Actor) {
  return app.inject({
    method: "POST",
    url: `/api/payments/${paymentId}/confirm`,
    headers: authHeaders(actor),
  });
}

describe("POST /api/payments/:id/confirm", () => {
  it("owner confirms a pending transfer → confirmed + confirmed_at + ticket completed", async () => {
    const { ticketId, paymentId } = await seedPendingTransfer();

    const res = await confirm(paymentId, owner);
    expect(res.statusCode).toBe(200);
    expect(res.json().payment.status).toBe("confirmed");
    expect(res.json().payment.confirmed_at).not.toBeNull();

    const payment = await repo.payments.byUuid(paymentId);
    expect(payment?.status).toBe("confirmed");
    expect(payment?.confirmed_at).toBeInstanceOf(Date);

    const ticket = await repo.tickets.byUuid(ticketId);
    expect(ticket?.status).toBe("completed");
  });

  it("a MEMBER cannot confirm (403 owner-only)", async () => {
    const { paymentId } = await seedPendingTransfer();
    const res = await confirm(paymentId, member);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden", detail: "owner_only" });

    // unchanged
    const payment = await repo.payments.byUuid(paymentId);
    expect(payment?.status).toBe("pending");
    expect(payment?.confirmed_at).toBeNull();
  });

  // roles-admin 2.3 · AU:Owner and admin confirm transfers, member cannot —
  // admin is dueño-tier now (`!isDueño`), body/response shape untouched.
  it("an ADMIN confirms a pending transfer (tier parity with owner)", async () => {
    const { ticketId, paymentId } = await seedPendingTransfer();
    const res = await confirm(paymentId, admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().payment.status).toBe("confirmed");
    expect(res.json().payment.confirmed_at).not.toBeNull();

    const payment = await repo.payments.byUuid(paymentId);
    expect(payment?.status).toBe("confirmed");
    expect((await repo.tickets.byUuid(ticketId))?.status).toBe("completed");
  });

  it("no silent revert: a confirmed payment cannot be re-confirmed / un-confirmed", async () => {
    const { paymentId } = await seedPendingTransfer();
    expect((await confirm(paymentId, owner)).statusCode).toBe(200);

    const again = await confirm(paymentId, owner);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({
      error: "invalid_transition",
      detail: "only_pending_can_confirm",
    });

    const payment = await repo.payments.byUuid(paymentId);
    expect(payment?.status).toBe("confirmed");
    expect(payment?.confirmed_at).toBeInstanceOf(Date);
  });

  it("a cash payment (already confirmed at sale time) cannot go through confirm", async () => {
    const ticketId = randomUUID();
    await repo.tickets.upsert({
      client_uuid: ticketId,
      shift_id: null,
      ticket_no: 1,
      total: 4000,
    });
    const paymentId = randomUUID();
    await repo.payments.upsert({
      client_uuid: paymentId,
      ticket_id: ticketId,
      method: "cash",
      amount: 4000,
      tendered: 4000,
      vuelto: 0,
      status: "confirmed",
    });
    const res = await confirm(paymentId, owner);
    expect(res.statusCode).toBe(409);
  });

  it("unknown payment id → 404, unauthenticated → 401", async () => {
    const missing = await confirm(randomUUID(), owner);
    expect(missing.statusCode).toBe(404);

    const anon = await app.inject({
      method: "POST",
      url: `/api/payments/${randomUUID()}/confirm`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it("cross-tenant: another tenant's payment is not-found, never confirmed", async () => {
    const { paymentId } = await seedPendingTransfer();
    const stranger = await createTenant(app, {
      email: "stranger@tenant.test",
      orgSlug: "org-stranger",
    });
    const res = await confirm(paymentId, stranger);
    expect(res.statusCode).toBe(404);

    const rows = await db
      .select()
      .from(t.payments)
      .where(eq(t.payments.client_uuid, paymentId));
    expect(rows[0].status).toBe("pending");
  });
});
