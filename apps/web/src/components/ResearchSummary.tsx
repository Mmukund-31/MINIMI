import { CheckCircle2, CircleDashed, ShieldCheck, TriangleAlert } from "lucide-react";
import type { ResearchMeta, SourceRef } from "../lib/api";

const INTENT_LABEL: Record<string, string> = {
  fact_lookup: "Fact lookup",
  general_research: "Research",
  comparison: "Comparison",
};

/**
 * Rendered from metadata computed in code, not from the model's prose: what the sources covered,
 * where they differ, and how the answer's figures were checked against its citations.
 */
export function ResearchSummary({ research, sources }: { research: ResearchMeta; sources: SourceRef[] }) {
  const { coverage, claimCheck } = research;
  const cells = coverage.cells.filter((c) => c.entity || c.aspect);
  const gaps = cells.filter((c) => c.status === "gap");
  const cite = (ids: string[]) =>
    ids.map((id) => {
      const s = sources.find((x) => x.id === id);
      return s ? (
        <a key={id} href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="ml-0.5 text-indigo-600 hover:underline dark:text-indigo-400">
          [{id.slice(1)}]
        </a>
      ) : null;
    });
  const label = (c: { entity: string | null; aspect: string | null }) => [c.entity, c.aspect].filter(Boolean).join(" · ");
  if (cells.length === 0 && claimCheck.checked === 0 && coverage.conflicts.length === 0) return null;
  return (
    <div className="rounded-xl border border-zinc-200 px-3 py-2.5 text-[13px] dark:border-zinc-800">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:text-zinc-400">
        <span>{INTENT_LABEL[research.intent] ?? "Research"} coverage</span>
        <span className="font-normal normal-case">
          · {coverage.rounds} research round{coverage.rounds === 1 ? "" : "s"}
          {coverage.followUpQueries.length > 0 && ` (follow-up for ${coverage.followUpQueries.length} gap${coverage.followUpQueries.length === 1 ? "" : "s"})`}
        </span>
      </div>
      {cells.length > 0 && (
        <ul className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {cells.map((c) => (
            <li key={label(c)} className="flex items-start gap-1.5 text-zinc-700 dark:text-zinc-300">
              {c.status === "verified" ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="verified" />
              ) : c.status === "mentioned" ? (
                <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-600" aria-label="mentioned" />
              ) : (
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" aria-label="not found" />
              )}
              <span>
                {label(c)}
                <span className="text-zinc-500"> · {c.status === "verified" ? "quote-verified" : c.status === "mentioned" ? "in sources, not quote-verified" : "not found in sources"}</span>
                {cite(c.sourceIds)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {coverage.conflicts.map((d) => (
        <div key={label(d) + d.kind} className="mt-1.5 flex items-start gap-1.5 text-amber-800 dark:text-amber-300">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Sources differ on {label(d) || "a key fact"}:{" "}
            {d.values.map((v, i) => (
              <span key={v.sourceId}>
                {i > 0 && " vs "}
                {v.value}
                {cite([v.sourceId])}
              </span>
            ))}
          </span>
        </div>
      ))}
      <div className="mt-1.5 flex items-start gap-1.5 text-[12px] text-zinc-500">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          {claimCheck.checked > 0
            ? `${claimCheck.supported + claimCheck.repaired}/${claimCheck.checked} statements with figures matched their cited sources${claimCheck.repaired ? ` (${claimCheck.repaired} re-cited)` : ""}${claimCheck.removed ? `; ${claimCheck.removed} removed as unsupported` : ""}.`
            : "No figures to check against sources."}
          {gaps.length > 0 && ` ${gaps.length} item${gaps.length === 1 ? "" : "s"} not found in the sources.`}
        </span>
      </div>
    </div>
  );
}
