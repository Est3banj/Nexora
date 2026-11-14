import { pathToFileURL } from "node:url";
import { closeDb } from "../db";
import { ensureAuthTables } from "../db/bootstrap";
import { initBaseline } from "../db/init-baseline";
import { createTenantWithFirstUser, FounderError } from "../founder/service";

/**
 * D4-1 · Founder CLI — tenant + first-user creation (degradation path,
 * founder-control spec §Degradation fallback).
 *
 *   pnpm --filter @pos/api tenant-create -- \
 *     --name "Tienda Granizados" \
 *     --email shop@tienda.co \
 *     --password "secret123" \
 *     [--slug tienda-granizados] [--actor founder@example.com]
 *
 * Produces the SAME organization + owner membership + audit records the
 * founder web plane creates (shared src/founder/service.ts).
 */

export type TenantCreateArgs = {
  name: string;
  email: string;
  password: string;
  slug?: string;
  actor: string;
};

export function parseTenantCreateArgs(argv: string[]): TenantCreateArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // pnpm/npm forward the `--` separator itself: the documented
    // `pnpm --filter @pos/api tenant-create -- --name …` reaches us as
    // ["--", "--name", …]. Skip it instead of rejecting the whole call.
    if (arg === "--") continue;
    if (!arg.startsWith("--")) {
      throw new FounderError(`unexpected argument: ${arg}`, 2);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new FounderError(`missing value for --${key}`, 2);
    }
    flags[key] = value;
    i++;
  }
  const { name, email, password, slug, actor } = flags;
  if (!name || !email || !password) {
    throw new FounderError(
      "usage: tenant-create --name <org> --email <user@tip.com> --password <min8> [--slug <slug>] [--actor <who>]",
      2,
    );
  }
  if (password.length < 8) {
    throw new FounderError("password must be at least 8 characters", 2);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new FounderError(`invalid email: ${email}`, 2);
  }
  return { name, email, password, slug, actor: actor ?? "cli:tenant-create" };
}

export async function runTenantCreate(argv: string[]): Promise<void> {
  const args = parseTenantCreateArgs(argv);
  const result = await createTenantWithFirstUser({
    name: args.name,
    slug: args.slug,
    email: args.email,
    password: args.password,
    actor: args.actor,
    source: "cli",
  });
  console.log("[tenant-create] done");
  console.log(`[tenant-create] organization id:   ${result.orgId}`);
  console.log(`[tenant-create] organization name: ${result.orgName}`);
  console.log(`[tenant-create] slug:              ${result.orgSlug}`);
  console.log(`[tenant-create] first user:        ${result.email} (${result.userId})`);
  console.log(`[tenant-create] audit id:          ${result.auditId}`);
  console.log("[tenant-create] sign-in: the first user logs into the web app with");
  console.log("[tenant-create] the credentials above; active org = this tenant.");
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    await ensureAuthTables();
    // A fresh database may have been created by this CLI alone (no API boot
    // yet): audit_log and the business tables must exist first.
    await initBaseline();
    await runTenantCreate(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tenant-create] ERROR: ${msg}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
