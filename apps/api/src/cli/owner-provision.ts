import { pathToFileURL } from "node:url";
import readline from "node:readline";
import { closeDb } from "../db";
import { ensureAuthTables } from "../db/bootstrap";
import { initBaseline } from "../db/init-baseline";
import { FounderError } from "../founder/service";
import { parseTenantCreateArgs, runTenantCreate } from "./tenant-create";

/**
 * FIRST-OWNER PROVISIONING (Partition B · deploy prep).
 *
 * The founder CLI (`tenant-create`) takes `--password <value>`, which puts the
 * owner's password into:
 *   · process argv          → visible in `ps` on the host and in shell history,
 *   · any wrapper that re-invokes it,
 *   · anything that logs its command line.
 *
 * This wrapper keeps the SAME validation and the SAME service
 * (`createTenantWithFirstUser` via `runTenantCreate`) but prompts on a TTY
 * with echo suppressed and hands the password over in memory only. It never
 * appears in argv, in an env var, or in a file.
 *
 *   pnpm --filter @pos/api owner-provision
 *   pnpm --filter @pos/api owner-provision --dry-run   # validates, no DB write
 *
 * It REQUIRES an interactive terminal: on a pipe there is no echo to suppress,
 * so reading a password from one would be pure theatre (and `echo … |` would
 * put it in shell history anyway).
 *
 * Platform-admin provisioning (`user.platformAdmin`) is a DIFFERENT,
 * separate, deliberate operation — see DEPLOY.md §Provisionamiento.
 */

/**
 * One readline interface for the WHOLE session. Opening a fresh interface per
 * prompt loses buffered input on a pipe and makes the terminal driver flip
 * raw mode on/off for every line; a single interface does neither.
 *
 * Echo suppression: every keystroke echo goes through `_writeToOutput`, so we
 * swap it out for the duration of a hidden read and print a bare newline when
 * Enter arrives.
 */
function createPrompts(): {
  ask: (prompt: string, hidden?: boolean) => Promise<string>;
  close: () => void;
} {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const internals = rl as unknown as { _writeToOutput: (text: string) => void };
  const originalWrite = internals._writeToOutput.bind(rl);
  let muted = false;

  internals._writeToOutput = (text: string) => {
    if (!muted) {
      originalWrite(text);
      return;
    }
    if (text.includes("\n") || text.includes("\r")) process.stdout.write("\n");
  };

  let open = true;
  let pending: { settled: boolean; reject: (err: Error) => void } | null = null;

  rl.once("close", () => {
    open = false;
    muted = false;
    // EOF / Ctrl-D while a question is still open.
    if (pending && !pending.settled) {
      pending.settled = true;
      pending.reject(new FounderError("input closed before the prompt was answered", 1));
    }
    pending = null;
  });

  const ask = (prompt: string, hidden = false): Promise<string> =>
    new Promise((resolve, reject) => {
      if (!open) {
        reject(new FounderError("input closed before the prompt was answered", 1));
        return;
      }
      const state = { settled: false, reject };
      pending = state;
      const finish = (answer: string) => {
        if (state.settled) return;
        state.settled = true;
        pending = null;
        muted = false;
        resolve(answer);
      };
      rl.question(prompt, finish);
      if (hidden) muted = true;
    });

  return {
    ask,
    close: () => {
      open = false;
      muted = false;
      rl.close();
    },
  };
}

/** Ask twice, refuse to continue on mismatch (typo protection). */
async function askPassword(prompts: ReturnType<typeof createPrompts>): Promise<string> {
  const first = await prompts.ask("Owner password (input hidden): ", true);
  const second = await prompts.ask("Repeat the password: ", true);
  if (first !== second) {
    throw new FounderError("passwords do not match, run it again", 1);
  }
  return first;
}

export async function runOwnerProvision(argv: string[]): Promise<void> {
  // pnpm forwards the `--` separator (`pnpm run x -- --flag`) — ignore it.
  const flags = argv.filter((a) => a !== "--");
  const dryRun = flags.includes("--dry-run");
  const unknown = flags.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) {
    throw new FounderError(
      `unexpected argument: ${unknown[0]}\nusage: owner-provision [--dry-run]`,
      2,
    );
  }

  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new FounderError(
      "an interactive terminal is required (stdin/stdout is not a TTY).\n" +
        "Run it on a console or inside `docker compose exec -it` — a pipe has " +
        "no echo to suppress and would put the password in shell history.",
      1,
    );
  }

  const prompts = createPrompts();
  try {
    console.log("[owner-provision] first owner of a tenant (commerce).");
    console.log(
      "[owner-provision] the password is read without echo and never written to disk.\n",
    );

    const name = (await prompts.ask("Business name: ")).trim();
    const email = (await prompts.ask("Owner email: ")).trim();
    const slug = (await prompts.ask("Slug (Enter = derived from the name): ")).trim();
    const password = await askPassword(prompts);

    // Same validator as the CLI, so both paths accept exactly the same input.
    const cliArgv = ["--name", name, "--email", email, "--password", password];
    if (slug) cliArgv.push("--slug", slug);
    parseTenantCreateArgs(cliArgv);

    if (dryRun) {
      console.log("\n[owner-provision] dry-run — nothing was written to the database.");
      console.log(`[owner-provision] business:  ${name}`);
      console.log(`[owner-provision] owner:     ${email}`);
      console.log(`[owner-provision] slug:      ${slug || "(derived)"}`);
      console.log(`[owner-provision] password:  OK (${password.length} chars, not shown)`);
      return;
    }

    await ensureAuthTables();
    await initBaseline();
    await runTenantCreate(cliArgv);
  } finally {
    prompts.close();
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    await runOwnerProvision(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[owner-provision] ERROR: ${msg}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
