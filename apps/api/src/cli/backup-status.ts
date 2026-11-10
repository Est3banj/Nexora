import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * D4-1 · Founder CLI — backup visibility (ops companion for the nightly
 * pg_dump landed in D4-6; readable from day one so the drill has a tool).
 *
 *   BACKUPS_DIR=/backups pnpm --filter @pos/api backup-status
 *
 * Lists dump files newest-first with size/mtime. Pure filesystem read —
 * no database access (exported for tests).
 */

export type BackupEntry = {
  file: string;
  size: number;
  mtime: Date;
};

const DUMP_RE = /\.(dump|pgdump|backup|sql)(\.gz|\.zst|\.bz2)?$/i;

export function listBackups(dir: string): BackupEntry[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => DUMP_RE.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { file: f, size: stat.size, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

export function formatBackups(dir: string): string {
  const entries = listBackups(dir);
  if (entries.length === 0) {
    return `[backup-status] no backup dumps in ${dir} (is the backup cron running?)`;
  }
  const lines = entries.map(
    (e) =>
      `${e.mtime.toISOString().replace("T", " ").slice(0, 19)}Z  ${String(e.size).padStart(10)}B  ${e.file}`,
  );
  return `[backup-status] ${dir} (${entries.length} dump(s), newest first)\n${lines.join("\n")}`;
}

export function runBackupStatus(dir?: string): string {
  const backupsDir = dir ?? process.env.BACKUPS_DIR ?? "/backups";
  const report = formatBackups(backupsDir);
  console.log(report);
  return report;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    runBackupStatus();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backup-status] ERROR: ${msg}`);
    process.exitCode = 1;
  }
}
