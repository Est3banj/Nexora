import type { PGlite } from "@electric-sql/pglite";
import { scopedFetch } from "../sync/scoped-fetch";
import { assertWritable } from "./preservation";

export type VoidSnapshot = {
  ticket_id: string;
  stockdiary: Array<{ id: string; variant_id: string; delta: number; note: string; created_at: string }>;
};

/** Mirror server evidence, never enqueue a privileged command. Add only newly
 * inserted deltas, preserving stock effects of any later offline sales. */
export async function mirrorVoidedSale(db: PGlite, tenantId: string, snapshot: VoidSnapshot, opts: { allowSealed?: boolean } = {}) {
  await db.transaction(async tx => {
    if (!opts.allowSealed) await assertWritable(tx, tenantId);
    const vault = await tx.query<{ tenant_id: string | null }>("SELECT tenant_id FROM local_vault WHERE id=1");
    if (vault.rows[0]?.tenant_id && vault.rows[0].tenant_id !== tenantId) throw new Error("tenant_mismatch");
    await tx.query("UPDATE tickets SET status='voided',updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, snapshot.ticket_id]);
    for (const d of snapshot.stockdiary) {
      const inserted = await tx.query(`INSERT INTO stockdiary (id,tenant_id,client_uuid,variant_id,delta,reason,note,ref_ticket_id,created_at)
        VALUES ($1,$2,$1,$3,$4,'sale_void',$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
      [d.id, tenantId, d.variant_id, d.delta, d.note, snapshot.ticket_id, d.created_at]);
      if (!inserted.rows.length) continue;
      await tx.query("UPDATE product_variants SET stock=stock+$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, d.variant_id, d.delta]);
      await tx.query(`INSERT INTO stockcurrent (id,tenant_id,variant_id,stock) VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id,variant_id) DO UPDATE SET stock=stockcurrent.stock+excluded.stock,updated_at=now()`,
      [crypto.randomUUID(), tenantId, d.variant_id, d.delta]);
      // Keep an existing queued variant refresh consistent without scheduling
      // a new write or accidentally moving it into the voided sale's group.
      await tx.query(`UPDATE sync_log SET payload=jsonb_set(payload,'{stock}',to_jsonb(v.stock))
        FROM product_variants v WHERE sync_log.tenant_id=$1 AND sync_log.entity='variant'
        AND sync_log.client_uuid=$2 AND v.tenant_id=$1 AND v.id=$2`, [tenantId, d.variant_id]);
    }
  });
}

export async function pullVoidedSale(db: PGlite, tenantId: string, ticketId: string) {
  const res = await scopedFetch(tenantId, `/api/sales/tickets/${ticketId}`);
  if (!res.ok) throw new Error("No se pudo actualizar la copia local; reintentá con conexión");
  const data = await res.json();
  if (data.ticket.status === "voided") await mirrorVoidedSale(db, tenantId, { ticket_id: ticketId, stockdiary: data.stockdiary }, { allowSealed: true });
}
