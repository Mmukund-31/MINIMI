/**
 * Evaluation primitives. A scenario runs real system code (with deterministic
 * test doubles for the LLM and search where needed) and returns pass/fail plus
 * metric contributions that the runner aggregates.
 */
import {
  comparePricing,
  compareProductUpdates,
  createRepositories,
  MemoryRetriever,
  openDatabase,
  resolveTemporal,
  seedDemoData,
  type ChangeStatus,
  type Comparison,
  type Evidence,
  type HistoricalClaim,
  type Message,
} from "@minimi/core";
import type { FixtureEntry, ScriptedLLMOptions } from "@minimi/core/testing";
import { FIXED_NOW, TZ } from "./fixtures/demo-fixtures";
import { eventsOf, makeRuntime, runTurn } from "./harness";

export type Category =
  | "memory"
  | "temporal"
  | "web_research"
  | "pricing"
  | "product_update"
  | "multi_turn"
  | "uncertainty"
  | "adversarial";

export interface Metrics {
  retrieval?: { tp: number; fp: number; fn: number };
  date?: { correct: number; total: number };
  change?: { tp: number; fp: number; fn: number; tn: number };
  status?: { correct: number; total: number };
  citations?: { valid: number; total: number };
  evidence?: { kept: number; proposed: number; plantedFabrications: number; plantedSurvived: number };
  searchCalls?: number;
  llmCalls?: number;
  latencyMs?: number;
  tokens?: number;
  errored?: boolean;
}

export interface Outcome {
  pass: boolean;
  failures: string[];
  metrics: Metrics;
}

export interface Scenario {
  id: string;
  category: Category;
  description: string;
  run: () => Promise<Outcome>;
}

const ok = (failures: string[], metrics: Metrics): Outcome => ({ pass: failures.length === 0, failures, metrics });

// ── Temporal ──────────────────────────────────────────────────────────────

export function temporalScenario(id: string, text: string, expected: { dates: string[]; ambiguous?: boolean; now?: string; tz?: string }, description = text): Scenario {
  return {
    id,
    category: "temporal",
    description,
    run: async () => {
      const r = resolveTemporal(text, { now: expected.now ?? FIXED_NOW.toISOString(), timezone: expected.tz ?? TZ });
      const ref = r.references[0];
      const got = ref?.candidates.map((c) => (c.startLocalDate === c.endLocalDate ? c.startLocalDate : `${c.startLocalDate}..${c.endLocalDate}`)) ?? [];
      const failures: string[] = [];
      if (JSON.stringify(got) !== JSON.stringify(expected.dates)) failures.push(`dates ${JSON.stringify(got)} ≠ ${JSON.stringify(expected.dates)}`);
      if (expected.ambiguous !== undefined && ref?.ambiguous !== expected.ambiguous) failures.push(`ambiguous=${ref?.ambiguous} expected ${expected.ambiguous}`);
      return ok(failures, { date: { correct: failures.length === 0 ? 1 : 0, total: 1 } });
    },
  };
}

// ── Memory retrieval ─────────────────────────────────────────────────────

export function memoryScenario(
  id: string,
  text: string,
  expectedTitles: string[],
  opts: { terms?: string[]; extra?: Array<{ title: string; at: string; turns: Array<[Message["role"], string]> }>; expectNote?: RegExp } = {},
): Scenario {
  return {
    id,
    category: "memory",
    description: text,
    run: async () => {
      const db = openDatabase(":memory:");
      const repos = createRepositories(db);
      seedDemoData(repos, db, { now: FIXED_NOW, timezone: TZ });
      for (const x of opts.extra ?? []) {
        const c = repos.conversations.create({ title: x.title, timezone: TZ, createdAt: x.at });
        x.turns.forEach(([role, content], i) => repos.messages.add({ conversationId: c.id, role, content, createdAt: new Date(Date.parse(x.at) + i * 60_000).toISOString() }));
      }
      const current = repos.conversations.create({ timezone: TZ });
      const r = new MemoryRetriever(repos.messages, repos.conversations).retrieve({
        text,
        terms: opts.terms,
        temporal: resolveTemporal(text, { now: FIXED_NOW, timezone: TZ }).references,
        currentConversationId: current.id,
        now: FIXED_NOW.toISOString(),
      });
      const got = new Set(r.summary.conversationIds.map((cid) => repos.conversations.get(cid)!.title));
      const want = new Set(expectedTitles);
      const tp = [...got].filter((t) => want.has(t)).length;
      const fp = got.size - tp;
      const fn = [...want].filter((t) => !got.has(t)).length;
      const failures: string[] = [];
      if (fp || fn) failures.push(`retrieved [${[...got].join(" | ")}], expected [${[...want].join(" | ")}]`);
      if (opts.expectNote && !opts.expectNote.test(r.notes.join(" "))) failures.push(`missing note ${opts.expectNote}: got "${r.notes.join(" ")}"`);
      db.close();
      return ok(failures, { retrieval: { tp, fp, fn } });
    },
  };
}

// ── Comparison engine ────────────────────────────────────────────────────

let evSeq = 0;
export function ev(subject: string, attribute: string, value: string, extra: Partial<Evidence> = {}): Evidence {
  evSeq++;
  return {
    id: `ev_${evSeq}`,
    claim: `${subject} ${attribute}: ${value}`,
    subject,
    category: "pricing",
    attribute,
    value,
    quote: value,
    sourceId: `S${evSeq}`,
    sourceUrl: `https://example.com/${evSeq}`,
    sourceTitle: "fixture",
    sourceKind: "official_pricing",
    retrievedAt: FIXED_NOW.toISOString(),
    evidenceType: "current",
    strength: "strong",
    ...extra,
  };
}

export function claim(subject: string, attribute: string, value: string): HistoricalClaim {
  return { subject, category: "pricing", attribute, value, messageId: "m", statedAt: "2026-11-09T10:00:00Z" };
}

function changeMetrics(got: Comparison[], expected: ChangeStatus[]): Metrics["change"] {
  const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
  got.forEach((c, i) => {
    const pred = c.status === "changed";
    const truth = expected[i] === "changed";
    if (pred && truth) m.tp++;
    else if (pred && !truth) m.fp++;
    else if (!pred && truth) m.fn++;
    else m.tn++;
  });
  return m;
}

export function pricingScenario(
  id: string,
  description: string,
  claims: HistoricalClaim[],
  evidence: Evidence[],
  expected: ChangeStatus[],
  category: Category = "pricing",
  /** Optional expected dimension per row (price_amount, pricing_model, ...). */
  dimensions?: string[],
): Scenario {
  return {
    id,
    category,
    description,
    run: async () => {
      const got = comparePricing(claims, evidence);
      const statuses = got.map((c) => c.status);
      const failures = JSON.stringify(statuses) === JSON.stringify(expected) ? [] : [`statuses ${JSON.stringify(statuses)} ≠ ${JSON.stringify(expected)}: ${got.map((c) => c.explanation).join(" / ")}`];
      if (dimensions && JSON.stringify(got.map((c) => c.dimension)) !== JSON.stringify(dimensions)) {
        failures.push(`dimensions ${JSON.stringify(got.map((c) => c.dimension))} ≠ ${JSON.stringify(dimensions)}`);
      }
      return ok(failures, { change: changeMetrics(got, expected), status: { correct: statuses.filter((s, i) => s === expected[i]).length, total: expected.length } });
    },
  };
}

export function updatesScenario(id: string, description: string, subjects: string[], evidence: Evidence[], baseline: string, expected: ChangeStatus[]): Scenario {
  return {
    id,
    category: "product_update",
    description,
    run: async () => {
      const got = compareProductUpdates(subjects, evidence, baseline);
      const statuses = got.map((c) => c.status);
      const failures = JSON.stringify(statuses) === JSON.stringify(expected) ? [] : [`statuses ${JSON.stringify(statuses)} ≠ ${JSON.stringify(expected)}`];
      return ok(failures, { change: changeMetrics(got, expected), status: { correct: statuses.filter((s, i) => s === expected[i]).length, total: expected.length } });
    },
  };
}

// ── End-to-end agent ─────────────────────────────────────────────────────

export interface AgentTurnSpec {
  message: string;
  script: ScriptedLLMOptions;
  search?: Record<string, FixtureEntry> | null;
}

export interface AgentExpectations {
  memoryStatus?: "found" | "not_found";
  memoryTitleIncludes?: string;
  statuses?: Record<string, ChangeStatus>; // "subject|category" or "subject"
  maxSearches?: number;
  answerIncludes?: string[];
  answerExcludes?: string[];
  noteMatches?: RegExp[];
  sourcesExclude?: string[];
  firstSourceDomain?: string;
  expectError?: string;
  plantedFabrications?: number;
  custom?: (ctx: { result: Message | undefined; events: ReturnType<typeof eventsOf<"stage">>; allEvents: Parameters<typeof eventsOf>[0] }) => string[];
}

export function agentScenario(id: string, category: Category, description: string, turns: AgentTurnSpec[], expect: AgentExpectations, env?: Record<string, string>): Scenario {
  return {
    id,
    category,
    description,
    run: async () => {
      const failures: string[] = [];
      // One runtime per scenario; for multi-turn, later turns reuse it with their own script via a fresh runtime sharing nothing but DB is not needed:
      // a single scripted provider handles all turns (structured arrays are consumed in order).
      const merged: ScriptedLLMOptions = mergeScripts(turns.map((t) => t.script));
      const { runtime, search } = makeRuntime({ script: merged, searchFixtures: turns[0]!.search === null ? null : Object.assign({}, ...turns.map((t) => t.search ?? {})), env });
      let convId: string | undefined;
      let last: Awaited<ReturnType<typeof runTurn>> | undefined;
      const t0 = Date.now();
      for (const t of turns) {
        last = await runTurn(runtime, t.message, convId);
        convId = last.result?.conversationId ?? convId;
      }
      const latencyMs = Date.now() - t0;
      const { result, error, events, text } = last!;
      const m: Metrics = { latencyMs, searchCalls: search?.queries.length ?? 0, llmCalls: result?.metadata.stats?.llmCalls, tokens: 0, errored: Boolean(error) && !expect.expectError };

      if (expect.expectError) {
        const code = (error as { code?: string } | undefined)?.code;
        if (code !== expect.expectError) failures.push(`expected error ${expect.expectError}, got ${code ?? "none"}`);
        runtime.close();
        return ok(failures, { ...m, errored: false });
      }
      if (error) {
        failures.push(`run failed: ${(error as Error).message}`);
        runtime.close();
        return ok(failures, m);
      }
      const meta = result!.metadata;
      if (expect.memoryStatus && meta.memory?.status !== expect.memoryStatus) failures.push(`memory ${meta.memory?.status} ≠ ${expect.memoryStatus}`);
      if (expect.memoryTitleIncludes) {
        const titles = (meta.memory?.conversationIds ?? []).map((cid) => runtime.repos.conversations.get(cid)?.title ?? "");
        if (!titles.some((t) => t.includes(expect.memoryTitleIncludes!))) failures.push(`memory titles [${titles.join(", ")}] lack "${expect.memoryTitleIncludes}"`);
      }
      if (expect.statuses) {
        const got = meta.comparisons ?? [];
        let correct = 0;
        const entries = Object.entries(expect.statuses);
        const preds: Comparison[] = [];
        const truths: ChangeStatus[] = [];
        for (const [key, want] of entries) {
          const [subject, category] = key.split("|");
          const c = got.find((x) => x.subject === subject && (!category || x.category === category));
          if (!c) failures.push(`no comparison for ${key}`);
          else {
            preds.push(c);
            truths.push(want);
            if (c.status === want) correct++;
            else failures.push(`${key}: ${c.status} ≠ ${want} (${c.explanation})`);
          }
        }
        m.status = { correct, total: entries.length };
        m.change = changeMetrics(preds, truths);
      }
      if (expect.maxSearches !== undefined && (search?.queries.length ?? 0) > expect.maxSearches) failures.push(`searches ${search?.queries.length} > ${expect.maxSearches}`);
      for (const s of expect.answerIncludes ?? []) if (!result!.content.includes(s)) failures.push(`answer lacks "${s}"`);
      for (const s of expect.answerExcludes ?? []) if (result!.content.includes(s) || text.includes(s)) failures.push(`answer contains forbidden "${s}"`);
      for (const re of expect.noteMatches ?? []) if (!re.test((meta.notes ?? []).join(" "))) failures.push(`notes lack ${re}`);
      const srcEvents = eventsOf(events, "sources")[0]?.sources ?? [];
      for (const s of expect.sourcesExclude ?? []) if (srcEvents.some((x) => x.url.includes(s))) failures.push(`source ${s} should have been excluded`);
      if (expect.firstSourceDomain && srcEvents[0]?.domain !== expect.firstSourceDomain) failures.push(`first source ${srcEvents[0]?.domain} ≠ ${expect.firstSourceDomain}`);

      // Citation correctness: every [S#] in the final answer resolves to a retrieved source.
      const ids = new Set((meta.sources ?? []).map((s) => s.id));
      const allIds = new Set(srcEvents.map((s) => s.id));
      const cites = [...result!.content.matchAll(/\[(S\d+)\]/g)].map((x) => x[1]!);
      const valid = cites.filter((c) => ids.has(c) && allIds.has(c)).length;
      if (valid !== cites.length) failures.push(`invalid citations in answer: ${cites.filter((c) => !ids.has(c)).join(",")}`);
      m.citations = { valid, total: cites.length };

      // Evidence integrity: planted fabrications (marked by their values) must not be persisted.
      const evRows = runtime.repos.research.evidenceForMessage(result!.id);
      const planted = expect.plantedFabrications ?? 0;
      const survived = evRows.filter((r) => /\$52|\$45|FABRICATED/.test(String(r.claim))).length;
      if (survived > 0) failures.push(`${survived} fabricated evidence item(s) survived validation`);
      m.evidence = { kept: evRows.length, proposed: evRows.length + planted, plantedFabrications: planted, plantedSurvived: survived };

      if (expect.custom) failures.push(...expect.custom({ result, events: eventsOf(events, "stage"), allEvents: events }));
      runtime.close();
      return ok(failures, m);
    },
  };
}

/** Concatenates per-turn scripts: structured responses become ordered arrays; the last synthesis wins per call order. */
function mergeScripts(scripts: ScriptedLLMOptions[]): ScriptedLLMOptions {
  if (scripts.length === 1) return scripts[0]!;
  const structured: Record<string, unknown[]> = {};
  for (const s of scripts) {
    for (const [k, v] of Object.entries(s.structured)) {
      structured[k] = [...(structured[k] ?? []), ...(Array.isArray(v) ? v : [v])];
    }
  }
  let turn = 0;
  const synths = scripts.map((s) => s.synthesis);
  return {
    structured: structured as ScriptedLLMOptions["structured"],
    synthesis: (req) => {
      const s = synths[Math.min(turn++, synths.length - 1)]!;
      if (s instanceof Error) throw s;
      return typeof s === "function" ? s(req) : s;
    },
  };
}
