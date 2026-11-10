type Item = { id: string; entity: string; client_uuid: string; payload: unknown };

/** Never split a sale at the HTTP cap; variant refreshes retain their latest
 * sale association (queue is upsert-latest per variant). */
export function groupQueue<T extends Item>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  const variantSale = new Map<string,string>();
  for (const row of rows) {
    const p=row.payload as Record<string,unknown>;
    if(row.entity === "variant" && typeof p.ref_ticket_id === "string") variantSale.set(row.client_uuid,p.ref_ticket_id);
  }
  for (const row of rows) {
    const p = row.payload as Record<string, unknown>;
    const parent = row.entity === "ticket" ? row.client_uuid
      : ["ticket_line", "payment"].includes(row.entity) ? p.ticket_id
      : row.entity === "stockdiary" && p.reason === "initial" && !p.ref_ticket_id ? variantSale.get(p.variant_id as string)
      : ["stockdiary", "variant"].includes(row.entity) ? p.ref_ticket_id : null;
    const key = typeof parent === "string" ? `ticket:${parent}` : `solo:${row.id}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  // Topological dependencies matter after upsert-latest moves a new variant
  // to a later sale. Products/categories/shifts precede their consumers;
  // initial stock travels with the sale owning the variant refresh.
  const result:T[][]=[];
  const owner=new Map<string,string>();
  for(const [key,group] of groups) for(const row of group) owner.set(row.client_uuid,key);
  const visited=new Set<string>();
  function visit(key:string) {
    if(visited.has(key)) return;
    visited.add(key);
    const group=groups.get(key)!;
    for(const row of group) {
      const p=row.payload as Record<string,unknown>;
      for(const field of ["product_id","category_id","variant_id","shift_id"]) {
        const dep=owner.get(p[field] as string);
        if(dep && dep!==key) visit(dep);
      }
    }
    result.push(group);
  }
  for(const key of groups.keys()) visit(key);
  return result;
}
