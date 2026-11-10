import { createHash, randomUUID } from "node:crypto";
import { pool } from "./index";

/** Server-only command. Payments/lines remain historical evidence, never rewritten. */
export async function voidSale(tenantId: string, actor: string, ticketId: string, reason: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const ticket = (await c.query(
      "SELECT * FROM tickets WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, ticketId],
    )).rows[0];
    if (!ticket) { await c.query("ROLLBACK"); return { error: "not_found" as const }; }
    if (ticket.status !== "voided") {
      const shift = (await c.query(
        "SELECT * FROM shifts WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, ticket.shift_id],
      )).rows[0];
      const closed = (await c.query("SELECT id FROM closedcash WHERE tenant_id=$1 AND shift_id=$2", [tenantId, ticket.shift_id])).rows[0];
      if (!shift || shift.status !== "open" || closed) {
        await c.query("ROLLBACK"); return { error: "shift_closed" as const };
      }
      // Refuse partial sync: derive all quantities and amounts from stored evidence.
      const lines = (await c.query("SELECT * FROM ticket_lines WHERE tenant_id=$1 AND ticket_id=$2", [tenantId, ticketId])).rows;
      const payments = (await c.query("SELECT * FROM payments WHERE tenant_id=$1 AND ticket_id=$2", [tenantId, ticketId])).rows;
      const movements = (await c.query("SELECT * FROM stockdiary WHERE tenant_id=$1 AND ref_ticket_id=$2", [tenantId, ticketId])).rows;
      const quantities = new Map<string, number>();
      for (const l of lines) quantities.set(l.variant_id, (quantities.get(l.variant_id) ?? 0) + l.qty);
      if (!lines.length || !payments.length || lines.some(l => l.subtotal !== l.qty * l.unit_price) ||
          lines.reduce((n, l) => n + l.subtotal, 0) !== ticket.total ||
          payments.reduce((n, p) => n + p.amount, 0) !== ticket.total ||
          payments.some(p => p.shift_id !== ticket.shift_id || !["pending", "confirmed"].includes(p.status)) ||
          [...quantities].some(([v, qty]) => movements.filter(m => m.variant_id === v && m.reason === "sale").reduce((n, m) => n + m.delta, 0) !== -qty)) {
        await c.query("ROLLBACK"); return { error: "incomplete_sale" as const };
      }
      // Serializes with sync's stock recomputation. Stable order avoids multi-variant deadlocks.
      for (const [variantId, qty] of [...quantities].sort(([a], [b]) => a.localeCompare(b))) {
        const variant = (await c.query("SELECT id FROM product_variants WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, variantId])).rows[0];
        if (!variant) throw new Error("Missing sale variant");
        // Ticket lock + stable tenant/ticket/variant key protect response-loss retries.
        const hash = createHash("sha256").update(`sale_void:${tenantId}:${ticketId}:${variantId}`).digest("hex");
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
        await c.query(`INSERT INTO stockdiary (id,tenant_id,client_uuid,variant_id,delta,reason,note,ref_ticket_id)
          VALUES ($1,$2,$1,$3,$4,'sale_void',$5,$6) ON CONFLICT (tenant_id,client_uuid) DO NOTHING`, [id, tenantId, variantId, qty, reason, ticketId]);
        const stock = (await c.query("SELECT coalesce(sum(delta),0)::int AS stock FROM stockdiary WHERE tenant_id=$1 AND variant_id=$2", [tenantId, variantId])).rows[0].stock;
        await c.query("UPDATE product_variants SET stock=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, variantId, stock]);
        await c.query(`INSERT INTO stockcurrent (id,tenant_id,variant_id,stock) VALUES ($1,$2,$3,$4)
          ON CONFLICT (tenant_id,variant_id) DO UPDATE SET stock=excluded.stock,updated_at=now()`, [randomUUID(), tenantId, variantId, stock]);
      }
      await c.query("UPDATE tickets SET status='voided',updated_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, ticketId]);
      await c.query("INSERT INTO audit_log (id,tenant_id,actor,action,meta) VALUES ($1,$2,$3,'sale.void',$4)",
        [randomUUID(), tenantId, actor, JSON.stringify({ ticket_id: ticketId, reason, original_status: ticket.status, total: ticket.total })]);
    }
    const audit = (await c.query("SELECT actor,created_at,meta FROM audit_log WHERE tenant_id=$1 AND action='sale.void' AND meta->>'ticket_id'=$2 ORDER BY created_at LIMIT 1", [tenantId, ticketId])).rows[0];
    const diary = (await c.query("SELECT * FROM stockdiary WHERE tenant_id=$1 AND ref_ticket_id=$2 AND reason='sale_void'", [tenantId, ticketId])).rows;
    await c.query("COMMIT");
    return { ticket_id: ticketId, status: "voided" as const, audit, stockdiary: diary };
  } catch (err) {
    await c.query("ROLLBACK"); throw err;
  } finally { c.release(); }
}
