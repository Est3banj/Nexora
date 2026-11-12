import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../src/db/pglite";
import { commitLocalSale, createLocalCustomer, createLocalProduct, enqueueMutation, openLocalShift, closeLocalShift, registerLocalAbono, registerLocalCashMovement } from "../src/db/local";
import { pushNow, resetInFlight } from "../src/sync/queue";
import type { MutationEnvelope } from "@pos/shared";
import { SALE_OUTBOX_MIGRATION_SQL } from "@pos/shared";
import { saveSaleSnapshot } from "../src/sync/sale-upload";
import { groupQueue } from "../src/sync/batch";

const tenant="33333333-3333-4333-8333-333333333333";
let db:PGlite;
let variant:string;
let product:string;
beforeEach(async()=>{
  db=(await openLocalDb({url:"memory://",locks:null}))!.db;
  await openLocalShift(db,tenant);
  const p=await createLocalProduct(db,tenant,{name:"Café",variant:{name:"Único",price:100,cost:40,code:"CAF-1",stock:100}});
  variant=p.variants[0].id;product=p.id;
  await db.query("UPDATE sync_log SET status='synced'");
  await commitLocalSale(db,tenant,{lines:Array.from({length:26},()=>({variant_id:variant,qty:1,unit_price:100})),tendered:2600});
});
afterEach(async()=>{vi.unstubAllGlobals();await db.close();});

it("never-synced offline opening and all shift evidence ACK before close despite timestamp skew", async () => {
  await db.query("UPDATE sync_log SET status='synced'");
  await closeLocalShift(db, tenant, { counted: 2600 });
  await db.query("UPDATE sync_log SET status='synced'");
  const shift = await openLocalShift(db, tenant, { opening_cash: 10000 });
  const customer = await createLocalCustomer(db,tenant,{name:"Cliente",credit_limit:50000});
  await commitLocalSale(db,tenant,{lines:[{variant_id:variant,qty:1,unit_price:100}],method:"credit",customerId:customer.id,cashAmount:0});
  await registerLocalAbono(db,tenant,{customer_id:customer.id,amount:50,method:"cash"});
  await registerLocalCashMovement(db,tenant,{direction:"in",amount:1000,reason:"Ingreso"});
  await closeLocalShift(db,tenant,{counted:11050,closingNote:"Offline"});
  await db.query("UPDATE sync_log SET client_ts=1 WHERE entity='closedcash' AND payload->>'shift_id'=$1",[shift.id]);
  const seen:string[]=[];
  vi.stubGlobal("fetch",vi.fn(async(_url:string,init:RequestInit)=>{
    const {mutations}=JSON.parse(init.body as string) as {mutations:MutationEnvelope[]};
    for(const m of mutations) {
      if(m.entity==="closedcash") {
        expect(seen).toContain("shift"); expect(seen).toContain("ticket");
        expect(seen).toContain("credit_abono"); expect(seen).toContain("cash_movement");
      }
      seen.push(m.entity);
    }
    return Response.json({results:mutations.map(m=>({client_uuid:m.client_uuid,status:"applied"}))});
  }));
  await pushNow(db,tenant,{force:true});
  expect(seen[0]).toBe("shift");
  expect(seen.at(-1)).toBe("closedcash");
  expect((await db.query("SELECT * FROM sync_log WHERE status<>'synced'")).rows).toEqual([]);
});

function server(opts:{cut?:number;loseFinalize?:boolean;onFinalize?:()=>Promise<void>}={}) {
  const parts=new Map<number,MutationEnvelope[]>();
  const operations=new Set<string>();
  let committed=0,calls=0,cut=opts.cut,lose=opts.loseFinalize;
  const fetch=vi.fn(async(url:string,init:RequestInit)=>{
    calls++; operations.add(url.split("/")[4]);
    const body=JSON.parse(init.body as string);
    if(url.endsWith("/parts")) {
      expect(body.mutations.length).toBeLessThanOrEqual(50);
      parts.set(body.index,body.mutations);
      expect((await db.query("SELECT id FROM sync_log WHERE entity='ticket' AND status='synced'")).rows).toHaveLength(0);
      if(cut===calls) {cut=undefined;throw new Error("disconnected_after_upload");}
      return Response.json({staged:true});
    }
    if(url.endsWith("/finalize")) {
      if(!committed) committed++;
      await opts.onFinalize?.();
      if(lose) {lose=false;throw new Error("response_lost_after_commit");}
      return Response.json({results:[...parts.values()].flat().map(m=>({client_uuid:m.client_uuid,status:"applied"}))});
    }
    return Response.json({results:body.mutations.map((m:MutationEnvelope)=>({client_uuid:m.client_uuid,status:"applied"}))});
  });
  vi.stubGlobal("fetch",fetch);
  return {fetch,operations,get committed(){return committed;}};
}

it.each([1,2])("upload disconnect at part %s resumes persisted operation after boot reset without premature ACK",async cut=>{
  const s=server({cut});
  await pushNow(db,tenant,{force:true});
  expect((await db.query("SELECT id FROM sync_log WHERE entity='ticket' AND status='synced'")).rows).toHaveLength(0);
  expect((await db.query("SELECT * FROM sync_sale_outbox")).rows).toHaveLength(1);
  await resetInFlight(db,tenant);
  await pushNow(db,tenant,{force:true});
  expect(s.operations.size).toBe(1);
  expect(s.committed).toBe(1);
  expect((await db.query("SELECT id FROM sync_log WHERE status<>'synced'")).rows).toHaveLength(0);
  expect((await db.query("SELECT * FROM sync_sale_outbox")).rows).toHaveLength(0);
});

it("response loss retries same snapshot; edit after snapshot survives old ACK and is sent later",async()=>{
  let edited=false;
  const s=server({loseFinalize:true,onFinalize:async()=>{
    if(edited)return;edited=true;
    await enqueueMutation(db,tenant,"variant",variant,{product_id:product,name:"Nuevo nombre",price:120,cost:60,code:"CAF-NEW",stock:74,low_stock_threshold:null,active:true});
  }});
  await pushNow(db,tenant,{force:true});
  expect((await db.query<{status:string}>("SELECT status FROM sync_log WHERE id=$1",[variant])).rows[0].status).toBe("pending");
  await resetInFlight(db,tenant);
  // Observe the old commit ACK before the subsequent regular mutation ACK.
  const original=globalThis.fetch;
  vi.stubGlobal("fetch",async(url:string,init:RequestInit)=>{
    if(url.endsWith("/mutations")) {
      expect((await db.query<{status:string}>("SELECT status FROM sync_log WHERE id=$1",[variant])).rows[0].status).toBe("in_flight");
      expect(JSON.parse(init.body as string).mutations[0].payload).toMatchObject({name:"Nuevo nombre",cost:60,code:"CAF-NEW"});
    }
    return original(url,init);
  });
  await pushNow(db,tenant,{force:true});
  expect(s.committed).toBe(1);
  expect((await db.query<{status:string}>("SELECT status FROM sync_log WHERE id=$1",[variant])).rows[0].status).toBe("pending");
  await pushNow(db,tenant,{force:true}); // at most one attempt per UUID per drain
  const row=(await db.query<{payload:unknown;status:string}>("SELECT payload,status FROM sync_log WHERE id=$1",[variant])).rows[0];
  expect(row).toMatchObject({status:"synced",payload:{name:"Nuevo nombre",cost:60,code:"CAF-NEW"}});
});

it("invalid sale is isolated and accessible, independent catalog drains; close cannot overtake it",async()=>{
  await db.query("UPDATE sync_log SET payload=jsonb_set(payload,'{total}','-1') WHERE entity='ticket'");
  await createLocalProduct(db,tenant,{name:"Otro",variant:{name:"Único",price:200,stock:0}});
  const s=server();
  for(let i=0;i<3;i++)await pushNow(db,tenant,{force:true});
  expect((await db.query("SELECT id FROM sync_log WHERE entity='ticket' AND status='poison' AND last_error LIKE 'validation:%'")).rows).toHaveLength(1);
  expect((await db.query("SELECT id FROM sync_log WHERE entity='product' AND status='synced'")).rows).toHaveLength(2);
  expect(s.committed).toBe(0);
});

it("many unavailable snapshots do not starve independent catalog or allow cash close to overtake sales",async()=>{
  const rows=(await db.query("SELECT * FROM sync_log WHERE status='pending'")).rows;
  for(let i=0;i<12;i++) await saveSaleSnapshot(db,tenant,rows);
  await createLocalProduct(db,tenant,{name:"Independiente",variant:{name:"Único",price:200,stock:0}});
  const shift=(await db.query<{id:string}>("SELECT id FROM shifts LIMIT 1")).rows[0].id;
  await enqueueMutation(db,tenant,"closedcash",crypto.randomUUID(),{shift_id:shift,expected:2600,counted:2600,diff:0});
  vi.stubGlobal("fetch",async(url:string,init:RequestInit)=>{
    if(url.includes("/sales/")) return Response.json({error:"not_found"},{status:404});
    const body=JSON.parse(init.body as string);
    expect(body.mutations.some((m:MutationEnvelope)=>m.entity==="closedcash")).toBe(false);
    return Response.json({results:body.mutations.map((m:MutationEnvelope)=>({client_uuid:m.client_uuid,status:"applied"}))});
  });
  await pushNow(db,tenant,{force:true});
  expect((await db.query("SELECT id FROM sync_log WHERE entity='product' AND status='synced'")).rows).toHaveLength(2);
  expect((await db.query("SELECT id FROM sync_log WHERE entity='closedcash' AND status='pending'")).rows).toHaveLength(1);
  expect((await db.query("SELECT operation_id FROM sync_sale_outbox WHERE last_attempt IS NOT NULL")).rows).toHaveLength(1);
  await pushNow(db,tenant,{force:true});
  expect((await db.query("SELECT operation_id FROM sync_sale_outbox WHERE last_attempt IS NOT NULL")).rows).toHaveLength(2);
});

it("additive migration preserves pending snapshot and versions in the existing datadir",async()=>{
  const rows=(await db.query("SELECT * FROM sync_log WHERE status='pending'")).rows;
  const operation=await saveSaleSnapshot(db,tenant,rows);
  await db.exec(SALE_OUTBOX_MIGRATION_SQL);
  await db.exec(SALE_OUTBOX_MIGRATION_SQL);
  expect((await db.query("SELECT rows FROM sync_sale_outbox WHERE operation_id=$1",[operation])).rows[0]).toEqual({rows:JSON.parse(JSON.stringify(rows))});
  expect((await db.query("SELECT * FROM sync_log WHERE status='pending'")).rows).toEqual(rows);
});

it("orders catalog/shift/variant dependencies across upsert-latest sale groups and includes unsent initial inventory",()=>{
  const row=(id:string,entity:string,payload:unknown)=>({id,client_uuid:id,entity,payload});
  const groups=groupQueue([
    row("early","ticket",{shift_id:"shift"}),row("early-line","ticket_line",{ticket_id:"early",variant_id:"v"}),
    row("initial","stockdiary",{variant_id:"v",reason:"initial"}),
    row("late","ticket",{shift_id:"shift"}),row("v","variant",{product_id:"p",ref_ticket_id:"late"}),
    row("p","product",{}),row("shift","shift",{status:"open"}),
  ]);
  expect(groups.map(g=>g.map(r=>r.id))).toEqual([["shift"],["p"],["initial","late","v"],["early","early-line"]]);
});

it("customer-before-sale ordering", async () => {
  await db.query("UPDATE sync_log SET status='synced'");
  const customer = await createLocalCustomer(db, tenant, { name: "Offline", credit_limit: 10000 });
  await commitLocalSale(db, tenant, { method: "credit", customerId: customer.id, cashAmount: 0,
    lines: Array.from({ length: 26 }, () => ({ variant_id: variant, qty: 1, unit_price: 100 })) });
  const rows = (await db.query<{ id:string;client_uuid:string;entity:string;payload:unknown }>("SELECT * FROM sync_log WHERE status='pending' ORDER BY client_ts")).rows;
  const groups = groupQueue(rows);
  expect(groups[0].map(r => r.entity)).toEqual(["customer"]);
  expect(groups[1].length).toBeGreaterThan(50);
  expect(groups[1].some(r => r.entity === "customer")).toBe(false);
  let customerApplied = false, parts = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (url.endsWith("/mutations")) {
      expect(body.mutations.map((m: MutationEnvelope) => m.entity)).toEqual(["customer"]);
      customerApplied = true;
      return Response.json({ results: body.mutations.map((m: MutationEnvelope) => ({ client_uuid: m.client_uuid, status: "applied" })) });
    }
    expect(customerApplied).toBe(true);
    if (url.endsWith("/parts")) {
      parts++;
      expect(body.mutations.some((m: MutationEnvelope) => m.entity === "customer")).toBe(false);
      return Response.json({ staged: true });
    }
    const snapshot = (await db.query<{rows: Array<{client_uuid:string}>}>("SELECT rows FROM sync_sale_outbox")).rows[0].rows;
    return Response.json({ results: snapshot.map(m => ({ client_uuid: m.client_uuid, status: "applied" })) });
  });
  await pushNow(db, tenant, { force: true });
  expect(parts).toBe(2);
  expect((await db.query("SELECT * FROM sync_log WHERE status<>'synced'")).rows).toEqual([]);
});
