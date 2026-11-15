import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CalendarClock, Database, Globe } from "lucide-react";
import { api, type ConversationListItem, type Health } from "./lib/api";
import { useChat } from "./hooks/useChat";
import { Sidebar } from "./components/Sidebar";
import { Composer } from "./components/Composer";
import { AssistantMessage, LiveAssistant, UserBubble } from "./components/MessageItem";

const DEMO_PROMPTS = [
  {
    icon: Globe,
    text: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?",
  },
  { icon: CalendarClock, text: "What did I ask you on 3 November? Is your answer still correct today?" },
  { icon: Database, text: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" },
];

const idFromHash = (): string | null => /^#\/c\/(conv_[a-z0-9]+)$/i.exec(window.location.hash)?.[1] ?? null;

export default function App() {
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(idFromHash);

  // Keep the open conversation in the URL (#/c/<id>) so refresh and links work.
  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    const hash = id ? `#/c/${id}` : "";
    if (window.location.hash !== hash) history.replaceState(null, "", hash || window.location.pathname);
  }, []);
  useEffect(() => {
    const onHash = () => setActiveIdState(idFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const [health, setHealth] = useState<Health | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(() => {
    api.listConversations().then((r) => setConversations(r.conversations)).catch(() => {});
  }, []);

  useEffect(() => {
    refreshList();
    api.health().then(setHealth).catch(() => setHealth(null));
  }, [refreshList]);

  const onCreated = useCallback((id: string) => setActiveId(id), [setActiveId]);
  const chat = useChat(activeId, onCreated, refreshList);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length, chat.live?.text, chat.live?.stages, chat.live?.searches.length]);

  const active = conversations.find((c) => c.id === activeId);
  const empty = chat.messages.length === 0 && !chat.live && !chat.loading;

  return (
    <div className="flex h-full">
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={(id) => !chat.busy && setActiveId(id)}
        onNew={() => !chat.busy && setActiveId(null)}
        onDelete={(id) => {
          api.deleteConversation(id).then(() => {
            if (id === activeId) setActiveId(null);
            refreshList();
          });
        }}
        health={health}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-zinc-200 px-6 text-sm dark:border-zinc-800">
          <span className="truncate font-medium text-zinc-800 dark:text-zinc-200">{active?.title.replace(/^\[Demo\]\s*/, "") ?? "New conversation"}</span>
          {active?.seeded && (
            <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300" title="This conversation was inserted as demonstration data. It is not real user history.">
              Seeded demo data
            </span>
          )}
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-6 py-8">
            {health && health.missing.length > 0 && (
              <div className="mb-6 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Missing configuration: <code className="font-mono text-xs">{health.missing.join(", ")}</code>. Add the keys to <code className="font-mono text-xs">.env</code> (see{" "}
                  <code className="font-mono text-xs">.env.example</code>) and restart <code className="font-mono text-xs">npm run dev</code>.
                </span>
              </div>
            )}

            {empty && (
              <div className="pt-10">
                <h1 className="text-2xl font-semibold tracking-tight">What should we look into?</h1>
                <p className="mt-2 max-w-xl text-[15px] text-zinc-500">
                  I remember our past conversations and check the web for what's changed since. Every claim links to a source. When I can't verify something, I say so.
                </p>
                <div className="mt-8 grid gap-2">
                  <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase">Try the challenge scenarios (uses seeded demo history)</div>
                  {DEMO_PROMPTS.map(({ icon: Icon, text }) => (
                    <button
                      key={text}
                      onClick={() => void chat.send(text)}
                      className="flex items-start gap-3 rounded-xl border border-zinc-200 px-4 py-3 text-left text-[14px] text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {chat.loadError && <div className="text-sm text-rose-600">Couldn't load this conversation: {chat.loadError}</div>}

            <div className="space-y-8">
              {chat.messages.map((m, i) =>
                m.role === "user" ? (
                  <UserBubble key={m.id} text={m.content} seeded={m.metadata.seeded} at={m.metadata.seeded ? m.createdAt : undefined} />
                ) : (
                  <AssistantMessage key={m.id} message={m} isLast={i === chat.messages.length - 1 && !chat.live} onFollowUp={(q) => void chat.send(q)} />
                ),
              )}
              {chat.live && (
                <>
                  <UserBubble text={chat.live.userText} />
                  <LiveAssistant live={chat.live} onRetry={chat.retry} />
                </>
              )}
            </div>
          </div>
        </div>

        <div className="shrink-0 px-6 pt-2 pb-5">
          <div className="mx-auto w-full max-w-3xl">
            <Composer onSend={(t) => void chat.send(t)} onStop={chat.stop} busy={chat.busy} />
          </div>
        </div>
      </main>
    </div>
  );
}
