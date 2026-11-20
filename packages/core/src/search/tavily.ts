import { AppError, isAbortError } from "../shared/errors";
import { nowIso } from "../shared/ids";
import type { SearchResult } from "../shared/types";
import { normalizeResult } from "./normalize";
import type { SearchOptions, SearchProvider } from "./provider";

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
  published_date?: string;
}

/**
 * Tavily Search API adapter (https://docs.tavily.com).
 * `search_depth: advanced` returns the most relevant page chunks, which carry
 * pricing tables and changelog entries far better than one-line snippets.
 */
export class TavilySearchProvider implements SearchProvider {
  readonly name = "tavily";

  constructor(
    private readonly apiKey: string,
    private readonly opts: { timeoutMs: number; endpoint?: string; fetchImpl?: typeof fetch } = { timeoutMs: 15_000 },
  ) {}

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const depth = options.depth ?? "advanced";
    const body: Record<string, unknown> = {
      query,
      search_depth: depth,
      max_results: options.maxResults,
      include_answer: false,
      include_raw_content: options.rawContent ? "markdown" : false,
      topic: options.topic ?? "general",
    };
    if (depth === "advanced") body.chunks_per_source = 3;
    if (options.includeDomains?.length) body.include_domains = options.includeDomains;
    if (options.recency) body.time_range = options.recency;

    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const doFetch = this.opts.fetchImpl ?? fetch;

    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await doFetch(this.opts.endpoint ?? "https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
        if (res.status === 401 || res.status === 403) {
          throw new AppError("NOT_CONFIGURED", "Tavily rejected the API key (check TAVILY_API_KEY).");
        }
        if (res.status === 432 || res.status === 433) {
          // Plan / pay-as-you-go credit limit: retrying can't help until the quota resets.
          throw new AppError("SEARCH_QUOTA", "The web-search quota (Tavily credits) is exhausted, so nothing could be searched. It resets with the Tavily plan, or use another TAVILY_API_KEY.");
        }
        if (res.status === 429 || res.status >= 500) {
          lastErr = new AppError("SEARCH_ERROR", `Tavily returned HTTP ${res.status}.`, { retryable: true });
          if (attempt === 0) {
            await sleep(800, signal);
            continue;
          }
          throw lastErr;
        }
        if (!res.ok) throw new AppError("SEARCH_ERROR", `Tavily returned HTTP ${res.status}.`);
        const json = (await res.json()) as { results?: TavilyResult[] };
        const retrievedAt = nowIso();
        return (json.results ?? [])
          .filter((r): r is TavilyResult & { url: string } => typeof r.url === "string")
          .map((r) =>
            normalizeResult(
              {
                title: r.title,
                url: r.url,
                snippet: r.content ?? "",
                content: r.raw_content ?? undefined,
                publishedAt: r.published_date,
                providerScore: r.score,
              },
              { provider: this.name, query, retrievedAt, fullText: options.rawContent },
            ),
          )
          .filter((r): r is SearchResult => r !== null);
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (isAbortError(err)) {
          if (timeout.aborted) throw new AppError("SEARCH_TIMEOUT", `Search timed out after ${this.opts.timeoutMs} ms.`, { retryable: true });
          throw err;
        }
        lastErr = err;
        if (attempt === 0) continue; // network error: one retry
      }
    }
    throw new AppError("SEARCH_ERROR", "Web search failed.", { retryable: true, cause: lastErr });
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}
