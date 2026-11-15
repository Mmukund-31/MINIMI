import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError, MAX_MESSAGE_CHARS, toAppError, type AgentEvent, type Runtime } from "@minimi/core";

const ChatBody = z
  .object({
    conversationId: z.string().regex(/^conv_[a-z0-9]{1,40}$/i).optional(),
    message: z.string().min(1).max(MAX_MESSAGE_CHARS),
    timezone: z.string().max(64).optional(),
  })
  .strict();

/**
 * POST /api/chat → text/event-stream
 *
 * Streams AgentEvents as SSE (`event: <type>\ndata: <json>\n\n`). The client
 * disconnecting aborts the execution (LLM + search requests are cancelled).
 */
export const chatRoutes =
  (runtime: Runtime): FastifyPluginAsync =>
  async (app) => {
    app.post("/chat", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
      const parsed = ChatBody.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid chat payload.");
      }
      // Fail fast (as JSON) on problems detectable before streaming starts.
      if (parsed.data.conversationId && !runtime.repos.conversations.get(parsed.data.conversationId)) {
        throw new AppError("NOT_FOUND", "Conversation not found.");
      }
      if (parsed.data.conversationId && runtime.agent.isBusy(parsed.data.conversationId)) {
        throw new AppError("CONFLICT", "An answer is already being generated in this conversation.", { retryable: true });
      }

      const controller = new AbortController();
      let finished = false;
      reply.raw.on("close", () => {
        if (!finished) controller.abort();
      });

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        "x-request-id": req.id,
      });
      const send = (e: AgentEvent) => {
        if (reply.raw.writableEnded) return;
        reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      const heartbeat = setInterval(() => {
        if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
      }, 15_000);

      try {
        await runtime.agent.run(
          { conversationId: parsed.data.conversationId, message: parsed.data.message, timezone: parsed.data.timezone, signal: controller.signal },
          send,
        );
      } catch (err) {
        const e = toAppError(err);
        if (e.code !== "CANCELLED") {
          req.log.warn({ code: e.code, msg: e.message }, "chat execution failed");
          send({ type: "error", error: { code: e.code, message: e.message, retryable: e.retryable } });
        }
      } finally {
        finished = true;
        clearInterval(heartbeat);
        reply.raw.end();
      }
    });
  };
