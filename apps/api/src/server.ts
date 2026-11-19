import { buildApp } from "./app";
import { config } from "./config";
import { ensureAuthTables } from "./db/bootstrap";
import { closeDb } from "./db";
import { AUDIT_RETENTION_DAYS, pruneAuditLog } from "./db/audit-retention";
import { initBaseline } from "./db/init-baseline";
import { migrateCatalog } from "./db/migrate-catalog";
import { migrateCost } from "./db/migrate-cost";
import { migrateFiado } from "./db/migrate-fiado";
import { migrateMesas } from "./db/migrate-mesas";
import { migratePrototype } from "./db/migrate-prototype";
import { migrateSaleStage } from "./db/sale-stage";
import { migrateSettings } from "./db/migrate-settings";

await ensureAuthTables();
// Base business schema FIRST (marker-gated, idempotent), then the additive
// migrations below — on a fresh database the ALTERs have tables to alter.
await initBaseline();
await migrateCatalog();
await migrateCost();
await migrateFiado();
await migrateMesas();
await migratePrototype();
await migrateSaleStage();
await migrateSettings();

// Retention housekeeping · AFTER initBaseline (which is what guarantees
// `audit_log` exists on a fresh database) and after the additive chain, so
// the prune always runs against a complete schema. Idempotent + cheap: one
// DELETE over a timestamp cutoff, once per boot (see audit-retention.ts for
// the 180-day policy and why it is a single global statement).
try {
  const pruned = await pruneAuditLog();
  if (pruned > 0) {
    console.log(`[audit-retention] dropped ${pruned} audit_log rows older than ${AUDIT_RETENTION_DAYS} days`);
  }
} catch (err) {
  console.error("[audit-retention] prune failed (boot continues, retried on next start):", err);
}

const app = await buildApp();

await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`[api] listening on :${config.port} (${config.nodeEnv})`);

let closing = false;
async function shutdown(code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    await closeDb();
  } catch (err) {
    app.log.error({ err }, "shutdown failed");
    code ||= 1;
  }
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

/**
 * P1-4 · process-level safety net. Without these listeners Node's default is
 * "print a stack and die": the pino destination is dropped mid-write, in-flight
 * requests never get an answer and the orchestrator sees a bare exit. Log the
 * reason FIRST (so it is in the log stream), then run the SAME ordered
 * shutdown as SIGTERM with a non-zero code — a crash must stay a crash, never
 * a silent "handled" event. Installed after listen(): a boot failure keeps its
 * own loud, non-zero failure path (App boot errors on the web side are
 * unrelated — this is the API process only).
 */
process.on("unhandledRejection", (reason) => {
  app.log.error({ err: reason }, "unhandledRejection");
  void shutdown(1);
});
process.on("uncaughtException", (err) => {
  app.log.error({ err }, "uncaughtException");
  void shutdown(1);
});
