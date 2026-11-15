import { AppError } from "../shared/errors";
import type { TokenUsage } from "../shared/types";

/**
 * Per-execution accounting for LLM and search calls. Enforces the call
 * budgets: exceeding one throws BUDGET_EXCEEDED, which the orchestrator turns
 * into graceful degradation, never an unbounded loop.
 */
export class UsageTracker {
  llmCalls = 0;
  searchCalls = 0;
  cacheHits = 0;
  readonly usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  readonly models = new Set<string>();
  readonly promptVersions: string[] = [];

  constructor(private readonly limits: { maxLlmCalls: number; maxSearches: number }) {}

  beginLlmCall(model: string, promptVersion: string): void {
    if (this.llmCalls >= this.limits.maxLlmCalls) {
      throw new AppError("BUDGET_EXCEEDED", `LLM call budget (${this.limits.maxLlmCalls}) exhausted.`);
    }
    this.llmCalls++;
    this.models.add(model);
    this.promptVersions.push(promptVersion);
  }

  addUsage(u: TokenUsage): void {
    this.usage.inputTokens += u.inputTokens;
    this.usage.outputTokens += u.outputTokens;
  }

  canSearch(): boolean {
    return this.searchCalls < this.limits.maxSearches;
  }

  beginSearch(): void {
    if (!this.canSearch()) throw new AppError("BUDGET_EXCEEDED", `Search budget (${this.limits.maxSearches}) exhausted.`);
    this.searchCalls++;
  }

  remainingLlmCalls(): number {
    return this.limits.maxLlmCalls - this.llmCalls;
  }
}
