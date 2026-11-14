/**
 * roles-admin 3.9 / design D4 · offline settings cache (display-only).
 *
 * Key `pos:settings:{tenantId}` — same localStorage lifetime as the
 * tenantName precedent (App.tsx tenant-name effect): settings are TENANT
 * facts, unlike the sessionStorage role hint. H3: this cache is a hint,
 * never authority — the annul code is always server-validated and the
 * fiado/oversell backstops re-check at sync apply. Settings mutations are
 * NEVER queued (not a sync entity).
 *
 * Absent/corrupt cache → DEFAULT_SETTINGS, which mirrors the absent-row
 * server defaults (enable_fiado true, allow_negative_stock true,
 * require_annul_code false) — so a cold cache behaves exactly like today.
 */

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
  annul_code_set: boolean;
  annul_code_expires_at: string | null;
  updated_at: string | null;
  updated_by: string | null;
};

/** Mirror of api db/settings.ts DEFAULT_SETTINGS (absent row = current behavior). */
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

export function settingsCacheKey(tenantId: string): string {
  return `pos:settings:${tenantId}`;
}

/**
 * Cache-first read: absent key, corrupt JSON or a non-object payload all
 * collapse to DEFAULT_SETTINGS (never a crash, never fabricated values).
 */
export function readSettingsCache(tenantId: string): PublicSettings {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_SETTINGS;
    const raw = localStorage.getItem(settingsCacheKey(tenantId));
    if (!raw) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return DEFAULT_SETTINGS;
    }
    return { ...DEFAULT_SETTINGS, ...(parsed as Partial<PublicSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function writeSettingsCache(tenantId: string, settings: PublicSettings): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(settingsCacheKey(tenantId), JSON.stringify(settings));
  } catch {
    /* quota/private-mode — cache is best-effort, the server still works */
  }
}

/**
 * Sign-out clears the tenant's key (App.tsx handleSignOut, next to
 * pos:tenant-name). With no tenantId, sweep every `pos:settings:*` key so a
 * stale entry from a previous session can never resurface.
 */
export function clearSettingsCache(tenantId?: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (tenantId) {
      localStorage.removeItem(settingsCacheKey(tenantId));
      return;
    }
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("pos:settings:")) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    /* best-effort */
  }
}

/**
 * Boot/online refresh merge: the server response wins field-by-field over
 * the cache, fields the response omits keep their last-known value.
 */
export function mergeSettings(
  base: PublicSettings,
  incoming: Partial<PublicSettings>,
): PublicSettings {
  return { ...base, ...incoming };
}
