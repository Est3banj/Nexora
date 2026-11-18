/**
 * better-auth logging policy (audit P1-5).
 *
 * better-auth does NOT log through pino: it builds its own logger in
 * `@better-auth/core/env/logger.mjs` (`createLogger(options.logger)`) and
 * prints to console. pino's `redact` therefore CANNOT reach it — the only
 * levers are the `logger` option (`level`, `log`) wired here.
 *
 * Two barriers, deliberately redundant:
 *
 *  1. `level: "warn"` — better-auth's default is already "warn", set here
 *     explicitly so the contract is visible in our code. Levels below warn
 *     (`debug`, `info`, `success`) are dropped inside `createLogger` BEFORE
 *     any sink runs. That is exactly where the flagged line lives:
 *     `api/routes/sign-up.mjs:194`
 *       ctx.context.logger.info(`Sign-up attempt for existing email: ${email}`)
 *     → never reaches stdout.
 *
 *  2. `log` — the sink itself. Even if someone raises `level`, every string
 *     is scrubbed of email-shaped tokens before it is printed. Message
 *     interpolation is a raw string, so a path-based redactor (pino `redact`)
 *     has nothing to attach to; only the sink can fix it.
 *
 * Non-string args (errors, objects) pass through untouched: none of the
 * warn/error call sites in better-auth 1.7.19 interpolate a user identifier
 * (grepped across the whole better-auth dist tree), and stringifying an
 * Error here would throw away its stack.
 */

/** Deliberately no `g` flag — `.test()` is safe to call repeatedly. */
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function scrubPII(message: string): string {
  return message.replace(EMAIL_RE, "[email]");
}

type LogSinkLevel = "debug" | "info" | "warn" | "error";

/**
 * `level` is `as const` so it stays the literal `"warn"` and satisfies
 * better-auth's `Exclude<LogLevel, "success">`.
 */
export const authLogger = {
  level: "warn" as const,
  log(level: LogSinkLevel, message: string, ...args: unknown[]) {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${scrubPII(message)}`;
    const rest = args.map((a) => (typeof a === "string" ? scrubPII(a) : a));
    if (level === "error") console.error(line, ...rest);
    else if (level === "warn") console.warn(line, ...rest);
    else console.log(line, ...rest);
  },
};
