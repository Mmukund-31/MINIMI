import { createRuntime, LLMClient, loadConfig, type AgentEvent, type AppConfig, type Runtime } from "@minimi/core";
import { FixtureSearchProvider, ScriptedLLMProvider, type FixtureEntry, type ScriptedLLMOptions } from "@minimi/core/testing";
import { FIXED_NOW, TZ } from "./fixtures/demo-fixtures";

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_PATH: ":memory:",
    APP_TIMEZONE: TZ,
    SEED_DEMO_DATA: "false",
    SEARCH_CACHE_TTL_HOURS: "6",
    ...env,
  } as NodeJS.ProcessEnv);
}

export interface TestRuntime {
  runtime: Runtime;
  llm: ScriptedLLMProvider;
  search: FixtureSearchProvider | null;
}

export function makeRuntime(opts: {
  script: ScriptedLLMOptions;
  searchFixtures?: Record<string, FixtureEntry> | null;
  fallback?: FixtureEntry;
  seed?: boolean;
  env?: Record<string, string>;
  now?: Date;
}): TestRuntime {
  const llm = new ScriptedLLMProvider(opts.script);
  const search = opts.searchFixtures === null ? null : new FixtureSearchProvider(opts.searchFixtures ?? {}, opts.fallback ?? []);
  const now = opts.now ?? FIXED_NOW;
  const runtime = createRuntime(testConfig(opts.env), {
    llm: new LLMClient({ fast: { provider: llm, model: "scripted-fast" }, extract: { provider: llm, model: "scripted-fast" }, synthesis: { provider: llm, model: "scripted-synth" } }),
    searchProvider: search,
    now: () => now,
    seed: opts.seed ?? true,
  });
  return { runtime, llm, search };
}

export async function runTurn(runtime: Runtime, message: string, conversationId?: string) {
  const events: AgentEvent[] = [];
  let error: unknown;
  let result;
  try {
    result = await runtime.agent.run({ message, conversationId, timezone: TZ }, (e) => events.push(e));
  } catch (err) {
    error = err;
  }
  const text = events.filter((e): e is Extract<AgentEvent, { type: "token" }> => e.type === "token").map((e) => e.text).join("");
  return { events, result, error, text };
}

export function eventsOf<T extends AgentEvent["type"]>(events: AgentEvent[], type: T): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}
