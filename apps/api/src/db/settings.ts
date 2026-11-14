import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { config } from "../config";
import * as t from "./schema";
import type { Db } from "./index";

/**
 * roles-admin 3.3 + 4.1 / design D4 · tenant settings loader + defaults +
 * mapper + annul-code helpers (HMAC/generation, D3).
 *
 * - ABSENT row = all defaults = today's shipped behavior (spec settings
 *   §Absent row = current behavior): fiado on, oversell allowed, no annul
 *   code, blank fiscal identity. Existing tenants change nothing on deploy.
 * - The mapper is an EXPLICIT field pick — never a row spread. `annul_code_hash`
 *   has no line in `toPublicSettings`, so the secret cannot leak even if the
 *   row shape grows (no whitelist footgun: whitelist is the function body).
 * - Reads are tenant-scoped point lookups (PK tenant_id, no index needed);
 *   routes only ever reach this through scopedRepo (scopedRepo-only rule).
 */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Annul-code TTL (roles-admin 3.3). Batch 4 (4.1/4.2) uses it for expiry. */
export const ANNUL_CODE_TTL_MIN = 15;

/**
 * roles-admin 4.1 / design D3 — annul-code helpers (node:crypto only).
 *
 * - 8 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`: I/O/0/1 dropped so a
 *   code can be read aloud without ambiguity (~32⁸ ≈ 1.1×10¹² combos).
 * - `randomInt` is CSPRNG-backed — no Math.random anywhere near a secret.
 * - HMAC-SHA256 keyed with `config.betterAuthSecret`: the code is short
 *   enough that a DB-dump brute force under bare SHA-256 would be cheap;
 *   keying the hash makes an offline attacker need the server secret too
 *   (D3 "Why HMAC over bare SHA-256").
 * - Compare via `timingSafeEqual` with a length guard FIRST — it THROWS on
 *   length mismatch, and a corrupt/truncated stored hash must read as a
 *   mismatch, never as a 500.
 */
export const ANNUL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ANNUL_CODE_LENGTH = 8;

/** Fresh plaintext code — returned to the operator EXACTLY once (D3). */
export function randomAnnulCode(): string {
  let code = "";
  for (let i = 0; i < ANNUL_CODE_LENGTH; i++) {
    code += ANNUL_CODE_ALPHABET[randomInt(ANNUL_CODE_ALPHABET.length)];
  }
  return code;
}

/** `HMAC-SHA256(config.betterAuthSecret, code)` hex — the only stored form. */
export function hmacAnnulCode(code: string): string {
  return createHmac("sha256", config.betterAuthSecret).update(code).digest("hex");
}

/** Constant-time verify of a stored hash against a candidate plaintext. */
export function verifyAnnulCode(storedHash: string, code: string): boolean {
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hmacAnnulCode(code), "hex");
  // Guard BEFORE timingSafeEqual: it throws on unequal lengths, and a
  // malformed stored value must degrade to `mismatch`, not to a 500.
  if (expected.length === 0 || expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/** Hash-free settings payload — the ONLY shape GET /api/settings returns. */
export type PublicSettings = {
  store_name: string | null;
  nit: string | null;
  address: string | null;
  phone: string | null;
  ticket_footer: string | null;
  ticket_prefix: string | null;
  iva_pct: number | null;
  default_credit_limit: number | null;
  allow_negative_stock: boolean;
  require_annul_code: boolean;
  enable_fiado: boolean;
  /** hash present, NEVER the hash itself */
  annul_code_set: boolean;
  annul_code_expires_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
};

/** The 11 writable fields (DDL minus code/audit columns) — PUT body shape. */
export type SettingsPatch = Partial<{
  store_name: string | null;
  nit: string | null;
  address: string | null;
  phone: string | null;
  ticket_footer: string | null;
  ticket_prefix: string | null;
  iva_pct: number | null;
  default_credit_limit: number | null;
  allow_negative_stock: boolean;
  require_annul_code: boolean;
  enable_fiado: boolean;
}>;

/**
 * Absent row = current behavior. Pinned by `settings.test.ts` and mirrored
 * by `apps/web/src/lib/settings.ts` DEFAULT_SETTINGS (cache parse-miss uses
 * the same constants — design D4 client cache note).
 */
export const DEFAULT_SETTINGS: PublicSettings = {
  store_name: null,
  nit: null,
  address: null,
  phone: null,
  ticket_footer: null,
  ticket_prefix: null,
  iva_pct: null,
  default_credit_limit: null,
  allow_negative_stock: true,
  require_annul_code: false,
  enable_fiado: true,
  annul_code_set: false,
  annul_code_expires_at: null,
  updated_at: null,
  updated_by: null,
};

/** row → PublicSettings. EXPLICIT pick: `annul_code_hash` is never read here. */
function toPublicSettings(row: t.TenantSettings): PublicSettings {
  return {
    store_name: row.store_name,
    nit: row.nit,
    address: row.address,
    phone: row.phone,
    ticket_footer: row.ticket_footer,
    ticket_prefix: row.ticket_prefix,
    iva_pct: row.iva_pct,
    default_credit_limit: row.default_credit_limit,
    allow_negative_stock: row.allow_negative_stock,
    require_annul_code: row.require_annul_code,
    enable_fiado: row.enable_fiado,
    annul_code_set: row.annul_code_hash !== null,
    annul_code_expires_at: row.annul_code_expires_at
      ? row.annul_code_expires_at.toISOString()
      : null,
    updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    updated_by: row.updated_by,
  };
}

/**
 * Point lookup by PK. Row absent → DEFAULT_SETTINGS (ST:Absent row =
 * current behavior). Accepts a tx so `applyMutationGroups` can read it
 * inside a push/finalize transaction without a second connection.
 */
export async function loadTenantSettings(
  db: Db | Tx,
  tenantId: string,
): Promise<PublicSettings> {
  const rows = await db
    .select()
    .from(t.tenantSettings)
    .where(eq(t.tenantSettings.tenant_id, tenantId))
    .limit(1);
  return rows[0] ? toPublicSettings(rows[0]) : DEFAULT_SETTINGS;
}

export { toPublicSettings };
