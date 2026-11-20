/**
 * Domain types shared by the backend and (via the API contract) the frontend.
 * All timestamps are ISO-8601 strings in UTC.
 */
import type { ClaimCheck } from "../agent/claim-gate";
import type { Coverage, VerifiedClaim } from "../research/general-evidence";
import type { ResearchIntent } from "../research/schemas";

export type { ClaimCheck, ClaimCheckItem } from "../agent/claim-gate";
export type { Coverage, CoverageCell, CoverageConflict, VerifiedClaim, ResearchEvidence } from "../research/general-evidence";
export type { ResearchIntent } from "../research/schemas";

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
  /** Imported with its original timestamps via POST /api/conversations/import. */
  imported?: boolean;
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
  imported?: boolean;
  executionId?: string;
  status?: "complete" | "error";
  sources?: SourceRef[];
  comparisons?: Comparison[];
  /** Current plans seen on vendor pages that the earlier answer did not mention (completeness, not change). */
  offering?: OfferingNote[];
  /** Plans the vendor lists as legacy (computed in code from verified quotes). */
  planStatus?: PlanStatusNote[];
  memory?: MemorySummary;
  notes?: string[];
  followUps?: string[];
  stats?: ExecutionStats;
  /** Lookup/research pipelines: what was established and how the answer was checked. */
  research?: ResearchMeta;
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
  /**
   * A date the page itself states (URL date slug, an explicit "Last updated/Published" line, or a
   * blog byline), when the provider gives none. Used only to show that a value predates a
   * conversation; never to claim something changed after it.
   */
  pageDate?: PageDate;
}

export interface PageDate {
  date: string;
  basis: "url" | "page_text" | "byline";
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
  /** Copied from the source (see SearchResult.pageDate). */
  pageDate?: PageDate;
  /** Pricing only: the source says this plan is legacy / not sold to new customers (verified quote in `statusQuote`). */
  planStatus?: "legacy";
  statusQuote?: string;
  /** Legacy plans: the current plan the source maps it to, if it names one. */
  successor?: string;
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
  /**
   * For "changed" rows and already-outdated rows: when the difference arose, as far as dated evidence shows.
   *  before_conversation  a dated vendor page already showed the current value before the conversation
   *  after_conversation   the vendor page showing the current value was published after the conversation
   *  unknown              the pages are undated: the earlier answer no longer matches, but when it changed is unknown
   */
  changeTiming?: "before_conversation" | "after_conversation" | "unknown";
  explanation: string;
  /** Evidence ids supporting the current value. */
  evidenceIds: string[];
  sourceIds: string[];
}

/** Completeness of an earlier answer: plans offered now that it didn't discuss. Not a claim that they are new. */
/** A plan the vendor lists as legacy (no longer sold to new customers), with its current successor if stated. */
export interface PlanStatusNote {
  subject: string;
  plan: string;
  value: string;
  sourceId: string;
  statusQuote: string;
  successor?: { plan: string; value: string; sourceId: string };
}

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
  | "coverage"
  | "synthesize"
  | "persist";

export interface ResearchMeta {
  intent: ResearchIntent;
  /** Quote-verified claims (research pipeline). */
  claims: VerifiedClaim[];
  coverage: Coverage;
  /** Claim gate results for the answer text. */
  claimCheck: ClaimCheck;
}

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
  /** Pipeline chosen in code: chat (no tools) · lookup · research (evidence + coverage loop) · deep (verified pricing/audit). */
  mode?: "chat" | "lookup" | "research" | "deep";
  intent?: ResearchIntent;
  /** Research rounds run (lookup/research: 1 or 2). */
  rounds?: number;
  /** Milliseconds from request start to the first stage event and to the first answer token. */
  firstStatusMs?: number;
  firstTokenMs?: number;
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
