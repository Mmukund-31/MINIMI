import { AgentOrchestrator, type Logger } from "./agent/orchestrator";
import { checkDatabase, openDatabase, type Db } from "./db/connection";
import { createRepositories, type Repositories } from "./db/repositories";
import { createLLMClient, type LLMClient } from "./llm/client";
import { CachedSearch } from "./search/cached";
import type { SearchProvider } from "./search/provider";
import { TavilySearchProvider } from "./search/tavily";
import { seedIfEmpty } from "./seed/demo";
import { missingCredentials, type AppConfig } from "./shared/config";
import { AppError } from "./shared/errors";

export interface Runtime {
  config: AppConfig;
  db: Db;
  repos: Repositories;
  agent: AgentOrchestrator;
  llm: LLMClient | null;
  search: CachedSearch | null;
  status(): RuntimeStatus;
  close(): void;
}

export interface RuntimeStatus {
  database: boolean;
  llm: { configured: boolean; provider: string; models: string[]; error?: string };
  search: { configured: boolean; provider: string };
  missing: string[];
}

export interface RuntimeOverrides {
  llm?: LLMClient | null;
  searchProvider?: SearchProvider | null;
  logger?: Logger;
  now?: () => Date;
  seed?: boolean;
}

/** Composition root: wires config → database → providers → orchestrator. */
export function createRuntime(config: AppConfig, overrides: RuntimeOverrides = {}): Runtime {
  const db = openDatabase(config.databasePath);
  const repos = createRepositories(db);

  if (overrides.seed ?? config.seedDemoData) {
    seedIfEmpty(repos, db, { timezone: config.timezone, now: overrides.now?.() });
  }

  let llm: LLMClient | null = null;
  let llmError: string | undefined;
  if (overrides.llm !== undefined) llm = overrides.llm;
  else {
    try {
      llm = createLLMClient(config);
    } catch (err) {
      llmError = err instanceof AppError ? err.message : String(err);
    }
  }

  let searchProvider: SearchProvider | null = null;
  if (overrides.searchProvider !== undefined) searchProvider = overrides.searchProvider;
  else if (config.search.tavilyApiKey) searchProvider = new TavilySearchProvider(config.search.tavilyApiKey, { timeoutMs: config.search.timeoutMs });
  const search = searchProvider ? new CachedSearch(searchProvider, repos.searchCache, config.search.cacheTtlHours) : null;

  const agent = new AgentOrchestrator({ config, repos, llm, search, logger: overrides.logger, now: overrides.now });

  return {
    config,
    db,
    repos,
    agent,
    llm,
    search,
    status: () => ({
      database: checkDatabase(db),
      llm: {
        configured: llm !== null,
        provider: llm?.describe().provider ?? config.llm.provider,
        models: llm?.describe().models ?? [...new Set([config.llm.modelFast, config.llm.modelExtract, config.llm.modelSynthesis])],
        error: llmError,
      },
      search: { configured: search !== null, provider: search?.name ?? "tavily" },
      missing: overrides.llm !== undefined || overrides.searchProvider !== undefined ? [] : missingCredentials(config),
    }),
    close: () => db.close(),
  };
}
