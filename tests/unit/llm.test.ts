import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, LLMClient, loadConfig, missingCredentials, parseJsonLoose, toProviderJsonSchema, UsageTracker } from "@minimi/core";
import { ScriptedLLMProvider } from "@minimi/core/testing";

const Schema = z.object({ answer: z.string(), score: z.number().min(0).max(1), note: z.string().nullable() });

const client = (structured: unknown[]) => {
  const p = new ScriptedLLMProvider({ structured: { s: structured as never }, synthesis: "ok" });
  return { p, c: new LLMClient({ fast: { provider: p, model: "m" }, extract: { provider: p, model: "m" }, synthesis: { provider: p, model: "m" } }) };
};
const req = { schema: Schema, schemaName: "s", system: "sys", prompt: "p", promptVersion: "v1" };

describe("LLMClient structured output", () => {
  it("validates and returns parsed output", async () => {
    const { c } = client([{ answer: "a", score: 0.5, note: null }]);
    const t = new UsageTracker({ maxLlmCalls: 5, maxSearches: 1 });
    expect(await c.generateStructured(req, t)).toEqual({ answer: "a", score: 0.5, note: null });
    expect(t.llmCalls).toBe(1);
  });

  it("repairs once after invalid output, sending the validation error back", async () => {
    const { c, p } = client(["not json at all", '```json\n{"answer":"b","score":1,"note":"x"}\n```']);
    const t = new UsageTracker({ maxLlmCalls: 5, maxSearches: 1 });
    expect((await c.generateStructured(req, t)).answer).toBe("b");
    expect(t.llmCalls).toBe(2);
    expect(p.calls[1]!.prompt).toMatch(/not valid JSON/);
  });

  it("gives up with LLM_INVALID_OUTPUT after the repair attempt fails", async () => {
    const { c } = client([{ answer: "a", score: 7, note: null }, { answer: "a" }]);
    const t = new UsageTracker({ maxLlmCalls: 5, maxSearches: 1 });
    await expect(c.generateStructured(req, t)).rejects.toMatchObject({ code: "LLM_INVALID_OUTPUT" });
  });

  it("never spends the call reserved for the final answer", async () => {
    const { c } = client([{ answer: "a", score: 0.5, note: null }]);
    const t = new UsageTracker({ maxLlmCalls: 2, maxSearches: 1 });
    await c.generateStructured(req, t);
    await expect(c.generateStructured(req, t)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});

describe("structured-output helpers", () => {
  it("produces closed JSON schemas without validation-only keywords", () => {
    const js = toProviderJsonSchema(Schema) as { additionalProperties: boolean; required: string[]; properties: Record<string, Record<string, unknown>> };
    expect(js.additionalProperties).toBe(false);
    expect(js.required).toEqual(["answer", "score", "note"]);
    expect(js.properties.score).not.toHaveProperty("minimum");
    expect(js).not.toHaveProperty("$schema");
  });
  it("extracts JSON from prose and code fences", () => {
    expect(parseJsonLoose('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
    expect(() => parseJsonLoose("nope")).toThrow(SyntaxError);
  });
});

describe("usage tracker", () => {
  it("enforces the search budget", () => {
    const t = new UsageTracker({ maxLlmCalls: 3, maxSearches: 2 });
    t.beginSearch();
    t.beginSearch();
    expect(t.canSearch()).toBe(false);
    expect(() => t.beginSearch()).toThrow(AppError);
  });
});

describe("config", () => {
  it("applies provider defaults and reports missing credentials", () => {
    const cfg = loadConfig({ LLM_PROVIDER: "groq", DATABASE_PATH: ":memory:" } as NodeJS.ProcessEnv);
    expect(cfg.llm.modelFast).toBe("openai/gpt-oss-20b");
    expect(cfg.llm.modelExtract).toBe("openai/gpt-oss-120b");
    expect(missingCredentials(cfg)).toEqual(["GROQ_API_KEY", "TAVILY_API_KEY"]);
    const mixed = loadConfig({ LLM_PROVIDER: "groq", LLM_SYNTHESIS_PROVIDER: "anthropic", GROQ_API_KEY: "g", TAVILY_API_KEY: "t" } as NodeJS.ProcessEnv);
    expect(mixed.llm.modelSynthesis).toBe("claude-opus-5-5");
    expect(missingCredentials(mixed)).toEqual(["ANTHROPIC_API_KEY"]);
  });
  it("rejects invalid values with a clear message", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "nope" } as NodeJS.ProcessEnv)).toThrow(/LLM_PROVIDER/);
  });
});
