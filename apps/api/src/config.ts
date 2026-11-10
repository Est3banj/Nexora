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
const betterAuthSecret = process.env.BETTER_AUTH_SECRET ?? DEV_SECRET;

// Fail fast: never boot production with a development secret.
if (nodeEnv === "production" && (!process.env.BETTER_AUTH_SECRET || betterAuthSecret === DEV_SECRET)) {
  throw new Error(
    "BETTER_AUTH_SECRET is missing or still the dev default. " +
      "Generate one with: openssl rand -base64 32",
  );
}

if (nodeEnv === "production" && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required in production");
}

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://esteban@127.0.0.1:5432/pos_piloto",
  port: Number(process.env.PORT ?? 3000),
  betterAuthSecret,
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  trustedOrigins: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(process.env.TRUSTED_ORIGINS?.split(",") ?? []),
  ],
  nodeEnv,
};
