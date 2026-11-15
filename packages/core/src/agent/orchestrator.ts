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
import { rankSources, type QueryPurpose, type SubjectHint } from "../search/ranking";
import type { AppConfig } from "../shared/config";
import { isValidTimezone } from "../shared/config";
import { AppError, isAbortError, toAppError } from "../shared/errors";
import { newId, nowIso } from "../shared/ids";
import { truncate } from "../shared/text";
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
import { CitationFilter, finalizeAnswer, StreamUrlFilter } from "./citations";
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

  constructor(private readonly deps: AgentDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.retriever = new MemoryRetriever(deps.repos.messages, deps.repos.conversations);
  }

  async run(input: RunInput, emit: (e: AgentEvent) => void): Promise<Message> {
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
    };
    repos.research.startSession({ id: state.id, conversationId: conversation.id, userMessageId: userMessage.id, query: text });
    const log = (obj: object, msg: string) => this.logger.info({ executionId: state.id, ...obj }, msg);

    try {
      const recent = repos.messages.recent(conversation.id, 8, userMessage.id);

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
              maxTokens: 2048,
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
        state.plan = await llm.generateStructured(
          { schema: PlanSchema, schemaName: "research_plan", system: p.system, prompt: p.prompt, promptVersion: PROMPT_VERSIONS.plan, maxTokens: 4096, signal },
          state.tracker,
        );
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
      const queue = [...plan.searches];
      const worker = async () => {
        while (queue.length > 0) {
          const s = queue.shift()!;
          if (!state.tracker.canSearch()) break;
          state.tracker.beginSearch();
          emit({ type: "search", query: s.query, status: "start" });
          const retrievedAt = nowIso();
          try {
            const isUpdate = s.purpose === "product_update";
            const out = await this.deps.search!.search(s.query, {
              maxResults: config.budgets.maxResultsPerSearch,
              recency: isUpdate ? "month" : undefined,
              topic: isUpdate ? "news" : "general",
              depth: isUpdate ? "basic" : "advanced",
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
              metadata: { purpose: s.purpose, subject: s.subject, urls: out.results.map((r) => r.url) },
            });
            emit({ type: "search", query: s.query, status: out.cached ? "cached" : "done", resultCount: out.results.length });
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
            emit({ type: "search", query: s.query, status: "failed", error: e.message });
            if (e.code === "NOT_CONFIGURED") throw e;
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      const failed = state.searchRecords.filter((r) => r.status === "failed" || r.status === "timeout").length;
      if (failed > 0) state.notes.push(`${failed} of ${state.searchRecords.length} web searches failed; results may be incomplete.`);

      const purposeByQuery = new Map<string, QueryPurpose>(plan.searches.map((s) => [s.query, s.purpose]));
      const subjects: SubjectHint[] = plan.subjects.length ? plan.subjects : state.analysis.entities.map((name) => ({ name, officialDomain: null }));
      const ranked = rankSources(dedupeResults(results), { subjects, purposeByQuery, maxSources: config.budgets.maxSources, now: state.now });
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
        const extraction = await llm.generateStructured(
          {
            schema: EvidenceExtractionSchema,
            schemaName: "evidence_extraction",
            system: EVIDENCE_SYSTEM,
            prompt: evidencePrompt({
              question: state.analysis.standaloneQuestion || state.userMessage.content,
              subjects,
              claims: formatClaims(state.claims),
              sources: formatSourcesForExtraction(state.sources, Math.floor(config.budgets.maxContextChars * 0.6)),
            }),
            promptVersion: PROMPT_VERSIONS.evidence,
            maxTokens: 8192,
            role: "extract",
            signal,
          },
          state.tracker,
        );
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
        { system: SYNTHESIZE_SYSTEM, messages: [{ role: "user", content: context }], promptVersion: PROMPT_VERSIONS.synthesize, maxTokens: 4096, signal },
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
    // Sources list: cited ones first, then the others that informed comparisons.
    const cited = state.sources.filter((s) => filter.used.has(s.id));
    const compared = new Set(state.comparisons.flatMap((c) => c.sourceIds));
    const rest = state.sources.filter((s) => !filter.used.has(s.id) && compared.has(s.id));
    return { content: final.text, usedSources: [...cited, ...rest] };
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private async stage(state: ExecutionState, stage: Stage, emit: (e: AgentEvent) => void, fn: () => Promise<string | undefined>): Promise<void> {
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
    const last = repos.messages.recent(conversation.id, 1)[0];
    if (last && last.role === "user" && last.content === text) return last;
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
