import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import {
  LOCAL_SCHEMA_SQL,
  CUSTOMER_ACCOUNTS_SQL,
  CUSTOMER_BALANCES_SQL,
  parseCustomerAccounts,
  parseCustomerBalances,
  LOW_STOCK_SQL,
  SALES_BY_DAY_SQL,
  TOP_PRODUCTS_SQL,
  parseLowStock,
  parseSalesByDay,
  parseTopProducts,
} from "@pos/shared";
import {
  authHeaders,
  buildTestApp,
  createTenant,
  joinOrg,
  resetTables,
  type Actor,
} from "./helpers";
import { closeDb, db, pool } from "../src/db";
import { scopedRepo, type ScopedRepo } from "../src/db/scope";

/**
 * D3-6 · Report fixture tests — EXACT numbers, no snapshots [MERGE GATE].
 * AC (reports spec):
 *  - §Seeded day totals correct (day1 45000; day2 30000 + 18000 pending)
 *  - §Day boundary uses local calendar day (23:30 Bogota sale → that day)
 *  - §Ranking by quantity (B 25, A 10/40000, C 10/20000 → B, A, C)
 *  - §Report reflects only tickets in range
 *  - §At-threshold and negative stock flagged (5/5 and −2/0, not 50/5)
 *  - §Cross-tenant figures excluded (B sees 9000 only, never A's 45000)
 *  - §Empty catalog / empty period → empty result, no error
 *  - offline path: the SAME fixtures against PGlite yield the SAME numbers
 * CI red = D3 reports gate red.
 */

let app: FastifyInstance;
let owner: Actor; // tenant A
let other: Actor; // tenant B
let repo: ScopedRepo; // A
let repoB: ScopedRepo; // B

/* ------------------------------------------------------------------ */
/* Canonical fixture set (single definition — server + PGlite)         */
/* ------------------------------------------------------------------ */

type VariantSpec = {
  product: string;
  name: string;
  price: number;
  stock: number;
  threshold: number | null;
};

const A_VARIANTS: Record<string, VariantSpec> = {
  va: { product: "Bebidas", name: "A", price: 4000, stock: 100, threshold: null },
  vb: { product: "Bebidas", name: "B", price: 600, stock: 100, threshold: null },
  vc: { product: "Bebidas", name: "C", price: 2000, stock: 100, threshold: null },
  vd: { product: "Servicio", name: "D", price: 18000, stock: 100, threshold: null },
  vl1: { product: "Bajo", name: "L1", price: 1000, stock: 5, threshold: 5 },
  vl2: { product: "Bajo", name: "L2", price: 1000, stock: -2, threshold: 0 },
  vl3: { product: "Bajo", name: "L3", price: 1000, stock: 50, threshold: 5 },
};

const B_VARIANTS: Record<string, VariantSpec> = {
  vf: { product: "Bebidas B", name: "F", price: 3000, stock: 100, threshold: null },
};

type FixtureTicket = {
  no: number;
  /** ISO instant — T2 sits at 23:30 America/Bogota on 2026-11-02 */
  createdAt: string;
  lines: Array<[key: string, qty: number]>;
  method: "cash" | "transfer";
  status: "confirmed" | "pending";
};

const A_TICKETS: FixtureTicket[] = [
  {
    no: 1,
    createdAt: "2026-11-01T17:00:00.000Z", // 12:00 Bogota, Nov 1
    lines: [["va", 5], ["vc", 5], ["vb", 25]], // 20000 + 10000 + 15000
    method: "cash",
    status: "confirmed",
  },
  {
    no: 2,
    createdAt: "2026-11-03T04:30:00.000Z", // 23:30 Bogota, Nov 2 (local-day boundary)
    lines: [["va", 5], ["vc", 5]], // 20000 + 10000
    method: "cash",
    status: "confirmed",
  },
  {
    no: 3,
    createdAt: "2026-11-03T01:00:00.000Z", // 20:00 Bogota, Nov 2
    lines: [["vd", 1]], // 18000 pending transfer
    method: "transfer",
    status: "pending",
  },
];

const B_TICKETS: FixtureTicket[] = [
  {
    no: 1,
    createdAt: "2026-11-01T17:00:00.000Z",
    lines: [["vf", 3]], // 9000
    method: "cash",
    status: "confirmed",
  },
];

const RANGE = { from: "2026-11-01", to: "2026-11-02" };

/* Exact expectations (reports spec numbers) */
const EXPECTED_SALES_A = [
  { day: "2026-11-01", tickets: 1, revenue: 45000, pending: 0, cash: 45000, transfer: 0, credit: 0, abonos: 0 },
  { day: "2026-11-02", tickets: 1, revenue: 30000, pending: 18000, cash: 30000, transfer: 0, credit: 0, abonos: 0 },
];
const EXPECTED_SALES_B = [
  { day: "2026-11-01", tickets: 1, revenue: 9000, pending: 0, cash: 9000, transfer: 0, credit: 0, abonos: 0 },
];
const EXPECTED_TOP_A = [
  { product_name: "Bebidas", variant_name: "B", qty: 25, revenue: 15000 },
  { product_name: "Bebidas", variant_name: "A", qty: 10, revenue: 40000 },
  { product_name: "Bebidas", variant_name: "C", qty: 10, revenue: 20000 },
  { product_name: "Servicio", variant_name: "D", qty: 1, revenue: 18000 },
];
const EXPECTED_LOW_A = [
  { product_name: "Bajo", variant_name: "L2", stock: -2, threshold: 0 },
  { product_name: "Bajo", variant_name: "L1", stock: 5, threshold: 5 },
];

function ticketTotal(spec: FixtureTicket, variants: Record<string, VariantSpec>): number {
  return spec.lines.reduce(
    (acc, [key, qty]) => acc + variants[key].price * qty,
    0,
  );
}

/* ------------------------------------------------------------------ */
/* Server-side seeder (via scopedRepo — the production write path)     */
/* ------------------------------------------------------------------ */

async function seedVariants(
  repoForTenant: ScopedRepo,
  specs: Record<string, VariantSpec>,
): Promise<Record<string, { variant_id: string; price: number }>> {
  const byProduct = new Map<string, Array<[string, VariantSpec]>>();
  for (const entry of Object.entries(specs)) {
    const list = byProduct.get(entry[1].product) ?? [];
    list.push(entry);
    byProduct.set(entry[1].product, list);
  }

  const ids: Record<string, { variant_id: string; price: number }> = {};
  for (const [, list] of byProduct) {
    const [firstKey, first] = list[0];
    const created = await repoForTenant.catalog.createProduct({
      name: first.product,
      variant: {
        name: first.name,
        price: first.price,
        stock: first.stock,
        low_stock_threshold: first.threshold,
      },
    });
    ids[firstKey] = { variant_id: created.variant.id, price: first.price };
    for (const [key, spec] of list.slice(1)) {
      const variant = await repoForTenant.catalog.addVariant(created.product.id, {
        name: spec.name,
        price: spec.price,
        stock: spec.stock,
        low_stock_threshold: spec.threshold,
      });
      ids[key] = { variant_id: variant!.id, price: spec.price };
    }
  }
  return ids;
}

async function seedTickets(
  repoForTenant: ScopedRepo,
  ids: Record<string, { variant_id: string; price: number }>,
  specs: Record<string, VariantSpec>,
  tickets: FixtureTicket[],
): Promise<void> {
  for (const tk of tickets) {
    const ticketId = randomUUID();
    const total = ticketTotal(tk, specs);
    await repoForTenant.tickets.upsert({
      client_uuid: ticketId,
      shift_id: null,
      ticket_no: tk.no,
      total,
      status: tk.status === "pending" ? "transfer_pending" : "completed",
      created_at: new Date(tk.createdAt),
    });
    await repoForTenant.ticketLines.insertMany(
      tk.lines.map(([key, qty]) => ({
        client_uuid: randomUUID(),
        ticket_id: ticketId,
        variant_id: ids[key].variant_id,
        qty,
        unit_price: ids[key].price,
        subtotal: ids[key].price * qty,
      })),
    );
    await repoForTenant.payments.upsert({
      client_uuid: randomUUID(),
      ticket_id: ticketId,
      method: tk.method,
      amount: total,
      status: tk.status,
      shift_id: null,
      created_at: new Date(tk.createdAt),
      ...(tk.status === "confirmed" ? { confirmed_at: new Date(tk.createdAt) } : {}),
    });
  }
}

async function seedServer(): Promise<void> {
  const idsA = await seedVariants(repo, A_VARIANTS);
  await seedTickets(repo, idsA, A_VARIANTS, A_TICKETS);
  const idsB = await seedVariants(repoB, B_VARIANTS);
  await seedTickets(repoB, idsB, B_VARIANTS, B_TICKETS);
}

/* ------------------------------------------------------------------ */
/* PGlite seeder (raw SQL — the offline report path)                   */
/* ------------------------------------------------------------------ */

async function seedLocal(
  local: PGlite,
  tenantId: string,
  specs: Record<string, VariantSpec>,
  tickets: FixtureTicket[],
): Promise<void> {
  const ids: Record<string, { variant_id: string; product_id: string; price: number }> = {};
  const productIds = new Map<string, string>();
  for (const [key, spec] of Object.entries(specs)) {
    let productId = productIds.get(spec.product);
    if (!productId) {
      productId = randomUUID();
      productIds.set(spec.product, productId);
      await local.query(
        `INSERT INTO products (id, tenant_id, client_uuid, name, active)
         VALUES ($1, $2, $1, $3, TRUE)`,
        [productId, tenantId, spec.product],
      );
    }
    const variantId = randomUUID();
    await local.query(
      `INSERT INTO product_variants
         (id, tenant_id, client_uuid, product_id, name, price, stock, low_stock_threshold, active)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, TRUE)`,
      [variantId, tenantId, productId, spec.name, spec.price, spec.stock, spec.threshold],
    );
    ids[key] = { variant_id: variantId, product_id: productId, price: spec.price };
  }

  for (const tk of tickets) {
    const ticketId = randomUUID();
    const total = ticketTotal(tk, specs);
    await local.query(
      `INSERT INTO tickets
         (id, tenant_id, client_uuid, shift_id, ticket_no, status, total, created_at)
       VALUES ($1, $2, $1, NULL, $3, $4, $5, $6)`,
      [
        ticketId,
        tenantId,
        tk.no,
        tk.status === "pending" ? "transfer_pending" : "completed",
        total,
        tk.createdAt,
      ],
    );
    for (const [key, qty] of tk.lines) {
      await local.query(
        `INSERT INTO ticket_lines
           (id, tenant_id, client_uuid, ticket_id, variant_id, qty, unit_price, subtotal)
         VALUES ($1, $2, $1, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          tenantId,
          ticketId,
          ids[key].variant_id,
          qty,
          ids[key].price,
          ids[key].price * qty,
        ],
      );
    }
    await local.query(
      `INSERT INTO payments
         (id, tenant_id, client_uuid, ticket_id, method, amount, tendered, vuelto,
          status, confirmed_at, shift_id, created_at)
       VALUES ($1, $2, $1, $3, $4, $5, $6, $7, $8, $9, NULL, $10)`,
      [
        randomUUID(),
        tenantId,
        ticketId,
        tk.method,
        total,
        tk.method === "cash" ? total : null,
        tk.method === "cash" ? 0 : null,
        tk.status,
        tk.status === "confirmed" ? tk.createdAt : null,
        tk.createdAt,
      ],
    );
  }
}

/* ------------------------------------------------------------------ */

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
  owner = await createTenant(app, { email: "rep-a@tenant.test", orgSlug: "org-rep-a" });
  other = await createTenant(app, { email: "rep-b@tenant.test", orgSlug: "org-rep-b" });
  repo = scopedRepo(db, owner.orgId);
  repoB = scopedRepo(db, other.orgId);
  await seedServer();
});

async function get(path: string, actor: Actor = owner) {
  return app.inject({ method: "GET", url: path, headers: authHeaders(actor) });
}

describe("sales by day (exact numbers)", () => {
  it("accounts include zero/negative/limits while Por Cobrar stays positive, identical on server and PGlite", async () => {
    const local = new PGlite("memory://");
    await local.exec(LOCAL_SCHEMA_SQL);
    const ids = Array.from({ length: 5 }, () => randomUUID());
    try {
      // Same fixture on both engines: A=53000-15000, B=10000-10000,
      // inactive excluded, inconsistent negative surfaced (never clamped).
      const stores = [
        { query: (sql: string, params: unknown[]) => pool.query(sql, params) },
        { query: (sql: string, params: unknown[]) => local.query(sql, params) },
      ];
      for (const q of stores) {
        for (const [i, name] of ["A", "B", "Inactive", "Negative", "Legacy"].entries()) {
          await q.query(`INSERT INTO customers(id,tenant_id,client_uuid,name,credit_limit,active)
            VALUES($1,$2,$1,$3,$4,$5)`, [ids[i], owner.orgId, name, i === 4 ? null : i === 1 ? 0 : 200000, i !== 2]);
        }
        for (const [i, customer, amount, method, status] of [
          [0, 0, 35000, "credit", "completed"], [1, 0, 18000, "credit", "completed"],
          [2, 0, 10000, "cash", "completed"], [3, 0, 99999, "credit", "voided"],
          [4, 1, 10000, "credit", "completed"], [5, 2, 9000, "credit", "completed"],
        ] as const) {
          const ticket = randomUUID();
          await q.query(`INSERT INTO tickets(id,tenant_id,client_uuid,ticket_no,total,status,customer_id)
            VALUES($1,$2,$1,$3,$4,$5,$6)`, [ticket, owner.orgId, i + 100, amount, status, ids[customer]]);
          const payment = randomUUID();
          await q.query(`INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,method,amount,status)
            VALUES($1,$2,$1,$3,$4,$5,'confirmed')`, [payment, owner.orgId, ticket, method, amount]);
        }
        for (const [customer, amount, method] of [[0, 10000, "cash"], [0, 5000, "transfer"], [1, 10000, "cash"], [3, 100, "cash"]] as const) {
          const id = randomUUID();
          await q.query(`INSERT INTO credit_abonos(id,tenant_id,client_uuid,customer_id,amount,method)
            VALUES($1,$2,$1,$3,$4,$5)`, [id, owner.orgId, ids[customer], amount, method]);
        }
      }
      const expected = [
        { customer_id: ids[0], name: "A", phone: null, credit: 53000, abonos: 15000, balance: 38000, credit_limit: 200000 },
        { customer_id: ids[1], name: "B", phone: null, credit: 10000, abonos: 10000, balance: 0, credit_limit: 0 },
        { customer_id: ids[4], name: "Legacy", phone: null, credit: 0, abonos: 0, balance: 0, credit_limit: null },
        { customer_id: ids[3], name: "Negative", phone: null, credit: 0, abonos: 100, balance: -100, credit_limit: 200000 },
      ];
      const accounts = await get("/api/reports/customer-accounts");
      expect(accounts.statusCode).toBe(200);
      expect(accounts.json().rows).toEqual(expected);
      expect(parseCustomerAccounts((await local.query<Record<string, unknown>>(CUSTOMER_ACCOUNTS_SQL, [owner.orgId])).rows)).toEqual(expected);
      const { credit_limit: _limit, ...positive } = expected[0];
      expect((await get("/api/reports/customer-balances")).json().rows).toEqual([positive]);
      expect(parseCustomerBalances((await local.query<Record<string, unknown>>(CUSTOMER_BALANCES_SQL, [owner.orgId])).rows)).toEqual([positive]);
      expect((await get("/api/reports/customer-accounts", other)).json().rows).toEqual([]);
      expect(parseCustomerAccounts((await local.query<Record<string, unknown>>(CUSTOMER_ACCOUNTS_SQL, [other.orgId])).rows)).toEqual([]);
      expect((await app.inject({ method: "GET", url: "/api/reports/customer-accounts" })).statusCode).toBe(401);
    } finally { await local.close(); }
  });
  it("day1 = 45000; day2 = 30000 with 18000 pending (local-day buckets)", async () => {
    const res = await get(`/api/reports/sales-by-day?from=${RANGE.from}&to=${RANGE.to}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual(EXPECTED_SALES_A);
  });

  it("a 23:30 Bogota sale lands on its LOCAL calendar day, not the UTC day", async () => {
    const res = await get(`/api/reports/sales-by-day?from=${RANGE.from}&to=${RANGE.to}`);
    const rows = res.json().rows as Array<{ day: string; revenue: number }>;
    // ticket 2 was created 2026-11-03T04:30Z = 2026-11-02 23:30 in Bogota
    const day2 = rows.find((r) => r.day === "2026-11-02");
    expect(day2?.revenue).toBe(30000);
    expect(rows.find((r) => r.day === "2026-11-03")).toBeUndefined();
  });

  it("empty period → zero rows, no error", async () => {
    const res = await get("/api/reports/sales-by-day?from=2027-01-01&to=2027-01-07");
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([]);
  });

  it("tenant B sees only its own 9000 — never tenant A's 45000", async () => {
    const res = await get(
      `/api/reports/sales-by-day?from=${RANGE.from}&to=${RANGE.to}`,
      other,
    );
    expect(res.json().rows).toEqual(EXPECTED_SALES_B);
    const total = (res.json().rows as Array<{ revenue: number }>).reduce(
      (acc, r) => acc + r.revenue,
      0,
    );
    expect(total).toBe(9000);
    expect(total).not.toBe(45000);
  });
});

describe("top products (exact numbers)", () => {
  it("order B, A, C with exact qty/revenue (D = 1 pending line ranks last)", async () => {
    const res = await get(`/api/reports/top-products?from=${RANGE.from}&to=${RANGE.to}`);
    expect(res.statusCode).toBe(200);
    const rows = res.json().rows as Array<Record<string, unknown>>;
    expect(
      rows.map((r) => ({
        product_name: r.product_name,
        variant_name: r.variant_name,
        qty: r.qty,
        revenue: r.revenue,
      })),
    ).toEqual(EXPECTED_TOP_A);
  });

  it("range filter: only day-1 tickets count (A 5 units, not 10)", async () => {
    const res = await get("/api/reports/top-products?from=2026-11-01&to=2026-11-01");
    const rows = res.json().rows as Array<{ variant_name: string; qty: number }>;
    expect(rows.find((r) => r.variant_name === "A")?.qty).toBe(5);
    expect(rows.find((r) => r.variant_name === "C")?.qty).toBe(5);
    expect(rows.find((r) => r.variant_name === "B")?.qty).toBe(25);
    expect(rows.find((r) => r.variant_name === "D")).toBeUndefined();
  });

  it("tenant B's ranking never contains tenant A's variants", async () => {
    const res = await get(
      `/api/reports/top-products?from=${RANGE.from}&to=${RANGE.to}`,
      other,
    );
    const rows = res.json().rows as Array<{ variant_name: string; qty: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ variant_name: "F", qty: 3 });
  });
});

describe("low stock (exact numbers)", () => {
  it("5/5 and −2/0 are flagged, 50/5 is not (system default 5 elsewhere)", async () => {
    const res = await get("/api/reports/low-stock");
    expect(res.statusCode).toBe(200);
    expect(res.json().default_threshold).toBe(5);
    const rows = res.json().rows as Array<Record<string, unknown>>;
    expect(
      rows.map((r) => ({
        product_name: r.product_name,
        variant_name: r.variant_name,
        stock: r.stock,
        threshold: r.threshold,
      })),
    ).toEqual(EXPECTED_LOW_A);
    expect(rows.map((r) => r.variant_name)).not.toContain("L3");
    // high-stock sale variants (100, no threshold → default 5) stay out
    expect(rows.map((r) => r.variant_name)).not.toContain("A");
  });

  it("empty catalog → empty report, no error", async () => {
    const empty = await createTenant(app, {
      email: "rep-empty@tenant.test",
      orgSlug: "org-rep-empty",
    });
    const res = await get("/api/reports/low-stock", empty);
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([]);
  });
});

describe("offline report path (same fixtures against PGlite)", () => {
  it("PGlite yields the exact same numbers as the server", async () => {
    const local = new PGlite("memory://");
    try {
      await local.exec(LOCAL_SCHEMA_SQL);
      await seedLocal(local, owner.orgId, A_VARIANTS, A_TICKETS);
      await seedLocal(local, other.orgId, B_VARIANTS, B_TICKETS);

      const salesA = parseSalesByDay(
        (
          await local.query(SALES_BY_DAY_SQL, [owner.orgId, RANGE.from, RANGE.to])
        ).rows as Record<string, unknown>[],
      );
      expect(salesA).toEqual(EXPECTED_SALES_A);

      const topA = parseTopProducts(
        (
          await local.query(TOP_PRODUCTS_SQL, [owner.orgId, RANGE.from, RANGE.to])
        ).rows as Record<string, unknown>[],
      );
      expect(
        topA.map(({ variant_id: _id, ...rest }) => rest),
      ).toEqual(EXPECTED_TOP_A);

      const lowA = parseLowStock(
        (await local.query(LOW_STOCK_SQL, [owner.orgId, 5])).rows as Record<
          string,
          unknown
        >[],
      );
      expect(
        lowA.map(({ variant_id: _id, ...rest }) => rest),
      ).toEqual(EXPECTED_LOW_A);

      const salesB = parseSalesByDay(
        (
          await local.query(SALES_BY_DAY_SQL, [other.orgId, RANGE.from, RANGE.to])
        ).rows as Record<string, unknown>[],
      );
      expect(salesB).toEqual(EXPECTED_SALES_B);
    } finally {
      await local.close();
    }
  }, 30_000);
});

/* ── roles-admin 2.2 · Dueño-tier financial gates ────────────────────── */

describe("Dueño-tier financial gates (roles-admin 2.2)", () => {
  let member: Actor;
  let admin: Actor;

  beforeEach(async () => {
    member = await joinOrg(app, owner, "member", "rep-member@test.dev");
    admin = await joinOrg(app, owner, "admin", "rep-admin@test.dev");
  });

  const FINANCIAL = [
    `/api/reports/sales-by-day?from=${RANGE.from}&to=${RANGE.to}`,
    `/api/reports/top-products?from=${RANGE.from}&to=${RANGE.to}`,
    `/api/reports/dashboard?from=${RANGE.from}&to=${RANGE.to}`,
  ];

  it("member 403 on the three financial datasets, no figure leaks", async () => {
    for (const url of FINANCIAL) {
      const res = await get(url, member);
      expect(res.statusCode, url).toBe(403);
      expect(res.json()).toEqual({ error: "forbidden", detail: "dueño_only" });
      expect(res.body).not.toContain("revenue");
    }
  });

  it("admin gets the EXACT same fixture numbers as owner (RP:Owner and admin financial reports unchanged)", async () => {
    for (const url of FINANCIAL) {
      const asOwner = await get(url, owner);
      const asAdmin = await get(url, admin);
      expect(asOwner.statusCode, url).toBe(200);
      expect(asAdmin.statusCode, url).toBe(200);
      expect(asAdmin.json(), url).toEqual(asOwner.json());
    }
    // the canonical fixture numbers themselves (non-regression)
    const sales = await get(FINANCIAL[0], admin);
    expect(sales.json().rows).toEqual(EXPECTED_SALES_A);
    const top = await get(FINANCIAL[1], admin);
    expect(top.json().rows.map((r: { variant_name: string }) => r.variant_name))
      .toEqual(EXPECTED_TOP_A.map(r => r.variant_name));
  });

  it("member still reads balances and low stock (RP:Member sees balances and low stock)", async () => {
    for (const url of [
      "/api/reports/customer-balances",
      "/api/reports/customer-accounts",
      "/api/reports/low-stock",
      "/api/rehydrate",
    ]) {
      expect((await get(url, member)).statusCode, url).toBe(200);
    }
    const low = await get("/api/reports/low-stock", member);
    expect(low.json().rows.map((r: { variant_name: string }) => r.variant_name))
      .toEqual(EXPECTED_LOW_A.map(r => r.variant_name));
  });
});
