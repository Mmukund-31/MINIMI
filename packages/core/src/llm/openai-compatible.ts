import OpenAI from "openai";
import { AppError } from "../shared/errors";
import type { CompletionRequest, CompletionResult, JsonCompletionRequest, LLMProvider, StreamChunk } from "./types";

export interface OpenAICompatibleOptions {
  name: string;
  apiKey: string;
  baseURL?: string;
  timeoutMs: number;
  maxRetries?: number;
}

/**
 * Adapter for OpenAI-compatible Chat Completions APIs (Groq, OpenAI, others).
 *
 * Structured output: requests `json_schema` response format (non-strict, for
 * broad model support); if the endpoint/model rejects it, falls back to
 * `json_object` mode with the schema in the prompt. The caller validates.
 * Retries for 408/409/429/5xx/connection errors are handled by the SDK
 * (exponential backoff, honours `retry-after`).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private readonly client: OpenAI;
  private jsonSchemaUnsupported = new Set<string>();

  constructor(opts: OpenAICompatibleOptions) {
    this.name = opts.name;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs,
      maxRetries: opts.maxRetries ?? 2,
    });
  }

  private reasoningParams(model: string, effort: CompletionRequest["effort"]): Record<string, unknown> {
    // gpt-oss models on Groq (and OpenAI reasoning models) accept reasoning_effort.
    if (/gpt-oss|^o\d|gpt-5/i.test(model)) return { reasoning_effort: effort ?? "low" };
    return {};
  }

  async completeJson(req: JsonCompletionRequest): Promise<CompletionResult> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: req.system },
      ...req.messages.map((m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.ChatCompletionMessageParam),
    ];
    const useSchema = !this.jsonSchemaUnsupported.has(req.model);
    try {
      return await this.callJson(req, messages, useSchema);
    } catch (err) {
      // Some models reject json_schema; remember and retry with json_object.
      if (useSchema && err instanceof OpenAI.BadRequestError && /response_format|json_schema|schema/i.test(err.message)) {
        this.jsonSchemaUnsupported.add(req.model);
        return this.callJson(req, messages, false);
      }
      throw mapError(err, this.name);
    }
  }

  private async callJson(
    req: JsonCompletionRequest,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    useSchema: boolean,
  ): Promise<CompletionResult> {
    const finalMessages = useSchema
      ? messages
      : [
          ...messages,
          {
            role: "user" as const,
            content: `Respond with a single JSON object that conforms to this JSON Schema (no prose, no code fences):\n${JSON.stringify(req.jsonSchema)}`,
          },
        ];
    try {
      const res = await this.client.chat.completions.create(
        {
          model: req.model,
          messages: finalMessages,
          max_completion_tokens: req.maxTokens,
          response_format: useSchema
            ? { type: "json_schema", json_schema: { name: req.schemaName, schema: req.jsonSchema, strict: false } }
            : { type: "json_object" },
          ...this.reasoningParams(req.model, req.effort),
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
        { signal: req.signal },
      );
      const choice = res.choices[0];
      return {
        text: choice?.message?.content ?? "",
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
      };
    } catch (err) {
      if (err instanceof OpenAI.BadRequestError) throw err; // let completeJson decide on fallback
      throw mapError(err, this.name);
    }
  }

  async *streamText(req: CompletionRequest): AsyncIterable<StreamChunk> {
    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      stream = (await this.client.chat.completions.create(
        {
          model: req.model,
          messages: [
            { role: "system", content: req.system },
            ...req.messages.map((m) => ({ role: m.role, content: m.content }) as OpenAI.Chat.ChatCompletionMessageParam),
          ],
          max_completion_tokens: req.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          ...this.reasoningParams(req.model, req.effort),
        } as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: req.signal },
      )) as unknown as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    } catch (err) {
      throw mapError(err, this.name);
    }
    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield { type: "text", text: delta };
        if (chunk.usage) {
          yield { type: "usage", usage: { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 } };
        }
      }
    } catch (err) {
      throw mapError(err, this.name);
    }
  }
}

function mapError(err: unknown, provider: string): unknown {
  if (err instanceof AppError) return err;
  if (err instanceof OpenAI.APIUserAbortError) return err;
  if (err instanceof OpenAI.RateLimitError) {
    return new AppError("LLM_RATE_LIMIT", `${provider} rate limit reached. Please wait a moment and retry.`, { retryable: true, cause: err });
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new AppError("NOT_CONFIGURED", `${provider} rejected the API key.`, { cause: err });
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new AppError("TIMEOUT", `${provider} timed out.`, { retryable: true, cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    return new AppError("LLM_ERROR", `${provider} request failed${status ? ` (HTTP ${status})` : ""}.`, {
      retryable: status >= 500 || status === 0,
      cause: err,
    });
  }
  return err;
}
