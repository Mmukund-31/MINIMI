import type { AgentEvent, Conversation, Message } from "@minimi/core/types";

export type { AgentEvent, Comparison, Conversation, Message, SourceRef, Stage, MemorySummary, ResearchMeta } from "@minimi/core/types";

export interface ConversationListItem {
  id: string;
  title: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  seeded: boolean;
  imported?: boolean;
}

export interface Health {
  status: "ok" | "degraded" | "error";
  llm: { configured: boolean; provider: string; models: string[]; error?: string };
  search: { configured: boolean; provider: string };
  missing: string[];
  timezone: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: { error?: { code: string; message: string; retryable: boolean } } = {};
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(body.error?.code ?? "HTTP_" + res.status, body.error?.message ?? `Request failed (${res.status})`, body.error?.retryable ?? res.status >= 500);
  }
  return res.json() as Promise<T>;
}

export const browserTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

export const api = {
  health: () => fetch("/api/health").then((r) => r.json() as Promise<Health>),
  listConversations: () => fetch("/api/conversations").then((r) => json<{ conversations: ConversationListItem[] }>(r)),
  getConversation: (id: string) => fetch(`/api/conversations/${id}`).then((r) => json<{ conversation: Conversation; messages: Message[] }>(r)),
  importConversation: (body: unknown) =>
    fetch("/api/conversations/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) =>
      json<{ conversation: Conversation; messageCount: number }>(r),
    ),
  deleteConversation: (id: string) =>
    fetch(`/api/conversations/${id}`, { method: "DELETE" }).then((r) => {
      if (!r.ok && r.status !== 204) throw new ApiError("HTTP_" + r.status, "Delete failed", false);
    }),
};

/**
 * POSTs a chat message and parses the SSE response stream, invoking
 * `onEvent` for each AgentEvent. (EventSource can't POST, so fetch + a
 * small SSE parser is used.)
 */
export async function streamChat(
  body: { conversationId?: string; message: string; timezone: string },
  onEvent: (e: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    await json(res);
    throw new ApiError("HTTP_" + res.status, "Chat request failed", true);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        /* ignore malformed event */
      }
    }
  }
}
