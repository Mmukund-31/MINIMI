import { useState } from "react";
import { AlertTriangle, ChevronDown, Database, Info, RotateCcw, Sparkles } from "lucide-react";
import type { Message } from "../lib/api";
import type { LiveTurn } from "../hooks/useChat";
import { ComparisonTable } from "./ComparisonTable";
import { Markdown } from "./Markdown";
import { ResearchProgress } from "./ResearchProgress";
import { SourceList } from "./SourceList";

export function UserBubble({ text, seeded, at }: { text: string; seeded?: boolean; at?: string }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-zinc-100 px-4 py-2.5 text-[15px] leading-6 whitespace-pre-wrap text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100">
        {text}
      </div>
      {(seeded || at) && (
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
          {seeded && <span className="rounded bg-violet-100 px-1 font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">seeded demo</span>}
          {at && <span>{new Date(at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>}
        </div>
      )}
    </div>
  );
}

function Details({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const m = message.metadata;
  const stats = m.stats;
  const hasNotes = (m.notes?.length ?? 0) > 0;
  if (!stats && !hasNotes && m.memory?.status !== "found") return null;
  return (
    <div className="text-xs text-zinc-500">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-300">
        <ChevronDown className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`} />
        How this answer was produced
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          {m.memory?.status === "found" && (
            <div className="flex gap-2">
              <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Memory: {m.memory.interpretation}{m.memory.seeded ? " (seeded demo conversation)" : ""}</span>
            </div>
          )}
          {m.memory?.status === "not_found" && (
            <div className="flex gap-2">
              <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>Memory: no matching conversation found</span>
            </div>
          )}
          {m.notes?.map((n, i) => (
            <div key={i} className="flex gap-2">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{n}</span>
            </div>
          ))}
          {stats && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-zinc-100 pt-2 font-mono text-[11px] dark:border-zinc-800">
              <span>{stats.searchCalls} searches{stats.cacheHits ? ` (${stats.cacheHits} cached)` : ""}</span>
              <span>{stats.llmCalls} model calls</span>
              <span>{(stats.usage.inputTokens + stats.usage.outputTokens).toLocaleString()} tokens</span>
              <span>{(stats.totalMs / 1000).toFixed(1)}s</span>
              <span>{stats.models.join(", ")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AssistantMessage({ message, onFollowUp, isLast }: { message: Message; onFollowUp: (q: string) => void; isLast: boolean }) {
  const m = message.metadata;
  const sources = m.sources ?? [];
  return (
    <div className="space-y-4">
      {m.seeded && <div className="text-[11px]"><span className="rounded bg-violet-100 px-1 font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">seeded demo</span></div>}
      {m.status === "error" && (
        <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5" /> Interrupted answer: may be incomplete. Send the question again to retry.
        </div>
      )}
      <Markdown text={message.content} sources={sources} />
      {m.comparisons && m.comparisons.length > 0 && <ComparisonTable comparisons={m.comparisons} sources={sources} />}
      {m.offering && m.offering.length > 0 && (
        <div className="rounded-xl border border-zinc-200 px-3 py-2.5 text-[13px] dark:border-zinc-800">
          <div className="mb-1.5 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Also offered now (not in the earlier answer)</div>
          {m.offering.map((o) => (
            <div key={o.subject} className="py-0.5 text-zinc-700 dark:text-zinc-300">
              <span className="font-medium">{o.subject}:</span>{" "}
              {o.plansNotDiscussed.map((p, i) => {
                const s = sources.find((x) => x.id === p.sourceId);
                return (
                  <span key={p.plan}>
                    {i > 0 && "; "}
                    {p.plan} ({p.value})
                    {s && (
                      <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="ml-0.5 text-indigo-600 hover:underline dark:text-indigo-400">
                        [{s.id.slice(1)}]
                      </a>
                    )}
                  </span>
                );
              })}
            </div>
          ))}
          <div className="mt-1 text-[11px] text-zinc-500">These may be new or may simply not have been discussed earlier.</div>
        </div>
      )}
      <SourceList sources={sources} />
      <Details message={message} />
      {isLast && m.followUps && m.followUps.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {m.followUps.map((f) => (
            <button
              key={f}
              onClick={() => onFollowUp(f)}
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1 text-[13px] text-zinc-700 transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function LiveAssistant({ live, onRetry }: { live: LiveTurn; onRetry: () => void }) {
  const writing = live.stages.synthesize?.status === "start";
  return (
    <div className="space-y-4">
      {(!live.text || live.error) && <ResearchProgress live={live} />}
      {live.text && <Markdown text={live.text} sources={live.sources} streaming={writing && !live.error} />}
      {live.comparisons.length > 0 && live.text && <ComparisonTable comparisons={live.comparisons} sources={live.sources} />}
      {live.error && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">{live.error.code === "CANCELLED" ? "Stopped" : "Something went wrong"}</div>
            <div className="mt-0.5 text-rose-700/90 dark:text-rose-300/80">{live.error.message}</div>
          </div>
          {live.error.retryable && (
            <button onClick={onRetry} className="inline-flex items-center gap-1 rounded-md border border-rose-300 px-2 py-1 text-xs font-medium hover:bg-rose-100 dark:border-rose-800 dark:hover:bg-rose-900/40">
              <RotateCcw className="h-3.5 w-3.5" /> Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
