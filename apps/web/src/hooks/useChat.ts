import { useCallback, useEffect, useRef, useState } from "react";
import { api, browserTimezone, streamChat, type AgentEvent, type Comparison, type MemorySummary, type Message, type SourceRef, type Stage } from "../lib/api";

export interface StageState {
  status: "start" | "done" | "skipped" | "failed";
  detail?: string;
}

export interface SearchActivity {
  query: string;
  status: "start" | "done" | "failed" | "cached";
  resultCount?: number;
  error?: string;
}

export interface LiveTurn {
  userText: string;
  stages: Partial<Record<Stage, StageState>>;
  searches: SearchActivity[];
  memory?: { summary: MemorySummary; exchanges: Array<{ conversationTitle: string; at: string; question?: string; seeded: boolean }> };
  sources: SourceRef[];
  comparisons: Comparison[];
  text: string;
  error?: { code: string; message: string; retryable: boolean };
}

export function useChat(conversationId: string | null, onConversationCreated: (id: string) => void, onTurnFinished: () => void) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const creatingRef = useRef<string | null>(null);

  // Load persisted history when switching conversations.
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setLive(null);
      return;
    }
    if (creatingRef.current === conversationId) return; // just created by the running turn
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .getConversation(conversationId)
      .then((r) => {
        if (!cancelled) {
          setMessages(r.messages);
          setLive(null);
        }
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || abortRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setLive({ userText: message, stages: {}, searches: [], sources: [], comparisons: [], text: "" });
      let convId = conversationId;

      const onEvent = (e: AgentEvent) => {
        switch (e.type) {
          case "conversation":
            if (!convId) {
              convId = e.conversationId;
              creatingRef.current = e.conversationId;
              onConversationCreated(e.conversationId);
            }
            break;
          case "stage":
            setLive((l) => (l ? { ...l, stages: { ...l.stages, [e.stage]: { status: e.status, detail: e.detail } } } : l));
            break;
          case "search":
            setLive((l) => {
              if (!l) return l;
              const others = l.searches.filter((s) => s.query !== e.query);
              const prev = l.searches.findIndex((s) => s.query === e.query);
              const entry = { query: e.query, status: e.status, resultCount: e.resultCount, error: e.error };
              const searches = prev >= 0 ? l.searches.map((s, i) => (i === prev ? entry : s)) : [...others, entry];
              return { ...l, searches };
            });
            break;
          case "memory":
            setLive((l) => (l ? { ...l, memory: { summary: e.summary, exchanges: e.exchanges } } : l));
            break;
          case "sources":
            setLive((l) => (l ? { ...l, sources: e.sources } : l));
            break;
          case "comparison":
            setLive((l) => (l ? { ...l, comparisons: e.comparisons } : l));
            break;
          case "token":
            setLive((l) => (l ? { ...l, text: l.text + e.text } : l));
            break;
          case "done":
            setMessages((m) => [
              ...m,
              { id: `local_${Date.now()}`, conversationId: e.message.conversationId, role: "user", content: message, createdAt: new Date().toISOString(), metadata: {} },
              e.message,
            ]);
            setLive(null);
            break;
          case "error":
            setLive((l) => (l ? { ...l, error: e.error } : l));
            break;
        }
      };

      try {
        await streamChat({ conversationId: conversationId ?? undefined, message, timezone: browserTimezone() }, onEvent, controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) {
          const e = err as { code?: string; message?: string; retryable?: boolean };
          setLive((l) => (l ? { ...l, error: { code: e.code ?? "NETWORK", message: e.message ?? "Connection failed.", retryable: e.retryable ?? true } } : l));
        } else {
          setLive((l) => (l ? { ...l, error: { code: "CANCELLED", message: "Stopped.", retryable: true } } : l));
        }
      } finally {
        abortRef.current = null;
        creatingRef.current = null;
        onTurnFinished();
      }
    },
    [conversationId, onConversationCreated, onTurnFinished],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const retry = useCallback(() => {
    if (live?.userText) void send(live.userText);
  }, [live, send]);

  return { messages, live, loading, loadError, send, stop, retry, busy: live !== null && !live.error };
}
