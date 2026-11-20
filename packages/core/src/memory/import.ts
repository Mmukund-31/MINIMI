import { z } from "zod";
import { transaction, type Db } from "../db/connection";
import type { Repositories } from "../db/repositories";
import { AppError } from "../shared/errors";
import { isValidTimezone } from "../shared/config";
import { truncate } from "../shared/text";
import type { Conversation } from "../shared/types";

/**
 * Importing a past conversation with its original timestamps lets anyone test
 * date-based recall ("what did I ask you on 3 November?") with their own
 * history instead of the seeded demo data. Imported messages are indexed by the
 * same FTS triggers and retrieved exactly like conversations held in the app.
 */
export const ImportSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().max(64).optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string().trim().min(1).max(8_000),
            createdAt: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type ImportInput = z.infer<typeof ImportSchema>;

/** Allowed clock skew for "not in the future". */
const SKEW_MS = 5 * 60_000;

export function importConversation(repos: Repositories, db: Db, body: unknown, opts: { now?: Date; defaultTimezone: string }): Conversation {
  const parsed = ImportSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError("VALIDATION", `Invalid import: ${issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "malformed payload"}.`);
  }
  const input = parsed.data;
  const now = (opts.now ?? new Date()).getTime();
  const times = input.messages.map((m) => Date.parse(m.createdAt));
  for (let i = 0; i < times.length; i++) {
    if (times[i]! > now + SKEW_MS) throw new AppError("VALIDATION", `Invalid import: messages.${i}.createdAt is in the future.`);
    if (i > 0 && times[i]! < times[i - 1]!) throw new AppError("VALIDATION", `Invalid import: messages must be in chronological order (messages.${i}).`);
  }
  const timezone = isValidTimezone(input.timezone) ? input.timezone : opts.defaultTimezone;
  const firstUser = input.messages.find((m) => m.role === "user");
  const title = input.title ?? truncate((firstUser ?? input.messages[0]!).content.replace(/\s+/g, " "), 60);
  const toIso = (t: number) => new Date(t).toISOString();

  return transaction(db, () => {
    const conv = repos.conversations.create({ title, timezone, createdAt: toIso(times[0]!), metadata: { imported: true } });
    input.messages.forEach((m, i) => {
      repos.messages.add({
        conversationId: conv.id,
        role: m.role,
        content: m.content,
        createdAt: toIso(times[i]!),
        metadata: { imported: true, ...(m.role === "assistant" ? { status: "complete" as const } : {}) },
      });
    });
    repos.conversations.touch(conv.id, toIso(times.at(-1)!));
    return { ...conv, updatedAt: toIso(times.at(-1)!) };
  });
}
