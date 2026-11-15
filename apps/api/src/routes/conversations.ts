import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError, isValidTimezone, type Runtime } from "@minimi/core";

const IdParams = z.object({ id: z.string().regex(/^conv_[a-z0-9]{1,40}$/i) });
const CreateBody = z.object({ title: z.string().max(120).optional(), timezone: z.string().max(64).optional() }).strict();

export const conversationRoutes =
  (runtime: Runtime): FastifyPluginAsync =>
  async (app) => {
    const { conversations, messages } = runtime.repos;

    app.get("/conversations", async () => {
      return {
        conversations: conversations.list(200).map((c) => ({
          id: c.id,
          title: c.title,
          timezone: c.timezone,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          lastMessageAt: c.lastMessageAt,
          messageCount: c.messageCount,
          seeded: Boolean(c.metadata.seeded),
        })),
      };
    });

    app.post("/conversations", async (req, reply) => {
      const body = CreateBody.safeParse(req.body ?? {});
      if (!body.success) throw new AppError("VALIDATION", "Invalid conversation payload.");
      const tz = isValidTimezone(body.data.timezone) ? body.data.timezone : runtime.config.timezone;
      const conv = conversations.create({ title: body.data.title, timezone: tz });
      return reply.status(201).send({ conversation: conv });
    });

    app.get("/conversations/:id", async (req) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) throw new AppError("VALIDATION", "Invalid conversation id.");
      const conv = conversations.get(p.data.id);
      if (!conv) throw new AppError("NOT_FOUND", "Conversation not found.");
      return { conversation: conv, messages: messages.listByConversation(conv.id) };
    });

    app.delete("/conversations/:id", async (req, reply) => {
      const p = IdParams.safeParse(req.params);
      if (!p.success) throw new AppError("VALIDATION", "Invalid conversation id.");
      if (!conversations.delete(p.data.id)) throw new AppError("NOT_FOUND", "Conversation not found.");
      return reply.status(204).send();
    });
  };
