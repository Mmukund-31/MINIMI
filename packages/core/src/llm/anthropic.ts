import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../shared/errors";
import type { CompletionRequest, CompletionResult, JsonCompletionRequest, LLMProvider, StreamChunk } from "./types";

export interface AnthropicOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries?: number;
}

/** Models that support server-side refusal fallbacks (beta `server-side-fallback-2026-07-01`). */
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5)/;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Anthropic Messages API adapter.
 *
 * - Structured output via `output_config.format` (JSON schema); validated again locally.
 * - Depth/cost controlled with `output_config.effort` (thinking stays adaptive by default).
 * - Refusal handling: checks `stop_reason === "refusal"`; on supported models
 *   the server-side fallback is enabled so a refusal is retried on a fallback model.
 * - Retries (408/409/429/5xx/connection) handled by the SDK.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(opts: AnthropicOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: opts.maxRetries ?? 2 });
  }

  private fallbackParams(model: string): Record<string, unknown> {
    return FALLBACK_MODELS.test(model) ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {};
  }

  async completeJson(req: JsonCompletionRequest): Promise<CompletionResult> {
    try {
      const params = {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: {
          effort: req.effort ?? "low",
          format: { type: "json_schema", schema: req.jsonSchema },
        },
        ...this.fallbackParams(req.model),
      };
      const res = (await this.client.beta.messages.create(
        params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
        { signal: req.signal },
      )) as Anthropic.Beta.Messages.BetaMessage;
      if (res.stop_reason === "refusal") {
        throw new AppError("LLM_REFUSAL", "The model declined to answer this request.", { retryable: false });
      }
      const text = res.content
        .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      return { text, usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } };
    } catch (err) {
      throw mapError(err);
    }
  }

  async *streamText(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const params = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { effort: req.effort ?? "medium" },
      ...this.fallbackParams(req.model),
    };
    try {
      const stream = this.client.beta.messages.stream(
        params as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming,
        { signal: req.signal },
      );
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        throw new AppError("LLM_REFUSAL", "The model declined to answer this request.", { retryable: false });
      }
      yield { type: "usage", usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens } };
    } catch (err) {
      throw mapError(err);
    }
  }
}

function mapError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError("LLM_RATE_LIMIT", "Anthropic rate limit reached. Please wait a moment and retry.", { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AppError("NOT_CONFIGURED", "Anthropic rejected the API key.", { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new AppError("TIMEOUT", "Anthropic timed out.", { retryable: true, cause: err });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AppError("LLM_ERROR", `Anthropic rejected the request: ${err.message}`, { retryable: false, cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    return new AppError("LLM_ERROR", `Anthropic request failed${status ? ` (HTTP ${status})` : ""}.`, {
      retryable: status >= 500 || status === 0,
      cause: err,
    });
  }
  return err;
}
