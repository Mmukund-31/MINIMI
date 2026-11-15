import { createRuntime, loadConfig, loadDotEnv } from "@minimi/core";
import { buildServer } from "./server";

loadDotEnv();
const config = loadConfig();
const isProd = config.env === "production" || process.argv.includes("--serve-web");

const runtime = createRuntime(config);
const app = await buildServer(runtime, {
  logger: {
    level: config.server.logLevel,
    redact: ["req.headers.authorization", "req.headers.cookie"],
  },
  serveWeb: isProd,
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  runtime.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const status = runtime.status();
await app.listen({ port: config.server.port, host: config.server.host });
app.log.info(
  {
    db: config.databasePath,
    timezone: config.timezone,
    llm: status.llm.configured ? `${status.llm.provider} (${status.llm.models.join(", ")})` : `NOT CONFIGURED: ${status.llm.error}`,
    search: status.search.configured ? status.search.provider : "NOT CONFIGURED (TAVILY_API_KEY)",
  },
  `MINIMI API listening on http://${config.server.host}:${config.server.port}`,
);
