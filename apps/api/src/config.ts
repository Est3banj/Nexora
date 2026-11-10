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

export const config = {
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgres://esteban@127.0.0.1:5432/pos_piloto",
  port: Number(process.env.PORT ?? 3000),
  betterAuthSecret:
    process.env.BETTER_AUTH_SECRET ?? "dev-secret-only-not-for-prod-0123456789abcdef",
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  trustedOrigins: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(process.env.TRUSTED_ORIGINS?.split(",") ?? []),
  ],
  nodeEnv: process.env.NODE_ENV ?? "development",
};
