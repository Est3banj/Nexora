import { getAuth } from "../auth/auth";
import { setUserPassword } from "../auth/password";
import { config } from "../config";
import { closeDb, db } from "../db";
import { ensureAuthTables } from "../db/bootstrap";
import { initBaseline } from "../db/init-baseline";
import { scopedRepo } from "../db/scope";

/**
 * Demo seed (task D1-8 dependency): owner user + tenant org + demo catalog
 * + open shift. Idempotent — safe to run on every boot/CI setup.
 *
 *   pnpm seed
 *   SEED_OWNER_EMAIL=... SEED_OWNER_PASSWORD=... pnpm seed
 *
 * The password default honours packages/shared PASSWORD_MIN (12): a sign-up
 * shorter than the floor is rejected by better-auth, so a fresh database
 * would never get an owner.
 */

const EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@demo.test";
const PASSWORD = process.env.SEED_OWNER_PASSWORD ?? "demo1234567890";
const ORG_NAME = "Tienda Demo";
const ORG_SLUG = "tienda-demo";

async function cookieHeaders(res: Response): Promise<Headers> {
  const headers = new Headers();
  for (const cookie of res.headers.getSetCookie()) {
    headers.append("cookie", cookie.split(";")[0]);
  }
  return headers;
}

async function trySignIn(): Promise<Headers | null> {
  try {
    // asResponse:true returns a Response instead of throwing on failure —
    // a 401 here simply means "no such user yet" (or a different password).
    const res = await getAuth().api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      asResponse: true,
    });
    return res.ok ? cookieHeaders(res) : null;
  } catch {
    return null;
  }
}

async function signInOrSignUp(): Promise<Headers> {
  const signedIn = await trySignIn();
  if (signedIn) return signedIn;

  const signUp = await getAuth().api.signUpEmail({
    body: { email: EMAIL, password: PASSWORD, name: "Dueño Demo" },
    asResponse: true,
  });
  if (signUp.ok) return cookieHeaders(signUp);

  const detail = await signUp.text().catch(() => "");
  const taken = signUp.status === 409 || signUp.status === 422 || /already|exists|taken/i.test(detail);
  if (!taken) {
    throw new Error(`[seed] sign-up failed (${signUp.status}): ${detail || "unknown"}`);
  }

  // The owner exists with a DIFFERENT credential: SEED_OWNER_PASSWORD changed
  // (or the account predates PASSWORD_MIN). Rotate it instead of failing
  // forever — seed is the only holder of this value, so the printed login
  // line below stays true and `pnpm seed` remains idempotent.
  const ctx = await getAuth().$context;
  const user = await ctx.internalAdapter.findUserByEmail(EMAIL);
  if (!user) throw new Error(`[seed] owner exists but could not be loaded: ${EMAIL}`);
  await setUserPassword(user.user.id, PASSWORD);
  await ctx.internalAdapter.deleteUserSessions(user.user.id);
  console.log(`[seed] owner credential rotated to SEED_OWNER_PASSWORD (${PASSWORD.length} chars)`);
  const rotated = await trySignIn();
  if (!rotated) throw new Error("[seed] owner credential rotated but sign-in still failed");
  return rotated;
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
  // Seed may run against a database the API has never booted on.
  await initBaseline();
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
