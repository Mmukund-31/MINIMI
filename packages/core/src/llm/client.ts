import type { z } from "zod";
import { AppError } from "../shared/errors";
import type { AppConfig } from "../shared/config";
import { AnthropicProvider } from "./anthropic";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { toProviderJsonSchema, validateJson } from "./structured-output";
import type { ChatMessage, Effort, LLMProvider } from "./types";
import type { UsageTracker } from "./usage";

/** fast: small structured stages · extract: evidence extraction (long input) · synthesis: streamed answer. */
export type LLMRole = "fast" | "extract" | "synthesis";

export interface RoleBinding {
  provider: LLMProvider;
  model: string;
}

export interface StructuredRequest<T> {
  schema: z.ZodType<T>;
  schemaName: string;
  system: string;
  prompt: string;
  /** Prompt version tag, recorded with usage for reproducibility. */
  promptVersion: string;
  maxTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
  role?: Exclude<LLMRole, "synthesis">;
}

export interface StreamRequest {
  system: string;
  messages: ChatMessage[];
  promptVersion: string;
  maxTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
}

/**
 * Provider-independent LLM façade used by the orchestrator.
 *
 * Responsibilities: role routing (fast structured stages vs. streamed
 * synthesis), call budget enforcement, token accounting, and Zod validation of
 * structured outputs with a single bounded repair attempt.
 */
export class LLMClient {
  constructor(private readonly roles: Record<LLMRole, RoleBinding>) {}

  describe(): { provider: string; models: string[] } {
    const all = [this.roles.fast, this.roles.extract, this.roles.synthesis];
    return { provider: [...new Set(all.map((r) => r.provider.name))].join("+"), models: [...new Set(all.map((r) => r.model))] };
  }

  async generateStructured<T>(req: StructuredRequest<T>, tracker: UsageTracker): Promise<T> {
    const { provider, model } = this.roles[req.role ?? "fast"];
    const jsonSchema = toProviderJsonSchema(req.schema);
    const messages: ChatMessage[] = [{ role: "user", content: req.prompt }];
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      // Structured stages may never consume the call reserved for the final answer.
      if (tracker.remainingLlmCalls() <= 1) {
        throw new AppError("BUDGET_EXCEEDED", "LLM call budget reserved for the final answer.");
      }
      tracker.beginLlmCall(model, req.promptVersion);
      const res = await provider.completeJson({
        system: req.system,
        messages,
        model,
        maxTokens: req.maxTokens ?? 8192,
        effort: req.effort ?? "low",
        schemaName: req.schemaName,
        jsonSchema,
        signal: req.signal,
      });
      tracker.addUsage(res.usage);
      const outcome = validateJson(req.schema, res.text);
      if (outcome.ok) return outcome.data;
      lastError = outcome.error;
      // Always keep one call in reserve for the final answer.
      if (tracker.remainingLlmCalls() <= 1) break;
      // One repair attempt: show the model its output and the validation error.
      messages.push(
        { role: "assistant", content: res.text.slice(0, 6000) || "(empty)" },
        { role: "user", content: `${outcome.error}\nReturn only the corrected JSON object.` },
      );
    }
    throw new AppError("LLM_INVALID_OUTPUT", `Model output failed validation for ${req.schemaName}: ${lastError}`, { retryable: true });
  }

  async *streamText(req: StreamRequest, tracker: UsageTracker): AsyncIterable<string> {
    const { provider, model } = this.roles.synthesis;
    tracker.beginLlmCall(model, req.promptVersion);
    for await (const chunk of provider.streamText({
      system: req.system,
      messages: req.messages,
      model,
      maxTokens: req.maxTokens ?? 8192,
      effort: req.effort ?? "medium",
      signal: req.signal,
    })) {
      if (chunk.type === "text") yield chunk.text;
      else tracker.addUsage(chunk.usage);
    }
  }
}

export function createProvider(name: AppConfig["llm"]["provider"], cfg: AppConfig): LLMProvider {
  const { keys, timeoutMs, openaiBaseUrl } = cfg.llm;
  switch (name) {
    case "groq":
      if (!keys.groq) throw new AppError("NOT_CONFIGURED", "GROQ_API_KEY is not set. Add it to .env (see .env.example).");
      return new OpenAICompatibleProvider({ name: "groq", apiKey: keys.groq, baseURL: "https://api.groq.com/openai/v1", timeoutMs });
    case "openai":
      if (!keys.openai) throw new AppError("NOT_CONFIGURED", "OPENAI_API_KEY is not set. Add it to .env (see .env.example).");
      return new OpenAICompatibleProvider({ name: "openai", apiKey: keys.openai, baseURL: openaiBaseUrl, timeoutMs });
    case "anthropic":
      if (!keys.anthropic) throw new AppError("NOT_CONFIGURED", "ANTHROPIC_API_KEY is not set. Add it to .env (see .env.example).");
      return new AnthropicProvider({ apiKey: keys.anthropic, timeoutMs });
  }
}

export function createLLMClient(cfg: AppConfig): LLMClient {
  const fast = createProvider(cfg.llm.provider, cfg);
  const synthesis = cfg.llm.synthesisProvider === cfg.llm.provider ? fast : createProvider(cfg.llm.synthesisProvider, cfg);
  return new LLMClient({
    fast: { provider: fast, model: cfg.llm.modelFast },
    extract: { provider: fast, model: cfg.llm.modelExtract },
    synthesis: { provider: synthesis, model: cfg.llm.modelSynthesis },
  });
}
