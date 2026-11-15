import type { TokenUsage } from "../shared/types";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export type Effort = "low" | "medium" | "high";

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  model: string;
  maxTokens: number;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface JsonCompletionRequest extends CompletionRequest {
  schemaName: string;
  /** JSON Schema (already sanitised for provider structured-output modes). */
  jsonSchema: Record<string, unknown>;
}

export interface CompletionResult {
  text: string;
  usage: TokenUsage;
}

export type StreamChunk = { type: "text"; text: string } | { type: "usage"; usage: TokenUsage };

/**
 * A provider adapter. Deliberately small: the orchestrator only needs
 * "give me JSON for this schema" and "stream me prose". Validation, repair,
 * budgets and usage accounting live in LLMClient, so every provider (and the
 * deterministic test provider) goes through the same checks.
 */
export interface LLMProvider {
  readonly name: string;
  completeJson(req: JsonCompletionRequest): Promise<CompletionResult>;
  streamText(req: CompletionRequest): AsyncIterable<StreamChunk>;
}
