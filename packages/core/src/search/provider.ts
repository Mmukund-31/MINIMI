import type { SearchResult } from "../shared/types";

export interface SearchOptions {
  maxResults: number;
  /** Restrict to recent content (used for "what's new" queries). */
  recency?: "week" | "month" | "year";
  /** "news" favours dated announcements (reliable publication dates); default "general". */
  topic?: "general" | "news";
  /** "advanced" returns richer page chunks (pricing tables); "basic" is cheaper. Default "advanced". */
  depth?: "basic" | "advanced";
  signal?: AbortSignal;
}

/**
 * The agent's single external tool. Providers return normalised results;
 * all results are treated as untrusted data downstream.
 */
export interface SearchProvider {
  readonly name: string;
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}
