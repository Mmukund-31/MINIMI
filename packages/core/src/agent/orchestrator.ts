import { DateTime } from "luxon";
import type { Repositories, SearchRecordInput } from "../db/repositories";
import type { LLMClient } from "../llm/client";
import { UsageTracker } from "../llm/usage";
import { MemoryRetriever, type MemoryResult } from "../memory/retrieval";
import { addUnassessedUpdates, assessOffering, compareProductUpdates, comparePricing, explainMissingEvidence } from "../research/change-detector";
import { looksLikeInjection, screenSources, sourceText, validateEvidence, verifyHistoricalClaims } from "../research/evidence";
import { assessPlanStatus } from "../research/plan-status";
import { timingEvidence } from "../research/timing";
import { AnalysisSchema, EvidenceExtractionSchema, PlanSchema, type Analysis, type Plan } from "../research/schemas";
import type { CachedSearch } from "../search/cached";
import { dedupeResults } from "../search/normalize";
import { classifySource, isOfficialDomain, isUserGenerated, rankSources, trustedDomainHint, vendorDomains, type QueryPurpose, type SubjectHint } from "../search/ranking";
import type { AppConfig } from "../shared/config";
import { isValidTimezone } from "../shared/config";
import { AppError, isAbortError, toAppError } from "../shared/errors";
import { newId, nowIso } from "../shared/ids";
import { normalizeForMatch, planLabel, subjectMatches, truncate } from "../shared/text";
import type {
  AgentEvent,
  Comparison,
  OfferingNote,
  PlanStatusNote,
  Conversation,
  Evidence,
  ExecutionStats,
  HistoricalClaim,
  Message,
  SearchResult,
  Source,
  SourceRef,
  Stage,
} from "../shared/types";
import { resolveTemporal, type TemporalResolution } from "../temporal/resolver";
import { buildGuardRules, dropUnsupportedPrices, enforceAnswerFacts } from "./answer-guard";
import { attachMissingCitations, CitationFilter, finalizeAnswer, StreamUrlFilter } from "./citations";
import { buildDirectContext, buildSynthesisContext, formatClaims, formatMemory, formatRecent, formatSourcesForExtraction, questionTerms } from "./context";
import { chooseIntent, enforceRouting, followUpSuggestions, heuristicAnalysis, isTimeSensitive, pipelineFor, wantsUpdateCheck, type Pipeline } from "./heuristics";
import { ClaimGate, type ClaimCheck } from "./claim-gate";
import { ensureRequiredFindings, requiredFindings } from "./required-findings";
import { assessCoverage, coverageSummary, gapQueries, namesEntity, verifyClaims, type Coverage, type VerifiedClaim } from "../research/general-evidence";
import { ClaimExtractionSchema, type ResearchIntent } from "../research/schemas";
import { finalizeSearchPlan, normalizeClaims, updateSearchedSubjects } from "../research/planner";
import {
  ANALYZE_SYSTEM,
  analyzePrompt,
  CLAIMS_SYSTEM,
  claimsPrompt,
  DIRECT_SYSTEM,
  EVIDENCE_SYSTEM,
  evidencePrompt,
  planPrompt,
  PROMPT_VERSIONS,
  SYNTHESIZE_SYSTEM,
} from "./prompts";

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface AgentDeps {
  config: AppConfig;
  repos: Repositories;
  /** null when no LLM credentials are configured. */
  llm: LLMClient | null;
  /** null when no search credentials are configured (agent degrades gracefully). */
  search: CachedSearch | null;
  logger?: Logger;
  now?: () => Date;
}

export interface RunInput {
  conversationId?: string;
  message: string;
  timezone?: string;
  signal?: AbortSignal;
}

export const MAX_MESSAGE_CHARS = 4_000;
/** Lookup/research: sources passed to the answer model, and the count below which coverage is "thin". */
const MAX_LOOKUP_SOURCES = 8;
const MAX_RESEARCH_SOURCES = 10;
const MIN_USABLE_SOURCES = 3;
/**
 * Character budgets sized to Groq's free tier (8K tokens/minute per model, reserved output
 * included): claim extraction runs on the fast model, the answer on the larger one.
 */
const DIRECT_CONTEXT_CHARS = 14_000;
const CLAIMS_SOURCE_CHARS = 9_000;

/** Mutable state of one execution; every transition goes through the orchestrator. */
interface ExecutionState {
  id: string;
  conversation: Conversation;
  userMessage: Message;
  now: Date;
  nowLocal: string;
  tracker: UsageTracker;
  stageMs: Partial<Record<Stage, number>>;
  notes: string[];
  temporal: TemporalResolution;
  analysis: Analysis;
  /** Research intent and the pipeline that serves it, decided in code after analysis (see chooseIntent). */
  intent: ResearchIntent;
  mode: Pipeline;
  /** Lookup/research pipelines. */
  verifiedClaims: VerifiedClaim[];
  coverage: Coverage | null;
  claimCheck: ClaimCheck | null;
  memory: MemoryResult | null;
  plan: Plan | null;
  claims: HistoricalClaim[];
  sources: Source[];
  searchRecords: SearchRecordInput[];
  evidence: Evidence[];
  comparisons: Comparison[];
  offering: OfferingNote[];
  planStatus: PlanStatusNote[];
  /** Answer text streamed so far (kept if the run fails mid-answer). */
  partial: string;
  /** Client disconnect + execution deadline. Checked between stages. */
  signal: AbortSignal;
}

/**
 * The single orchestrated agent.
 *
 *   validate → analyze → temporal → memory → plan → search → evidence
 *            → compare → synthesize (stream) → validate citations → persist
 *
 * The LLM interprets, extracts and writes; this class decides what runs,
 * enforces budgets, validates every model output against real data, and
 * degrades gracefully when a stage fails.
 */
export class AgentOrchestrator {
  private readonly logger: Logger;
  private readonly retriever: MemoryRetriever;

  /** Conversations with an answer currently being generated (single process). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: AgentDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.retriever = new MemoryRetriever(deps.repos.messages, deps.repos.conversations);
  }

  isBusy(conversationId: string): boolean {
    return this.inFlight.has(conversationId);
  }

  /**
   * One answer at a time per conversation: concurrent turns would interleave
   * history and each would see the other's half-finished state.
   */
  async run(input: RunInput, emit: (e: AgentEvent) => void): Promise<Message> {
    const id = input.conversationId;
    if (id) {
      if (this.inFlight.has(id)) throw new AppError("CONFLICT", "An answer is already being generated in this conversation.", { retryable: true });
      this.inFlight.add(id);
    }
    try {
      return await this.runUnlocked(input, emit);
    } finally {
      if (id) this.inFlight.delete(id);
    }
  }

  private async runUnlocked(input: RunInput, emitRaw: (e: AgentEvent) => void): Promise<Message> {
    const { config, repos } = this.deps;
    const started = Date.now();
    // Latency instrumentation: time to the first status update and to the first answer token.
    const timing: { firstStatus?: number; firstToken?: number } = {};
    const emit = (e: AgentEvent) => {
      if (e.type === "stage" && timing.firstStatus === undefined) timing.firstStatus = Date.now() - started;
      if (e.type === "token" && timing.firstToken === undefined) timing.firstToken = Date.now() - started;
      emitRaw(e);
    };

    // ── validate ───────────────────────────────────────────────────────
    const text = input.message?.trim() ?? "";
    if (!text) throw new AppError("VALIDATION", "Message must not be empty.");
    if (text.length > MAX_MESSAGE_CHARS) throw new AppError("VALIDATION", `Message is too long (max ${MAX_MESSAGE_CHARS} characters).`);
    if (!this.deps.llm) {
      throw new AppError("NOT_CONFIGURED", "No LLM provider is configured. Add an API key to .env (see .env.example) and restart.");
    }
    const llm = this.deps.llm;

    const deadline = AbortSignal.timeout(config.budgets.maxExecutionMs);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;

    const conversation = this.resolveConversation(input);
    const userMessage = this.persistUserMessage(conversation, text);
    emit({ type: "conversation", conversationId: conversation.id, userMessageId: userMessage.id });

    const now = this.deps.now?.() ?? new Date();
    const state: ExecutionState = {
      id: newId("exec"),
      conversation,
      userMessage,
      now,
      nowLocal: DateTime.fromJSDate(now).setZone(conversation.timezone).toFormat("cccc d LLLL yyyy, HH:mm"),
      tracker: new UsageTracker({ maxLlmCalls: config.budgets.maxLlmCalls, maxSearches: config.budgets.maxSearches }),
      stageMs: {},
      notes: [],
      temporal: { references: [], unresolved: [], nowLocal: "", timezone: conversation.timezone },
      analysis: heuristicAnalysis(text, []),
      intent: "chat",
      mode: "chat",
      verifiedClaims: [],
      coverage: null,
      claimCheck: null,
      memory: null,
      plan: null,
      claims: [],
      sources: [],
      searchRecords: [],
      evidence: [],
      comparisons: [],
      offering: [],
      planStatus: [],
      partial: "",
      signal,
    };
    repos.research.startSession({ id: state.id, conversationId: conversation.id, userMessageId: userMessage.id, query: text });
    const log = (obj: object, msg: string) => this.logger.info({ executionId: state.id, ...obj }, msg);

    try {
      // Interrupted partial answers are kept for the user but never fed back to the model as context.
      const recent = repos.messages.recent(conversation.id, 8, userMessage.id).filter((m) => m.metadata.status !== "error");

      // ── temporal (deterministic, first pass on raw text) ─────────────
      await this.stage(state, "temporal", emit, async () => {
        state.temporal = resolveTemporal(text, { now, timezone: conversation.timezone });
        return state.temporal.references.length ? state.temporal.references.map((r) => `${r.expression} → ${r.candidates[0]?.label ?? "previous conversation"}`).join("; ") : undefined;
      });

      // ── analyze (LLM, with heuristic fallback + routing guarantees) ──
      await this.stage(state, "analyze", emit, async () => {
        try {
          const a = await llm.generateStructured(
            {
              schema: AnalysisSchema,
              schemaName: "message_analysis",
              system: ANALYZE_SYSTEM,
              prompt: analyzePrompt({ message: text, recent: formatRecent(recent, 3000), nowLocal: state.nowLocal }),
              promptVersion: PROMPT_VERSIONS.analyze,
              maxTokens: 1536,
              signal,
            },
            state.tracker,
          );
          state.analysis = enforceRouting(a, text, state.temporal.references, { inConversation: recent.length > 0 });
          // Resolve any extra temporal phrases the model spotted.
          if (a.temporalExpressions.length) {
            const extra = resolveTemporal(text, { now, timezone: conversation.timezone, extraExpressions: a.temporalExpressions });
            state.temporal = extra;
          }
        } catch (err) {
          if (isAbortError(err)) throw err;
          this.logger.warn({ executionId: state.id, err: describeErr(err) }, "analysis failed; using heuristic analysis");
          state.analysis = heuristicAnalysis(text, state.temporal.references);
        }
        state.intent = chooseIntent(state.analysis, text);
        state.mode = pipelineFor(state.intent);
        return `${state.intent.replace(/_/g, " ")}${state.analysis.needsMemory ? " · memory" : ""}${state.analysis.aspects.length ? ` · ${state.analysis.aspects.length} aspect(s)` : ""}`;
      });
      log({ analysis: state.analysis }, "analysis");

      // ── memory ───────────────────────────────────────────────────────
      if (state.analysis.needsMemory) {
        await this.stage(state, "memory", emit, async () => {
          state.memory = this.retriever.retrieve({
            text: state.analysis.standaloneQuestion || text,
            terms: [text, ...state.analysis.entities],
            temporal: state.temporal.references,
            currentConversationId: conversation.id,
            excludeMessageIds: [userMessage.id],
            maxExchanges: 6,
            now: now.toISOString(),
          });
          state.notes.push(...state.memory.notes);
          emit({
            type: "memory",
            summary: state.memory.summary,
            exchanges: state.memory.exchanges.map((e) => ({
              conversationTitle: e.conversationTitle,
              at: e.at,
              question: e.user ? truncate(e.user.content, 160) : undefined,
              seeded: e.seeded,
            })),
          });
          return state.memory.summary.status === "found" ? `found ${state.memory.exchanges.length} exchange(s)` : "nothing found";
        });
      } else {
        emit({ type: "stage", stage: "memory", status: "skipped" });
      }
      if (state.temporal.unresolved.length) state.notes.push(`Couldn't interpret the date phrase(s): ${state.temporal.unresolved.join(", ")}.`);

      // ── research (plan → search → evidence → compare) ───────────────
      const searchWanted = state.analysis.needsWebSearch;
      if (searchWanted && !this.deps.search) {
        state.notes.push("Web search isn't configured (TAVILY_API_KEY missing), so current facts couldn't be checked.");
      }
      if (searchWanted && this.deps.search && state.mode === "deep") {
        await this.runResearch(state, llm, recent, signal, emit);
      } else if (searchWanted && this.deps.search && (state.mode === "lookup" || state.mode === "research")) {
        await this.runWebResearch(state, llm, signal, emit);
      } else {
        for (const s of ["plan", "search", "evidence", "compare"] as const) emit({ type: "stage", stage: s, status: "skipped" });
      }

      // ── synthesize (streamed) + citation validation ──────────────────
      const { content, usedSources } = await this.synthesize(state, llm, recent, signal, emit);

      // ── persist ──────────────────────────────────────────────────────
      const t0 = Date.now();
      const stats: ExecutionStats = {
        executionId: state.id,
        llmCalls: state.tracker.llmCalls,
        searchCalls: state.tracker.searchCalls,
        cacheHits: state.tracker.cacheHits,
        usage: { ...state.tracker.usage },
        stageMs: state.stageMs,
        totalMs: Date.now() - started,
        provider: llm.describe().provider,
        models: [...state.tracker.models],
        mode: state.mode,
        intent: state.intent,
        rounds: state.coverage?.rounds,
        firstStatusMs: timing.firstStatus,
        firstTokenMs: timing.firstToken,
      };
      const sourceRefs: SourceRef[] = usedSources.map(toSourceRef);
      const assistant = repos.messages.add({
        conversationId: conversation.id,
        role: "assistant",
        content,
        metadata: {
          executionId: state.id,
          status: "complete",
          sources: sourceRefs,
          comparisons: state.comparisons,
          offering: state.offering,
          planStatus: state.planStatus,
          memory: state.memory?.summary ?? { status: "not_requested", conversationIds: [], messageIds: [] },
          notes: state.notes,
          ...(state.coverage && state.claimCheck ? { research: { intent: state.intent, claims: state.verifiedClaims, coverage: state.coverage, claimCheck: state.claimCheck } } : {}),
          followUps: state.mode !== "deep" ? [] : followUpSuggestions({
            comparisons: state.comparisons,
            memoryFound: state.memory?.summary.status === "found",
            searched: state.sources.length > 0,
          }),
          stats,
        },
      });
      repos.research.saveResearch({ sessionId: state.id, messageId: assistant.id, searches: state.searchRecords, evidence: state.evidence });
      repos.conversations.touch(conversation.id);
      state.stageMs.persist = Date.now() - t0;
      stats.totalMs = Date.now() - started;
      repos.research.finishSession(state.id, "completed", stats);
      log({ stats }, "execution completed");
      emit({ type: "done", message: assistant });
      return assistant;
    } catch (err) {
      const appErr = toAppError(err);
      repos.research.finishSession(state.id, appErr.code === "CANCELLED" ? "cancelled" : "failed", null, appErr.code);
      this.logger.error({ executionId: state.id, code: appErr.code, err: describeErr(err) }, "execution failed");
      // Keep whatever the user already saw stream in, clearly marked as interrupted.
      if (state.partial.trim()) {
        try {
          repos.messages.add({
            conversationId: conversation.id,
            role: "assistant",
            content: state.partial,
            metadata: {
              executionId: state.id,
              status: "error",
              sources: state.sources.filter((s) => state.partial.includes(`[${s.id}]`)).map(toSourceRef),
              notes: [`This answer was interrupted (${appErr.code === "CANCELLED" ? "stopped" : appErr.message}) and may be incomplete.`],
            },
          });
        } catch (persistErr) {
          this.logger.error({ executionId: state.id, err: describeErr(persistErr) }, "failed to persist partial answer");
        }
      }
      throw appErr;
    }
  }

  // ── stages ──────────────────────────────────────────────────────────

  private async runResearch(state: ExecutionState, llm: LLMClient, recent: Message[], signal: AbortSignal, emit: (e: AgentEvent) => void): Promise<void> {
    const { config } = this.deps;
    const exchanges = state.memory?.exchanges ?? [];
    const memoryText = formatMemory(exchanges, state.conversation.timezone, Math.floor(config.budgets.maxContextChars * 0.35), true);

    // plan
    await this.stage(state, "plan", emit, async () => {
      try {
        const p = planPrompt({
          question: state.analysis.standaloneQuestion || state.userMessage.content,
          nowLocal: state.nowLocal,
          memory: memoryText,
          recent: formatRecent(recent, 2000),
          maxSearches: config.budgets.maxSearches,
          wantsPricing: state.analysis.asksAboutPricing,
          wantsUpdates: state.analysis.asksAboutProductUpdates,
        });
        const planReq = { schema: PlanSchema, schemaName: "research_plan", system: p.system, prompt: p.prompt, promptVersion: PROMPT_VERSIONS.plan, maxTokens: 3072, signal };
        try {
          state.plan = await llm.generateStructured(planReq, state.tracker);
        } catch (err) {
          // Escalate once to the stronger extraction model if the fast model can't produce a valid plan.
          if (!(err instanceof AppError) || err.code !== "LLM_INVALID_OUTPUT" || state.tracker.remainingLlmCalls() <= 3) throw err;
          this.logger.warn({ executionId: state.id, err: describeErr(err) }, "plan invalid on fast model; escalating to extract model");
          state.plan = await llm.generateStructured({ ...planReq, role: "extract" }, state.tracker);
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
        this.logger.warn({ executionId: state.id, err: describeErr(err) }, "planning failed; using fallback plan");
        state.plan = this.fallbackPlan(state);
        state.notes.push("Research planning fell back to a simple search strategy.");
      }
      const verified = verifyHistoricalClaims(normalizeClaims(state.plan.historicalClaims, state.plan.subjects), exchanges);
      state.claims = verified.verified;
      if (verified.rejected.length) {
        this.logger.warn({ executionId: state.id, rejected: verified.rejected.length }, "dropped unverifiable historical claims");
      }
      // Deterministic guarantees on top of the model's plan (dedupe, update coverage, budget).
      state.plan.searches = finalizeSearchPlan(state.plan, {
        wantsUpdates: wantsUpdateCheck(state.userMessage.content),
        maxSearches: config.budgets.maxSearches,
        monthYear: DateTime.fromJSDate(state.now).setZone(state.conversation.timezone).toFormat("LLLL yyyy"),
      });
      if (state.plan.searches.length === 0) state.plan.searches = this.fallbackPlan(state).searches.slice(0, config.budgets.maxSearches);
      return `${state.plan.searches.length} search(es), ${state.claims.length} earlier claim(s) to verify`;
    });
    const plan = state.plan!;

    // search (the single tool), bounded concurrency
    await this.stage(state, "search", emit, async () => {
      const results: SearchResult[] = [];
      // Official-domain-first: when the vendor's domain is known, search it directly so the
      // vendor's own pricing page / changelog is in the evidence pool (open web search often
      // returns only third-party roundups). If that finds nothing, fall back to an open search.
      const domainFor = (subject: string | null): string | null => {
        if (!subject) return null;
        const hint = plan.subjects.find((x) => subjectMatches(x.name, subject))?.officialDomain;
        return trustedDomainHint(hint);
      };
      // Domain-first applies to pricing only: update searches use the dated news index
      // (vendor pages rarely carry publication dates), where official changelogs still rank first.
      const queue: Array<{ s: (typeof plan.searches)[number]; domain: string | null; filler?: boolean }> = plan.searches.map((s) => ({
        s,
        domain: s.purpose === "pricing" ? domainFor(s.subject) : null,
      }));
      // One search stays in reserve for the timing check (compare stage) when earlier prices are
      // being re-checked; only the optional open-web "filler" searches give it up.
      const reserve = state.claims.some((c) => c.category === "pricing") ? 1 : 0;
      // Fallback searches run before update searches so price checks are never starved.
      const openQueued = new Set<string>();
      const enqueueFallback = (s: (typeof plan.searches)[number]) => {
        if (openQueued.has(s.query)) return;
        openQueued.add(s.query);
        const firstUpdate = queue.findIndex((q) => q.s.purpose === "product_update");
        queue.splice(firstUpdate < 0 ? queue.length : firstUpdate, 0, { s, domain: null });
      };
      // Any budget left after the plan: open-web versions of domain-restricted pricing searches,
      // so a stale or wrong domain hint can't leave a vendor without evidence. Official pages
      // still rank first; third-party results only fill gaps (and are labelled as such).
      for (const q of [...queue]) {
        if (q.domain) queue.push({ s: q.s, domain: null, filler: true });
      }
      const openDone = new Set<string>();
      let quotaError: string | null = null;
      const worker = async () => {
        while (queue.length > 0) {
          const { s, domain, filler } = queue.shift()!;
          if (filler && state.tracker.searchCalls >= config.budgets.maxSearches - reserve) continue;
          // Each open-web query runs at most once (a fallback may have moved it earlier).
          if (!domain) {
            if (openDone.has(s.query)) continue;
            openDone.add(s.query);
          }
          if (!state.tracker.canSearch()) break;
          state.tracker.beginSearch();
          const label = domain ? `${s.query} · ${domain}` : s.query;
          emit({ type: "search", query: label, status: "start" });
          const retrievedAt = nowIso();
          try {
            const isUpdate = s.purpose === "product_update";
            const out = await this.deps.search!.search(s.query, {
              maxResults: config.budgets.maxResultsPerSearch,
              recency: isUpdate ? "month" : undefined,
              // Vendor sites aren't in the news index, so domain-restricted searches use the general topic.
              topic: isUpdate && !domain ? "news" : "general",
              depth: isUpdate && !domain ? "basic" : "advanced",
              includeDomains: domain ? vendorDomains(domain) : undefined,
              signal,
            });
            if (out.cached) state.tracker.cacheHits++;
            results.push(...out.results.map((r) => ({ ...r, query: s.query })));
            state.searchRecords.push({
              query: s.query,
              provider: this.deps.search!.name,
              retrievedAt,
              status: out.cached ? "cached" : "ok",
              resultCount: out.results.length,
              metadata: { purpose: s.purpose, subject: s.subject, includeDomains: domain ? vendorDomains(domain) : [], urls: out.results.map((r) => r.url) },
            });
            emit({ type: "search", query: label, status: out.cached ? "cached" : "done", resultCount: out.results.length });
            // Official pages often render prices with JavaScript: if none are visible, also search the open web.
            const visiblePrice = out.results.some((r) => /[$€£₹¥]\s?\d/.test(`${r.snippet} ${r.content ?? ""}`));
            if (domain && (out.results.length === 0 || !visiblePrice)) enqueueFallback(s);
          } catch (err) {
            if (isAbortError(err) && signal.aborted) throw err;
            const e = toAppError(err);
            state.searchRecords.push({
              query: s.query,
              provider: this.deps.search!.name,
              retrievedAt,
              status: e.code === "SEARCH_TIMEOUT" ? "timeout" : "failed",
              resultCount: 0,
              metadata: { purpose: s.purpose, error: e.message },
            });
            emit({ type: "search", query: label, status: "failed", error: e.message });
            if (domain) enqueueFallback(s);
            if (e.code === "NOT_CONFIGURED") throw e;
            if (e.code === "SEARCH_QUOTA") {
              // Every further search would fail the same way: stop and say why.
              quotaError = e.message;
              queue.length = 0;
            }
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const failed = state.searchRecords.filter((r) => r.status === "failed" || r.status === "timeout").length;
      if (quotaError) state.notes.push(quotaError);
      else if (failed > 0) state.notes.push(`${failed} of ${state.searchRecords.length} web searches failed; results may be incomplete.`);

      const purposeByQuery = new Map<string, QueryPurpose>(plan.searches.map((s) => [s.query, s.purpose]));
      const subjects: SubjectHint[] = plan.subjects.length ? plan.subjects : state.analysis.entities.map((name) => ({ name, officialDomain: null }));
      const subjectByQuery = new Map<string, string | null>(plan.searches.map((s) => [s.query, s.subject]));
      const ranked = rankSources(dedupeResults(results), { subjects, purposeByQuery, subjectByQuery, maxSources: config.budgets.maxSources, now: state.now });
      const { usable, quarantined } = screenSources(ranked);
      if (quarantined.length) {
        state.notes.push(`${quarantined.length} search result(s) were excluded because they contained instructions aimed at AI systems.`);
        this.logger.warn({ executionId: state.id, urls: quarantined.map((q) => q.url) }, "quarantined sources");
      }
      state.sources = usable.map((s, i) => ({ ...s, id: `S${i + 1}` }));
      emit({ type: "sources", sources: state.sources.map(toSourceRef) });
      return `${state.sources.length} source(s) from ${state.searchRecords.length} search(es)`;
    });

    // evidence
    await this.stage(state, "evidence", emit, async () => {
      if (state.sources.length === 0) {
        state.notes.push("The web searches returned no usable results.");
        return "no sources";
      }
      if (state.tracker.remainingLlmCalls() <= 1) {
        state.notes.push("Skipped evidence extraction to stay within the model-call budget.");
        return "skipped (budget)";
      }
      try {
        const subjects = plan.subjects.map((s) => s.name).join(", ") || state.analysis.entities.join(", ");
        const prompt = evidencePrompt({
          question: state.analysis.standaloneQuestion || state.userMessage.content,
          subjects,
          claims: formatClaims(state.claims),
          sources: formatSourcesForExtraction(state.sources, Math.floor(config.budgets.maxContextChars * 0.6), [...plan.subjects.map((s) => s.name), ...state.claims.map((c) => c.attribute)]),
        });
        const extractWith = (p: string, role: "extract" | "fast") =>
          llm.generateStructured(
            { schema: EvidenceExtractionSchema, schemaName: "evidence_extraction", system: EVIDENCE_SYSTEM, prompt: p, promptVersion: PROMPT_VERSIONS.evidence, maxTokens: 4096, role, signal },
            state.tracker,
          );
        // If the extraction model is rate-limited (per-minute or daily quota), fall back to the
        // fast model, which has its own quota, rather than answering without evidence.
        const extract = async (p: string) => {
          try {
            return await extractWith(p, "extract");
          } catch (err) {
            if (!(err instanceof AppError) || err.code !== "LLM_RATE_LIMIT" || !llm.hasDistinctModel("extract", "fast") || state.tracker.remainingLlmCalls() <= 2) throw err;
            this.logger.warn({ executionId: state.id, err: describeErr(err) }, "extraction model rate-limited; falling back to fast model");
            state.notes.push("The primary extraction model was rate-limited, so a smaller model extracted the evidence.");
            return extractWith(p, "fast");
          }
        };
        let extraction = await extract(prompt);
        // Occasionally the extractor returns nothing although the sources visibly contain prices.
        // One bounded retry with an explicit nudge (never when it would use the answer's reserved call).
        const pricesVisible = state.sources.some((s) => /[$€£₹¥]\s?\d/.test(`${s.snippet} ${s.content ?? ""}`));
        const wantsPrices = state.claims.some((c) => c.category === "pricing") || state.analysis.asksAboutPricing;
        if (extraction.findings.length === 0 && wantsPrices && pricesVisible && state.tracker.remainingLlmCalls() > 2) {
          this.logger.info({ executionId: state.id }, "empty extraction despite visible prices; retrying once");
          extraction = await extract(`${prompt}\n\nNOTE: Several sources above contain prices. Extract every plan price stated for the subjects, each with a verbatim quote.`);
        }
        const report = validateEvidence(extraction, state.sources);
        state.evidence = report.evidence;
        if (report.rejected.length) {
          this.logger.info({ executionId: state.id, rejected: report.rejected }, "rejected unsupported evidence");
        }
        return `${report.evidence.length}/${report.proposed} claim(s) verified against sources`;
      } catch (err) {
        if (isAbortError(err)) throw err;
        this.logger.warn({ executionId: state.id, err: describeErr(err) }, "evidence extraction failed");
        state.notes.push("Couldn't extract verifiable evidence from the search results, so current facts are unconfirmed.");
        return "failed (degraded)";
      }
    });

    // compare (deterministic)
    await this.stage(state, "compare", emit, async () => {
      const comparePricingRows = () => explainMissingEvidence(comparePricing(state.claims, state.evidence), state.sources);
      let pricing = comparePricingRows();
      // Timing: a difference found on undated pages says nothing about when it happened. One
      // bounded, deterministic search looks for a self-dated vendor page (see research/timing.ts).
      const undated = pricing
        .filter((c) => c.status === "changed" && c.changeTiming === "unknown" && (c.dimension === "pricing_model" || c.dimension === "price_amount") && c.currentValue)
        .sort((a, b) => (a.dimension === "pricing_model" ? 0 : 1) - (b.dimension === "pricing_model" ? 0 : 1))[0];
      if (undated && state.tracker.canSearch() && (await this.timingSearch(state, plan, undated, signal, emit))) pricing = comparePricingRows();
      // Legacy plans: flagged by the extractor, or read from legacy-plan tables on the vendor's own pages.
      const vendorOf = (s: Source) => plan.subjects.find((x) => isOfficialDomain(s.sourceDomain, [x]))?.name;
      state.planStatus = assessPlanStatus(state.evidence, state.sources.map((s) => ({ ...s, subject: vendorOf(s) })));
      const subjectNames = plan.subjects.map((s) => s.name);
      // Product-update rows only when the user asked about launches/updates or whether an answer is
      // still correct (deterministic gate). "Not checked" when no update search ran, or it returned nothing.
      const ok = state.searchRecords.filter((r) => r.status === "ok" || r.status === "cached");
      const ran = updateSearchedSubjects(plan.searches, new Set(ok.map((r) => r.query)));
      const gotResults = updateSearchedSubjects(plan.searches, new Set(ok.filter((r) => r.resultCount > 0).map((r) => r.query)));
      const coverage = (subject: string) => (gotResults(subject) ? "checked" : ran(subject) ? "no_results" : "not_run") as "checked" | "no_results" | "not_run";
      const updates =
        wantsUpdateCheck(state.userMessage.content) && subjectNames.length
          ? addUnassessedUpdates(compareProductUpdates(subjectNames, state.evidence, state.memory?.summary.baselineDate, coverage), state.sources, state.memory?.summary.baselineDate)
          : [];
      state.comparisons = [...pricing, ...updates];
      const earlierAnswers = (state.memory?.exchanges ?? []).map((e) => e.assistant?.content ?? "").join("\n");
      state.offering = assessOffering(state.claims, state.evidence, earlierAnswers);
      if (state.comparisons.length) emit({ type: "comparison", comparisons: state.comparisons });
      const counts = state.comparisons.reduce<Record<string, number>>((acc, c) => ((acc[c.status] = (acc[c.status] ?? 0) + 1), acc), {});
      return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing to compare";
    });
  }

  /**
   * Lookup and research pipelines: a bounded adaptive loop.
   *
   *   round 1: the analysis's queries (comparisons: at least one per option), concurrently
   *   evidence (research only): one extraction call → claims with verbatim quotes, verified in code
   *   coverage: entities × aspects → verified / mentioned / gap; sources that differ
   *   round 2 (only if gaps remain): one targeted query per gap, never a repeat; then stop
   *
   * Stopping criteria: no gaps · two rounds done · search budget spent · search quota exhausted.
   * Round-2 results aren't sent through a second extraction call (one extraction keeps a request
   * inside Groq's per-minute token quota); their sentences are checked by the claim gate instead.
   */
  private async runWebResearch(state: ExecutionState, llm: LLMClient, signal: AbortSignal, emit: (e: AgentEvent) => void): Promise<void> {
    const { config } = this.deps;
    const a = state.analysis;
    const question = a.standaloneQuestion || state.userMessage.content;
    const research = state.mode === "research";
    const entities = a.entities.slice(0, 5);
    const aspects = a.aspects.slice(0, 6);
    const timeSensitive = isTimeSensitive(`${state.userMessage.content} ${question}`);
    const year = DateTime.fromJSDate(state.now).setZone(state.conversation.timezone).toFormat("yyyy");
    const results: SearchResult[] = [];
    const queriesRun: string[] = [];
    let quotaHit = false;
    emit({ type: "stage", stage: "plan", status: "skipped" });

    const runRound = async (qs: string[], opts: { topic: "general" | "news"; recency?: "week" | "month"; label?: string; round?: 1 | 2; includeDomains?: string[] }) =>
      Promise.all(
        qs.map(async (query) => {
          if (!state.tracker.canSearch() || quotaHit) return;
          state.tracker.beginSearch();
          queriesRun.push(query);
          const label = opts.label ? `${query} · ${opts.label}` : query;
          const round = opts.round ?? (opts.label ? 2 : 1);
          emit({ type: "search", query: label, status: "start" });
          const retrievedAt = nowIso();
          try {
            const out = await this.deps.search!.search(query, { maxResults: config.budgets.maxResultsPerSearch, topic: opts.topic, recency: opts.recency, depth: "advanced", includeDomains: opts.includeDomains, signal });
            if (out.cached) state.tracker.cacheHits++;
            results.push(...out.results.map((r) => ({ ...r, query })));
            state.searchRecords.push({ query, provider: this.deps.search!.name, retrievedAt, status: out.cached ? "cached" : "ok", resultCount: out.results.length, metadata: { purpose: "general", topic: opts.topic, round, includeDomains: opts.includeDomains ?? [], urls: out.results.map((r) => r.url) } });
            emit({ type: "search", query: label, status: out.cached ? "cached" : "done", resultCount: out.results.length });
          } catch (err) {
            if (isAbortError(err) && signal.aborted) throw err;
            const e = toAppError(err);
            if (e.code === "NOT_CONFIGURED") throw e;
            state.searchRecords.push({ query, provider: this.deps.search!.name, retrievedAt, status: e.code === "SEARCH_TIMEOUT" ? "timeout" : "failed", resultCount: 0, metadata: { purpose: "general", error: e.message } });
            emit({ type: "search", query: label, status: "failed", error: e.message });
            if (e.code === "SEARCH_QUOTA") {
              quotaHit = true;
              if (!state.notes.includes(e.message)) state.notes.push(e.message);
            }
          }
        }),
      );

    // Official sources first: domains the analysis named (vetted: plausible hostnames, never review
    // sites) mark official pages in ranking and get one domain-restricted query in round 1.
    // Live 2026-11-20: "latest Node.js LTS" and "what is new in React" cited only third-party blogs.
    const officialDomains = [...new Set(a.officialDomains.map((d) => trustedDomainHint(d)).filter((d): d is string => Boolean(d)))].slice(0, 3);
    const subjects: SubjectHint[] = entities.map((name) => ({ name, officialDomain: officialDomains.find((d) => isOfficialDomain(d, [{ name, officialDomain: null }])) ?? null }));
    for (const d of officialDomains) if (!subjects.some((x) => x.officialDomain === d)) subjects.push({ name: d.split(".")[0]!, officialDomain: d });
    const requestedVersions = requestedMajorVersions(`${state.userMessage.content} ${question}`);
    // Ranking keeps earlier sources' ids stable: round-2 sources are appended after them.
    const rankNew = (exclude: Set<string>, max: number): Source[] => {
      const purposeByQuery = new Map<string, QueryPurpose>(queriesRun.map((q) => [q, "general"]));
      const candidates = dedupeResults(results.filter((r) => !exclude.has(r.url)));
      // Pages explicitly for another major version than the one asked about are dropped when other
      // sources remain. Live 2026-11-20: "dark mode in Tailwind CSS v4" was answered from v3.tailwindcss.com.
      const matching = candidates.filter((r) => !versionMismatch(r.url, requestedVersions));
      const ranked = rankSources(matching.length >= Math.min(2, candidates.length) ? matching : candidates, { subjects, purposeByQuery, maxSources: max, now: state.now });
      const { usable, quarantined } = screenSources(ranked);
      if (quarantined.length) {
        state.notes.push(`${quarantined.length} search result(s) were excluded because they contained instructions aimed at AI systems.`);
        this.logger.warn({ executionId: state.id, urls: quarantined.map((q) => q.url) }, "quarantined sources");
      }
      return usable;
    };
    const maxSources = Math.min(research ? MAX_RESEARCH_SOURCES : MAX_LOOKUP_SOURCES, config.budgets.maxSources);

    // ── round 1 ──
    await this.stage(state, "search", emit, async () => {
      const seen = new Set<string>();
      const queries = a.searchQueries.map((q) => q.replace(/\s+/g, " ").trim()).filter((q) => q.length >= 2 && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()));
      // A comparison searches every option: add "<option> <criteria>" for options no query names.
      if (state.intent === "comparison") {
        for (const e of entities) {
          if (!queries.some((q) => subjectMatches(e, q) || q.toLowerCase().includes(e.toLowerCase()))) queries.push(`${e} ${aspects.slice(0, 3).join(" ")}`.trim());
        }
      }
      if (queries.length === 0) queries.push(truncate(question, 150));
      const limit = Math.min(state.intent === "comparison" ? 4 : 3, config.budgets.maxSearches - 1);
      const official = officialDomains.length ? [runRound([queries[0]!], { topic: "general", label: "official", round: 1, includeDomains: officialDomains.flatMap((d) => vendorDomains(d)) })] : [];
      await Promise.all([runRound(queries.slice(0, official.length ? limit - 1 : limit), timeSensitive ? { topic: "news", recency: "month" } : { topic: "general" }), ...official]);
      state.sources = rankNew(new Set(), maxSources).map((s, i) => ({ ...s, id: `S${i + 1}` }));
      emit({ type: "sources", sources: state.sources.map(toSourceRef) });
      return `${state.sources.length} source(s) from ${queriesRun.length} search(es)`;
    });

    // ── evidence (research only): claims with verbatim quotes, verified in code ──
    if (research && state.sources.length > 0 && state.tracker.remainingLlmCalls() > 1) {
      await this.stage(state, "evidence", emit, async () => {
        try {
          const extraction = await llm.generateStructured(
            {
              schema: ClaimExtractionSchema,
              schemaName: "claim_extraction",
              system: CLAIMS_SYSTEM,
              prompt: claimsPrompt({ question, entities, aspects, sources: formatSourcesForExtraction(state.sources, CLAIMS_SOURCE_CHARS, [...entities, ...aspects, ...questionTerms(question)]) }),
              promptVersion: PROMPT_VERSIONS.claims,
              maxTokens: 2500,
              role: "fast",
              signal,
            },
            state.tracker,
          );
          const report = verifyClaims(extraction, state.sources, { entities, aspects });
          state.verifiedClaims = report.claims;
          if (report.rejected.length) this.logger.info({ executionId: state.id, rejected: report.rejected }, "rejected unsupported claims");
          return `${report.claims.length}/${extraction.claims.length} claim(s) verified against sources`;
        } catch (err) {
          if (isAbortError(err)) throw err;
          this.logger.warn({ executionId: state.id, err: describeErr(err) }, "claim extraction failed; answering from excerpts");
          return "failed (answering from excerpts)";
        }
      });
    } else {
      emit({ type: "stage", stage: "evidence", status: "skipped" });
    }
    emit({ type: "stage", stage: "compare", status: "skipped" });

    // ── coverage → targeted follow-up (bounded: at most one more round) ──
    await this.stage(state, "coverage", emit, async () => {
      // Lookups have no extraction: their cells are "mentioned" when a source addresses them.
      let coverage = assessCoverage({ entities, aspects, claims: state.verifiedClaims, sources: state.sources, round: 1 });
      const thin = state.sources.length < MIN_USABLE_SOURCES;
      const gaps = coverage.cells.filter((c) => c.status === "gap");
      if ((gaps.length > 0 || thin) && !quotaHit && state.tracker.canSearch()) {
        const remaining = Math.min(3, config.budgets.maxSearches - state.tracker.searchCalls);
        let followUps = gapQueries(coverage, { question, previous: queriesRun, max: remaining, year: timeSensitive ? year : undefined });
        // Thin coverage with no targetable gap: broaden once with the question itself.
        if (followUps.length === 0 && thin) followUps = gapQueries({ ...coverage, cells: [{ entity: null, aspect: null, status: "gap", claimIds: [], sourceIds: [] }] }, { question: truncate(question, 150), previous: queriesRun, max: 1 });
        if (followUps.length) {
          this.logger.info({ executionId: state.id, gaps: gaps.length, followUps }, "coverage gaps; targeted follow-up searches");
          await runRound(followUps, { topic: "general", label: "follow-up" });
          const existing = new Set(state.sources.map((s) => s.url));
          const added = rankNew(existing, Math.max(0, maxSources + 3 - state.sources.length)).map((s, i) => ({ ...s, id: `S${state.sources.length + i + 1}` }));
          state.sources = [...state.sources, ...added];
          emit({ type: "sources", sources: state.sources.map(toSourceRef) });
          coverage = assessCoverage({ entities, aspects, claims: state.verifiedClaims, sources: state.sources, round: 2, followUpQueries: followUps });
        }
      }
      state.coverage = coverage;
      // Tell the answer model when no source names an entity in full, so it doesn't attribute
      // facts about a similarly named thing to it (or invent the entity's existence).
      const unnamed = entities.filter((e) => state.sources.length > 0 && !state.sources.some((s) => namesEntity(sourceText(s), e)));
      if (unnamed.length) state.notes.push(`None of the retrieved sources names ${unnamed.map((e) => `"${e}"`).join(", ")} exactly. Don't attribute facts about similarly named products to ${unnamed.length > 1 ? "them" : "it"}; say it couldn't be found.`);
      const failed = state.searchRecords.filter((r) => r.status === "failed" || r.status === "timeout").length;
      if (failed > 0 && !quotaHit) state.notes.push(`${failed} of ${state.searchRecords.length} web searches failed; results may be incomplete.`);
      if (state.sources.length === 0) state.notes.push("The web searches returned no usable results.");
      const sum = coverageSummary(coverage);
      return `${sum.verified + sum.mentioned}/${sum.total} covered${sum.gaps ? ` · ${sum.gaps} gap(s)` : ""} · ${coverage.rounds} round(s)${coverage.conflicts.length ? ` · ${coverage.conflicts.length} difference(s)` : ""}`;
    });
  }

  private async synthesize(
    state: ExecutionState,
    llm: LLMClient,
    recent: Message[],
    signal: AbortSignal,
    emit: (e: AgentEvent) => void,
  ): Promise<{ content: string; usedSources: Source[] }> {
    const t0 = Date.now();
    state.signal.throwIfAborted();
    emit({ type: "stage", stage: "synthesize", status: "start" });
    const deep = state.mode === "deep";
    const searchWanted = state.analysis.needsWebSearch;
    const mustMention = deep ? requiredFindings(state.comparisons) : [];
    const context = deep
      ? buildSynthesisContext({
          question: state.userMessage.content,
          nowLocal: state.nowLocal,
          timezone: state.conversation.timezone,
          recent,
          memory: state.memory,
          memoryRequested: state.analysis.needsMemory,
          comparisons: state.comparisons,
          offering: state.offering,
          planStatus: state.planStatus,
          evidence: state.evidence,
          sources: state.sources,
          notes: state.notes,
          searchAttempted: state.searchRecords.length > 0,
          maxChars: this.deps.config.budgets.maxContextChars,
          mustMention,
        })
      : buildDirectContext({
          question: state.userMessage.content,
          nowLocal: state.nowLocal,
          timezone: state.conversation.timezone,
          recent,
          sources: state.sources,
          notes: state.notes,
          searchStatus: !searchWanted ? "not_needed" : !this.deps.search ? "unavailable" : state.searchRecords.some((r) => r.status === "ok" || r.status === "cached") ? "ok" : "failed",
          focusTerms: [...state.analysis.entities, ...questionTerms(state.analysis.standaloneQuestion || state.userMessage.content)],
          maxChars: Math.min(DIRECT_CONTEXT_CHARS, this.deps.config.budgets.maxContextChars),
          ...(state.mode === "research" && state.coverage ? { claims: state.verifiedClaims, coverage: state.coverage } : {}),
        });
    const filter = new CitationFilter(new Set(state.sources.map((s) => s.id)));
    const urlGuard = new StreamUrlFilter(state.sources.map((s) => s.url));
    // Search-grounded answers pass the claim gate line by line before anything is shown.
    // Non-pricing historical audits use it too (pricing answers have the dedicated price verifier);
    // figures from the remembered conversation are exempt, since restating it is legitimate.
    const gated = state.mode === "lookup" || state.mode === "research" || state.intent === "historical_audit";
    const gate =
      gated && state.sources.length > 0
        ? new ClaimGate(
            state.sources,
            [state.userMessage.content, ...recent.map((m) => m.content), state.nowLocal, ...(state.memory?.exchanges ?? []).flatMap((x) => [x.user?.content ?? "", x.assistant?.content ?? "", x.at])].join("\n"),
            [state.userMessage.content, ...recent.filter((m) => m.role === "user").map((m) => m.content)].join("\n"),
          )
        : null;
    const pass = (s: string) => (gate ? gate.push(s) : s);
    // Chat and direct answers stream on the stronger model, which is idle on those paths (see strongStreamRole).
    const preferred = deep ? "synthesis" : llm.strongStreamRole();
    const request = (role: "synthesis" | "extract") => ({
      system: deep ? SYNTHESIZE_SYSTEM : DIRECT_SYSTEM,
      messages: [{ role: "user" as const, content: context }],
      promptVersion: deep ? PROMPT_VERSIONS.synthesize : PROMPT_VERSIONS.direct,
      maxTokens: deep ? 3072 : 2048,
      signal,
      role,
    });
    let raw = "";
    try {
      const streamWith = async (role: "synthesis" | "extract") => {
        for await (const chunk of llm.streamText(request(role), state.tracker)) {
          const out = pass(urlGuard.push(filter.push(chunk)));
          if (out) {
            raw += out;
            emit({ type: "token", text: out });
          }
        }
      };
      try {
        await streamWith(preferred);
      } catch (err) {
        // Rate-limited before anything was shown: retry once on the regular answer model (own quota).
        if (preferred === "synthesis" || raw || !(err instanceof AppError) || err.code !== "LLM_RATE_LIMIT") throw err;
        this.logger.warn({ executionId: state.id, err: describeErr(err) }, "answer model rate-limited; retrying on the synthesis model");
        await streamWith("synthesis");
      }
      const urlTail = urlGuard.push(filter.flush()) + urlGuard.flush();
      const tail = gate ? gate.push(urlTail) + gate.flush() : urlTail;
      if (tail) {
        raw += tail;
        emit({ type: "token", text: tail });
      }
    } catch (err) {
      state.partial = finalizeAnswer(raw, state.sources.map((s) => s.url)).text;
      emit({ type: "stage", stage: "synthesize", status: "failed" });
      throw err;
    }
    if (!raw.trim()) throw new AppError("LLM_ERROR", "The model returned an empty answer.", { retryable: true });
    const final = finalizeAnswer(raw, state.sources.map((s) => s.url));
    if (filter.removed.length || urlGuard.removed.length || final.removedUrls.length) {
      this.logger.warn({ executionId: state.id, removedCitations: filter.removed, removedUrls: [...urlGuard.removed, ...final.removedUrls] }, "citation validation removed items");
    }
    state.stageMs.synthesize = Date.now() - t0;
    emit({ type: "stage", stage: "synthesize", status: "done" });
    if (!deep) {
      // Chat/lookup/research: citations and URLs are restricted to retrieved sources, and every
      // figure in a search-grounded answer was checked against its cited source by the claim gate.
      const text = final.text;
      if (gate) {
        state.claimCheck = gate.stats;
        if (gate.stats.removed > 0) {
          state.notes.push(`${gate.stats.removed} statement(s) were removed because no retrieved source supports their figures.`);
          this.logger.warn({ executionId: state.id, removed: gate.stats.items.filter((i) => i.status === "unsupported") }, "claim gate removed statements");
        }
      } else if (state.mode === "lookup" || state.mode === "research") {
        state.claimCheck = { checked: 0, supported: 0, repaired: 0, removed: 0, citedWithoutFigures: 0, items: [] };
      }
      if (!state.coverage && (state.mode === "lookup" || state.mode === "research")) {
        state.coverage = { cells: [], conflicts: [], rounds: 0, followUpQueries: [] };
      }
      const citedIds = new Set([...text.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]!));
      const cited = state.sources.filter((s) => citedIds.has(s.id));
      return { content: text, usedSources: [...cited, ...state.sources.filter((s) => !citedIds.has(s.id))] };
    }
    // Code-level constraints: the prose may not contradict the computed rows (see answer-guard.ts).
    if (gate && gate.stats.removed > 0) {
      state.notes.push(`${gate.stats.removed} statement(s) were removed because no retrieved source supports their figures.`);
      this.logger.warn({ executionId: state.id, removed: gate.stats.items.filter((i) => i.status === "unsupported") }, "claim gate removed statements");
    }
    const guarded = enforceAnswerFacts(final.text, buildGuardRules({ comparisons: state.comparisons, planStatus: state.planStatus, question: state.userMessage.content }));
    if (guarded.applied.length) this.logger.info({ executionId: state.id, rules: guarded.applied }, "answer guard applied");
    // Prices the model states must exist somewhere it was given (evidence, rows, sources, memory).
    const support = [
      ...state.evidence.flatMap((e) => [e.value, e.quote]),
      ...state.comparisons.flatMap((c) => [c.previousValue ?? "", c.currentValue ?? "", c.explanation]),
      ...state.offering.flatMap((o) => o.plansNotDiscussed.map((p) => p.value)),
      ...state.planStatus.flatMap((n) => [n.value, n.successor?.value ?? ""]),
      ...state.sources.map((s) => `${s.title} ${s.snippet} ${s.content ?? ""}`),
      ...(state.memory?.exchanges ?? []).flatMap((x) => [x.user?.content ?? "", x.assistant?.content ?? ""]),
      ...recent.map((m) => m.content),
      state.userMessage.content,
    ].join("\n");
    const priced = dropUnsupportedPrices(guarded.text, support, state.userMessage.content);
    if (priced.removed.length) this.logger.warn({ executionId: state.id, removed: priced.removed }, "removed sentences with unsupported prices");
    // Attach citations the model omitted for verified values (deterministic; see attachMissingCitations).
    const cited0 = attachMissingCitations(priced.text, state.evidence);
    // Every computed change and possible update must be stated (see required-findings.ts).
    const required = ensureRequiredFindings(cited0, mustMention);
    if (required.added.length) this.logger.info({ executionId: state.id, added: required.added }, "required findings appended");
    const content = required.text;
    const citedIds = new Set([...content.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]!));
    // Sources list: cited ones first, then the others that informed comparisons.
    const cited = state.sources.filter((s) => citedIds.has(s.id));
    const compared = new Set([...state.comparisons.flatMap((c) => c.sourceIds), ...state.offering.flatMap((o) => o.plansNotDiscussed.map((p) => p.sourceId))]);
    const rest = state.sources.filter((s) => !citedIds.has(s.id) && compared.has(s.id));
    return { content, usedSources: [...cited, ...rest] };
  }

  // ── helpers ─────────────────────────────────────────────────────────

  /**
   * One timing search for a "changed" row whose pages are undated. Adds deterministic historical
   * evidence (and its source) only for a vendor-owned page that dates itself before the
   * conversation and already shows the plan in its current shape. Returns true if evidence was added.
   */
  private async timingSearch(state: ExecutionState, plan: Plan, row: Comparison, signal: AbortSignal, emit: (e: AgentEvent) => void): Promise<boolean> {
    const claim = state.claims.find((c) => c.category === "pricing" && subjectMatches(c.subject, row.subject) && normalizeForMatch(c.attribute) === normalizeForMatch(row.attribute));
    if (!claim || !this.deps.search) return false;
    const query = `${planLabel(row.subject, row.attribute)} pricing change`;
    const label = `${query} (timing check)`;
    state.tracker.beginSearch();
    emit({ type: "search", query: label, status: "start" });
    const retrievedAt = nowIso();
    let results: SearchResult[];
    try {
      const out = await this.deps.search.search(query, { maxResults: 5, topic: "general", depth: "advanced", rawContent: true, signal });
      if (out.cached) state.tracker.cacheHits++;
      results = out.results.map((r) => ({ ...r, query }));
      state.searchRecords.push({ query, provider: this.deps.search.name, retrievedAt, status: out.cached ? "cached" : "ok", resultCount: results.length, metadata: { purpose: "timing", subject: row.subject, urls: results.map((r) => r.url) } });
      emit({ type: "search", query: label, status: out.cached ? "cached" : "done", resultCount: results.length });
    } catch (err) {
      if (isAbortError(err) && signal.aborted) throw err;
      const e = toAppError(err);
      state.searchRecords.push({ query, provider: this.deps.search.name, retrievedAt, status: e.code === "SEARCH_TIMEOUT" ? "timeout" : "failed", resultCount: 0, metadata: { purpose: "timing", error: e.message } });
      emit({ type: "search", query: label, status: "failed", error: e.message });
      state.notes.push(e.code === "SEARCH_QUOTA" ? e.message : `The timing search for ${row.subject} failed, so when its pricing changed is unknown.`);
      return false;
    }
    const subjects: SubjectHint[] = plan.subjects.length ? plan.subjects : [{ name: row.subject, officialDomain: null }];
    const found = timingEvidence(results, {
      subject: row.subject,
      plan: row.attribute,
      currentValue: row.currentValue!,
      dimension: row.dimension as "pricing_model" | "price_amount",
      isVendorOwned: (r) => isOfficialDomain(r.sourceDomain, subjects) && !isUserGenerated(r.url, r.sourceDomain),
      now: state.now,
    })
      .filter((f) => !looksLikeInjection(f.excerpt) && Date.parse(f.result.pageDate.date) < Date.parse(claim.statedAt))
      .sort((a, b) => Date.parse(a.result.pageDate.date) - Date.parse(b.result.pageDate.date));
    const f = found[0];
    if (!f) {
      state.notes.push(`A timing search for ${row.subject} found no dated page on the vendor's site, so when its pricing changed is unknown.`);
      return false;
    }
    let src = state.sources.find((s) => s.url === f.result.url);
    if (src) {
      src.content = `${src.content ?? ""}\n…\n${f.excerpt}`;
      src.pageDate ??= f.result.pageDate;
    } else {
      src = { ...f.result, snippet: truncate(f.excerpt, 300), content: f.excerpt, id: `S${state.sources.length + 1}`, kind: classifySource(f.result, subjects), rankScore: 0 };
      state.sources.push(src);
      emit({ type: "sources", sources: state.sources.map(toSourceRef) });
    }
    state.evidence.push({ ...f.evidence, id: newId("ev"), sourceId: src.id, sourceKind: src.kind });
    return true;
  }

  private async stage(state: ExecutionState, stage: Stage, emit: (e: AgentEvent) => void, fn: () => Promise<string | undefined>): Promise<void> {
    state.signal.throwIfAborted(); // stop promptly after a client disconnect or deadline
    const t0 = Date.now();
    emit({ type: "stage", stage, status: "start" });
    try {
      const detail = await fn();
      state.stageMs[stage] = Date.now() - t0;
      emit({ type: "stage", stage, status: "done", detail });
    } catch (err) {
      state.stageMs[stage] = Date.now() - t0;
      emit({ type: "stage", stage, status: "failed" });
      throw err;
    }
  }

  private fallbackPlan(state: ExecutionState): Plan {
    const subjects = state.analysis.entities.slice(0, this.deps.config.budgets.maxSearches).map((name) => ({ name, officialDomain: null }));
    const q = state.analysis.standaloneQuestion || state.userMessage.content;
    const searches: Plan["searches"] = subjects.length
      ? subjects.map((s) => ({
          query: `${s.name} ${state.analysis.asksAboutPricing ? "pricing" : state.analysis.asksAboutProductUpdates ? "new features announcement" : ""}`.trim(),
          purpose: state.analysis.asksAboutPricing ? "pricing" : state.analysis.asksAboutProductUpdates ? "product_update" : "general",
          subject: s.name,
        }))
      : [{ query: truncate(q, 150), purpose: "general", subject: null }];
    return { subjects, historicalClaims: [], searches };
  }

  private resolveConversation(input: RunInput): Conversation {
    const { repos, config } = this.deps;
    if (input.conversationId) {
      const c = repos.conversations.get(input.conversationId);
      if (!c) throw new AppError("NOT_FOUND", "Conversation not found.");
      return c;
    }
    const tz = isValidTimezone(input.timezone) ? input.timezone : config.timezone;
    return repos.conversations.create({ timezone: tz });
  }

  /** Persists the user message; a retry of an unanswered identical message reuses it. */
  private persistUserMessage(conversation: Conversation, text: string): Message {
    const { repos } = this.deps;
    // A retry of an unanswered (or interrupted) identical message reuses it instead of duplicating it.
    const tail = repos.messages.recent(conversation.id, 2);
    const last = tail.at(-1);
    const prev = tail.length > 1 ? tail[0] : undefined;
    if (last && last.role === "user" && last.content === text) return last;
    if (last?.role === "assistant" && last.metadata.status === "error" && prev?.role === "user" && prev.content === text) return prev;
    const msg = repos.messages.add({ conversationId: conversation.id, role: "user", content: text });
    if (conversation.title === "New conversation") {
      repos.conversations.rename(conversation.id, truncate(text.replace(/\s+/g, " "), 60));
    }
    return msg;
  }
}

function toSourceRef(s: Source): SourceRef {
  return { id: s.id, title: s.title, url: s.url, domain: s.sourceDomain, publishedAt: s.publishedAt, retrievedAt: s.retrievedAt, kind: s.kind };
}

function describeErr(err: unknown): { name?: string; message?: string; code?: string } {
  if (err instanceof AppError) return { name: err.name, message: err.message, code: err.code };
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}

/** Major versions named with a "v" in the question ("Tailwind CSS v4" → [4]). */
export function requestedMajorVersions(text: string): number[] {
  return [...new Set([...text.matchAll(/\bv(\d{1,3})(?:\.\d+)*\b/gi)].map((m) => Number(m[1])))];
}

/** True when a URL is explicitly for a different major version: "v3.tailwindcss.com", "/docs/v3/", "/v2/". */
export function versionMismatch(url: string, requested: number[]): boolean {
  if (requested.length === 0) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const found = [...`${u.hostname.split(".")[0]} ${u.pathname}`.matchAll(/(?:^|[/\s])v(\d{1,3})(?=[/.\s]|$)/gi)].map((m) => Number(m[1]));
  return found.length > 0 && !found.some((v) => requested.includes(v));
}
