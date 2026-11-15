/**
 * Domain types shared by the backend and (via the API contract) the frontend.
 * All timestamps are ISO-8601 strings in UTC.
 */

export type Role = "user" | "assistant";

export interface Conversation {
  id: string;
  title: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  metadata: ConversationMetadata;
}

export interface ConversationMetadata {
  /** True for clearly-labelled demonstration data inserted by the seeder. */
  seeded?: boolean;
  seedLabel?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
  metadata: MessageMetadata;
}

export interface MessageMetadata {
  seeded?: boolean;
  executionId?: string;
  status?: "complete" | "error";
  sources?: SourceRef[];
  comparisons?: Comparison[];
  /** Current plans seen on vendor pages that the earlier answer did not mention (completeness, not change). */
  offering?: OfferingNote[];
  memory?: MemorySummary;
  notes?: string[];
  followUps?: string[];
  stats?: ExecutionStats;
}

// ── Web search ────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Longer extracted page text (may be absent). Untrusted. */
  content?: string;
  /** Publication date as reported by the provider. Never inferred. */
  publishedAt?: string;
  retrievedAt: string;
  sourceDomain: string;
  provider: string;
  /** Provider relevance score in [0,1] where available. */
  providerScore?: number;
  query: string;
}

export type SourceKind = "official_pricing" | "official_changelog" | "official" | "news" | "third_party";

/** A ranked, de-duplicated search result that the answer may cite as [S#]. */
export interface Source extends SearchResult {
  id: string;
  kind: SourceKind;
  rankScore: number;
}

/** What the client/persisted message keeps about a cited source. */
export interface SourceRef {
  id: string;
  title: string;
  url: string;
  domain: string;
  publishedAt?: string;
  retrievedAt: string;
  kind: SourceKind;
}

// ── Evidence & comparison ────────────────────────────────────────────────

export type ClaimCategory = "pricing" | "product_update" | "other";

/** A factual claim recovered from a retrieved past assistant answer. */
export interface HistoricalClaim {
  subject: string;
  category: ClaimCategory;
  /** e.g. plan name ("Pro", "Sales Hub Professional"). */
  attribute: string;
  value: string;
  /** Message the claim was found in (verified by substring match). */
  messageId: string;
  statedAt: string;
}

export type EvidenceType = "historical" | "current";

export interface Evidence {
  id: string;
  claim: string;
  subject: string;
  category: ClaimCategory;
  attribute: string;
  value: string;
  quote: string;
  sourceId: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceKind: SourceKind;
  publishedAt?: string;
  retrievedAt: string;
  evidenceType: EvidenceType;
  /** Qualitative strength derived from source kind + verification, not a model guess. */
  strength: "strong" | "moderate" | "weak";
  significance?: "major" | "minor";
  /** True when the model paraphrased and the quote was recovered verbatim from the source by locatePriceSpan. */
  quoteRepaired?: boolean;
  /** Pricing only: the price was tied to the named plan (plan named in the quote, or plan name followed by this price in the source). */
  planVerified?: boolean;
}

export type ChangeStatus = "changed" | "unchanged" | "uncertain" | "not_comparable";

/**
 * Which aspect a comparison row is about, so "changed" is never ambiguous:
 *  price_amount       same plan, same terms: the number itself
 *  pricing_model      flat subscription ↔ usage-based (or a different meter)
 *  billing_terms      period / billing cycle / per-seat vs total differ, so no monetary verdict
 *  currency           different currencies, so no monetary verdict
 *  plan_availability  the plan wasn't found among current plans
 *  feature            product launches / feature changes
 *  evidence           no usable or conflicting evidence
 */
export type ComparisonDimension = "price_amount" | "pricing_model" | "billing_terms" | "currency" | "plan_availability" | "feature" | "evidence";

export interface Comparison {
  subject: string;
  category: "pricing" | "product_update";
  attribute: string;
  previousValue?: string;
  currentValue?: string;
  status: ChangeStatus;
  dimension: ComparisonDimension;
  /**
   * Was the earlier claim right *when it was made*? Distinct from "changed since":
   *  consistent       current evidence matches the claim
   *  already_outdated an official page published before the conversation already showed a different value
   *  unknown          not determinable from the evidence
   */
  historicalAccuracy?: "consistent" | "already_outdated" | "unknown";
  explanation: string;
  /** Evidence ids supporting the current value. */
  evidenceIds: string[];
  sourceIds: string[];
}

/** Completeness of an earlier answer: plans offered now that it didn't discuss. Not a claim that they are new. */
export interface OfferingNote {
  subject: string;
  plansNotDiscussed: Array<{ plan: string; value: string; sourceId: string }>;
}

// ── Memory ───────────────────────────────────────────────────────────────

export interface MemoryExchange {
  conversationId: string;
  conversationTitle: string;
  seeded: boolean;
  user?: Message;
  assistant?: Message;
  at: string;
}

export interface MemorySummary {
  status: "found" | "not_found" | "not_requested";
  interpretation?: string;
  conversationIds: string[];
  messageIds: string[];
  baselineDate?: string;
  seeded?: boolean;
}

// ── Execution ────────────────────────────────────────────────────────────

export type Stage =
  | "validate"
  | "analyze"
  | "temporal"
  | "memory"
  | "plan"
  | "search"
  | "evidence"
  | "compare"
  | "synthesize"
  | "persist";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ExecutionStats {
  executionId: string;
  llmCalls: number;
  searchCalls: number;
  cacheHits: number;
  usage: TokenUsage;
  stageMs: Partial<Record<Stage, number>>;
  totalMs: number;
  provider: string;
  models: string[];
}

/** Server-sent events emitted while answering. */
export type AgentEvent =
  | { type: "conversation"; conversationId: string; userMessageId: string }
  | { type: "stage"; stage: Stage; status: "start" | "done" | "skipped" | "failed"; detail?: string }
  | { type: "search"; query: string; status: "start" | "done" | "failed" | "cached"; resultCount?: number; error?: string }
  | { type: "memory"; summary: MemorySummary; exchanges: Array<{ conversationTitle: string; at: string; question?: string; seeded: boolean }> }
  | { type: "sources"; sources: SourceRef[] }
  | { type: "comparison"; comparisons: Comparison[] }
  | { type: "token"; text: string }
  | { type: "done"; message: Message }
  | { type: "error"; error: { code: string; message: string; retryable: boolean } };
