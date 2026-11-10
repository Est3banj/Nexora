type Item = { id: string; entity: string; client_uuid: string; payload: unknown };

/** Never split a sale at the HTTP cap; variant refreshes retain their latest
 * sale association (queue is upsert-latest per variant). */
export function groupQueue<T extends Item>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const p = row.payload as Record<string, unknown>;
    const parent = row.entity === "ticket" ? row.client_uuid
      : ["ticket_line", "payment"].includes(row.entity) ? p.ticket_id
      : ["stockdiary", "variant"].includes(row.entity) ? p.ref_ticket_id : null;
    const key = typeof parent === "string" ? `ticket:${parent}` : `solo:${row.id}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
}
