import Fastify, { type FastifyInstance } from "fastify";
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
    const e = err as { code?: string; message?: string; statusCode?: number };
    if (e.code === "23505") {
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

  // better-auth routes (sign-in, session, organization set-active, …)
  app.route(
    {
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url: "/api/auth/*",
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
