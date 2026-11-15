/**
 * Live evaluation: `npm run eval:live`
 *
 * Runs the official challenge prompts (plus two controls) against the REAL
 * configured LLM provider and Tavily, on a fresh temporary database seeded
 * with the labelled demo conversations. Network results change over time, so
 * this is kept separate from the deterministic test suite.
 *
 * Output: evals/LIVE_REPORT.md (summary + answers) and a full JSON trace in
 * evals/results/. Automatic checks cover retrieval, grounding and citation
 * integrity; factual accuracy of current prices needs a human to open the
 * cited sources (the report lists them).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, loadConfig, loadDotEnv, missingCredentials, type AgentEvent, type Logger, type Message } from "@minimi/core";

const here = dirname(fileURLToPath(import.meta.url));

const CASES: Array<{ id: string; prompt: string; expectMemory?: string; expectSearch: boolean }> = [
  { id: "demo-crm", prompt: "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?", expectMemory: "CRM shortlist", expectSearch: true },
  { id: "demo-nov3", prompt: "What did I ask you on 3 November? Is your answer still correct today?", expectMemory: "Copilot", expectSearch: true },
  { id: "demo-postgres", prompt: "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", expectMemory: "Postgres", expectSearch: true },
  { id: "control-research", prompt: "What is the current price of the Cursor Pro plan?", expectSearch: true },
  { id: "control-chat", prompt: "Thanks! What kinds of questions can you help me with?", expectSearch: false },
];

class CapturingLogger implements Logger {
  readonly entries: Array<{ level: string; msg?: string; obj: Record<string, unknown> }> = [];
  info(obj: object, msg?: string) { this.entries.push({ level: "info", msg, obj: obj as Record<string, unknown> }); }
  warn(obj: object, msg?: string) { this.entries.push({ level: "warn", msg, obj: obj as Record<string, unknown> }); }
  error(obj: object, msg?: string) { this.entries.push({ level: "error", msg, obj: obj as Record<string, unknown> }); }
}

async function main() {
  loadDotEnv();
  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);
  const dbPath = join(here, "results", `live-${Date.now()}.db`);
  mkdirSync(join(here, "results"), { recursive: true });
  const config = loadConfig({ ...process.env, DATABASE_PATH: dbPath, SEED_DEMO_DATA: "true", SEARCH_CACHE_TTL_HOURS: "0" });
  const missing = missingCredentials(config);
  if (missing.length) {
    console.error(`Live evaluation needs real credentials. Missing: ${missing.join(", ")} (set them in .env).`);
    process.exitCode = 2;
    return;
  }
  const logger = new CapturingLogger();
  const runtime = createRuntime(config, { logger });
  const llm = runtime.llm!.describe();
  console.log(`Live eval · provider ${llm.provider} · models ${llm.models.join(", ")} · tz ${config.timezone}\n`);

  const results: Array<Record<string, unknown>> = [];
  for (const c of CASES.filter((x) => !only || x.id === only)) {
    const events: AgentEvent[] = [];
    const t0 = Date.now();
    const logStart = logger.entries.length;
    let message: Message | undefined;
    let error: string | undefined;
    try {
      message = await runtime.agent.run({ message: c.prompt, timezone: config.timezone }, (e) => events.push(e));
    } catch (err) {
      error = `${(err as { code?: string }).code ?? "ERR"}: ${(err as Error).message}`;
    }
    const ms = Date.now() - t0;
    const logs = logger.entries.slice(logStart);
    const meta = message?.metadata;
    const sourcesEvt = events.find((e): e is Extract<AgentEvent, { type: "sources" }> => e.type === "sources");
    const allSourceIds = new Set(sourcesEvt?.sources.map((s) => s.id) ?? []);
    const cites = message ? [...message.content.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]!) : [];
    const rejected = logs.filter((l) => l.msg === "rejected unsupported evidence").flatMap((l) => (l.obj.rejected as unknown[]) ?? []);
    const evidenceKept = message ? runtime.repos.research.evidenceForMessage(message.id).length : 0;
    const memoryTitles = (meta?.memory?.conversationIds ?? []).map((id) => runtime.repos.conversations.get(id)?.title ?? id);
    const searches = events.filter((e): e is Extract<AgentEvent, { type: "search" }> => e.type === "search" && e.status !== "start");

    const checks: Record<string, boolean> = {
      completed: !error,
      memory: c.expectMemory ? memoryTitles.some((t) => t.includes(c.expectMemory!)) : true,
      searchedWhenExpected: c.expectSearch ? searches.length > 0 : searches.length === 0,
      citationsResolve: cites.every((id) => allSourceIds.has(id)),
      citesSomething: c.expectSearch ? cites.length > 0 : true,
    };
    const row = {
      id: c.id,
      prompt: c.prompt,
      pass: Object.values(checks).every(Boolean),
      checks,
      error,
      latencyMs: ms,
      llmCalls: meta?.stats?.llmCalls,
      searchCalls: meta?.stats?.searchCalls,
      tokens: meta?.stats ? meta.stats.usage.inputTokens + meta.stats.usage.outputTokens : undefined,
      stageMs: meta?.stats?.stageMs,
      memory: { status: meta?.memory?.status, titles: memoryTitles, interpretation: meta?.memory?.interpretation },
      searches: searches.map((s) => ({ query: s.query, status: s.status, results: s.resultCount, error: s.error })),
      evidence: { kept: evidenceKept, rejected: rejected.length, rejectedDetail: rejected },
      comparisons: meta?.comparisons ?? [],
      sources: meta?.sources ?? [],
      allSources: sourcesEvt?.sources.map((s) => ({ id: s.id, domain: s.domain, kind: s.kind, title: s.title, url: s.url })) ?? [],
      notes: meta?.notes ?? [],
      answer: message?.content,
    };
    results.push(row);
    console.log(`${row.pass ? "PASS" : "FAIL"} ${c.id} · ${(ms / 1000).toFixed(1)}s · ${row.searchCalls ?? 0} searches · ${row.llmCalls ?? 0} LLM calls · ${row.tokens ?? 0} tokens · evidence ${evidenceKept} kept / ${rejected.length} rejected${error ? ` · ${error}` : ""}`);
    for (const [k, v] of Object.entries(checks)) if (!v) console.log(`   ✗ ${k}`);
  }
  runtime.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });

  const stamp = new Date().toISOString();
  writeFileSync(join(here, "results", `live-${stamp.replace(/[:.]/g, "-")}.json`), JSON.stringify({ ranAt: stamp, provider: llm, results }, null, 2));
  if (!only) writeFileSync(join(here, "LIVE_REPORT.md"), renderReport(stamp, llm, results));
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} live cases passed automatic checks.${only ? "" : " Report: evals/LIVE_REPORT.md"}`);
}

function renderReport(stamp: string, llm: { provider: string; models: string[] }, results: Array<Record<string, unknown>>): string {
  const lines = [
    "# Live evaluation report",
    "",
    `Run on ${stamp} with \`npm run eval:live\` · LLM: ${llm.provider} (${llm.models.join(", ")}) · search: Tavily.`,
    "Fresh temporary database seeded with the labelled demo conversations; search cache disabled.",
    "Automatic checks: completed, retrieved the right conversation, searched when expected, every [S#] resolves to a retrieved source.",
    "**Not automatically checked:** whether current prices are factually right. Open the cited sources below to verify.",
    "",
    "| Case | Result | Latency | LLM calls | Searches | Tokens | Evidence kept / rejected |",
    "|---|---|---|---|---|---|---|",
    ...results.map((r) => {
      const ev = r.evidence as { kept: number; rejected: number };
      return `| ${r.id} | ${r.pass ? "pass" : "**fail**"} | ${((r.latencyMs as number) / 1000).toFixed(1)}s | ${r.llmCalls ?? "-"} | ${r.searchCalls ?? "-"} | ${r.tokens ?? "-"} | ${ev.kept} / ${ev.rejected} |`;
    }),
    "",
  ];
  for (const r of results) {
    lines.push(`## ${r.id}`, "", `> ${r.prompt}`, "");
    if (r.error) lines.push(`**Error:** ${r.error}`, "");
    const mem = r.memory as { status?: string; titles: string[]; interpretation?: string };
    if (mem.status) lines.push(`- Memory: ${mem.status}${mem.titles.length ? ` (${mem.titles.join(", ")})` : ""}${mem.interpretation ? `, ${mem.interpretation}` : ""}`);
    const s = r.searches as Array<{ query: string; status: string; results?: number }>;
    if (s.length) lines.push(`- Searches: ${s.map((x) => `"${x.query}" (${x.status}, ${x.results ?? 0})`).join("; ")}`);
    const notes = r.notes as string[];
    if (notes.length) lines.push(`- Notes: ${notes.join(" ")}`);
    const cmp = r.comparisons as Array<{ subject: string; category: string; attribute: string; previousValue?: string; currentValue?: string; status: string }>;
    if (cmp.length) {
      lines.push("", "| Subject | Category | Then | Now | Status |", "|---|---|---|---|---|");
      for (const c of cmp) lines.push(`| ${c.subject} (${c.attribute}) | ${c.category} | ${c.previousValue ?? "-"} | ${c.currentValue ?? "-"} | ${c.status} |`);
    }
    lines.push("", "**Answer:**", "", String(r.answer ?? "(none)"), "");
    const src = r.sources as Array<{ id: string; title: string; url: string; publishedAt?: string }>;
    if (src.length) lines.push("**Sources:**", "", ...src.map((x) => `- [${x.id}] ${x.title} (${x.url})${x.publishedAt ? `, published ${x.publishedAt.slice(0, 10)}` : ""}`), "");
  }
  return lines.join("\n");
}

void main();
