import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

/**
 * D1-4 · DB-access lint gate
 * AC (design §5): routes receive `repo = scopedRepo(db, req.ctx.tenantId)`;
 * introducing a raw query outside `apps/api/src/db/` FAILS lint.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const probeFile = path.join(repoRoot, "apps/api/src/lint-gate-probe.ts");
const scopeFile = path.join(repoRoot, "apps/api/src/db/scope.ts");
const routeFile = path.join(repoRoot, "apps/api/src/routes/catalog.ts");

afterAll(() => {
  fs.rmSync(probeFile, { force: true });
});

async function lint(file: string) {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintFiles([file]);
  return result.messages;
}

describe("scopedRepo is the only DB path", () => {
  it("a raw db.select outside src/db/ fails lint", async () => {
    fs.writeFileSync(
      probeFile,
      [
        `import { db } from "./db";`,
        `export async function leak() {`,
        `  return db.select().from("products");`,
        `}`,
        ``,
      ].join("\n"),
    );
    const messages = await lint(probeFile);
    const gate = messages.find((m) => m.ruleId === "no-restricted-syntax");
    expect(gate).toBeDefined();
    expect(gate?.message).toContain("scopedRepo");
  });

  it("a raw db.insert outside src/db/ fails lint", async () => {
    fs.writeFileSync(
      probeFile,
      [
        `import { db } from "./db";`,
        `export async function leak() {`,
        `  return db.insert("products").values({});`,
        `}`,
        ``,
      ].join("\n"),
    );
    const messages = await lint(probeFile);
    expect(messages.some((m) => m.ruleId === "no-restricted-syntax")).toBe(true);
  });

  it("src/db/scope.ts (the sanctioned path) passes the gate", async () => {
    const messages = await lint(scopeFile);
    expect(messages.filter((m) => m.ruleId === "no-restricted-syntax")).toEqual([]);
  });

  it("routes pass the gate (they go through repoFor → scopedRepo)", async () => {
    const messages = await lint(routeFile);
    expect(messages.filter((m) => m.ruleId === "no-restricted-syntax")).toEqual([]);
  });
});
