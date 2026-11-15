import { MessageSquare, Plus, Search, Trash2 } from "lucide-react";
import type { ConversationListItem, Health } from "../lib/api";

function relative(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "short" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function Sidebar(props: {
  conversations: ConversationListItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  health: Health | null;
}) {
  const { conversations, activeId, onSelect, onNew, onDelete, health } = props;
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/70 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 text-white dark:bg-white dark:text-zinc-900">
          <Search className="h-4 w-4" strokeWidth={2.5} />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight">Minimi</div>
          <div className="text-[11px] text-zinc-500">Research agent</div>
        </div>
      </div>
      <div className="px-3">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-xs transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
        >
          <Plus className="h-4 w-4" /> New conversation
        </button>
      </div>
      <nav className="mt-3 flex-1 overflow-y-auto px-2 pb-3" aria-label="Conversation history">
        {conversations.length === 0 && <div className="px-3 py-6 text-center text-xs text-zinc-500">No conversations yet</div>}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`group flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-sm transition ${
              c.id === activeId ? "bg-zinc-200/70 dark:bg-zinc-800" : "hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
            }`}
            onClick={() => onSelect(c.id)}
          >
            <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-zinc-800 dark:text-zinc-200">{c.title.replace(/^\[Demo\]\s*/, "")}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
                {c.seeded && <span className="rounded bg-violet-100 px-1 font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">seeded demo</span>}
                <span>{relative(c.lastMessageAt ?? c.updatedAt)}</span>
              </div>
            </div>
            <button
              aria-label="Delete conversation"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete "${c.title}"?`)) onDelete(c.id);
              }}
              className="invisible rounded p-0.5 text-zinc-400 group-hover:visible hover:text-rose-600"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </nav>
      {health && (
        <div className="border-t border-zinc-200 px-4 py-3 text-[11px] text-zinc-500 dark:border-zinc-800">
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${health.llm.configured ? "bg-emerald-500" : "bg-rose-500"}`} />
            <span className="truncate" title={health.llm.models.join(", ")}>
              {health.llm.configured ? `${health.llm.provider} · ${health.llm.models.map((m) => m.replace(/^.*\//, "")).join(" + ")}` : "LLM not configured"}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${health.search.configured ? "bg-emerald-500" : "bg-amber-500"}`} />
            {health.search.configured ? `Web search: ${health.search.provider}` : "Web search not configured"}
          </div>
        </div>
      )}
    </aside>
  );
}
