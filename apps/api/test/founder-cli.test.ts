import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  buildTestApp,
  createTenant,
  resetTables,
  signIn,
} from "./helpers";
import { closeDb, db, pool } from "../src/db";
import { founderSyncStatus } from "../src/db/founder";
import { scopedRepo } from "../src/db/scope";
import { createTenantWithFirstUser } from "../src/founder/service";
import { runTenantCreate, parseTenantCreateArgs } from "../src/cli/tenant-create";
import { formatSyncStatus } from "../src/cli/sync-status";
import { listBackups } from "../src/cli/backup-status";
import { getAuth } from "../src/auth/auth";

/**
 * D4-1 · Founder CLI (degradation path)
 * AC (founder-control spec):
 *  - §Degradation fallback: CLI-created tenant equivalent — first user
 *    signs in with full tenant scope, indistinguishable from UI-created
 *  - §Creation is audited (timestamp + actor + created tenant id)
 *  - §Tenant isolation applies to founder queries: A=7, B=2, never 9
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

beforeEach(async () => {
  await resetTables();
});

async function seedPending(tenantId: string, n: number): Promise<void> {
  const repo = scopedRepo(db, tenantId);
  for (let i = 0; i < n; i++) {
    const id = randomUUID();
    await repo.syncLog.enqueue({
      client_uuid: id,
      client_ts: Date.now() + i,
      entity: "product",
      op: "upsert",
      payload: { name: `p${i}`, active: true },
    });
  }
}

describe("D4-1 · CLI-created tenant is equivalent (§Degradation fallback)", () => {
  it("creates org + owner membership + audit; first user signs in with full tenant scope", async () => {
    const result = await createTenantWithFirstUser({
      name: "Tienda Granizados",
      email: "shop@tienda.co",
      password: "secret1234",
      actor: "cli:tenant-create",
      source: "cli",
    });
    expect(result.orgId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.orgSlug).toContain("tienda-granizados");

    // first user signs in fresh → set-active (web login flow) → full scope
    const cookie = await signIn(app, {
      email: "shop@tienda.co",
      password: "secret1234",
    });
    const active = await app.inject({
      method: "POST",
      url: "/api/auth/organization/set-active",
      headers: { cookie },
      payload: { organizationId: result.orgId },
    });
    expect(active.statusCode).toBe(200);

    // active org = the new tenant, empty catalog, zero rows from others
    const products = await app.inject({
      method: "GET",
      url: "/api/catalog/products",
      headers: { cookie },
    });
    expect(products.statusCode).toBe(200);
    expect(products.json().products).toEqual([]);

    const tickets = await app.inject({
      method: "GET",
      url: "/api/sales/tickets",
      headers: { cookie },
    });
    expect(tickets.json().tickets).toEqual([]);

    // creator membership is OWNER (better-auth creatorRole)
    const role = await getAuth().api.getActiveMemberRole({
      headers: new Headers({ cookie }),
    });
    expect(role.role).toBe("owner");
  });

  it("creation is audited: timestamp + actor + created tenant id (§Creation is audited)", async () => {
    const result = await createTenantWithFirstUser({
      name: "Tienda Auditada",
      email: "audit@tienda.co",
      password: "secret1234",
      actor: "founder-cli",
      source: "cli",
    });

    const res = await pool.query(
      `SELECT actor, action, meta, created_at FROM audit_log WHERE tenant_id = $1`,
      [result.orgId],
    );
    const rows = res.rows as Array<{
      actor: string;
      action: string;
      meta: Record<string, unknown> | null;
      created_at: Date;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("founder-cli");
    expect(rows[0].action).toBe("tenant.create");
    expect(rows[0].created_at).toBeInstanceOf(Date);
    expect(rows[0].meta?.org_id).toBe(result.orgId);
    expect(rows[0].meta?.first_user_email).toBe("audit@tienda.co");
  });

  it("CLI arg parser validates required flags", () => {
    expect(() => parseTenantCreateArgs(["--name", "X"])).toThrow(/usage/);
    expect(() =>
      parseTenantCreateArgs(["--name", "X", "--email", "a@b.co", "--password", "short"]),
    ).toThrow(/at least 8/);
    const ok = parseTenantCreateArgs([
      "--name",
      "X",
      "--email",
      "a@b.co",
      "--password",
      "secret1234",
    ]);
    expect(ok.actor).toBe("cli:tenant-create");
  });

  it("runTenantCreate end-to-end prints the new tenant metadata", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (msg?: unknown) => {
      logs.push(String(msg));
    };
    try {
      await runTenantCreate([
        "--name",
        "Tienda Print",
        "--email",
        "print@tienda.co",
        "--password",
        "secret1234",
        "--actor",
        "tester",
      ]);
    } finally {
      console.log = orig;
    }
    const out = logs.join("\n");
    expect(out).toContain("organization id:");
    expect(out).toContain("print@tienda.co");

    const orgs = await pool.query(
      `SELECT id, name FROM organization WHERE name = 'Tienda Print'`,
    );
    expect(orgs.rows).toHaveLength(1);
  });
});

describe("D4-1 · founder sync-status isolation (A=7, B=2, never 9)", () => {
  it("per-tenant pending counts never merge across tenants", async () => {
    const tenantA = await createTenant(app, {
      email: "a@sync.test",
      orgSlug: "org-sync-a",
      orgName: "Sync A",
    });
    const tenantB = await createTenant(app, {
      email: "b@sync.test",
      orgSlug: "org-sync-b",
      orgName: "Sync B",
    });
    await seedPending(tenantA.orgId, 7);
    await seedPending(tenantB.orgId, 2);

    const rows = await founderSyncStatus();
    const rowA = rows.find((r) => r.tenant_id === tenantA.orgId);
    const rowB = rows.find((r) => r.tenant_id === tenantB.orgId);
    expect(rowA?.pending).toBe(7);
    expect(rowB?.pending).toBe(2);
    // never a merged row
    expect(rows.some((r) => r.pending === 9)).toBe(false);
    expect(rows).toHaveLength(2);
    // metadata only — user counts are per-tenant too
    expect(rowA?.users).toBe(1);
    expect(rowB?.users).toBe(1);
    // no business payloads on the row shape
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        ["errors", "last_error", "last_sync", "name", "pending", "tenant_id", "users"].sort(),
      );
    }
  });

  it("last sync timestamp reflects that tenant's drained queue only", async () => {
    const tenantA = await createTenant(app, {
      email: "a2@sync.test",
      orgSlug: "org-sync-a2",
      orgName: "Sync A2",
    });
    const tenantB = await createTenant(app, {
      email: "b2@sync.test",
      orgSlug: "org-sync-b2",
      orgName: "Sync B2",
    });
    await seedPending(tenantA.orgId, 1);
    await seedPending(tenantB.orgId, 1);

    // drain A's queue the way sync-apply does (status synced + updated_at)
    const { eq } = await import("drizzle-orm");
    const t = await import("../src/db/schema");
    await db
      .update(t.syncLog)
      .set({ status: "synced", updated_at: new Date() })
      .where(eq(t.syncLog.tenant_id, tenantA.orgId));

    const rows = await founderSyncStatus();
    const rowA = rows.find((r) => r.tenant_id === tenantA.orgId)!;
    const rowB = rows.find((r) => r.tenant_id === tenantB.orgId)!;
    expect(rowA.last_sync).toBeInstanceOf(Date);
    expect(rowB.last_sync).toBeNull();
    expect(rowA.pending).toBe(0);
    expect(rowB.pending).toBe(1);

    // formatter is CLI-ready and never prints foreign counts
    const text = formatSyncStatus(rows);
    expect(text).toContain("Sync A2");
    expect(text).toContain("Sync B2");
  });
});

describe("D4-1 · backup-status CLI", () => {
  it("lists dump files newest-first and handles a missing directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-backups-"));
    try {
      expect(listBackups(path.join(dir, "nope"))).toEqual([]);
      fs.writeFileSync(path.join(dir, "old.dump"), "a".repeat(10));
      const future = new Date(Date.now() + 60_000);
      fs.writeFileSync(path.join(dir, "new.dump.gz"), "b".repeat(20));
      fs.utimesSync(path.join(dir, "old.dump"), future, future);
      // noise files are ignored
      fs.writeFileSync(path.join(dir, "notes.txt"), "x");

      const entries = listBackups(dir);
      expect(entries.map((e) => e.file)).toEqual(["old.dump", "new.dump.gz"]);
      expect(entries[0].size).toBe(10);
      expect(entries[1].size).toBe(20);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
