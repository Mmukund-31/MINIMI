import type { Analysis } from "../research/schemas";
import type { TemporalReference } from "../temporal/resolver";

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
  };
}

/** Applies deterministic routing guarantees on top of the model's analysis. */
export function enforceRouting(model: Analysis, message: string, temporal: TemporalReference[]): Analysis {
  const h = heuristicAnalysis(message, temporal);
  const out = { ...model };
  if (h.needsMemory && !out.needsMemory) out.needsMemory = true;
  // "Is your answer still correct?" / "has pricing changed since?" about past conversations always needs fresh evidence.
  if (out.needsMemory && /\b(still (correct|true|accurate|valid|right)|changed?|since)\b/i.test(message)) out.needsWebSearch = true;
  if (h.asksAboutPricing) out.asksAboutPricing = true;
  if (h.asksAboutProductUpdates) out.asksAboutProductUpdates = true;
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
