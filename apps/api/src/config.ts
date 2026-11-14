import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

// Load root .env when present. MUST happen BEFORE reading process.env —
// a prior `??= ""` would pin an empty DATABASE_URL that dotenv cannot override.
const envFile = path.join(repoRoot, ".env");
if (fs.existsSync(envFile)) {
  const { config } = await import("dotenv");
  config({ path: envFile, override: false });
}

const DEV_SECRET = "dev-secret-only-not-for-prod-0123456789abcdef";
const nodeEnv = process.env.NODE_ENV ?? "development";
const isProduction = nodeEnv === "production";

function failFast(message: string): never {
  throw new Error(`[config] refused to boot (${nodeEnv}): ${message}`);
}

function parseAbsoluteUrl(value: string, label: string): URL {
  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    failFast(`${label} must be an absolute URL, got ${JSON.stringify(value)}`);
  }
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    failFast(`${label} must be a public origin in production, got loopback ${JSON.stringify(value)}`);
  }
  return parsed;
}

/**
 * Production fail-fast (Partition B · static audit).
 *
 * Every value below is REQUIRED when NODE_ENV=production: a boot that falls
 * back to a dev secret, a localhost origin or an implicit trusted-origin
 * list is a security bug, not a convenience. Dev defaults exist ONLY when
 * nodeEnv !== "production" (see the `config` export).
 *
 * Nothing here is validated in dev/test, so the local and CI flows keep
 * their current behaviour byte-for-byte.
 */
type ProductionEnv = {
  secret: string;
  betterAuthUrl: string;
  trustedOrigins: string[];
  databaseUrl: string;
};

function loadProductionEnv(): ProductionEnv {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret === DEV_SECRET) {
    failFast(
      "BETTER_AUTH_SECRET is missing or still the dev default. Generate one with: openssl rand -base64 32",
    );
  }
  if (secret.length < 32) {
    failFast(
      "BETTER_AUTH_SECRET is too short (< 32 chars). Generate one with: openssl rand -base64 32",
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    failFast("DATABASE_URL is required in production");
  }
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    failFast("DATABASE_URL must be a postgres:// or postgresql:// URL");
  }

  const rawAuthUrl = process.env.BETTER_AUTH_URL;
  if (!rawAuthUrl) {
    failFast(
      "BETTER_AUTH_URL is required in production (public https origin of this API)",
    );
  }
  const authUrl = parseAbsoluteUrl(rawAuthUrl, "BETTER_AUTH_URL");
  if (authUrl.protocol !== "https:") {
    failFast(
      `BETTER_AUTH_URL must use https:// in production, got ${authUrl.protocol}//`,
    );
  }

  const origins = (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    failFast(
      "TRUSTED_ORIGINS is required in production: comma-separated https origins " +
        "of the web app (e.g. https://pos.example.com). No dev origin is added here.",
    );
  }
  for (const origin of origins) {
    const parsed = parseAbsoluteUrl(origin, "TRUSTED_ORIGINS entry");
    if (parsed.protocol !== "https:") {
      failFast(`TRUSTED_ORIGINS entries must use https:// in production, got ${origin}`);
    }
  }

  return {
    secret,
    betterAuthUrl: rawAuthUrl,
    trustedOrigins: origins,
    databaseUrl,
  };
}

const production = isProduction ? loadProductionEnv() : null;

export const config = {
  databaseUrl:
    production?.databaseUrl ||
    process.env.DATABASE_URL ||
    "postgres://esteban@127.0.0.1:5432/pos_piloto",
  port: Number(process.env.PORT ?? 3000),
  betterAuthSecret: production?.secret ?? process.env.BETTER_AUTH_SECRET ?? DEV_SECRET,
  betterAuthUrl:
    production?.betterAuthUrl ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  trustedOrigins: production?.trustedOrigins ?? [
    // dev/test defaults — never reach a production boot (loadProductionEnv
    // requires an explicit TRUSTED_ORIGINS instead).
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(process.env.TRUSTED_ORIGINS?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? []),
  ],
  nodeEnv,
};
