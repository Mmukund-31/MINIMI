import type { SearchCacheRepository } from "../db/repositories";
import { sha256 } from "../shared/ids";
import type { SearchResult } from "../shared/types";
import type { SearchOptions, SearchProvider } from "./provider";

export interface CachedSearchOutcome {
  results: SearchResult[];
  cached: boolean;
}

/**
 * SQLite-backed cache in front of a SearchProvider. Identical queries within
 * the TTL reuse stored results (saves quota, makes re-runs reproducible).
 * Failures are never cached.
 */
export class CachedSearch {
  constructor(
    private readonly provider: SearchProvider,
    private readonly cache: SearchCacheRepository,
    private readonly ttlHours: number,
  ) {}

  get name(): string {
    return this.provider.name;
  }

  static key(provider: string, query: string, opts: SearchOptions): string {
    return sha256(
      JSON.stringify([provider, query.trim().toLowerCase().replace(/\s+/g, " "), opts.maxResults, opts.recency ?? null, opts.topic ?? "general", opts.depth ?? "advanced", opts.includeDomains ?? []]),
    );
  }

  async search(query: string, opts: SearchOptions): Promise<CachedSearchOutcome> {
    const key = CachedSearch.key(this.provider.name, query, opts);
    if (this.ttlHours > 0) {
      const hit = this.cache.get(key, this.ttlHours * 3_600_000);
      if (hit) {
        try {
          return { results: JSON.parse(hit) as SearchResult[], cached: true };
        } catch {
          // corrupt entry: fall through and refresh
        }
      }
    }
    const results = await this.provider.search(query, opts);
    if (this.ttlHours > 0) this.cache.set(key, this.provider.name, query, JSON.stringify(results));
    return { results, cached: false };
  }
}
