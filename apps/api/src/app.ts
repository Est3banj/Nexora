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
import { syncRoutes } from "./sync/route";

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? config.nodeEnv !== "test",
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
      allowList: (req) => req.url === "/api/health",
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
      handler: authRouteHandler,
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

  app.get("/api/health", async () => ({ ok: true }));

  await app.ready();
  return app;
}
