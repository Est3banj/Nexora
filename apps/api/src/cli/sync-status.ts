import { pathToFileURL } from "node:url";
import { closeDb } from "../db";
import { founderSyncStatus, type FounderSyncStatus } from "../db/founder";

/**
 * D4-1 · Founder CLI — per-tenant sync status (degradation of the
 * founder-control §Per-tenant sync status view).
 *
 *   pnpm --filter @pos/api sync-status
 *
 * Same query as the web founder plane (src/db/founder.ts): one metadata
 * row per tenant, correlated per-tenant counts — A=7 + B=2 never shows 9
 * (spec §Counts do not bleed across tenants). No business payloads.
 */

const fmtTs = (d: Date | null): string =>
  d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) + "Z" : "—";

export function formatSyncStatus(rows: FounderSyncStatus[]): string {
  if (rows.length === 0) return "[sync-status] no tenants yet";
  const header = [
    "TENANT".padEnd(12),
    "NAME".padEnd(28),
    "USERS".padStart(5),
    "PENDING".padStart(8),
    "ERRORS".padStart(7),
    "LAST SYNC".padEnd(20),
  ].join("  ");
  const body = rows
    .map((r) =>
      [
        r.tenant_id.slice(0, 12).padEnd(12),
        (r.name.length > 26 ? `${r.name.slice(0, 25)}…` : r.name).padEnd(28),
        String(r.users).padStart(5),
        String(r.pending).padStart(8),
        String(r.errors).padStart(7),
        fmtTs(r.last_sync).padEnd(20),
      ].join("  ") + (r.last_error ? `  last error: ${r.last_error}` : ""),
    )
    .join("\n");
  return `${header}\n${body}`;
}

export async function runSyncStatus(): Promise<FounderSyncStatus[]> {
  const rows = await founderSyncStatus();
  console.log(formatSyncStatus(rows));
  return rows;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    await runSyncStatus();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sync-status] ERROR: ${msg}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
