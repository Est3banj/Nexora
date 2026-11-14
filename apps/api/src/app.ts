import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config } from "./config";
import { authRouteHandler } from "./auth/handler";
import { authPlugin } from "./auth/plugin";
import { catalogRoutes } from "./routes/catalog";
import { salesRoutes } from "./routes/sales";
import { paymentRoutes } from "./routes/payments";
import { rehydrateRoutes } from "./routes/rehydrate";
import { shiftRoutes } from "./routes/shifts";
import { reportRoutes } from "./routes/reports";
import { founderRoutes } from "./routes/founder";
import { settingsRoutes } from "./routes/settings";
import { adminUsersRoutes } from "./routes/admin-users";
import { syncRoutes } from "./sync/route";
import { pool } from "./db";

/**
 * Readiness budget for /api/health: one round-trip (SELECT 1 + three
 * to_regclass probes) must answer inside this window or the probe reports
 * "not ready" instead of hanging a healthcheck.
 */
const HEALTH_BUDGET_MS = 700;

type Readiness = {
  ready: boolean;
  db: "up" | "down";
  schema: "ok" | "incomplete" | "unknown";
  ms: number;
};

/**
 * Bounded datastore probe: is the DB reachable AND is the schema there?
 *
 * `products`     — base business baseline (db/init-baseline.ts)
 * `audit_log`    — server-only baseline table
 * `"user"`       — better-auth tables (db/bootstrap.ts)
 *
 * All three are created before the listener starts (server.ts runs
 * ensureAuthTables → initBaseline → additive migrations → buildApp), so a
 * "not ready" answer means a real problem: the boot sequence did not finish,
 * the DB went away, or someone pointed us at the wrong database.
 */
async function readiness(): Promise<Readiness> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const budget = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("health_budget_exceeded")), HEALTH_BUDGET_MS);
    });
    const query = pool.query<{ ok: number; business: boolean; audit: boolean; auth: boolean }>(
      `SELECT 1 AS ok,
              to_regclass('public.products')  IS NOT NULL AS business,
              to_regclass('public.audit_log') IS NOT NULL AS audit,
              to_regclass('public."user"')    IS NOT NULL AS auth`,
    );
    // Never leave a rejected pool query unhandled when the budget wins.
    query.catch(() => undefined);
    const res = await Promise.race([query, budget]);
    const row = res.rows[0];
    const schemaOk = Boolean(row?.business && row?.audit && row?.auth);
    return {
      ready: Boolean(row) && schemaOk,
      db: "up",
      schema: schemaOk ? "ok" : "incomplete",
      ms: Date.now() - started,
    };
  } catch {
    return { ready: false, db: "down", schema: "unknown", ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? config.nodeEnv !== "test",
    // Partition B · trust the proxy in front of us and nothing else.
    // Compose never publishes the API port, so the only peer that can reach
    // :3000 is the Caddy container on the Docker network: X-Forwarded-For is
    // honoured only when the PEER ADDRESS is inside Docker's private range,
    // which makes req.ip (and the rate-limit key below) the real client IP
    // instead of Caddy's container IP — where every user would share one
    // bucket.
    //   Why a CIDR and not a hop count: Fastify 5 deliberately treats a
    //   numeric `trustProxy` as "trust nobody" (a peer cannot be validated
    //   by hop count alone), and `true` would let any client spoof its own
    //   X-Forwarded-For. If you move the compose network off 172.16.0.0/12,
    //   change this value to match.
    trustProxy: "172.16.0.0/12",
  });

  // Brute-force / abuse protection (audit: no rate-limit on login).
  // Global API cap + tighter window on /api/auth/* (sign-in lives there).
  // Disabled in tests so suites are not throttled.
  if (config.nodeEnv !== "test") {
    await app.register(rateLimit, {
      global: true,
      max: 300,
      timeWindow: "1 minute",
      keyGenerator: (req) => req.ip,
      allowList: (req) => req.url === "/api/health" || req.url === "/api/health/live",
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "validation_error",
        issues: err.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    let e = err as { code?: string; message?: string; statusCode?: number; constraint?: string; cause?: unknown };
    if (e.cause) e = e.cause as typeof e;
    if (e.code === "23505") {
      if (e.constraint === "product_variants_tenant_code_uq") {
        return reply.code(409).send({ error: "duplicate_code", message: "El código ya pertenece a otra variante de este comercio" });
      }
      return reply.code(409).send({ error: "conflict", detail: e.message });
    }
    if (e.code === "23503") {
      return reply.code(404).send({ error: "not_found" });
    }
    const status = e.statusCode ?? 500;
    if (status >= 500) {
      app.log.error(err);
      return reply.code(500).send({ error: "internal_error" });
    }
    return reply.code(status).send({ error: e.message });
  });

  // Baseline security headers (audit: none present).
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    if (config.nodeEnv === "production") {
      reply.header(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    }
    return payload;
  });

  // better-auth routes (sign-in, session, organization set-active, …).
  // Auth gets a tighter window: 20 req/min/IP — enough for login + org
  // calls, too low for credential stuffing.
  app.route(
    {
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url: "/api/auth/*",
      ...(config.nodeEnv !== "test"
        ? {
            config: {
              rateLimit: { max: 20, timeWindow: "1 minute" },
            },
          }
        : {}),
      handler: async (req, reply) => {
        // Compare a normalized pathname (query excluded), including encoded separators,
        // case, duplicate slashes and trailing slash; leave all other auth paths alone.
        let path = new URL(req.url, "http://localhost").pathname;
        try { path = decodeURIComponent(path); } catch { /* invalid encoding cannot match an SDK endpoint */ }
        path = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
        // Membership writers are controlled app operations. The SDK's default
        // admin permissions are broader than our owner/admin policy; invitation
        // acceptance and leaving can mutate membership too. In-process founder
        // provisioning bypasses this HTTP proxy intentionally.
        const membershipWriters = ["add-member", "update-member-role", "remove-member", "invite-member",
          "accept-invitation", "reject-invitation", "cancel-invitation", "leave", "delete"];
        if (req.method !== "GET" && membershipWriters.some(endpoint => path === `/api/auth/organization/${endpoint}`)) {
          return reply.code(403).send({ error: "use_admin_users_api" });
        }
        return authRouteHandler(req, reply);
      },
    },
  );

  await app.register(authPlugin);
  await app.register(catalogRoutes);
  await app.register(salesRoutes);
  await app.register(syncRoutes);
  await app.register(paymentRoutes);
  await app.register(rehydrateRoutes);
  await app.register(shiftRoutes);
  await app.register(reportRoutes);
  await app.register(founderRoutes);
  await app.register(settingsRoutes);
  await app.register(adminUsersRoutes);

  // Health probes (Partition B). Two endpoints, deliberately different:
  //
  //  GET /api/health      READINESS — bounded DB + schema check (700ms
  //                       budget). 503 while the datastore cannot serve
  //                       traffic. This is what the container healthcheck,
  //                       the reverse proxy and `depends_on` gate on.
  //  GET /api/health/live LIVENESS  — process is up: zero I/O, always 200.
  //                       Use it to tell "API process dead" apart from
  //                       "database unreachable" during an incident.
  app.get("/api/health", async (_req, reply) => {
    const state = await readiness();
    reply.header("Cache-Control", "no-store");
    if (!state.ready) {
      return reply.code(503).send({
        ok: false,
        live: true,
        ready: false,
        db: state.db,
        schema: state.schema,
        ms: state.ms,
      });
    }
    return { ok: true, live: true, ready: true, db: state.db, schema: state.schema, ms: state.ms };
  });

  app.get("/api/health/live", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    return { ok: true, live: true };
  });

  await app.ready();
  return app;
}
