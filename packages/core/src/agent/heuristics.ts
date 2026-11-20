import type { Analysis, ResearchIntent } from "../research/schemas";
import type { TemporalReference } from "../temporal/resolver";
import { truncate } from "../shared/text";

const MEMORY_CUE =
  /\b((i|we) (asked|discussed|talked|shortlisted|mentioned|said|chose|picked|compared|looked at)|your (answer|reply|recommendation|response|advice)|you (said|told|recommended|suggested|answered)|last time|earlier (you|we|i)|since (then|our|we)|those (tools|options|providers|products)|what did i)\b/i;
const FRESHNESS_CUE =
  /\b(price|prices|pricing|cost|costs|changed?|changes|still (correct|true|accurate|valid|right)|latest|current(ly)?|today|now|new|release[sd]?|updates?|shipped|launch(ed)?|news|announce[sd]?|version)\b/i;
const UPDATES_CUE =
  /\b(ship(ped)?|launch(ed|es)?|release[sd]?|new features?|announce[sd]?|announcements?|updates?|something big|anything big|what'?s new|changelog)\b/i;

/** Deterministic: did the user explicitly ask about launches/updates (not just prices)? */
export const asksAboutUpdates = (message: string): boolean => UPDATES_CUE.test(message);

/** Update checks also matter when the user asks whether an earlier answer is still correct. */
export const wantsUpdateCheck = (message: string): boolean =>
  asksAboutUpdates(message) || /\bstill (correct|accurate|true|valid|right|up[- ]to[- ]date|the case)\b/i.test(message);
const PRICING_CUE = /\b(price|prices|pricing|cost|costs|plan|plans|per seat|subscription|tier)\b/i;
const SMALL_TALK = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|bye|good (morning|evening|afternoon))\b[!. ]*$/i;
const NOT_ENTITY = new Set([
  "I", "On", "Last", "What", "Is", "Has", "Have", "Did", "Do", "The", "And", "Since", "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday", "Sunday", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
  "November", "December", "Can", "Could", "Would", "Please", "Any", "How", "Which", "When", "Where", "Why", "Who", "Yesterday", "Today",
]);

/**
 * Rule-based analysis. Used (a) as a fallback when the model's structured
 * output can't be validated and (b) to enforce non-negotiable routing: a
 * message with a past-date reference plus a memory cue always triggers
 * memory retrieval, whatever the model said.
 */
export function heuristicAnalysis(message: string, temporal: TemporalReference[]): Analysis {
  const memory = MEMORY_CUE.test(message) || (temporal.length > 0 && /\b(asked|discussed|shortlisted|talked|said|told|answer)\b/i.test(message));
  const smallTalk = SMALL_TALK.test(message.trim());
  const fresh = !smallTalk && FRESHNESS_CUE.test(message);
  const entities = [...new Set((message.match(/\b[A-Z][a-zA-Z0-9.+-]*(?:\s+[A-Z][a-zA-Z0-9.+-]*)*/g) ?? []).filter((e) => !NOT_ENTITY.has(e.split(" ")[0]!)))].slice(0, 8);
  const intent: Analysis["intent"] = memory && fresh ? "memory_and_research" : memory ? "memory_recall" : fresh ? "research" : "chat";
  return {
    intent,
    needsMemory: memory,
    needsWebSearch: fresh,
    standaloneQuestion: message,
    entities,
    temporalExpressions: temporal.map((t) => t.expression),
    asksAboutPricing: PRICING_CUE.test(message),
    asksAboutProductUpdates: UPDATES_CUE.test(message),
    searchQueries: fresh ? [truncate(message.replace(/\s+/g, " ").trim(), 150)] : [],
    researchIntent: memory ? "historical_audit" : !fresh ? "chat" : COMPARE_CUE.test(message) && entities.length >= 2 ? "comparison" : "fact_lookup",
    aspects: [],
    officialDomains: [],
  };
}

/**
 * Research intent, decided in code from the model's analysis plus deterministic cues. The model
 * proposes; these rules have the last word, so a reference to an earlier conversation can never be
 * answered without memory, and a price check can never skip the verified pricing pipeline.
 *
 *   chat              no current facts needed
 *   fact_lookup       one or two targeted searches, answer over excerpts
 *   general_research  multiple sources, claim extraction, coverage loop
 *   comparison        general_research with entities × criteria coverage
 *   historical_audit  recall an earlier conversation and re-check its claims (verified pipeline)
 *   pricing_diff      plan-by-plan price check on named products (verified pipeline)
 */
export function chooseIntent(a: Analysis, message = ""): ResearchIntent {
  if (a.needsMemory) return a.asksAboutPricing ? "pricing_diff" : "historical_audit";
  if (!a.needsWebSearch) return "chat";
  const text = `${message} ${a.standaloneQuestion}`;
  const comparative = a.researchIntent === "comparison" || COMPARE_CUE.test(text);
  const nonPricingAspects = a.aspects.filter((x) => !PRICING_CUE.test(x));
  // A comparison of several products on several criteria stays a comparison even if price is one
  // criterion; a pure price question about named products takes the verified pricing pipeline.
  if (comparative && a.entities.length >= 2 && (nonPricingAspects.length > 0 || !a.asksAboutPricing)) return "comparison";
  if (a.asksAboutPricing && a.entities.length > 0 && nonPricingAspects.length === 0) return "pricing_diff";
  if (comparative && a.entities.length >= 2) return "comparison";
  if (a.researchIntent === "general_research" || a.aspects.length >= 2) return "general_research";
  return "fact_lookup";
}

/** Pipelines: chat (no tools) · lookup (fast) · research (evidence + coverage loop) · deep (verified pricing/audit). */
export type Pipeline = "chat" | "lookup" | "research" | "deep";

export function pipelineFor(intent: ResearchIntent): Pipeline {
  switch (intent) {
    case "chat":
      return "chat";
    case "fact_lookup":
      return "lookup";
    case "general_research":
    case "comparison":
      return "research";
    case "historical_audit":
    case "pricing_diff":
      return "deep";
  }
}

const VERSION_CUE = /\b(?:v\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)?)\b|\b(?:version|release notes|changelog)\b/i;
const COMPARE_CUE =/\b(vs\.?|versus|compare[ds]?|comparison|which (?:is|one is|should i)|better than|or)\b/i;

const TIME_SENSITIVE = /\b(news|latest|today|tonight|yesterday|this (week|month|morning)|right now|breaking|just (announced|released|launched)|score|won|wins|election|outage|stock|weather)\b/i;

/** Questions about very recent events go to the news index with a recency window. */
export const isTimeSensitive = (text: string): boolean => TIME_SENSITIVE.test(text);

/** Applies deterministic routing guarantees on top of the model's analysis. */
export function enforceRouting(model: Analysis, message: string, temporal: TemporalReference[], opts: { inConversation?: boolean } = {}): Analysis {
  const h = heuristicAnalysis(message, temporal);
  const out = { ...model };
  if (h.needsMemory && !out.needsMemory) out.needsMemory = true;
  // "What about the second one?" inside a conversation refers to the recent turns (already in
  // context), not to an earlier conversation. Memory needs an explicit cue or a date reference.
  // Live 2026-11-20: a follow-up was routed to memory and found nothing.
  if (out.needsMemory && !h.needsMemory && temporal.length === 0 && opts.inConversation) out.needsMemory = false;
  // Versions, releases and anything "latest/current/new" change: never answered from model memory.
  // Live 2026-11-20: "dark mode in Tailwind CSS v4" was answered without search, with v3 config.
  if (!out.needsWebSearch && (h.needsWebSearch || VERSION_CUE.test(message))) out.needsWebSearch = true;
  // "Is your answer still correct?" / "has pricing changed since?" about past conversations always needs fresh evidence.
  if (out.needsMemory && /\b(still (correct|true|accurate|valid|right)|changed?|since)\b/i.test(message)) out.needsWebSearch = true;
  if (h.asksAboutPricing) out.asksAboutPricing = true;
  if (h.asksAboutProductUpdates) out.asksAboutProductUpdates = true;
  // A search with no queries would be a no-op: fall back to the question itself.
  if (out.needsWebSearch && out.searchQueries.length === 0) out.searchQueries = [truncate((out.standaloneQuestion || message).replace(/\s+/g, " ").trim(), 150)];
  if (out.needsMemory && out.needsWebSearch) out.intent = "memory_and_research";
  else if (out.needsMemory && out.intent === "chat") out.intent = "memory_recall";
  else if (out.needsWebSearch && out.intent === "chat") out.intent = "research";
  return out;
}

export function followUpSuggestions(input: {
  comparisons: Array<{ subject: string; status: string; category: string }>;
  memoryFound: boolean;
  searched: boolean;
}): string[] {
  const out: string[] = [];
  const uncertain = input.comparisons.find((c) => c.status === "uncertain" || c.status === "not_comparable");
  const changed = input.comparisons.find((c) => c.status === "changed" && c.category === "pricing");
  if (changed) out.push(`What does the ${changed.subject} price change mean for our total cost?`);
  if (uncertain) out.push(`Dig deeper into ${uncertain.subject}: find the official pricing page`);
  if (input.memoryFound && !input.searched) out.push("Check whether that is still accurate today");
  if (input.searched && out.length < 2) out.push("Which option is the best value right now?");
  return out.slice(0, 3);
}
