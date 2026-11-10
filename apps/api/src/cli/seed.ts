import { getAuth } from "../auth/auth";
import { config } from "../config";
import { closeDb, db } from "../db";
import { ensureAuthTables } from "../db/bootstrap";
import { scopedRepo } from "../db/scope";

/**
 * Demo seed (task D1-8 dependency): owner user + tenant org + demo catalog
 * + open shift. Idempotent — safe to run on every boot/CI setup.
 *
 *   pnpm seed
 *   SEED_OWNER_EMAIL=... SEED_OWNER_PASSWORD=... pnpm seed
 */

const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@demo.test";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "demo12345";
const ORG_NAME = "Tienda Demo";
const ORG_SLUG = "tienda-demo";

async function cookieHeaders(res: Response): Promise<Headers> {
  const headers = new Headers();
  for (const cookie of res.headers.getSetCookie()) {
    headers.append("cookie", cookie.split(";")[0]);
  }
  return headers;
}

async function signInOrSignUp(): Promise<Headers> {
  const auth = getAuth();
  try {
    // asResponse:true returns a Response instead of throwing on failure —
    // a 401 here simply means "no such user yet".
    const res = await auth.api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      asResponse: true,
    });
    if (res.ok) return cookieHeaders(res);
  } catch {
    // fall through to sign-up
  }
  const res = await auth.api.signUpEmail({
    body: { email: EMAIL, password: PASSWORD, name: "Dueño Demo" },
    asResponse: true,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `[seed] sign-up failed (${res.status}): ${detail || "unknown"}`,
    );
  }
  return cookieHeaders(res);
}

async function ensureOrg(headers: Headers): Promise<string> {
  const auth = getAuth();
  const existing = await auth.api.listOrganizations({ headers });
  let org = existing.find((o) => o.slug === ORG_SLUG) ?? existing[0];
  if (!org) {
    org = await auth.api.createOrganization({
      body: { name: ORG_NAME, slug: ORG_SLUG },
      headers,
    });
  }
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });
  return org.id;
}

const DEMO_PRODUCTS = [
  {
    name: "Cerveza",
    variants: [
      { name: "330ml", price: 4000, stock: 48 },
      { name: "600ml", price: 7000, stock: 24 },
    ],
  },
  {
    name: "Granizado de Fresa",
    variants: [
      { name: "Mediano", price: 3000, stock: 30 },
      { name: "Grande", price: 5000, stock: 30 },
    ],
  },
  { name: "Gaseosa", variants: [{ name: "Personal", price: 2500, stock: 36 }] },
  { name: "Agua", variants: [{ name: "600ml", price: 2000, stock: 40 }] },
];

async function main(): Promise<void> {
  await ensureAuthTables();
  const headers = await signInOrSignUp();
  const tenantId = await ensureOrg(headers);
  const repo = scopedRepo(db, tenantId);

  const current = await repo.products.list();
  if (current.length === 0) {
    for (const p of DEMO_PRODUCTS) {
      const [first, ...rest] = p.variants;
      const { product } = await repo.catalog.createProduct({
        name: p.name,
        variant: { name: first.name, price: first.price, stock: first.stock },
      });
      for (const v of rest) {
        await repo.catalog.addVariant(product.id, {
          name: v.name,
          price: v.price,
          stock: v.stock,
        });
      }
    }
    console.log(`[seed] catalog created for tenant ${tenantId}`);
  } else {
    console.log(`[seed] catalog already present (${current.length} products)`);
  }

  const open = await repo.shifts.open();
  if (!open) {
    await repo.shifts.createOpen();
    console.log("[seed] open shift created");
  }

  console.log("[seed] done");
  console.log(`[seed] tenant(organization) id: ${tenantId}`);
  console.log(`[seed] owner login: ${EMAIL} / ${PASSWORD}`);
  console.log(`[seed] api url: ${config.betterAuthUrl}`);
}

try {
  await main();
} finally {
  await closeDb();
}
