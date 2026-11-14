import { expect, it } from "vitest";
import { NAVIGATION, isDueñoHint, visibleNav } from "../src/components/navigation";

/**
 * roles-admin 5.9 · the settled matrix as a PURE test (menu-visibility
 * §Role tab sets + §Fail closed on UNKNOWN role / design D6):
 *
 *  - `null` (unknown / never-verified) → ONLY the 5 member-safe tabs.
 *    Fail-closed means the PROTECTED surfaces (Panel, Reportes,
 *    Administración, Consola) never render for a role we could not verify.
 *  - `member` → the same 5; `owner`/`admin` → those 5 + Panel + Reportes
 *    + Administración (8 — batch 6).
 *  - `enable_fiado: false` → `credito` drops for EVERY role.
 *  - Consola is NEVER in the matrix (design D7: account menu, batch 7).
 *
 * The AppShell tabbar, the command palette and the App screen guard all
 * consume `visibleNav` — this test pins the ONE source they share.
 */
const tabs = (r: Parameters<typeof visibleNav>[0], o?: { enableFiado?: boolean }) =>
  visibleNav(r, o).map((item) => item.tab);

const MEMBER_SAFE = ["sale", "arqueo", "tickets", "catalog", "credito"];
const DUENO_EXTRA = ["dashboard", "reports", "admin"];

it("null (unknown role) renders ONLY the 5 member-safe tabs — fail closed", () => {
  expect(tabs(null)).toEqual(MEMBER_SAFE);
  /* Protected surfaces stay hidden for an unverified role. */
  for (const protectedTab of DUENO_EXTRA) {
    expect(tabs(null)).not.toContain(protectedTab);
  }
  expect(tabs(null, { enableFiado: false })).toEqual(
    MEMBER_SAFE.filter((t) => t !== "credito"),
  );
});

it("member sees exactly the same 5 tabs", () => {
  expect(tabs("member")).toEqual(MEMBER_SAFE);
  expect(tabs("member", { enableFiado: false })).toEqual(
    MEMBER_SAFE.filter((t) => t !== "credito"),
  );
});

it("owner and admin both see 8, Administración last (Dueño tier ≡ admin)", () => {
  const owner = tabs("owner");
  const admin = tabs("admin");
  expect(owner).toEqual(admin);
  expect(owner).toHaveLength(8);
  expect(owner.at(-1)).toBe("admin");
  expect(tabs("owner", { enableFiado: false })).toHaveLength(7);
  expect(tabs("admin", { enableFiado: false })).toHaveLength(7);
  expect(tabs("member", { enableFiado: false })).toHaveLength(4);
  /* Exact SET — the prototype's nav order (design-rules layout.navOrder)
   * is preserved: member-safe entries keep their relative order and the
   * Dueño-only ones join them (credito stays the prototype's 7th entry). */
  expect(new Set(owner)).toEqual(new Set([...MEMBER_SAFE, ...DUENO_EXTRA]));
  expect(owner.slice(0, 4)).toEqual(MEMBER_SAFE.slice(0, 4));
  expect(owner).toContain("credito");
  /* enable_fiado=false drops exactly one tab for the Dueño tier too. */
  expect(tabs("owner", { enableFiado: false })).toEqual(
    owner.filter((t) => t !== "credito"),
  );
  expect(tabs("admin", { enableFiado: false })).toEqual(
    admin.filter((t) => t !== "credito"),
  );
});

it("credito is the ONLY item flagged requiresFiado (and it is tier 'all')", () => {
  const fiado = NAVIGATION.filter((item) => "requiresFiado" in item && item.requiresFiado);
  expect(fiado).toHaveLength(1);
  expect(fiado[0].tab).toBe("credito");
  expect(fiado[0].tier).toBe("all");
});

it("Consola never appears in visibleNav for any role", () => {
  for (const role of [null, "member", "owner", "admin"] as const) {
    /* stringified scan: "consola" is not even a member of AppTab, so a
     * typed `.toContain` would not compile — this asserts the VALUE. */
    expect(JSON.stringify(visibleNav(role)).toLowerCase()).not.toContain("consola");
    expect(JSON.stringify(visibleNav(role, { enableFiado: false })).toLowerCase()).not.toContain("consola");
  }
});

it("tier field is exactly all|dueno and isDueñoHint matches it", () => {
  for (const item of NAVIGATION) {
    expect(["all", "dueno"]).toContain(item.tier);
  }
  /* isDueñoHint: owner/admin true, member/null false (decision #3/#10). */
  expect(isDueñoHint("owner")).toBe(true);
  expect(isDueñoHint("admin")).toBe(true);
  expect(isDueñoHint("member")).toBe(false);
  expect(isDueñoHint(null)).toBe(false);
  /* The matrix itself obeys the helper: dueno items only for the tier. */
  expect(tabs("owner")).toEqual(
    NAVIGATION.filter((i) => i.tier === "all" || isDueñoHint("owner")).map((i) => i.tab),
  );
});

it("visibleNav returns a fresh array (callers may sort/filter freely)", () => {
  const a = visibleNav("owner");
  a.pop();
  expect(visibleNav("owner")).toHaveLength(8);
});
