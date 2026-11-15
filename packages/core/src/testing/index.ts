/**
 * DETERMINISTIC TEST DOUBLES. Used only by the automated tests and the offline
 * evaluation suite. They are never wired into the running application.
 *
 * - ScriptedLLMProvider returns pre-written model outputs per stage (including
 *   deliberately invalid or adversarial ones), so the real validation,
 *   comparison and citation code paths run unchanged.
 * - FixtureSearchProvider returns canned search results, timeouts or errors.
 */
import { AppError } from "../shared/errors";
import { normalizeResult } from "../search/normalize";
import type { SearchOptions, SearchProvider } from "../search/provider";
import type { SearchResult, TokenUsage } from "../shared/types";
import type { CompletionRequest, CompletionResult, JsonCompletionRequest, LLMProvider, StreamChunk } from "../llm/types";

export type ScriptedResponse = string | object | Error | ((req: JsonCompletionRequest, callIndex: number) => string | object);

export interface ScriptedLLMOptions {
  /** Keyed by schemaName: message_analysis | research_plan | evidence_extraction. Arrays are consumed in order. */
  structured: Record<string, ScriptedResponse | ScriptedResponse[]>;
  /** Final answer text, or a function of the synthesis prompt. */
  synthesis: string | ((req: CompletionRequest) => string) | Error;
  /** Simulate a provider failure part-way through streaming the answer. */
  streamFailure?: { afterChars: number; error: Error };
  usage?: TokenUsage;
}

export class ScriptedLLMProvider implements LLMProvider {
  readonly name = "scripted";
  readonly calls: Array<{ kind: "json" | "stream"; schemaName?: string; system: string; prompt: string }> = [];
  private counters = new Map<string, number>();

  constructor(private readonly opts: ScriptedLLMOptions) {}

  async completeJson(req: JsonCompletionRequest): Promise<CompletionResult> {
    this.calls.push({ kind: "json", schemaName: req.schemaName, system: req.system, prompt: req.messages.map((m) => m.content).join("\n") });
    const entry = this.opts.structured[req.schemaName];
    if (entry === undefined) throw new AppError("LLM_ERROR", `No scripted response for ${req.schemaName}`);
    const n = this.counters.get(req.schemaName) ?? 0;
    this.counters.set(req.schemaName, n + 1);
    const resp = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry;
    if (resp instanceof Error) throw resp;
    const value = typeof resp === "function" ? resp(req, n) : resp;
    return { text: typeof value === "string" ? value : JSON.stringify(value), usage: this.opts.usage ?? { inputTokens: 0, outputTokens: 0 } };
  }

  async *streamText(req: CompletionRequest): AsyncIterable<StreamChunk> {
    this.calls.push({ kind: "stream", system: req.system, prompt: req.messages.map((m) => m.content).join("\n") });
    const s = this.opts.synthesis;
    if (s instanceof Error) throw s;
    const text = typeof s === "function" ? s(req) : s;
    // Emit in small uneven chunks to exercise the streaming citation filter.
    for (let i = 0; i < text.length; ) {
      if (this.opts.streamFailure && i >= this.opts.streamFailure.afterChars) throw this.opts.streamFailure.error;
      const size = 3 + (i % 7);
      yield { type: "text", text: text.slice(i, i + size) };
      i += size;
    }
    yield { type: "usage", usage: this.opts.usage ?? { inputTokens: 0, outputTokens: 0 } };
  }

  structuredCalls(): string[] {
    return this.calls.filter((c) => c.kind === "json").map((c) => c.schemaName!);
  }
}

export type FixtureResult = Partial<SearchResult> & { url: string; title: string; snippet: string };
export type FixtureEntry = FixtureResult[] | "timeout" | "error";

export class FixtureSearchProvider implements SearchProvider {
  readonly name = "fixture";
  readonly queries: string[] = [];

  /**
   * @param fixtures matched in order: exact query, then the first key whose
   *        words all appear in the query (case-insensitive), then `fallback`.
   */
  constructor(
    private readonly fixtures: Record<string, FixtureEntry>,
    private readonly fallback: FixtureEntry = [],
    private readonly retrievedAt = "2026-11-15T09:00:00.000Z",
  ) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    this.queries.push(query);
    const entry = this.lookup(query);
    if (entry === "timeout") throw new AppError("SEARCH_TIMEOUT", "Search timed out (fixture).", { retryable: true });
    if (entry === "error") throw new AppError("SEARCH_ERROR", "Search failed (fixture).", { retryable: true });
    return entry
      .map((r) => normalizeResult({ ...r, query }, { provider: this.name, query, retrievedAt: this.retrievedAt }))
      .filter((r): r is SearchResult => r !== null)
      // Honour include_domains like the real provider does.
      .filter((r) => !opts.includeDomains?.length || opts.includeDomains.some((d) => r.sourceDomain === d || r.sourceDomain.endsWith(`.${d}`)))
      .slice(0, opts.maxResults);
  }

  private lookup(query: string): FixtureEntry {
    if (this.fixtures[query]) return this.fixtures[query]!;
    const q = query.toLowerCase();
    for (const [k, v] of Object.entries(this.fixtures)) {
      if (k.toLowerCase().split(/\s+/).every((w) => q.includes(w))) return v;
    }
    return this.fallback;
  }
}
