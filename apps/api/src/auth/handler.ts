import type { FastifyReply, FastifyRequest } from "fastify";
import { getAuth } from "./auth";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Bridges Fastify → better-auth's Fetch-API handler.
 *
 * Fastify has already parsed application/json bodies by the time the route
 * runs, so the body is re-serialized into a fresh Request. This avoids the
 * classic Fastify + toNodeHandler pitfall of a pre-consumed raw stream.
 */
export async function authRouteHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const host = req.headers.host ?? "localhost:3000";
  const url = new URL(req.url, `http://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, String(value));
    }
  }
  // The body we send may be re-serialized — never forward the original length.
  headers.delete("content-length");

  let body: string | undefined;
  if (MUTATING.has(req.method)) {
    if (typeof req.body === "string") body = req.body;
    else if (Buffer.isBuffer(req.body)) body = req.body.toString("utf8");
    else if (req.body !== undefined) body = JSON.stringify(req.body);
  }

  const request = new Request(url, {
    method: req.method,
    headers,
    ...(body !== undefined ? { body } : {}),
  });

  const res = await getAuth().handler(request);
  reply.status(res.status);
  for (const cookie of res.headers.getSetCookie()) {
    reply.header("set-cookie", cookie);
  }
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    reply.header(key, value);
  });
  const buf = Buffer.from(await res.arrayBuffer());
  reply.send(buf.length > 0 ? buf : undefined);
}
