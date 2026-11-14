import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  clearSettingsCache,
  mergeSettings,
  readSettingsCache,
  settingsCacheKey,
  writeSettingsCache,
  type PublicSettings,
} from "../src/lib/settings";

/**
 * roles-admin 3.9 · offline settings cache (design D4 client cache).
 * AC (settings spec §Offline settings cache is display-only):
 *  - absent/corrupt localStorage → DEFAULT_SETTINGS (never a crash)
 *  - partial cache merges over the defaults
 *  - merge on fetch: the server response wins field-by-field
 *  - clear on sign-out (tenant key, and the no-arg sweep)
 *  - DEFAULT_SETTINGS mirrors the absent-row server defaults
 */

const TENANT = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4444-8555-555555555555";

type FakeStorage = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
};

function installStorage(initial: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(initial));
  const storage: FakeStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  vi.stubGlobal("localStorage", storage);
  return map;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DEFAULT_SETTINGS (mirror of the absent-row server defaults)", () => {
  it("pins today's behavior: fiado on, oversell allowed, annul code off, the rest null", () => {
    expect(DEFAULT_SETTINGS).toEqual({
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
    });
  });
});

describe("readSettingsCache", () => {
  it("absent key → defaults", () => {
    installStorage();
    expect(readSettingsCache(TENANT)).toEqual(DEFAULT_SETTINGS);
  });

  it("no localStorage at all (node/test env) → defaults, no throw", () => {
    // nothing stubbed: typeof localStorage === "undefined"
    expect(readSettingsCache(TENANT)).toEqual(DEFAULT_SETTINGS);
  });

  it("corrupt JSON → defaults (never a crash)", () => {
    installStorage({ [settingsCacheKey(TENANT)]: "{{{not json" });
    expect(readSettingsCache(TENANT)).toEqual(DEFAULT_SETTINGS);
  });

  it("non-object payloads → defaults", () => {
    for (const raw of ["null", '"string"', "42", "[]"]) {
      installStorage({ [settingsCacheKey(TENANT)]: raw });
      expect(readSettingsCache(TENANT)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("partial cache merges over the defaults (missing keys fall back)", () => {
    installStorage({
      [settingsCacheKey(TENANT)]: JSON.stringify({
        store_name: "Última conocida",
        allow_negative_stock: false,
      }),
    });
    expect(readSettingsCache(TENANT)).toEqual({
      ...DEFAULT_SETTINGS,
      store_name: "Última conocida",
      allow_negative_stock: false,
    });
  });

  it("tenant-scoped key: another tenant's cache is invisible", () => {
    installStorage({
      [settingsCacheKey(OTHER)]: JSON.stringify({ ...DEFAULT_SETTINGS, store_name: "De B" }),
    });
    expect(readSettingsCache(TENANT).store_name).toBeNull();
    expect(readSettingsCache(OTHER).store_name).toBe("De B");
  });
});

describe("write / clear", () => {
  it("write → read roundtrip preserves every field", () => {
    installStorage();
    const value: PublicSettings = {
      ...DEFAULT_SETTINGS,
      nit: "900111222",
      ticket_prefix: "NX",
      enable_fiado: false,
      annul_code_set: true,
      annul_code_expires_at: "2026-11-13T10:00:00.000Z",
      updated_at: "2026-11-13T09:55:00.000Z",
      updated_by: "user-1",
    };
    writeSettingsCache(TENANT, value);
    expect(readSettingsCache(TENANT)).toEqual(value);
  });

  it("clear(tenant) removes only that tenant's key", () => {
    const map = installStorage({
      [settingsCacheKey(TENANT)]: JSON.stringify({ ...DEFAULT_SETTINGS, store_name: "A" }),
      [settingsCacheKey(OTHER)]: JSON.stringify({ ...DEFAULT_SETTINGS, store_name: "B" }),
    });
    clearSettingsCache(TENANT);
    expect(map.has(settingsCacheKey(TENANT))).toBe(false);
    expect(readSettingsCache(TENANT)).toEqual(DEFAULT_SETTINGS);
    expect(readSettingsCache(OTHER).store_name).toBe("B");
  });

  it("clear() with no tenant sweeps every pos:settings:* key (stale session cannot resurface)", () => {
    const map = installStorage({
      [settingsCacheKey(TENANT)]: JSON.stringify({ ...DEFAULT_SETTINGS, store_name: "A" }),
      [settingsCacheKey(OTHER)]: JSON.stringify({ ...DEFAULT_SETTINGS, store_name: "B" }),
      "pos:tenant-name": "Se conserva",
    });
    clearSettingsCache();
    expect([...map.keys()]).toEqual(["pos:tenant-name"]);
  });
});

describe("mergeSettings (boot/online refresh)", () => {
  it("server response wins field-by-field; omitted fields keep last-known values", () => {
    const cache: PublicSettings = {
      ...DEFAULT_SETTINGS,
      store_name: "Viejo nombre",
      nit: "111",
      allow_negative_stock: false,
    };
    // partial response: only the fields the server actually sent
    const server: Partial<PublicSettings> = {
      store_name: "Nombre nuevo",
      enable_fiado: false,
    };
    expect(mergeSettings(cache, server)).toEqual({
      ...cache,
      store_name: "Nombre nuevo",
      enable_fiado: false,
    });
  });
});
