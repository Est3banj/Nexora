import { buildApp } from "./app";
import { config } from "./config";
import { ensureAuthTables } from "./db/bootstrap";
import { closeDb } from "./db";
import { migrateCatalog } from "./db/migrate-catalog";
import { migrateCost } from "./db/migrate-cost";
import { migrateFiado } from "./db/migrate-fiado";
import { migratePrototype } from "./db/migrate-prototype";
import { migrateSaleStage } from "./db/sale-stage";

await ensureAuthTables();
await migrateCatalog();
await migrateCost();
await migrateFiado();
await migratePrototype();
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
