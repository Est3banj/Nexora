import type { PGlite } from "@electric-sql/pglite";
import type { LocalQueryable } from "./pglite";

/** Additive, same datadir. A seal survives crashes/reloads and is NOT an ACK. */
export const PRESERVATION_SQL = `
CREATE TABLE IF NOT EXISTS local_vault (
  id integer PRIMARY KEY CHECK (id=1), tenant_id text, sealed boolean NOT NULL DEFAULT false
);
INSERT INTO local_vault(id) VALUES(1) ON CONFLICT DO NOTHING;
`;

export const BUSINESS_TABLES = ["sync_sale_outbox", "sync_log", "cash_movements", "stockdiary", "stockcurrent", "closedcash", "credit_abonos", "payments", "ticket_lines", "tickets", "customers", "shifts", "product_variants", "products", "categories"] as const;

export async function unresolvedWork(q: LocalQueryable): Promise<number> {
  const r = await q.query<{ n: string }>(`SELECT
    (SELECT count(*) FROM sync_log WHERE status <> 'synced') +
    (SELECT count(*) FROM sync_sale_outbox) AS n`);
  return Number(r.rows[0].n);
}

export async function assertWritable(q: LocalQueryable, tenant?: string): Promise<void> {
  const r = await q.query<{ sealed: boolean; tenant_id: string | null }>("SELECT * FROM local_vault WHERE id=1");
  const vault = r.rows[0];
  if (vault?.sealed) throw new Error("Base protegida: reintentá la sincronización o volvé a ingresar");
  if (tenant && vault?.tenant_id && vault.tenant_id !== tenant) throw new Error("tenant_mismatch");
}

export async function sealLocal(db: PGlite): Promise<void> {
  await db.query("UPDATE local_vault SET sealed=true WHERE id=1");
}

/** Old installations may have multiple scoped tenants. Never adopt their work
 * under a new session. Acknowledge/recover each original tenant first. */
export async function claimLocal(db: PGlite, tenant: string): Promise<void> {
  await sealLocal(db);
  await db.transaction(async tx => {
    const foreign = await tx.query(`SELECT tenant_id FROM sync_log WHERE status<>'synced' AND tenant_id::text<>$1
      UNION SELECT tenant_id FROM sync_sale_outbox WHERE tenant_id::text<>$1`, [tenant]);
    if (foreign.rows.length) throw new Error("Hay cambios protegidos de otro comercio. Volvé a ingresar con ese comercio para sincronizarlos.");
    const owners = await tx.query<{ tenant_id: string | null }>("SELECT tenant_id FROM local_vault WHERE id=1");
    if (owners.rows[0].tenant_id && owners.rows[0].tenant_id !== tenant && await unresolvedWork(tx)) {
      throw new Error("Hay cambios protegidos de otro comercio. Volvé a ingresar con ese comercio para sincronizarlos.");
    }
    const foreignCache = await tx.query(BUSINESS_TABLES.map(table =>
      `SELECT tenant_id::text AS tenant_id FROM ${table} WHERE tenant_id::text<>$1`).join(" UNION "), [tenant]);
    if (foreignCache.rows.length || owners.rows[0].tenant_id && owners.rows[0].tenant_id !== tenant) {
      if (await unresolvedWork(tx)) throw new Error("protected_foreign_cache");
      for (const table of BUSINESS_TABLES) await tx.query(`DELETE FROM ${table}`);
    }
    await tx.query("UPDATE local_vault SET tenant_id=$1,sealed=false WHERE id=1", [tenant]);
  });
}
