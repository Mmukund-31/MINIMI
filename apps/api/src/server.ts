import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { AppError, type Runtime } from "@minimi/core";
import { chatRoutes } from "./routes/chat";
import { conversationRoutes } from "./routes/conversations";
import { healthRoutes } from "./routes/health";

export interface ServerOptions {
  logger?: boolean | object;
  /** Serve the built frontend (production single-port mode). */
  serveWeb?: boolean;
  rateLimitPerMinute?: number;
}

export async function buildServer(runtime: Runtime, opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 64 * 1024,
    genReqId: (req) => {
      const header = req.headers["x-request-id"];
      return typeof header === "string" && /^[\w-]{1,64}$/.test(header) ? header : `req_${Math.random().toString(36).slice(2, 12)}`;
    },
    requestIdHeader: false,
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
    reply.header("x-content-type-options", "nosniff");
  });

  await app.register(rateLimit, {
    global: false,
    max: opts.rateLimitPerMinute ?? 30,
    timeWindow: "1 minute",
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, retryable: err.retryable } });
    }
    const e = err as { validation?: unknown; statusCode?: number; message?: string };
    if (e.validation) {
      return reply.status(400).send({ error: { code: "VALIDATION", message: e.message ?? "Invalid request.", retryable: false } });
    }
    if (e.statusCode === 429) {
      return reply.status(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests. Please slow down.", retryable: true } });
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: "BAD_REQUEST", message: e.message ?? "Bad request.", retryable: false } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "Unexpected server error.", retryable: true } });
  });

  await app.register(healthRoutes(runtime), { prefix: "/api" });
  await app.register(conversationRoutes(runtime), { prefix: "/api" });
  await app.register(chatRoutes(runtime), { prefix: "/api" });

  if (opts.serveWeb) {
    const dist = join(runtime.config.rootDir, "apps", "web", "dist");
    if (existsSync(dist)) {
      await app.register(fastifyStatic, { root: dist, prefix: "/" });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith("/api")) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Not found.", retryable: false } });
        return reply.sendFile("index.html");
      });
    }
  }
  return app;
}
