import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Repository root, resolved from this file's location (works from src and bundled dist). */
export function findRepoRoot(start = dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, ".env.example")) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Loads `<repo>/.env` into process.env (without overriding real env vars). */
export function loadDotEnv(root = findRepoRoot()): void {
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  const before = { ...process.env };
  process.loadEnvFile(file);
  // process.loadEnvFile overrides existing values; restore explicitly-set ones.
  for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
}

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const int = (def: number, min = 1, max = 1_000_000) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));
const bool = (def: boolean) =>
  z.preprocess(
    (v) => (v === undefined || v === "" ? def : String(v).toLowerCase() === "true" || v === "1"),
    z.boolean(),
  );

export const providerNames = ["groq", "anthropic", "openai"] as const;
export type ProviderName = (typeof providerNames)[number];

const EnvSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.enum(["development", "production", "test"]).default("development")),
  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(providerNames).default("groq")),
  LLM_SYNTHESIS_PROVIDER: z.preprocess(emptyToUndefined, z.enum(providerNames).optional()),
  GROQ_API_KEY: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalString,
  LLM_MODEL_FAST: optionalString,
  LLM_MODEL_EXTRACT: optionalString,
  LLM_MODEL_SYNTHESIS: optionalString,
  TAVILY_API_KEY: optionalString,
  PORT: int(8787, 1, 65535),
  HOST: z.preprocess(emptyToUndefined, z.string().default("127.0.0.1")),
  APP_TIMEZONE: optionalString,
  DATABASE_PATH: z.preprocess(emptyToUndefined, z.string().default("data/minimi.db")),
  SEED_DEMO_DATA: bool(true),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")),
  MAX_SEARCHES: int(10, 1, 24),
  MAX_RESULTS_PER_SEARCH: int(5, 1, 20),
  MAX_SOURCES: int(12, 1, 40),
  SEARCH_TIMEOUT_MS: int(15_000, 1_000),
  LLM_TIMEOUT_MS: int(90_000, 1_000),
  MAX_LLM_CALLS: int(8, 2, 20),
  MAX_EXECUTION_MS: int(180_000, 5_000),
  MAX_CONTEXT_CHARS: int(24_000, 2_000),
  SEARCH_CACHE_TTL_HOURS: int(6, 0, 24 * 30),
});

/**
 * Per-role defaults. On Groq's free tier every model has its own tokens-per-minute
 * bucket (8K TPM measured), so the heavy evidence-extraction call runs on a
 * different model from the analysis/planning/synthesis calls: one research
 * request then fits inside both buckets instead of stalling on rate limits.
 */
export const DEFAULT_MODELS: Record<ProviderName, { fast: string; extract: string; synthesis: string }> = {
  groq: { fast: "openai/gpt-oss-20b", extract: "openai/gpt-oss-120b", synthesis: "openai/gpt-oss-20b" },
  anthropic: { fast: "claude-opus-5-5", extract: "claude-opus-5-5", synthesis: "claude-opus-5-5" },
  openai: { fast: "gpt-5-mini", extract: "gpt-5-mini", synthesis: "gpt-5-mini" },
};

export interface AppConfig {
  env: "development" | "production" | "test";
  rootDir: string;
  llm: {
    provider: ProviderName;
    synthesisProvider: ProviderName;
    modelFast: string;
    modelExtract: string;
    modelSynthesis: string;
    keys: { groq?: string; anthropic?: string; openai?: string };
    openaiBaseUrl?: string;
    timeoutMs: number;
  };
  search: { tavilyApiKey?: string; timeoutMs: number; cacheTtlHours: number };
  server: { port: number; host: string; logLevel: string };
  timezone: string;
  databasePath: string;
  seedDemoData: boolean;
  budgets: {
    maxSearches: number;
    maxResultsPerSearch: number;
    maxSources: number;
    maxLlmCalls: number;
    maxExecutionMs: number;
    maxContextChars: number;
  };
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTimezone(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, rootDir = findRepoRoot()): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const provider = e.LLM_PROVIDER;
  const synthesisProvider = e.LLM_SYNTHESIS_PROVIDER ?? provider;
  // Model overrides apply to the primary provider; the synthesis override applies to the synthesis provider.
  const modelFast = e.LLM_MODEL_FAST ?? DEFAULT_MODELS[provider].fast;
  const modelExtract = e.LLM_MODEL_EXTRACT ?? e.LLM_MODEL_FAST ?? DEFAULT_MODELS[provider].extract;
  const modelSynthesis =
    e.LLM_MODEL_SYNTHESIS ??
    (synthesisProvider === provider && e.LLM_MODEL_FAST ? e.LLM_MODEL_FAST : DEFAULT_MODELS[synthesisProvider].synthesis);
  const tz = isValidTimezone(e.APP_TIMEZONE) ? e.APP_TIMEZONE : systemTimezone();
  return {
    env: e.NODE_ENV,
    rootDir,
    llm: {
      provider,
      synthesisProvider,
      modelFast,
      modelExtract,
      modelSynthesis,
      keys: { groq: e.GROQ_API_KEY, anthropic: e.ANTHROPIC_API_KEY, openai: e.OPENAI_API_KEY },
      openaiBaseUrl: e.OPENAI_BASE_URL,
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
    search: { tavilyApiKey: e.TAVILY_API_KEY, timeoutMs: e.SEARCH_TIMEOUT_MS, cacheTtlHours: e.SEARCH_CACHE_TTL_HOURS },
    server: { port: e.PORT, host: e.HOST, logLevel: e.LOG_LEVEL },
    timezone: tz,
    databasePath: e.DATABASE_PATH === ":memory:" || isAbsolute(e.DATABASE_PATH) ? e.DATABASE_PATH : resolve(rootDir, e.DATABASE_PATH),
    seedDemoData: e.SEED_DEMO_DATA,
    budgets: {
      maxSearches: e.MAX_SEARCHES,
      maxResultsPerSearch: e.MAX_RESULTS_PER_SEARCH,
      maxSources: e.MAX_SOURCES,
      maxLlmCalls: e.MAX_LLM_CALLS,
      maxExecutionMs: e.MAX_EXECUTION_MS,
      maxContextChars: e.MAX_CONTEXT_CHARS,
    },
  };
}

/** Human-readable list of missing credentials for the configured providers. */
export function missingCredentials(cfg: AppConfig): string[] {
  const missing: string[] = [];
  const need = new Set([cfg.llm.provider, cfg.llm.synthesisProvider]);
  if (need.has("groq") && !cfg.llm.keys.groq) missing.push("GROQ_API_KEY");
  if (need.has("anthropic") && !cfg.llm.keys.anthropic) missing.push("ANTHROPIC_API_KEY");
  if (need.has("openai") && !cfg.llm.keys.openai) missing.push("OPENAI_API_KEY");
  if (!cfg.search.tavilyApiKey) missing.push("TAVILY_API_KEY");
  return missing;
}
