import { buildApp } from "./app";
import { config } from "./config";
import { ensureAuthTables } from "./db/bootstrap";
import { closeDb } from "./db";
import { migrateCatalog } from "./db/migrate-catalog";
import { migrateSaleStage } from "./db/sale-stage";

await ensureAuthTables();
await migrateCatalog();
await migrateSaleStage();

const app = await buildApp();

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`[api] listening on :${config.port} (${config.nodeEnv})`);

async function shutdown(): Promise<void> {
  await app.close();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
