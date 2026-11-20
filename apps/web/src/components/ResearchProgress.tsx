import { Check, CircleDashed, Database, Globe, Loader2, X } from "lucide-react";
import type { Stage } from "../lib/api";
import type { LiveTurn } from "../hooks/useChat";

const STAGES: Array<{ id: Stage; label: string }> = [
  { id: "analyze", label: "Understanding the question" },
  { id: "temporal", label: "Resolving dates" },
  { id: "memory", label: "Searching past conversations" },
  { id: "plan", label: "Planning research" },
  { id: "search", label: "Searching the web" },
  { id: "evidence", label: "Verifying evidence against sources" },
  { id: "compare", label: "Comparing then vs. now" },
  { id: "coverage", label: "Checking coverage (follow-up searches for gaps)" },
  { id: "synthesize", label: "Writing the answer" },
];

function Icon({ status }: { status?: string }) {
  if (status === "start") return <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />;
  if (status === "done") return <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />;
  if (status === "failed") return <X className="h-3.5 w-3.5 text-rose-500" />;
  return <CircleDashed className="h-3.5 w-3.5 text-zinc-300 dark:text-zinc-600" />;
}

export function ResearchProgress({ live }: { live: LiveTurn }) {
  const visible = STAGES.filter((s) => live.stages[s.id] && live.stages[s.id]!.status !== "skipped");
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 text-[13px] dark:border-zinc-800 dark:bg-zinc-900/40">
      <ul className="space-y-1.5">
        {visible.map((s) => {
          const st = live.stages[s.id]!;
          return (
            <li key={s.id} className="flex items-start gap-2">
              <span className="mt-0.5">
                <Icon status={st.status} />
              </span>
              <span className="text-zinc-700 dark:text-zinc-300">
                {s.label}
                {st.detail && <span className="text-zinc-500"> · {st.detail}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      {live.memory && live.memory.exchanges.length > 0 && (
        <div className="mt-3 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
          {live.memory.exchanges.slice(0, 3).map((e, i) => (
            <div key={i} className="flex items-start gap-2 py-0.5 text-zinc-600 dark:text-zinc-400">
              <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">
                <span className="font-medium text-zinc-700 dark:text-zinc-300">{e.conversationTitle}</span>
                <span className="text-zinc-500"> · {new Date(e.at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                {e.seeded && <span className="ml-1.5 rounded bg-violet-100 px-1 text-[10px] font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">seeded demo</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      {live.searches.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
          {live.searches.map((s) => (
            <div key={s.query} className="flex items-center gap-2 text-zinc-600 dark:text-zinc-400">
              {s.status === "start" ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : s.status === "failed" ? <X className="h-3.5 w-3.5 shrink-0 text-rose-500" /> : <Globe className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{s.query}</span>
              {s.resultCount !== undefined && <span className="shrink-0 text-xs text-zinc-400">{s.resultCount} results{s.status === "cached" ? " · cached" : ""}</span>}
              {s.error && <span className="shrink-0 text-xs text-rose-500">{s.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
