import type { PGlite } from "@electric-sql/pglite";
import {
  MUTATION_BATCH_MAX,
  mutationEnvelopeSchema,
  syncPushResponseSchema,
  type MutationEnvelope,
  type SyncResult,
  SALE_OUTBOX_MIGRATION_SQL,
} from "@pos/shared";
import { saveSaleSnapshot, uploadSaleSnapshot, SaleUploadError } from "./sale-upload";
import { getSyncState, patchSync, writeLastSync, readLastSync } from "./store";
import { pullVoidedSale } from "../db/void-sale";
import { groupQueue } from "./batch";
import { scopedFetch } from "./scoped-fetch";

/**
 * Client sync queue (task D2-2 / D2-5, design §3 + §6).
 *
 * - drain in `client_ts` order, batch ≤50, statuses
 *   pending → in_flight → synced | failed → poison
 * - boot reset: `in_flight` → `pending` (crash mid-push retried with the
 *   SAME uuid — server idempotency makes that a `duplicate` ack)
 * - `online` event + manual retry force-drain; post-commit push respects
 *   per-entry exponential backoff for previously failed entries
 * - deterministic rejections (validation / conflict_hash_mismatch) promote
 *   to `poison` after MAX_ATTEMPTS: isolated, visible, preserved — they
 *   can never stall the rest of the queue (sync §Partial batch failure)
 * - transport failures NEVER poison: they are retryable by definition
 */

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const MAX_DRAIN_ROUNDS = 10;
const RETRY_TIMER_MS = 4_000;

type QueueRow = {
  id: string;
  client_uuid: string;
  entity: string;
  op: string;
  payload: unknown;
  client_ts: number;
  attempts: number;
  status: string;
  updated_at: string | Date;
  last_error: string | null;
};

type Active = { db: PGlite; tenantId: string };

let active: Active | null = null;
let generation = 0;
let draining = false;
let drainTask: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

function online(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function eligible(row: QueueRow, force: boolean, now: number): boolean {
  if (row.status === "pending") return true;
  if (row.status !== "failed") return false;
  if (force) return true;
  return now - new Date(row.updated_at).getTime() >= backoffMs(row.attempts);
}

const SELECT_BATCH = `
  SELECT id, client_uuid, entity, op, payload, client_ts, attempts, status,
         updated_at, last_error
  FROM sync_log
  WHERE tenant_id = $1 AND status IN ('pending', 'failed')
   ORDER BY client_ts ASC, created_at ASC`;

async function markInFlight(db: PGlite, row: QueueRow): Promise<void> {
  await db.query(
    `UPDATE sync_log SET status = 'in_flight', updated_at = now()
     WHERE id = $1 AND client_ts = $2 AND payload = $3::jsonb`,
    [row.id, row.client_ts, JSON.stringify(row.payload)],
  );
}

async function markSynced(db: PGlite, row: QueueRow): Promise<void> {
  await db.query(
    `UPDATE sync_log
     SET status = 'synced', attempts = 0, last_error = NULL, updated_at = now()
      WHERE id = $1 AND client_ts = $2 AND payload = $3::jsonb`,
    [row.id, row.client_ts, JSON.stringify(row.payload)],
  );
}

/**
 * `deterministic` = the server (or our own validation) rejected the content:
 * retrying can never succeed → attempts climb and, at MAX_ATTEMPTS, the
 * entry becomes `poison` (excluded from auto-retry, visible + preserved).
 */
async function markFailure(
  db: PGlite,
  row: QueueRow,
  message: string,
  deterministic: boolean,
): Promise<void> {
  const attempts = row.attempts + 1;
  const status = deterministic && attempts >= MAX_ATTEMPTS ? "poison" : "failed";
  await db.query(
    `UPDATE sync_log
     SET status = $2, attempts = $3, last_error = $4, updated_at = now()
      WHERE id = $1 AND client_ts = $5 AND payload = $6::jsonb`,
    [row.id, status, attempts, message.slice(0, 500), row.client_ts, JSON.stringify(row.payload)],
  );
}

/** Recompute the badge counts from sync_log and publish them. */
export async function refreshSyncStatus(db: PGlite, tenantId: string): Promise<void> {
  const res = await db.query<{
    pending: string;
    failed: string;
    poison: string;
    in_flight: string;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'pending') AS pending,
            count(*) FILTER (WHERE status = 'failed') AS failed,
            count(*) FILTER (WHERE status = 'poison') AS poison,
            count(*) FILTER (WHERE status = 'in_flight') AS in_flight
     FROM sync_log WHERE tenant_id = $1`,
    [tenantId],
  );
  const row = res.rows[0];
  const pending =
    Number(row?.pending ?? 0) + Number(row?.failed ?? 0) + Number(row?.in_flight ?? 0);
  patchSync({
    pending,
    failed: Number(row?.failed ?? 0),
    poison: Number(row?.poison ?? 0),
    inFlight: Number(row?.in_flight ?? 0),
    online: online(),
  });
}

/** Crash recovery (design §6): entries left `in_flight` are pending again. */
export async function resetInFlight(db: PGlite, tenantId: string): Promise<void> {
  await db.query(
    `UPDATE sync_log SET status = 'pending', updated_at = now()
     WHERE tenant_id = $1 AND status = 'in_flight'`,
    [tenantId],
  );
}

/** One round: validate → mark in_flight → POST → apply per-result statuses. */
async function drainOnce(
  db: PGlite,
  tenantId: string,
  force: boolean,
  attempted: Set<string>,
): Promise<{ synced: number; handled: number }> {
  await db.exec(SALE_OUTBOX_MIGRATION_SQL);
  // Resume immutable operations first, even when a newer queue payload now
  // references another sale. ACK comparisons below preserve those edits.
  const snapshots = await db.query<{ operation_id: string; rows: QueueRow[] }>("SELECT operation_id,rows FROM sync_sale_outbox WHERE tenant_id=$1 ORDER BY coalesce(last_attempt,created_at)", [tenantId]);
  const snapshotMembers = new Set(snapshots.rows.flatMap(s=>s.rows.map(r=>r.id)));
  for (const snapshot of snapshots.rows) {
    if (attempted.has("sale_snapshot_retry")) break;
    if (snapshot.rows.some(r => attempted.has(r.id))) continue;
    attempted.add("sale_snapshot_retry");
    await db.query("UPDATE sync_sale_outbox SET last_attempt=now() WHERE tenant_id=$1 AND operation_id=$2",[tenantId,snapshot.operation_id]);
    return drainSale(db, tenantId, snapshot.rows, snapshot.operation_id, attempted);
  }
  const sel = await db.query<QueueRow>(SELECT_BATCH, [tenantId]);
  const now = Date.now();
  const candidates: QueueRow[] = [];
  for (const group of groupQueue(sel.rows)) {
    if (group.some(r => snapshotMembers.has(r.id) || attempted.has(r.id) || !eligible(r, force, now))) continue;
    // A close cannot overtake an unresolved sale (including poison). Other
    // independent catalog/sale groups continue draining normally.
    if (group.some(r => r.entity === "closedcash")) {
      const close = group.find(r => r.entity === "closedcash");
      if (close) {
        const shiftId = (close.payload as { shift_id: string }).shift_id;
        if (snapshots.rows.some(s => s.rows.some(r => (r.payload as { shift_id?: string }).shift_id === shiftId))) continue;
        const pending = await db.query(`SELECT id FROM sync_log WHERE tenant_id=$1 AND status <> 'synced'
          AND ((entity IN ('ticket','payment','credit_abono','cash_movement') AND payload->>'shift_id'=$2)
            OR (entity='shift' AND client_uuid=$2::uuid)) LIMIT 1`, [tenantId, shiftId]);
        if (pending.rows.length) continue;
      }
    }
    if (group.length > MUTATION_BATCH_MAX) {
      if (candidates.length) break;
      if (group.some(row => !mutationEnvelopeSchema.safeParse({ ...row, client_ts: Number(row.client_ts) }).success)) {
        for (const row of group) { attempted.add(row.id); await markFailure(db, row, "validation: invalid_sale_group", true); }
        continue;
      }
      const operation = await saveSaleSnapshot(db, tenantId, group);
      return drainSale(db, tenantId, group, operation, attempted);
    }
    if (candidates.length + group.length > MUTATION_BATCH_MAX) break;
    // Invalid member rejects the whole sale locally, rather than sending half.
    if (group.some(row => !mutationEnvelopeSchema.safeParse({ ...row, client_ts: Number(row.client_ts) }).success)) {
      for (const row of group) { attempted.add(row.id); await markFailure(db, row, "validation: invalid_sale_group", true); }
      continue;
    }
    candidates.push(...group);
  }
  if (candidates.length === 0) return { synced: 0, handled: 0 };

  const send: MutationEnvelope[] = [];
  const sendRows: QueueRow[] = [];
  let handled = 0;
  for (const row of candidates) {
    attempted.add(row.id);
    const parsed = mutationEnvelopeSchema.safeParse({
      client_uuid: row.client_uuid,
      client_ts: row.client_ts,
      entity: row.entity,
      op: row.op,
      payload: row.payload,
    });
    if (parsed.success) {
      send.push(parsed.data);
      sendRows.push(row);
    } else {
      // client-side pre-validation: an invalid entry is skipped locally and
      // never blocks the valid ones behind it in the batch
      const msg = `validation: ${parsed.error.issues[0]?.message ?? "invalid"}`;
      await markFailure(db, row, msg, true);
      handled += 1;
    }
  }
  if (send.length === 0) return { synced: 0, handled };

  for (const row of sendRows) await markInFlight(db, row);

  let results: SyncResult[];
  try {
    const res = await scopedFetch(tenantId, "/api/sync/mutations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutations: send }),
    });
    if (!res.ok) throw new Error(`server_${res.status}`);
    results = syncPushResponseSchema.parse(await res.json()).results;
  } catch (err) {
    // transport / server failure → whole batch stays retryable (never poison)
    const msg = err instanceof Error ? err.message : String(err);
    for (const row of sendRows) await markFailure(db, row, msg, false);
    await refreshSyncStatus(db, tenantId);
    patchSync({ syncing: false, error: msg });
    scheduleRetry();
    return { synced: 0, handled: sendRows.length };
  }

  let synced = 0;
  const byUuid = new Map(
    results.filter((r) => r.client_uuid).map((r) => [r.client_uuid as string, r]),
  );
  for (const row of sendRows) {
    const result = byUuid.get(row.client_uuid);
    if (!result) {
      await markFailure(db, row, "missing_result", false);
      continue;
    }
    if (result.voided_ticket) {
      try { await pullVoidedSale(db, tenantId, result.voided_ticket); }
      catch { await markFailure(db, row, "canonical_mirror_failed", false); continue; }
    }
    if (result.status === "applied" || result.status === "duplicate") {
      if (result.closedcash) {
        const c = result.closedcash;
        await db.query(`UPDATE closedcash SET expected=$3,counted=$4,diff=$5,
          calculation_version=coalesce($6,calculation_version),closing_note=CASE WHEN $7 THEN $8 ELSE closing_note END
          WHERE tenant_id=$1 AND shift_id=$2`, [tenantId, c.shift_id, c.expected, c.counted, c.diff, c.calculation_version ?? null,
          c.closing_note !== undefined, c.closing_note ?? null]);
      }
      // ACK only the version actually sent. An in-flight catalog edit keeps
      // its newer pending payload and will be drained on the next push.
      await markSynced(db, row);
      synced += 1;
    } else if (result.reason === "db_error") {
      // transient-ish (constraint race): retryable, not poison
      await markFailure(db, row, "db_error", false);
    } else {
      await markFailure(db, row, result.reason ?? "rejected", true);
    }
    handled += 1;
  }

  if (synced > 0) writeLastSync(tenantId);
  await refreshSyncStatus(db, tenantId);
  patchSync({ error: null });
  return { synced, handled };
}

async function drainSale(db: PGlite, tenantId: string, rows: QueueRow[], operation: string, attempted: Set<string>) {
  for (const row of rows) { attempted.add(row.id); await markInFlight(db, row); }
  try {
    const results = await uploadSaleSnapshot(db, tenantId, operation);
    const acknowledged = new Set(results.map(r=>r.client_uuid));
    if (results.length !== rows.length || acknowledged.size !== rows.length || rows.some(r=>!acknowledged.has(r.client_uuid)) || results.some(r => r.status === "rejected")) throw new Error("sale_commit_not_acknowledged");
    // One local transaction: receipt ACK and outbox removal survive reload as
    // a unit. SQL version+payload guard prevents old ACK overwriting new edits.
    for (const result of results) if (result.voided_ticket) await pullVoidedSale(db, tenantId, result.voided_ticket);
    await db.transaction(async tx => {
      for (const row of rows) await tx.query("UPDATE sync_log SET status='synced',attempts=0,last_error=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND client_ts=$3 AND payload=$4::jsonb", [tenantId, row.id, row.client_ts, JSON.stringify(row.payload)]);
      await tx.query("DELETE FROM sync_sale_outbox WHERE tenant_id=$1 AND operation_id=$2", [tenantId, operation]);
    });
    writeLastSync(tenantId);
    return { synced: rows.length, handled: rows.length };
  } catch (err) {
    const deterministic = err instanceof SaleUploadError && err.deterministic;
    const message = err instanceof Error ? err.message : String(err);
    for (const row of rows) await markFailure(db, row, message, deterministic);
    // Even an invalid snapshot is unacknowledged business evidence. Keep it
    // durable: a later edit must never make its older sale disappear.
    patchSync({ error: message });
    return { synced: 0, handled: rows.length };
  }
}

function scheduleRetry(): void {
  if (retryTimer || typeof window === "undefined") return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const a = active;
    if (a && online() && getSyncState().pending > 0) {
      void pushNow(a.db, a.tenantId);
    }
  }, RETRY_TIMER_MS);
}

/**
 * Drain the queue. `force` bypasses per-entry backoff (online event,
 * manual retry, boot). Concurrent calls join the running drain, including its
 * ACK writes. Every row is attempted at most once per run
 * (the `attempted` set), so the loop always terminates.
 */
export async function pushNow(
  db: PGlite,
  tenantId: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (drainTask) return drainTask;
  const task = drain(db, tenantId, opts);
  drainTask = task;
  try { await task; } finally { if (drainTask === task) drainTask = null; }
}

async function drain(db: PGlite, tenantId: string, opts: { force?: boolean }): Promise<void> {
  if (!online()) {
    await refreshSyncStatus(db, tenantId);
    return;
  }
  if (draining) return;
  draining = true;
  patchSync({ syncing: true });
  try {
    const attempted = new Set<string>();
    for (let i = 0; i < MAX_DRAIN_ROUNDS; i++) {
      const { handled } = await drainOnce(
        db,
        tenantId,
        opts.force ?? false,
        attempted,
      );
      if (handled === 0) break;
    }
    await refreshSyncStatus(db, tenantId);
    if (getSyncState().pending > 0) scheduleRetry();
  } finally {
    draining = false;
    patchSync({ syncing: false });
  }
}

/**
 * Boot: reset crashed in-flight rows, bind online/offline listeners once,
 * publish status, and auto-push anything already queued (reconnect drain —
 * sync §Automatic sync on reconnect).
 */
export async function initSync(db: PGlite, tenantId: string): Promise<void> {
  const current = ++generation;
  active = { db, tenantId };
  await resetInFlight(db, tenantId);
  if (current !== generation) return;
  patchSync({ lastSync: readLastSync(tenantId) });

  if (!listenersBound && typeof window !== "undefined") {
    listenersBound = true;
    window.addEventListener("online", () => {
      patchSync({ online: true });
      const a = active;
      if (a) void pushNow(a.db, a.tenantId, { force: true });
    });
    window.addEventListener("offline", () => patchSync({ online: false }));
  }

  await refreshSyncStatus(db, tenantId);
  if (current === generation && online()) void pushNow(db, tenantId, { force: true });
}

/** Detach listeners/timers from the old session and await any in-flight ACK. */
export async function stopSync(): Promise<void> {
  generation++;
  active = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (drainTask) await drainTask;
  patchSync({ pending: 0, failed: 0, poison: 0, inFlight: 0, syncing: false, error: null, lastSync: null });
}

/** Manual retry preserves every payload and immutable snapshot. */
export async function retryPoison(db: PGlite, tenantId: string): Promise<number> {
  const res = await db.query<{ id: string }>(
    `UPDATE sync_log SET status='pending', attempts=0 WHERE tenant_id = $1 AND status = 'poison' RETURNING id`,
    [tenantId],
  );
  await refreshSyncStatus(db, tenantId);
  await pushNow(db, tenantId, { force: true });
  return res.rows.length;
}

/**
 * Forced DOUBLE-PUSH hook (D2-9 E2E): re-POSTs already-synced envelopes
 * without touching their status — the server must ack `duplicate` and keep
 * exactly one row (sync §Double-push creates one row).
 */
export async function repushSynced(
  db: PGlite,
  tenantId: string,
  limit = 20,
): Promise<SyncResult[]> {
  const sel = await db.query<QueueRow>(
    `SELECT id, client_uuid, entity, op, payload, client_ts, attempts, status,
            updated_at, last_error
     FROM sync_log
     WHERE tenant_id = $1 AND status = 'synced'
     ORDER BY client_ts DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  if (sel.rows.length === 0) return [];
  const envelopes = sel.rows.map((row) =>
    mutationEnvelopeSchema.parse({
      client_uuid: row.client_uuid,
      client_ts: row.client_ts,
      entity: row.entity,
      op: row.op,
      payload: row.payload,
    }),
  );
  const res = await scopedFetch(tenantId, "/api/sync/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mutations: envelopes }),
  });
  if (!res.ok) throw new Error(`server_${res.status}`);
  return syncPushResponseSchema.parse(await res.json()).results;
}
