import { ExternalLink } from "lucide-react";
import type { SourceRef } from "../lib/api";

const KIND_LABEL: Record<SourceRef["kind"], string> = {
  official_pricing: "Official pricing",
  official_changelog: "Official update",
  official: "Official",
  news: "News",
  third_party: "Third-party",
};

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null);

export function SourceList({ sources }: { sources: SourceRef[] }) {
  if (sources.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">Sources</div>
      <ol className="grid gap-1.5 sm:grid-cols-2">
        {sources.map((s) => (
          <li key={s.id}>
            <a
              href={s.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="group flex h-full items-start gap-2 rounded-lg border border-zinc-200 px-2.5 py-2 transition hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:border-zinc-700 dark:hover:bg-zinc-900"
            >
              <span className="mt-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded bg-zinc-100 px-1 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {s.id.slice(1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-1 text-[13px] font-medium text-zinc-800 group-hover:text-indigo-700 dark:text-zinc-200 dark:group-hover:text-indigo-300">
                  {s.title}
                </span>
                <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-zinc-500">
                  <span>{s.domain}</span>
                  <span aria-hidden>·</span>
                  <span>{KIND_LABEL[s.kind]}</span>
                  {s.publishedAt ? (
                    <>
                      <span aria-hidden>·</span>
                      <span>published {fmt(s.publishedAt)}</span>
                    </>
                  ) : (
                    <>
                      <span aria-hidden>·</span>
                      <span>no publish date · retrieved {fmt(s.retrievedAt)}</span>
                    </>
                  )}
                </span>
              </span>
              <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
