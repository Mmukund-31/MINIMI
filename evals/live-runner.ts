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
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntime, loadConfig, loadDotEnv, missingCredentials, type AgentEvent, type Comparison, type Logger, type Message } from "@minimi/core";
import { gradeEntry, gradeOffering, rowMentionsEntity, structuralChecks, summarizeGrades, updateChecks, type GradedEntry, type GroundTruthEntry, type OfferingGrade, type OfferingTruth } from "./grading";

const here = dirname(fileURLToPath(import.meta.url));
const groundTruth = JSON.parse(readFileSync(join(here, "ground-truth.json"), "utf8")) as { fetchedAt: string; humanReviewedAt?: string; cases: Record<string, GroundTruthEntry[]>; offering?: Record<string, OfferingTruth[]> };
// Groq counts requested max_tokens against the per-minute limit; consecutive research cases need a pause.
const PAUSE_MS = Number(process.env.LIVE_EVAL_PAUSE_MS ?? 20_000);

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

/**
 * `--from=<saved run json>`: re-render LIVE_REPORT.md from a saved run without calling any API.
 * Ground-truth grading, offering (completeness) grading and the entity check are recomputed; every
 * other check and all system outputs are exactly as recorded in that run.
 */
function rerenderFrom(file: string) {
  const saved = JSON.parse(readFileSync(file, "utf8")) as { ranAt: string; provider: { provider: string; models: string[] }; results: Array<Record<string, unknown>> };
  for (const r of saved.results) {
    const comparisons = (r.comparisons ?? []) as Comparison[];
    const truth = groundTruth.cases[r.id as string] ?? [];
    r.graded = truth.map((e) => gradeEntry(e, comparisons));
    r.gradeSummary = summarizeGrades(r.graded as GradedEntry[]);
    // Completeness (offering) grades are recomputed too, so review-label changes show up.
    r.offeringGrades = (groundTruth.offering?.[r.id as string] ?? []).map((o) => gradeOffering(o, (r.offering ?? []) as Parameters<typeof gradeOffering>[1]));
    const checks = r.checks as Record<string, boolean>;
    checks.entitiesCovered = [...new Set(truth.map((t) => t.subject))].every((s) => comparisons.some((x) => rowMentionsEntity(x, s)));
    r.pass = Object.values(checks).every(Boolean);
    r.violations ??= [];
    r.planAttribution ??= { verified: 0, total: 0 };
  }
  const note = `Re-rendered from the saved run \`${file.replace(/.*[\\/]/, "")}\`; ground-truth and completeness grading and the entity check were recomputed with the current grader and ground truth, everything else is as recorded.`;
  writeFileSync(join(here, "LIVE_REPORT.md"), renderReport(saved.ranAt, saved.provider, saved.results, note));
  console.log(`Re-rendered evals/LIVE_REPORT.md from ${file}`);
}

/** Summary of every complete saved run, to show run-to-run variance honestly. */
function runHistory(): string[] {
  const dir = join(here, "results");
  const rows: string[] = [];
  for (const f of readdirSync(dir).filter((x) => /^live-.*\.json$/.test(x)).sort()) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { ranAt: string; results: Array<Record<string, unknown>> };
      if (j.results.length < CASES.length) continue;
      const g = j.results.flatMap((r) => (r.graded ?? []) as GradedEntry[]);
      const count = (k: string) => g.filter((x) => x.grade === k).length;
      const fallback = j.results.filter((r) => ((r.notes ?? []) as string[]).some((n) => /rate-limited/.test(n))).length;
      const quotaOut = j.results.filter((r) => /LLM_RATE_LIMIT/.test(String(r.error ?? ""))).length;
      const grades = j.results.some((r) => "graded" in r) ? `${count("correct")} / ${count("abstained")} / ${count("wrong")} / ${count("missing")}` : "– (run predates grading)";
      rows.push(`| ${j.ranAt.slice(0, 16).replace("T", " ")} | ${j.results.filter((r) => r.pass).length}/${j.results.length} | ${grades} | ${fallback ? `${fallback} case(s) used the fallback extractor` : ""}${quotaOut ? `${fallback ? "; " : ""}${quotaOut} case(s) failed: daily quota exhausted` : ""} |`);
    } catch {
      /* skip unreadable files */
    }
  }
  return rows;
}

async function main() {
  loadDotEnv();
  const from = process.argv.find((a) => a.startsWith("--from="))?.slice(7);
  if (from) return rerenderFrom(from);
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
    if (results.length > 0 && PAUSE_MS > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
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

    const comparisons = meta?.comparisons ?? [];
    const truth = groundTruth.cases[c.id] ?? [];
    const graded = truth.map((e) => gradeEntry(e, comparisons));
    const violations = [
      ...structuralChecks({
        comparisons,
        sources: sourcesEvt?.sources ?? [],
        baselineDate: meta?.memory?.baselineDate,
        answer: message?.content ?? "",
        retrievedSourceIds: allSourceIds,
      }),
      ...updateChecks({ comparisons, sources: sourcesEvt?.sources ?? [], baselineDate: meta?.memory?.baselineDate, answer: message?.content ?? "" }),
    ];
    const offering = meta?.offering ?? [];
    const offeringGrades = (groundTruth.offering?.[c.id] ?? []).map((o) => gradeOffering(o, offering));
    const evRows = message ? runtime.repos.research.evidenceForMessage(message.id) : [];
    const pricingEv = evRows.map((r) => JSON.parse(String(r.metadata)) as { category?: string; planVerified?: boolean }).filter((m) => m.category === "pricing");

    const checks: Record<string, boolean> = {
      completed: !error,
      historicalConversation: c.expectMemory ? memoryTitles.some((t) => t.includes(c.expectMemory!)) : true,
      searchedWhenExpected: c.expectSearch ? searches.length > 0 : searches.length === 0,
      citationsResolve: cites.every((id) => allSourceIds.has(id)),
      citesSomething: c.expectSearch ? cites.length > 0 : true,
      // Correct entities: every vendor from the earlier conversation gets a comparison row.
      entitiesCovered: [...new Set(truth.map((t) => t.subject))].every((s) => comparisons.some((x) => rowMentionsEntity(x, s))),
      structural: violations.length === 0,
    };
    const row = {
      id: c.id,
      prompt: c.prompt,
      pass: Object.values(checks).every(Boolean),
      checks,
      graded,
      gradeSummary: summarizeGrades(graded),
      violations,
      planAttribution: { verified: pricingEv.filter((m) => m.planVerified).length, total: pricingEv.length },
      offering,
      offeringGrades,
      error,
      latencyMs: ms,
      llmCalls: meta?.stats?.llmCalls,
      searchCalls: meta?.stats?.searchCalls,
      tokens: meta?.stats ? meta.stats.usage.inputTokens + meta.stats.usage.outputTokens : undefined,
      stageMs: meta?.stats?.stageMs,
      memory: { status: meta?.memory?.status, titles: memoryTitles, interpretation: meta?.memory?.interpretation },
      searches: searches.map((s) => ({ query: s.query, status: s.status, results: s.resultCount, error: s.error })),
      evidence: { kept: evidenceKept, rejected: rejected.length, rejectedDetail: rejected },
      comparisons,
      sources: meta?.sources ?? [],
      allSources: sourcesEvt?.sources.map((s) => ({ id: s.id, domain: s.domain, kind: s.kind, title: s.title, url: s.url })) ?? [],
      notes: meta?.notes ?? [],
      warnings: logs.filter((l) => l.level !== "info").map((l) => ({ level: l.level, msg: l.msg, err: (l.obj as { err?: unknown }).err })),
      answer: message?.content,
    };
    results.push(row);
    console.log(`${row.pass ? "PASS" : "FAIL"} ${c.id} · ${(ms / 1000).toFixed(1)}s · ${row.searchCalls ?? 0} searches · ${row.llmCalls ?? 0} LLM calls · ${row.tokens ?? 0} tokens · evidence ${evidenceKept} kept / ${rejected.length} rejected${error ? ` · ${error}` : ""}`);
    for (const [k, v] of Object.entries(checks)) if (!v) console.log(`   ✗ ${k}`);
    for (const v of violations) console.log(`   ✗ ${v.check}: ${v.detail}`);
    const gs = row.gradeSummary;
    if (gs.gradable) console.log(`   ground truth${gs.provisional ? " (PROVISIONAL)" : ""}: ${gs.correct} correct · ${gs.abstained} abstained · ${gs.wrong} wrong · ${gs.missing} missing · ${gs.ungraded} ungraded`);
    for (const g of graded.filter((x) => x.grade === "wrong" || x.grade === "missing")) console.log(`   ✗ ${g.subject} ${g.plan}: ${g.grade} (${g.reason})`);
  }
  runtime.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });

  const stamp = new Date().toISOString();
  writeFileSync(join(here, "results", `live-${stamp.replace(/[:.]/g, "-")}.json`), JSON.stringify({ ranAt: stamp, provider: llm, results }, null, 2));
  if (!only) writeFileSync(join(here, "LIVE_REPORT.md"), renderReport(stamp, llm, results));
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} live cases passed automatic checks.${only ? "" : " Report: evals/LIVE_REPORT.md"}`);
}

function renderReport(stamp: string, llm: { provider: string; models: string[] }, results: Array<Record<string, unknown>>, note?: string): string {
  const lines = [
    "# Live evaluation report",
    "",
    `Run on ${stamp} with \`npm run eval:live\` · LLM: ${llm.provider} (${llm.models.join(", ")}) · search: Tavily.${note ? ` ${note}` : ""}`,
    `Fresh temporary database seeded with the labelled demo conversations; search cache disabled; ${PAUSE_MS / 1000}s pause between cases (one user asking one question at a time; Groq free-tier limits are per minute).`,
    "",
    "**Automatic checks (pass/fail):** completed · retrieved the right earlier conversation · searched when expected · every [S#] resolves to a retrieved source · research answers cite something · every vendor from the earlier conversation has a comparison row · structural checks (no verdict without an official source or an explicit third-party qualification, no amount change across incompatible terms, no 'changed' resting on a page published before the conversation).",
    "",
    `**Ground-truth grading** uses [ground-truth.json](ground-truth.json). Official pages were first fetched ${groundTruth.fetchedAt}${groundTruth.humanReviewedAt ? `; the project author re-reviewed the expectations on ${groundTruth.humanReviewedAt} and marked every graded entry \`human-confirmed\` (a review date, separate from the run date above)` : ""}. ${results.some((r) => (r.gradeSummary as { provisional?: boolean } | undefined)?.provisional) ? "Some graded entries in this run are not `human-confirmed`, so their grades are **PROVISIONAL**." : "Every grade in this run uses `human-confirmed` entries, so none is provisional."} Vendor/plan entries whose price could not be verified on the official page have no expected value and stay ungraded (never guessed). *abstained* = honest uncertain/not-comparable where a verdict was possible; *wrong* = a confident verdict the ground truth contradicts.`,
    "",
    "| Case | Auto checks | Ground truth (correct / abstained / wrong / missing · ungraded) | Plan attribution verified | Latency | LLM calls | Searches | Tokens | Evidence kept / rejected |",
    "|---|---|---|---|---|---|---|---|---|",
    ...results.map((r) => {
      const ev = r.evidence as { kept: number; rejected: number };
      const g = r.gradeSummary as ReturnType<typeof summarizeGrades>;
      const pa = r.planAttribution as { verified: number; total: number };
      const gt = g.gradable ? `${g.correct} / ${g.abstained} / ${g.wrong} / ${g.missing} · ${g.ungraded}${g.provisional ? " (provisional)" : ""}` : "–";
      return `| ${r.id} | ${r.pass ? "pass" : "**fail**"} | ${gt} | ${pa.total ? `${pa.verified}/${pa.total}` : "–"} | ${((r.latencyMs as number) / 1000).toFixed(1)}s | ${r.llmCalls ?? "-"} | ${r.searchCalls ?? "-"} | ${r.tokens ?? "-"} | ${ev.kept} / ${ev.rejected} |`;
    }),
    "",
  ];
  for (const r of results) {
    lines.push(`## ${r.id}`, "", `> ${r.prompt}`, "");
    if (r.error) lines.push(`**Error:** ${r.error}`, "");
    const failed = Object.entries(r.checks as Record<string, boolean>).filter(([, v]) => !v).map(([k]) => k);
    if (failed.length) lines.push(`- Failed checks: ${failed.join(", ")}`);
    for (const v of r.violations as Array<{ check: string; detail: string }>) lines.push(`- Structural violation (${v.check}): ${v.detail}`);
    const graded = r.graded as GradedEntry[];
    if (graded.length) {
      lines.push("", "| Ground truth | Grade | System said | Why |", "|---|---|---|---|");
      for (const g of graded) lines.push(`| ${g.subject} · ${g.plan} | ${g.grade} | ${g.got ? `${g.got.status} (${g.got.dimension})` : "–"} | ${g.reason} |`);
      lines.push("");
    }
    const og = (r.offeringGrades ?? []) as OfferingGrade[];
    const offeringNotes = (r.offering ?? []) as Array<{ subject: string; plansNotDiscussed: Array<{ plan: string; value: string }> }>;
    if (og.length || offeringNotes.length) {
      lines.push("**Completeness (current plans not in the earlier answer):**", "");
      for (const n of offeringNotes) lines.push(`- System listed for ${n.subject}: ${n.plansNotDiscussed.map((p) => `${p.plan} (${p.value})`).join("; ")}`);
      for (const g of og) lines.push(`- Ground truth${g.provisional ? " (provisional)" : ""} for ${g.subject}: found ${g.found.join(", ") || "none"}${g.missed.length ? `; missed ${g.missed.join(", ")}` : ""}`);
      lines.push("");
    }
    const mem = r.memory as { status?: string; titles: string[]; interpretation?: string };
    if (mem.status) lines.push(`- Memory: ${mem.status}${mem.titles.length ? ` (${mem.titles.join(", ")})` : ""}${mem.interpretation ? `, ${mem.interpretation}` : ""}`);
    const s = r.searches as Array<{ query: string; status: string; results?: number }>;
    if (s.length) lines.push(`- Searches: ${s.map((x) => `"${x.query}" (${x.status}, ${x.results ?? 0})`).join("; ")}`);
    const notes = r.notes as string[];
    if (notes.length) lines.push(`- Notes: ${notes.join(" ")}`);
    const cmp = r.comparisons as Array<{ subject: string; category: string; attribute: string; previousValue?: string; currentValue?: string; status: string; dimension: string }>;
    if (cmp.length) {
      lines.push("", "| Subject | Category | Then | Now | Status | Dimension |", "|---|---|---|---|---|---|");
      for (const c of cmp) lines.push(`| ${c.subject} (${c.attribute}) | ${c.category} | ${c.previousValue ?? "-"} | ${c.currentValue ?? "-"} | ${c.status} | ${c.dimension} |`);
    }
    lines.push("", "**Answer:**", "", String(r.answer ?? "(none)"), "");
    const src = r.sources as Array<{ id: string; title: string; url: string; publishedAt?: string }>;
    if (src.length) lines.push("**Sources:**", "", ...src.map((x) => `- [${x.id}] ${x.title} (${x.url})${x.publishedAt ? `, published ${x.publishedAt.slice(0, 10)}` : ""}`), "");
  }
  const history = runHistory();
  if (history.length) {
    lines.push("## Run history", "", `Every complete live run saved in \`evals/results/\` (checks and grades as recorded by the code and ground truth of that time, not re-graded with the current grader; grades recorded before the human review${groundTruth.humanReviewedAt ? ` on ${groundTruth.humanReviewedAt}, including that morning's development runs,` : ""} were made against then-provisional ground truth, and the review changed no expectation; earlier runs had fewer checks; live results vary because search results and model outputs vary).`, "", "| Run (UTC) | Auto checks | Ground truth correct / abstained / wrong / missing | Notes |", "|---|---|---|---|", ...history, "");
  }
  return lines.join("\n");
}

void main();
