import type { Comparison, SourceRef } from "../lib/api";

const STATUS: Record<Comparison["status"], { label: string; cls: string; hint: string }> = {
  changed: {
    label: "Changed",
    cls: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900",
    hint: "Comparable terms, different value, backed by a cited source",
  },
  unchanged: {
    label: "Unchanged",
    cls: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900",
    hint: "Comparable terms, same value, backed by a cited source",
  },
  uncertain: {
    label: "Uncertain",
    cls: "bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700",
    hint: "Missing, conflicting or unconfirmed evidence",
  },
  not_comparable: {
    label: "Not comparable",
    cls: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900",
    hint: "Different plan, currency, unit or billing terms",
  },
};

const DIMENSION: Record<NonNullable<Comparison["dimension"]>, string> = {
  price_amount: "price",
  pricing_model: "pricing model",
  billing_terms: "billing terms",
  currency: "currency",
  plan_availability: "plan availability",
  feature: "features",
  evidence: "evidence",
};

export function StatusChip({ status, dimension }: { status: Comparison["status"]; dimension?: Comparison["dimension"] }) {
  const s = STATUS[status];
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <span title={s.hint} className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset ${s.cls}`}>
        {s.label}
      </span>
      {dimension && dimension !== "evidence" && <span className="text-[10px] whitespace-nowrap text-zinc-500">{DIMENSION[dimension]}</span>}
    </span>
  );
}

export function ComparisonTable({ comparisons, sources }: { comparisons: Comparison[]; sources: SourceRef[] }) {
  if (comparisons.length === 0) return null;
  const byId = new Map(sources.map((s) => [s.id, s]));
  const groups: Array<[string, Comparison[]]> = [
    ["Pricing then vs. now", comparisons.filter((c) => c.category === "pricing")],
    ["Product updates since then", comparisons.filter((c) => c.category === "product_update")],
  ];
  return (
    <div className="space-y-4">
      {groups
        .filter(([, rows]) => rows.length > 0)
        .map(([title, rows]) => (
          <div key={title} className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <div className="border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-medium tracking-wide text-zinc-500 uppercase dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
              {title}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="text-xs text-zinc-500 dark:text-zinc-400">
                  <tr className="border-b border-zinc-100 dark:border-zinc-800/70">
                    <th className="px-3 py-2 font-medium">Subject</th>
                    {title.startsWith("Pricing") && <th className="px-3 py-2 font-medium">Then</th>}
                    <th className="px-3 py-2 font-medium">{title.startsWith("Pricing") ? "Now" : "Finding"}</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c, i) => (
                    <tr key={`${c.subject}-${c.attribute}-${i}`} className="border-b border-zinc-100 align-top last:border-0 dark:border-zinc-800/70">
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-zinc-900 dark:text-zinc-100">{c.subject}</div>
                        <div className="text-xs text-zinc-500">{c.attribute}</div>
                      </td>
                      {title.startsWith("Pricing") && <td className="px-3 py-2.5 text-zinc-600 dark:text-zinc-400">{c.previousValue ?? "–"}</td>}
                      <td className="px-3 py-2.5 text-zinc-800 dark:text-zinc-200">
                        <div>{c.currentValue ?? <span className="text-zinc-400">–</span>}</div>
                        <div className="mt-1 text-xs text-zinc-500">
                          {c.explanation}
                          {c.sourceIds.map((id) => {
                            const s = byId.get(id);
                            return s ? (
                              <a key={id} href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.title} className="ml-1 text-indigo-600 hover:underline dark:text-indigo-400">
                                [{id.slice(1)}]
                              </a>
                            ) : null;
                          })}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusChip status={c.status} dimension={c.dimension} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </div>
  );
}
