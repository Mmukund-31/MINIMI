import type { FastifyPluginAsync } from "fastify";
import type { Runtime } from "@minimi/core";

export const healthRoutes =
  (runtime: Runtime): FastifyPluginAsync =>
  async (app) => {
    app.get("/health", async (_req, reply) => {
      const s = runtime.status();
      const ok = s.database;
      return reply.status(ok ? 200 : 503).send({
        status: ok ? (s.llm.configured && s.search.configured ? "ok" : "degraded") : "error",
        database: s.database,
        llm: { configured: s.llm.configured, provider: s.llm.provider, models: s.llm.models, error: s.llm.error },
        search: s.search,
        missing: s.missing,
        timezone: runtime.config.timezone,
        budgets: runtime.config.budgets,
      });
    });
  };
