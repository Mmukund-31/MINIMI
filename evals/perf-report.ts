/**
 * `npm run eval:perf`: performance and resilience summary computed from saved live runs
 * (evals/results/live-*.json). No API calls. Only complete runs with no quota failures count.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown> & { id: string };
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "results");
const runs = readdirSync(dir)
  .filter((f) => /^live-.*\.json$/.test(f))
  .sort()
  .map((f) => ({ f, j: JSON.parse(readFileSync(join(dir, f), "utf8")) as { ranAt: string; results: Row[] } }))
  .filter(({ j }) => j.results.length >= 5 && !j.results.some((r) => /LLM_RATE_LIMIT/.test(String(r.error ?? ""))));

const research = runs.flatMap(({ j }) => j.results.filter((r) => r.id !== "control-chat" && !r.error));
const num = (r: Row, k: string) => Number(r[k] ?? 0);
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : 0;
};

console.log(`Runs analysed: ${runs.length} complete runs without quota failures; ${research.length} research answers.\n`);
console.log("| Metric | avg | p50 | p90 | max |");
console.log("|---|---|---|---|---|");
for (const [label, key] of [["Searches per answer", "searchCalls"], ["LLM calls per answer", "llmCalls"], ["Tokens per answer", "tokens"], ["Latency (ms)", "latencyMs"]] as const) {
  const xs = research.map((r) => num(r, key));
  console.log(`| ${label} | ${avg(xs).toFixed(0)} | ${pct(xs, 50)} | ${pct(xs, 90)} | ${Math.max(...xs)} |`);
}

const stages = ["analyze", "plan", "search", "evidence", "synthesize"];
console.log("\n| Stage | avg ms | p90 ms |");
console.log("|---|---|---|");
for (const s of stages) {
  const xs = research.map((r) => Number((r.stageMs as Record<string, number> | undefined)?.[s] ?? 0)).filter((x) => x > 0);
  console.log(`| ${s} | ${avg(xs).toFixed(0)} | ${pct(xs, 90)} |`);
}

const fallback = research.filter((r) => ((r.notes ?? []) as string[]).some((n) => /rate-limited/.test(n))).length;
const failedSearches = research.flatMap((r) => (r.searches ?? []) as Array<{ status: string }>).filter((s) => s.status === "failed" || s.status === "timeout").length;
const totalSearches = research.flatMap((r) => (r.searches ?? []) as unknown[]).length;
console.log(`\nExtraction fallback used: ${fallback}/${research.length} research answers.`);
console.log(`Search failures/timeouts: ${failedSearches}/${totalSearches} searches.`);

// Search budget vs CRM coverage (the case that hits the budget).
console.log("\n| CRM run | searches | graded correct | abstained | wrong |");
console.log("|---|---|---|---|---|");
for (const { j } of runs) {
  const crm = j.results.find((r) => r.id === "demo-crm");
  const g = (crm?.graded ?? []) as Array<{ grade: string }>;
  if (!crm || !g.length) continue;
  const c = (k: string) => g.filter((x) => x.grade === k).length;
  console.log(`| ${j.ranAt.slice(0, 16)} | ${num(crm, "searchCalls")} | ${c("correct")} | ${c("abstained")} | ${c("wrong")} |`);
}
