import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, closeDb } from "../src/db";
import { AUDIT_RETENTION_DAYS, pruneAuditLog } from "../src/db/audit-retention";
import { resetTables } from "./helpers";

/**
 * audit_log RETENTION (plan de estabilidad).
 *
 * The table is insert-only (scope.ts) with no read path, so without a prune
 * it grows forever and the disk bill lands months later. The boot step
 * (server.ts → pruneAuditLog, after initBaseline) must:
 *
 *  1. drop rows older than the 180-day policy;
 *  2. keep rows inside the window (including the "just now" ones every other
 *     test file reads — admin-users asserts on the MOST RECENT audit row);
 *  3. be idempotent: a second run over the same data deletes nothing.
 *
 * No app/boot involved: this is the maintenance function itself, run against
 * the same test database the suite uses.
 */

async function insertAudit(opts: { ageDays: number; action?: string }): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO audit_log (id, tenant_id, actor, action, meta, created_at)
     VALUES ($1, NULL, 'test', $2, '{}'::jsonb, now() - ($3::int * interval '1 day'))`,
    [id, opts.action ?? `test.${opts.ageDays}d`, opts.ageDays],
  );
  return id;
}

async function auditIds(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM audit_log ORDER BY created_at`);
  return rows.map((r) => r.id);
}

beforeEach(() => resetTables());
afterAll(() => closeDb());

describe("audit_log retention", () => {
  it("borra solo lo que cruza el corte de 180 días (viejo fuera, reciente dentro)", async () => {
    const oldId = await insertAudit({ ageDays: AUDIT_RETENTION_DAYS + 1 });
    const edgeOldId = await insertAudit({ ageDays: 400, action: "test.400d" });
    const recentId = await insertAudit({ ageDays: 7 });
    const edgeRecentId = await insertAudit({ ageDays: AUDIT_RETENTION_DAYS - 1, action: "test.179d" });
    const freshId = await insertAudit({ ageDays: 0 });

    const pruned = await pruneAuditLog();

    expect(pruned).toBe(2);
    const remaining = await auditIds();
    expect(remaining).not.toContain(oldId);
    expect(remaining).not.toContain(edgeOldId);
    expect(remaining.sort()).toEqual([recentId, edgeRecentId, freshId].sort());
  });

  it("es idempotente: la segunda corrida no borra nada", async () => {
    const recentId = await insertAudit({ ageDays: 1 });
    expect(await pruneAuditLog()).toBe(0);
    expect(await pruneAuditLog()).toBe(0);
    expect(await auditIds()).toEqual([recentId]);
  });

  it("la constante de la política es 180 días", () => {
    expect(AUDIT_RETENTION_DAYS).toBe(180);
  });
});
