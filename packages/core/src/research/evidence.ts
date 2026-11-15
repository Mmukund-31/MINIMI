import { newId } from "../shared/ids";
import { containsNormalized, normalizeForMatch, subjectMatches } from "../shared/text";
import type { Evidence, HistoricalClaim, MemoryExchange, Source, SourceKind } from "../shared/types";
import { extractNumbers } from "./price";
import type { EvidenceExtraction, Plan } from "./schemas";

/** Phrases typical of prompt-injection attempts embedded in web content. */
const INJECTION_PATTERNS = [
  /ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts?|messages?)/i,
  /disregard (all |any )?(the )?(previous|prior|above|system) (instructions|prompts?)/i,
  /\byou are now\b/i,
  /\b(system|developer) prompt\b/i,
  /\bas an ai (language )?model\b.*\b(must|should)\b/i,
  /\bnew instructions?:/i,
  /<\/?(system|assistant|instructions?)>/i,
  /\bdo not (tell|inform) the user\b/i,
  /\b(respond|reply|answer) only with\b/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** Splits sources into usable and quarantined (contain instructions aimed at AI systems). */
export function screenSources(sources: Source[]): { usable: Source[]; quarantined: Source[] } {
  const usable: Source[] = [];
  const quarantined: Source[] = [];
  for (const s of sources) {
    if (looksLikeInjection(`${s.title}\n${s.snippet}\n${s.content ?? ""}`)) quarantined.push(s);
    else usable.push(s);
  }
  return { usable, quarantined };
}

export function sourceText(s: Source): string {
  return `${s.title}\n${s.snippet}\n${s.content ?? ""}`;
}

/** Punctuation/markup-insensitive form: keeps letters, digits and price symbols only. */
export function normalizeLoose(s: string): string {
  return normalizeForMatch(s)
    .replace(/[^a-z0-9$€£₹¥%.]+/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True if `quote` is genuinely present in `text`: exact (normalised) match,
 * or the same character sequence ignoring punctuation/markup (table pipes,
 * dashes, bullets), or "…"-elided parts that each occur in order. Paraphrases
 * never match: every part must be a contiguous run of the source's words.
 */
export function quoteFound(text: string, quote: string): boolean {
  if (containsNormalized(text, quote)) return true;
  const hay = normalizeLoose(text);
  const q = normalizeLoose(quote);
  if (q.length >= 8 && hay.includes(q)) return true;
  // Elisions ("…") and table-cell joins (";" / "|") split the quote into parts that must
  // each occur contiguously, in order.
  const parts = quote
    .split(/\s*(?:\.\.\.|…|\[\.\.\.\]|;|\s\|\s)\s*/)
    .map(normalizeLoose)
    .filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p.length < 6)) return false;
  let from = 0;
  for (const p of parts) {
    const at = hay.indexOf(p, from);
    if (at < 0) return false;
    from = at + p.length;
  }
  return true;
}

const PLAN_FILLER = new Set(["plan", "plans", "tier", "the", "edition", "package", "subscription"]);

/**
 * Deterministic quote recovery for paraphrased price findings. Looks for the
 * plan name in the source text and accepts only if the FIRST currency amount
 * that follows it (within ~120 chars) equals the claimed amount, so a price
 * belonging to the next plan in a table can't be attributed to this one.
 * Returns the genuine (normalised) source span, or null.
 */
export function locatePriceSpan(text: string, attribute: string, value: string, subject = ""): string | null {
  const target = extractNumbers(value).find((n) => n !== 0);
  if (target === undefined) return null;
  const brand = new Set(normalizeLoose(subject).split(" ").filter((t) => t.length >= 3));
  const core = normalizeLoose(attribute)
    .split(" ")
    .filter((t) => t && !brand.has(t) && !PLAN_FILLER.has(t));
  if (core.length === 0 || core.join(" ").length < 2) return null;
  const hay = normalizeLoose(text);
  const needle = core.join(" ");
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return null;
    from = at + needle.length;
    // whole-word match only ("pro" must not match "professional")
    const before = hay[at - 1];
    const after = hay[at + needle.length];
    if ((before && before !== " ") || (after && after !== " ")) continue;
    const window = hay.slice(at, at + needle.length + 120);
    const m = /[$€£₹¥]\s?(\d+(?:\.\d+)?)/.exec(window.slice(needle.length));
    if (!m) continue;
    if (Number(m[1]) !== target) continue;
    const end = needle.length + m.index + m[0].length;
    const tail = window.slice(end).trim().split(" ").slice(0, 4).join(" ");
    return `${window.slice(0, end)}${tail ? ` ${tail}` : ""}`.trim();
  }
}

const STRENGTH: Record<SourceKind, Evidence["strength"]> = {
  official_pricing: "strong",
  official_changelog: "strong",
  official: "strong",
  news: "moderate",
  third_party: "weak",
};

export interface ValidationReport {
  evidence: Evidence[];
  rejected: Array<{ reason: string; sourceId: string; value: string; quote: string }>;
  proposed: number;
}

/**
 * Validates model-extracted evidence against the actual search results.
 * An item survives only if:
 *   1. its sourceId exists in this session's sources,
 *   2. its quote occurs (normalised) in that source's text,
 *   3. any number in the value also occurs in the quote,
 *   4. it contains no injection-style instructions.
 * Source metadata (URL, title, dates) is copied from the search result,
 * never from the model, so it cannot be fabricated.
 */
export function validateEvidence(extraction: EvidenceExtraction, sources: Source[]): ValidationReport {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const evidence: Evidence[] = [];
  const rejected: ValidationReport["rejected"] = [];
  const seen = new Set<string>();

  const check = (sourceId: string, quote: string, value: string): string | null => {
    const src = byId.get(sourceId.trim().toUpperCase());
    if (!src) return "unknown source id";
    if (normalizeForMatch(quote).length < 8) return "quote too short";
    if (!quoteFound(sourceText(src), quote)) return "quote not found in source";
    const nums = extractNumbers(value).filter((n) => n !== 0);
    const quoteNums = new Set(extractNumbers(quote));
    if (nums.length > 0 && !nums.some((n) => quoteNums.has(n))) return "value not supported by quote";
    if (looksLikeInjection(quote) || looksLikeInjection(value)) return "instruction-like content";
    return null;
  };

  const push = (e: Omit<Evidence, "id" | "sourceUrl" | "sourceTitle" | "sourceKind" | "publishedAt" | "retrievedAt" | "evidenceType" | "strength">) => {
    const src = byId.get(e.sourceId.trim().toUpperCase())!;
    const key = `${src.id}|${normalizeForMatch(e.subject)}|${normalizeForMatch(e.attribute)}|${normalizeForMatch(e.value)}`;
    if (seen.has(key)) return;
    seen.add(key);
    evidence.push({
      ...e,
      id: newId("ev"),
      sourceId: src.id,
      sourceUrl: src.url,
      sourceTitle: src.title,
      sourceKind: src.kind,
      publishedAt: src.publishedAt,
      retrievedAt: src.retrievedAt,
      evidenceType: "current",
      strength: STRENGTH[src.kind],
    });
  };

  for (const f of extraction.findings) {
    let quote = f.quote;
    let reason = check(f.sourceId, quote, f.value);
    let repaired = false;
    if (reason === "quote not found in source" && f.category === "pricing") {
      // The model paraphrased. Try to recover the genuine span from the source itself.
      const src = byId.get(f.sourceId.trim().toUpperCase());
      const span = src ? locatePriceSpan(sourceText(src), f.attribute, f.value, f.subject) : null;
      if (span && !check(f.sourceId, span, f.value)) {
        quote = span;
        reason = null;
        repaired = true;
      }
    }
    if (reason) {
      rejected.push({ reason, sourceId: f.sourceId, value: f.value, quote: f.quote });
      continue;
    }
    push({
      claim: `${f.subject} ${f.attribute}: ${f.value}`,
      subject: f.subject,
      category: f.category,
      attribute: f.attribute,
      value: f.value,
      quote,
      sourceId: f.sourceId,
      ...(repaired ? { quoteRepaired: true } : {}),
    });
  }
  for (const u of extraction.updates) {
    const reason = check(u.sourceId, u.quote, "");
    if (reason) {
      rejected.push({ reason, sourceId: u.sourceId, value: u.title, quote: u.quote });
      continue;
    }
    push({
      claim: `${u.subject}: ${u.title}`,
      subject: u.subject,
      category: "product_update",
      attribute: "update",
      value: u.title,
      quote: u.quote,
      sourceId: u.sourceId,
      significance: u.significance,
    });
  }
  return { evidence, rejected, proposed: extraction.findings.length + extraction.updates.length };
}

/**
 * Verifies model-extracted historical claims against the retrieved memory.
 * A claim is kept only if its value text (or its numeric amount plus the
 * subject) actually appears in a retrieved assistant message: the agent
 * cannot "remember" things that were never said.
 */
export function verifyHistoricalClaims(
  claims: Plan["historicalClaims"],
  exchanges: MemoryExchange[],
): { verified: HistoricalClaim[]; rejected: Plan["historicalClaims"] } {
  const answers = exchanges.map((e) => e.assistant).filter((m): m is NonNullable<typeof m> => Boolean(m));
  const verified: HistoricalClaim[] = [];
  const rejected: Plan["historicalClaims"] = [];
  for (const c of claims) {
    const ordered = [...answers.filter((m) => m.id === c.messageId), ...answers.filter((m) => m.id !== c.messageId)];
    const hit = ordered.find((m) => {
      if (containsNormalized(m.content, c.value)) return true;
      const nums = extractNumbers(c.value);
      if (nums.length === 0) return false;
      const msgNums = new Set(extractNumbers(m.content));
      return nums.every((n) => msgNums.has(n)) && containsNormalized(m.content, c.subject.split(" ")[0] ?? c.subject);
    });
    if (!hit) {
      rejected.push(c);
      continue;
    }
    if (verified.some((v) => subjectMatches(v.subject, c.subject) && normalizeForMatch(v.attribute) === normalizeForMatch(c.attribute))) continue;
    verified.push({ subject: c.subject, category: c.category, attribute: c.attribute, value: c.value, messageId: hit.id, statedAt: hit.createdAt });
  }
  return { verified, rejected };
}
