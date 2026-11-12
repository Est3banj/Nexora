import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { mutationEnvelopeSchema, saleDigest, type MutationEnvelope, type SaleManifest } from "@pos/shared";
import { db, pool, closeDb } from "../src/db";
import { scopedRepo } from "../src/db/scope";
import { closeShift, computeExpected } from "../src/db/arqueo";
import { getAuth } from "../src/auth/auth";
import { authHeaders, buildTestApp, createTenant, resetTables, type Actor } from "./helpers";

let app: FastifyInstance;
let owner: Actor;
let repo: ReturnType<typeof scopedRepo>;
beforeAll(async () => { app = await buildTestApp(); });
afterAll(async () => { await app.close(); await closeDb(); });
beforeEach(async () => {
  await resetTables(); owner = await createTenant(app, { email: "stage@test.dev", orgSlug: "stage" }); repo = scopedRepo(db, owner.orgId);
});
async function fixture() {
  const shift = await repo.shifts.createOpen();
  const { product, variant } = await repo.catalog.createProduct({ name: "Café", photo: "data:image/png;base64,aGVsbG8=", variant: { name: "Único", price: 100, cost: 40, code: "CAF-1", stock: 100 } });
  const ticket = randomUUID();
  const env = (entity: string, payload: unknown, client_uuid: string = randomUUID()) => mutationEnvelopeSchema.parse({ entity, payload, client_uuid, client_ts: Date.now(), op: "upsert" });
  const items: MutationEnvelope[] = [
    env("ticket", { shift_id: shift.id, ticket_no: 1, status: "completed", total: 2600 }, ticket),
    ...Array.from({ length: 26 }, () => env("ticket_line", { ticket_id: ticket, variant_id: variant.id, qty: 1, unit_price: 100, subtotal: 100 })),
    env("payment", { ticket_id: ticket, shift_id: shift.id, method: "cash", status: "confirmed", amount: 2600, tendered: 3000, vuelto: 400 }),
    ...Array.from({ length: 26 }, () => env("stockdiary", { ref_ticket_id: ticket, variant_id: variant.id, reason: "sale", delta: -1 })),
    env("variant", { product_id: product.id, name: "Único", price: 100, stock: 74, low_stock_threshold: null, active: true, ref_ticket_id: ticket }, variant.id),
  ];
  return { ticket, shift, variant, product, items, ...await plan(items, ticket) };
}
async function plan(items: MutationEnvelope[], ticket: string) {
  const parts = [items.slice(0,50), items.slice(50)];
  const manifest: SaleManifest = { ticket_id: ticket, count: items.length, hash: await saleDigest(items), parts: await Promise.all(parts.map(saleDigest)) };
  return { parts, manifest, operation: randomUUID() };
}
function upload(s: { operation: string; manifest: SaleManifest; parts: MutationEnvelope[][] }, index: number, actor = owner) {
  return app.inject({ method: "POST", url: `/api/sync/sales/${s.operation}/parts`, headers: authHeaders(actor), payload: { manifest: s.manifest, index, mutations: s.parts[index] } });
}
function finalize(s: { operation: string; manifest: SaleManifest }, actor = owner) {
  return app.inject({ method: "POST", url: `/api/sync/sales/${s.operation}/finalize`, headers: authHeaders(actor), payload: s.manifest });
}
async function stage(s: Awaited<ReturnType<typeof fixture>>) { for (let i=0;i<s.parts.length;i++) expect((await upload(s,i)).statusCode).toBe(200); }
async function untouched(s: Awaited<ReturnType<typeof fixture>>) {
  expect(await repo.tickets.byUuid(s.ticket)).toBeUndefined();
  expect(await repo.ticketLines.listByTicket(s.ticket)).toHaveLength(0);
  expect(await repo.payments.listByTicket(s.ticket)).toHaveLength(0);
  expect(await repo.stock.recount(s.variant.id)).toBe(100);
  expect((await repo.productVariants.byUuid(s.variant.id))?.stock).toBe(100);
}

it("55 mutations upload out of order without business effects, finalize response-loss/retry and concurrent commits converge", async () => {
  const s = await fixture();
  expect(s.items).toHaveLength(55);
  expect((await upload(s,1)).statusCode).toBe(200);
  await untouched(s);
  expect((await finalize(s)).json()).toEqual({ error: "sale_incomplete" });
  expect((await upload(s,1)).statusCode).toBe(200); // lost upload response
  expect((await upload(s,0)).statusCode).toBe(200);
  await untouched(s);
  const results = await Promise.all([finalize(s), finalize(s)]);
  expect(results.map(r => r.statusCode)).toEqual([200,200]);
  expect(results[0].json()).toEqual(results[1].json());
  expect((await finalize(s)).statusCode).toBe(200); // lost finalize response
  expect(await repo.ticketLines.listByTicket(s.ticket)).toHaveLength(26);
  expect(await repo.payments.listByTicket(s.ticket)).toHaveLength(1);
  expect(await repo.stock.recount(s.variant.id)).toBe(74);
  expect(await repo.productVariants.byUuid(s.variant.id)).toMatchObject({ stock: 74, cost: 40, code: "CAF-1" });
  expect(await repo.stock.byVariant(s.variant.id)).toMatchObject({ stock: 74 });
  expect(await repo.products.byUuid(s.product.id)).toMatchObject({ photo: s.product.photo });
  expect(await computeExpected(owner.orgId,s.shift.id)).toMatchObject({ cash:2600,expected:2600 });
  expect((await pool.query("SELECT count(*)::int AS n FROM sync_sale_parts")).rows[0].n).toBe(0);
});

it.each(["part", "manifest", "count", "total", "movement", "mixed", "customer", "void"])("rejects altered %s without any business effects", async kind => {
  let s = await fixture();
  if (kind === "part") {
    s.parts[0][0].client_ts++;
    expect((await upload(s,0)).statusCode).toBe(400);
  } else {
    if (kind === "total" && s.items[0].entity === "ticket") s.items[0].payload.total++;
    if (kind === "movement") { const m = s.items.find(m => m.entity === "stockdiary")!; if(m.entity === "stockdiary") m.payload.delta = -2; }
    if (kind === "void") { const m = s.items.find(m => m.entity === "stockdiary")!; if(m.entity === "stockdiary") m.payload.reason = "sale_void"; }
    if (kind === "mixed") s.items.push(mutationEnvelopeSchema.parse({ client_uuid: randomUUID(),client_ts: Date.now(),entity:"product",payload:{name:"Injected",active:true} }));
    if (kind === "customer") s.items.push(mutationEnvelopeSchema.parse({ client_uuid: randomUUID(),client_ts: Date.now(),entity:"customer",payload:{name:"Injected",credit_limit:100000} }));
    s = { ...s, ...await plan(s.items,s.ticket) };
    if (kind === "manifest") s.manifest.hash = "0".repeat(64);
    if (kind === "count") s.manifest.count++;
    await stage(s);
    expect((await finalize(s)).statusCode).toBe(400);
  }
  await untouched(s);
});

it("immutable manifest and part payload cannot be replaced", async () => {
  const s=await fixture(); await upload(s,0);
  s.manifest.hash="a".repeat(64);
  expect((await upload(s,1)).statusCode).toBe(409);
  await untouched(s);
});

it("tenant-scoped receipts/dependencies reveal nothing, auth and revoked membership enforced", async () => {
  const s=await fixture(); await stage(s);
  const other=await createTenant(app,{email:"other-stage@test.dev",orgSlug:"other-stage"});
  expect((await finalize(s,other)).statusCode).toBe(404);
  expect((await upload(s,0,other)).statusCode).toBe(200); // independent namespace
  await upload(s,1,other);
  expect((await finalize(s,other)).statusCode).toBe(404); // foreign dependencies
  const unauth=await app.inject({method:"POST",url:`/api/sync/sales/${s.operation}/finalize`,payload:s.manifest});
  expect(unauth.statusCode).toBe(401);
  await pool.query('DELETE FROM member WHERE "userId"=$1',[owner.userId]);
  expect((await finalize(s)).statusCode).toBe(403);
});

it("member cannot manufacture void through staging; applied sale stays voided on replay", async () => {
  const s=await fixture(); await stage(s); expect((await finalize(s)).statusCode).toBe(200);
  const voided=await app.inject({method:"POST",url:`/api/sales/tickets/${s.ticket}/void`,headers:authHeaders(owner),payload:{reason:"Error de cobro"}});
  expect(voided.statusCode).toBe(200);
  expect((await finalize(s)).statusCode).toBe(200);
  const replay={...s,...await plan(s.items,s.ticket)}; await stage(replay);
  expect((await finalize(replay)).statusCode).toBe(200);
  expect((await repo.tickets.byUuid(s.ticket))?.status).toBe("voided");
  expect(await repo.stock.recount(s.variant.id)).toBe(100);
  const member=await createTenant(app,{email:"stage-member@test.dev",orgSlug:"stage-member"});
  await getAuth().api.addMember({body:{organizationId:owner.orgId,userId:member.userId,role:"member"},headers:new Headers(authHeaders(owner))});
  await app.inject({method:"POST",url:"/api/auth/organization/set-active",headers:authHeaders(member),payload:{organizationId:owner.orgId}});
  const altered=structuredClone(s.items); const movement=altered.find(m=>m.entity==="stockdiary")!;
  if(movement.entity==="stockdiary") {movement.payload.reason="sale_void";movement.payload.delta=1;}
  const attack={...s,...await plan(altered,s.ticket)};
  for(let i=0;i<attack.parts.length;i++) await upload(attack,i,member);
  expect((await finalize(attack,member)).statusCode).toBe(400);
});

it("late offline upload survives shift close without rewriting the financial snapshot", async () => {
  const s=await fixture(); await stage(s);
  await closeShift({tenantId:owner.orgId,shiftId:s.shift.id,counted:0});
  const before = await repo.closedcash.byShift(s.shift.id);
  expect((await finalize(s)).statusCode).toBe(200);
  expect(await repo.closedcash.byShift(s.shift.id)).toEqual(before);
  expect(await repo.stock.recount(s.variant.id)).toBe(74);
});

it("applied receipt survives close and TTL; expired uncommitted upload can resume safely", async () => {
  const s=await fixture(); await upload(s,0);
  await pool.query("UPDATE sync_sale_operations SET created_at=now()-interval '8 days'");
  await upload(s,1); expect((await finalize(s)).statusCode).toBe(409);
  await upload(s,0); expect((await finalize(s)).statusCode).toBe(200);
  await closeShift({tenantId:owner.orgId,shiftId:s.shift.id,counted:2600});
  await pool.query("UPDATE sync_sale_operations SET created_at=now()-interval '8 days'");
  expect((await upload(s,0)).statusCode).toBe(200);
  expect((await finalize(s)).statusCode).toBe(200);
  expect(await repo.closedcash.byShift(s.shift.id)).toMatchObject({expected:2600,diff:0});
  expect(await repo.stock.recount(s.variant.id)).toBe(74);
});

it("late conflict rolls back the ENTIRE sale, including earlier valid upserts", async () => {
  const s=await fixture();
  const line=s.items[1];
  // Poison the ledger only: finalization must roll back other valid rows.
  await pool.query("INSERT INTO sync_log(id,tenant_id,client_uuid,entity,op,payload,status,client_ts) VALUES($1,$2,$1,'ticket_line','upsert',$3,'synced',$4)",[line.client_uuid,owner.orgId,JSON.stringify({...line.payload,qty:999}),line.client_ts+100]);
  await stage(s);
  expect((await finalize(s)).json().error).toContain("sale_rejected:conflict_hash_mismatch");
  await untouched(s);
});

it("first offline sale creates its variant and initial inventory atomically, without dropping catalog fields", async () => {
  let s=await fixture();
  await pool.query("DELETE FROM stockdiary WHERE variant_id=$1",[s.variant.id]);
  await pool.query("DELETE FROM stockcurrent WHERE variant_id=$1",[s.variant.id]);
  await pool.query("DELETE FROM product_variants WHERE id=$1",[s.variant.id]);
  const refresh=s.items.find(m=>m.entity==="variant")!;
  if(refresh.entity==="variant") {refresh.payload.cost=40;refresh.payload.code="CAF-1";}
  s.items.unshift(mutationEnvelopeSchema.parse({entity:"stockdiary",client_uuid:randomUUID(),client_ts:1,payload:{variant_id:s.variant.id,delta:100,reason:"initial"}}));
  s={...s,...await plan(s.items,s.ticket)};
  await stage(s);
  expect(await repo.productVariants.byUuid(s.variant.id)).toBeUndefined();
  expect((await finalize(s)).statusCode).toBe(200);
  expect(await repo.productVariants.byUuid(s.variant.id)).toMatchObject({stock:74,cost:40,code:"CAF-1"});
  expect(await repo.stock.recount(s.variant.id)).toBe(74);
});

it("bounds count, part size/index and tenant pending quota with explicit errors", async()=>{
  const s=await fixture();
  s.manifest.count=2001;
  expect((await upload(s,0)).statusCode).toBe(400);
  s.manifest.count=55;
  const url=`/api/sync/sales/${s.operation}/parts`;
  expect((await app.inject({method:"POST",url,headers:authHeaders(owner),payload:{manifest:s.manifest,index:2,mutations:s.parts[0]}})).statusCode).toBe(400);
  expect((await app.inject({method:"POST",url,headers:authHeaders(owner),payload:{manifest:s.manifest,index:0,mutations:s.items}})).statusCode).toBe(400);
  await pool.query("INSERT INTO sync_sale_operations(tenant_id,operation_id,manifest) SELECT $1,gen_random_uuid(),$2 FROM generate_series(1,32)",[owner.orgId,JSON.stringify(s.manifest)]);
  const response=await upload(s,0);
  expect(response.statusCode).toBe(429);
  expect(response.json()).toEqual({error:"sale_staging_quota"});
  await untouched(s);
});

it("race with cash close freezes one coherent expected amount",async()=>{
  const s=await fixture();await stage(s);
  const [commit,closed]=await Promise.all([finalize(s),closeShift({tenantId:owner.orgId,shiftId:s.shift.id,counted:2600})]);
  expect(commit.statusCode).toBe(200);
  if ("error" in closed) throw new Error(closed.error);
  // Whoever acquires the shift lock first chooses the snapshot boundary:
  // all 26 lines or none, never a partial sale. Late acceptance is now valid.
  expect([0,2600]).toContain(closed.closedcash.expected);
  expect(closed.closedcash.diff).toBe(2600-closed.closedcash.expected);
  expect(await repo.closedcash.byShift(s.shift.id)).toMatchObject(closed.closedcash);
  expect(await repo.stock.recount(s.variant.id)).toBe(74);
  expect((await repo.shifts.expected(s.shift.id)).expected).toBe(2600);
});
