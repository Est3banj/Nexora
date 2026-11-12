import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { openLocalDb } from "../src/db/pglite";
import { openLocalShift, closeLocalShift, computeLocalExpected, registerLocalCashMovement, listLocalCashMovements, clearLocalBusinessData, hasPendingShiftEvidence, mirrorServerClose, listLocalClosedCash } from "../src/db/local";
import { claimLocal } from "../src/db/preservation";
import { rehydrateFromServer } from "../src/sync/rehydrate";
import { pushNow, stopSync } from "../src/sync/queue";
import { groupQueue } from "../src/sync/batch";

const tenant = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
beforeEach(async () => { db = (await openLocalDb({ url: "memory://", locks: null }))!.db; await claimLocal(db, tenant); });
afterEach(async () => { await stopSync(); vi.unstubAllGlobals(); await db.close(); });

it.each(["legacy_v1", "drawer_cash_v2"] as const)("%s nonzero base, movements, methods, note and close envelope survive schema reopen", async calculation_version => {
  const shift = await openLocalShift(db, tenant, { opening_cash: 10000, opened_by: tenant, calculation_version });
  for (const [method, amount] of [["cash",5000],["transfer",9000],["credit",20000]] as const) {
    await db.query(`INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,shift_id,method,amount,status)
      VALUES($1,$2,$1,$3,$4,$5,$6,'confirmed')`, [crypto.randomUUID(), tenant, crypto.randomUUID(), shift.id, method, amount]);
  }
  for (const [method, amount] of [["cash",2000],["transfer",3000]] as const) {
    await db.query(`INSERT INTO credit_abonos(id,tenant_id,client_uuid,customer_id,shift_id,method,amount)
      VALUES($1,$2,$1,$3,$4,$5,$6)`, [crypto.randomUUID(),tenant,crypto.randomUUID(),shift.id,method,amount]);
  }
  await registerLocalCashMovement(db, tenant, { direction: "in", amount: 1000, reason: "Ingreso" });
  await registerLocalCashMovement(db, tenant, { direction: "out", amount: 3000, reason: "Retiro", note: "Proveedor" });
  const expected = calculation_version === "drawer_cash_v2" ? 15000 : 16000;
  expect(await computeLocalExpected(db, tenant, shift.id)).toMatchObject({ expected, transfers: 9000, abonos: 2000 });
  const close = await closeLocalShift(db, tenant, { counted: expected, closingNote: "Sin novedad" });
  expect(close.closedcash).toMatchObject({ closing_note: "Sin novedad", calculation_version, diff: 0 });
  const before = (await db.query("SELECT * FROM closedcash")).rows;
  const { LOCAL_SCHEMA_SQL } = await import("@pos/shared");
  await db.exec(LOCAL_SCHEMA_SQL);
  expect((await db.query("SELECT * FROM closedcash")).rows).toEqual(before);
  const queuedShift = (await db.query<{ payload: Record<string, unknown> }>("SELECT payload FROM sync_log WHERE entity='shift'")).rows[0].payload;
  expect(queuedShift).toMatchObject({ status: "closed", opening_cash: 10000, opened_by: tenant, calculation_version });
  await expect(registerLocalCashMovement(db, tenant, { direction: "in", amount: 1, reason: "late" })).rejects.toThrow("SHIFT_REQUIRED");
  await expect(clearLocalBusinessData(db)).rejects.toThrow("unacknowledged_local_work");
  expect(await listLocalCashMovements(db, tenant, shift.id)).toHaveLength(2);
  expect(await listLocalCashMovements(db, other, shift.id)).toEqual([]);
});

it("new opens activate v2, invalid amounts/reasons/base roll back without money or queue rows", async () => {
  await expect(openLocalShift(db, tenant, { opening_cash: -1 })).rejects.toThrow();
  expect((await db.query("SELECT * FROM shifts")).rows).toEqual([]);
  const shift = await openLocalShift(db, tenant);
  expect(shift.calculation_version).toBe("drawer_cash_v2");
  for (const amount of [0,-1,1.5,2147483648])
    await expect(registerLocalCashMovement(db, tenant, { amount, direction: "in", reason: "Ingreso" })).rejects.toThrow();
  await expect(registerLocalCashMovement(db, tenant, { amount: 10, direction: "out", reason: " " })).rejects.toThrow();
  expect(await listLocalCashMovements(db, tenant, shift.id)).toEqual([]);
  expect((await db.query("SELECT * FROM sync_log")).rows).toHaveLength(1);
});

it("M8 pinned prototype money: 150000 base + 185000 cash = 335000, 72000 transfer stays separate; invalid closes write nothing", async () => {
  await expect(registerLocalCashMovement(db, tenant, { direction: "in", amount: 1, reason: "No shift" })).rejects.toThrow("SHIFT_REQUIRED");
  for (const opening_cash of [-1, 0.5, 2147483648, NaN])
    await expect(openLocalShift(db, tenant, { opening_cash })).rejects.toThrow();
  const shift = await openLocalShift(db, tenant, { opening_cash: 150000 });
  for (const [method, amount] of [["cash",185000],["transfer",72000]] as const)
    await db.query(`INSERT INTO payments(id,tenant_id,client_uuid,ticket_id,shift_id,method,amount,status) VALUES($1,$2,$1,$3,$4,$5,$6,'confirmed')`, [crypto.randomUUID(),tenant,crypto.randomUUID(),shift.id,method,amount]);
  expect(await computeLocalExpected(db, tenant, shift.id)).toMatchObject({ expected: 335000, transfers: 72000, opening_cash: 150000 });
  for (const counted of [-1, 0.5, 2147483648, NaN])
    await expect(closeLocalShift(db, tenant, { counted })).rejects.toThrow("NEGATIVE_COUNTED");
  expect(await listLocalClosedCash(db, tenant)).toEqual([]);
  expect((await db.query("SELECT * FROM sync_log WHERE entity='closedcash'")).rows).toEqual([]);
  await registerLocalCashMovement(db, tenant, { direction: "in", amount: 10000, reason: "Cambio" });
  await registerLocalCashMovement(db, tenant, { direction: "out", amount: 3000, reason: "Proveedor" });
  const close = await closeLocalShift(db, tenant, { counted: 342000, closingNote: "M8 revisado" });
  expect(close.closedcash).toMatchObject({ expected: 342000, diff: 0, closing_note: "M8 revisado" });
  expect(await listLocalClosedCash(db, tenant)).toEqual([expect.objectContaining({ sync_pending: true })]);
});

it("M8 online canonical snapshot retains original server timestamp, note, version and figures without recalculation on replay", async () => {
  const shift = await openLocalShift(db, tenant, { opening_cash: 150000 });
  const row = { id: crypto.randomUUID(), shift_id: shift.id, expected: 123, counted: 120, diff: -3,
    closing_note: "Canónico", calculation_version: "legacy_v1", created_at: "2025-01-01T12:00:00.000Z" };
  await mirrorServerClose(db, tenant, row);
  const original = (await db.query<{ created_at: string }>("SELECT * FROM closedcash")).rows;
  expect(new Date(original[0].created_at).toISOString()).toBe(row.created_at);
  expect(await listLocalClosedCash(db, tenant)).toEqual([expect.objectContaining({ expected: 123, diff: -3, closing_note: "Canónico", calculation_version: "legacy_v1", sync_pending: false })]);
  await mirrorServerClose(db, tenant, { ...row, expected: 999, closing_note: "No sobrescribir" });
  expect((await db.query("SELECT * FROM closedcash")).rows).toEqual(original);
});

it("explicit close dependency ignores timestamp skew and poison movement blocks close until ACK, then canonical ACK wins", async () => {
  const shift = await openLocalShift(db, tenant, { opening_cash: 10000 });
  const m = await registerLocalCashMovement(db, tenant, { amount: 1000, direction: "in", reason: "Ingreso" });
  await closeLocalShift(db, tenant, { counted: 11000, closingNote: "Local" });
  await db.query("UPDATE sync_log SET client_ts=1 WHERE entity='closedcash'");
  const groups = groupQueue((await db.query<{ id: string; entity: string; client_uuid: string; payload: unknown }>("SELECT * FROM sync_log ORDER BY client_ts")).rows);
  expect(groups.findIndex(g => g.some(r => r.entity === "cash_movement"))).toBeLessThan(groups.findIndex(g => g.some(r => r.entity === "closedcash")));
  await db.query("UPDATE sync_log SET status='poison' WHERE client_uuid=$1", [m.id]);
  expect(await hasPendingShiftEvidence(db, tenant, shift.id)).toBe(true);
  const sent: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { mutations } = JSON.parse(init.body as string);
    sent.push(...mutations.map((r: { entity: string }) => r.entity));
    return Response.json({ results: mutations.map((r: { client_uuid: string; entity: string }) => ({ client_uuid: r.client_uuid, status: "applied",
      ...(r.entity === "closedcash" ? { closedcash: { shift_id: shift.id, expected: 12000, counted: 11000, diff: -1000,
        calculation_version: "drawer_cash_v2", closing_note: "Servidor" } } : {}) })) });
  }));
  await pushNow(db, tenant, { force: true });
  expect(sent).not.toContain("closedcash");
  await db.query("UPDATE sync_log SET status='pending' WHERE client_uuid=$1", [m.id]);
  await pushNow(db, tenant, { force: true });
  expect(sent.indexOf("cash_movement")).toBeLessThan(sent.indexOf("closedcash"));
  expect(await hasPendingShiftEvidence(db, tenant, shift.id)).toBe(false);
  expect((await db.query("SELECT expected,counted,diff,calculation_version,closing_note FROM closedcash")).rows[0])
    .toEqual({ expected: 12000, counted: 11000, diff: -1000, calculation_version: "drawer_cash_v2", closing_note: "Servidor" });
});

it("paged fresh-device reconstruction retains legacy/v2 history and movements, retry creates no queue/duplicates", async () => {
  const stamp = { created_at: "2026-11-11T12:00:00.000Z", updated_at: "2026-11-11T12:00:00.000Z" };
  const shifts = [0,1].map(i => ({ id: crypto.randomUUID(), status: "closed", opened_at: stamp.created_at,
    closed_at: stamp.updated_at, opening_cash: i ? 10000 : 0, opened_by: i ? tenant : null,
    calculation_version: i ? "drawer_cash_v2" : "legacy_v1", ...stamp }));
  const closes = shifts.map((s,i) => ({ id: crypto.randomUUID(), shift_id: s.id, expected: i ? 15000 : 24000,
    counted: i ? 15000 : 23000, diff: i ? 0 : -1000, calculation_version: s.calculation_version, closing_note: i ? "Revisado" : null, ...stamp }));
  const moves = shifts.map(s => ({ id: crypto.randomUUID(), shift_id: s.id, direction: "in", amount: 1000, reason: "Ingreso", ...stamp }));
  const fetchFn = async (url: string) => {
    const i = Number(new URL(url,"http://local").searchParams.get("offset"));
    return Response.json({ shifts: [shifts[i]], closedcash: [closes[i]], cash_movements: [moves[i]], next_offset: i ? null : 1 });
  };
  for (let i=0;i<2;i++) await rehydrateFromServer(db, tenant, { pageSize: 1, fetchFn });
  expect((await db.query("SELECT * FROM shifts")).rows).toHaveLength(2);
  expect((await db.query("SELECT * FROM cash_movements")).rows).toHaveLength(2);
  const rows = (await db.query("SELECT expected,counted,diff,calculation_version,closing_note FROM closedcash ORDER BY expected")).rows;
  expect(rows).toEqual([
    { expected: 15000, counted: 15000, diff: 0, calculation_version: "drawer_cash_v2", closing_note: "Revisado" },
    { expected: 24000, counted: 23000, diff: -1000, calculation_version: "legacy_v1", closing_note: null },
  ]);
  expect((await db.query("SELECT * FROM sync_log")).rows).toEqual([]);
});
