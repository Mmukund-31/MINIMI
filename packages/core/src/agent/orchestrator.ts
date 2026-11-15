import { DateTime } from "luxon";
import type { Repositories, SearchRecordInput } from "../db/repositories";
import type { LLMClient } from "../llm/client";
import { UsageTracker } from "../llm/usage";
import { MemoryRetriever, type MemoryResult } from "../memory/retrieval";
import { compareProductUpdates, comparePricing } from "../research/change-detector";
import { screenSources, validateEvidence, verifyHistoricalClaims } from "../research/evidence";
import { AnalysisSchema, EvidenceExtractionSchema, PlanSchema, type Analysis, type Plan } from "../research/schemas";
import type { CachedSearch } from "../search/cached";
import { dedupeResults } from "../search/normalize";
import { rankSources, trustedDomainHint, type QueryPurpose, type SubjectHint } from "../search/ranking";
import type { AppConfig } from "../shared/config";
import { isValidTimezone } from "../shared/config";
import { AppError, isAbortError, toAppError } from "../shared/errors";
import { newId, nowIso } from "../shared/ids";
import { subjectMatches, truncate } from "../shared/text";
import type {
  AgentEvent,
  Comparison,
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
import { attachMissingCitations, CitationFilter, finalizeAnswer, StreamUrlFilter } from "./citations";
import { buildSynthesisContext, formatClaims, formatMemory, formatRecent, formatSourcesForExtraction } from "./context";
import { enforceRouting, followUpSuggestions, heuristicAnalysis, wantsUpdateCheck } from "./heuristics";
import { finalizeSearchPlan, normalizeClaims, updateSearchedSubjects } from "../research/planner";
import {
  ANALYZE_SYSTEM,
  analyzePrompt,
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
  memory: MemoryResult | null;
  plan: Plan | null;
  claims: HistoricalClaim[];
  sources: Source[];
  searchRecords: SearchRecordInput[];
  evidence: Evidence[];
  comparisons: Comparison[];
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

  private async runUnlocked(input: RunInput, emit: (e: AgentEvent) => void): Promise<Message> {
    const { config, repos } = this.deps;
    const started = Date.now();

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
      memory: null,
      plan: null,
      claims: [],
      sources: [],
      searchRecords: [],
      evidence: [],
      comparisons: [],
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
          state.analysis = enforceRouting(a, text, state.temporal.references);
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
        return `${state.analysis.intent}${state.analysis.needsWebSearch ? " · web search" : ""}${state.analysis.needsMemory ? " · memory" : ""}`;
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
      if (searchWanted && this.deps.search) {
        await this.runResearch(state, llm, recent, signal, emit);
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
          memory: state.memory?.summary ?? { status: "not_requested", conversationIds: [], messageIds: [] },
          notes: state.notes,
          followUps: followUpSuggestions({
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
      const queue: Array<{ s: (typeof plan.searches)[number]; domain: string | null }> = plan.searches.map((s) => ({
        s,
        domain: s.purpose === "pricing" ? domainFor(s.subject) : null,
      }));
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
        if (q.domain) queue.push({ s: q.s, domain: null });
      }
      const openDone = new Set<string>();
      const worker = async () => {
        while (queue.length > 0) {
          const { s, domain } = queue.shift()!;
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
              includeDomains: domain ? [domain] : undefined,
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
              metadata: { purpose: s.purpose, subject: s.subject, includeDomains: domain ? [domain] : [], urls: out.results.map((r) => r.url) },
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
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const failed = state.searchRecords.filter((r) => r.status === "failed" || r.status === "timeout").length;
      if (failed > 0) state.notes.push(`${failed} of ${state.searchRecords.length} web searches failed; results may be incomplete.`);

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
      const pricing = comparePricing(state.claims, state.evidence);
      const subjectNames = plan.subjects.map((s) => s.name);
      // Product-update rows only when the user asked about launches/updates or whether an answer is
      // still correct (deterministic gate), and "not checked" when no update search actually ran.
      const executed = new Set(state.searchRecords.filter((r) => r.status === "ok" || r.status === "cached").map((r) => r.query));
      const updates =
        wantsUpdateCheck(state.userMessage.content) && subjectNames.length
          ? compareProductUpdates(subjectNames, state.evidence, state.memory?.summary.baselineDate, updateSearchedSubjects(plan.searches, executed))
          : [];
      state.comparisons = [...pricing, ...updates];
      if (state.comparisons.length) emit({ type: "comparison", comparisons: state.comparisons });
      const counts = state.comparisons.reduce<Record<string, number>>((acc, c) => ((acc[c.status] = (acc[c.status] ?? 0) + 1), acc), {});
      return Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing to compare";
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
    const context = buildSynthesisContext({
      question: state.userMessage.content,
      nowLocal: state.nowLocal,
      timezone: state.conversation.timezone,
      recent,
      memory: state.memory,
      memoryRequested: state.analysis.needsMemory,
      comparisons: state.comparisons,
      evidence: state.evidence,
      sources: state.sources,
      notes: state.notes,
      searchAttempted: state.searchRecords.length > 0,
      maxChars: this.deps.config.budgets.maxContextChars,
    });
    const filter = new CitationFilter(new Set(state.sources.map((s) => s.id)));
    const urlGuard = new StreamUrlFilter(state.sources.map((s) => s.url));
    let raw = "";
    try {
      for await (const chunk of llm.streamText(
        { system: SYNTHESIZE_SYSTEM, messages: [{ role: "user", content: context }], promptVersion: PROMPT_VERSIONS.synthesize, maxTokens: 3072, signal },
        state.tracker,
      )) {
        const out = urlGuard.push(filter.push(chunk));
        if (out) {
          raw += out;
          emit({ type: "token", text: out });
        }
      }
      const tail = urlGuard.push(filter.flush()) + urlGuard.flush();
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
    // Attach citations the model omitted for verified values (deterministic; see attachMissingCitations).
    const content = attachMissingCitations(final.text, state.evidence);
    const citedIds = new Set([...content.matchAll(/\[(S\d+)\]/g)].map((m) => m[1]!));
    // Sources list: cited ones first, then the others that informed comparisons.
    const cited = state.sources.filter((s) => citedIds.has(s.id));
    const compared = new Set(state.comparisons.flatMap((c) => c.sourceIds));
    const rest = state.sources.filter((s) => !citedIds.has(s.id) && compared.has(s.id));
    return { content, usedSources: [...cited, ...rest] };
  }

  // ── helpers ─────────────────────────────────────────────────────────

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
