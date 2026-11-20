import { mentionedIn } from "../research/change-detector";
import { textMentionsSubject } from "../research/evidence";
import { NEW_CUSTOMER_WORDING } from "../research/plan-status";
import { extractNumbers } from "../research/price";
import { normalizeForMatch, planLabel, truncate } from "../shared/text";
import type { Comparison, PlanStatusNote } from "../shared/types";

/**
 * Deterministic constraints on the final answer text.
 *
 * Verdicts are computed in code, but the prose is the model's, and live runs showed it can
 * contradict the computed rows: "no releases were found for Freshsales" when no update search
 * ran, "the earlier answer correctly listed Neon at $19/month" when a dated vendor page shows it
 * was already out of date, or "$20 per month" for a plan the vendor no longer sells. Each rule
 * below is derived from the rows; when the answer contradicts a rule, the contradicting sentence
 * is replaced by a statement built from the row, and when the required statement is missing it
 * is added. The model's wording is otherwise left alone.
 */

export interface GuardRule {
  id: string;
  /** Sentences that contradict the computed row. */
  offending: (sentence: string) => boolean;
  /** Is the required fact already stated? */
  present: (answer: string) => boolean;
  statement: string;
  /** Where to put the statement when nothing offending was replaced. */
  place: "end" | { after: (sentence: string) => boolean };
  /** Optional in-place correction of a sentence (applied before `offending`). */
  rewrite?: (sentence: string) => string;
}

/** A leading "Yes –" answers "has it changed since?" affirmatively; drop it for rows whose timing isn't established. */
export function stripLeadingYes(sentence: string): string {
  const m = /^(\s*(?:[-*]|\d+\.)\s+)?(?:\*\*)?yes\b(?:\*\*)?[\s,;:.!–—-]*/i.exec(sentence);
  if (!m || m[0].length === (m[1]?.length ?? 0)) return sentence;
  const rest = sentence.slice(m[0].length);
  return `${m[1] ?? ""}${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

const cite = (ids: string[]) => ids.slice(0, 2).map((s) => `[${s}]`).join("");
const listing = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);
/** Mentions the vendor by a distinctive name (never true for names made only of generic words). */
const mentions = (s: string, subject: string) => !textMentionsSubject("", subject) && textMentionsSubject(s, subject);
/** Is the fact stated about this vendor, in one sentence or within one bullet/paragraph ("- **Neon** … The earlier answer was already out of date")? */
const sentenceAbout = (answer: string, subject: string, re: RegExp) =>
  splitSentences(answer).some((s) => mentions(s, subject) && re.test(s)) ||
  answer.split(/\n(?=\s*(?:[-*]|\d+\.)\s|\s*\n)/).some((block) => mentions(block, subject) && re.test(block));

const RELEASE_WORDS = /\b(releases?|launch(?:es|ed)?|shipped|ship|updates?|announcements?|new features?)\b/i;
const NEGATIVE = /\b(no|none|nothing|not|n't|without)\b|\bwere found\b|\bno (?:verifiable|major|notable)\b/i;
const COVERAGE_STATED = /\bnot checked\b|\bwasn['’]?t checked\b|\bweren['’]?t checked\b|\bcouldn['’]?t (?:verify|check)\b|\bcould not (?:verify|check)\b|\bunable to (?:verify|check)\b/i;
const CLAIMS_CORRECT = /\b(correct(?:ly)?|accurate(?:ly)?|still (?:valid|right|true))\b/i;
const CLAIMS_SINCE = /\b(changed since|since (?:then|our|the last|that|last|we)|after (?:our|the|that) (?:conversation|discussion|chat)|was replaced|has (?:been )?(?:changed|replaced|switched|moved)|switched to|moved to)\b/i;
const EARLIER_CORRECT = /\b(earlier|previous|prior|original) (answer|reply|response|estimate|information)\b[^.]*\b(was|is|were|remains?|still)\b[^.]*\b(correct|accurate|right|valid)\b/i;
const CLAIMS_CHANGE = /\b(shift(?:ed)?|change[sd]?|moved?|switch(?:ed)?|increase[sd]?|decrease[sd]?|raised|cut|dropped|now costs?|new (?:INR|USD|EUR|GBP|price|rate))\b/i;
const NOT_COMPARABLE_STATED = /\bnot (?:directly )?comparable\b|\bcan['’]?t (?:be )?compare|\bcannot (?:be )?compare|\bdifferent (?:currenc|terms|billing)/i;
/** "No major updates were found …": a statement about updates being absent (unlike a stray "not" elsewhere in the sentence). */
const NO_UPDATE_STATED = /\b(?:no|none|nothing)\b[^.]{0,60}\b(?:updates?|releases?|launch(?:es)?|features?|changes?|found|announce\w*|shipped)\b|\bnot (?:find|found|identified)\b|\bwere(?:n['’]?t| not) found\b/i;
const LAUNCHED = /\b(released|launched|introduced|announced|shipped|rolled out|unveiled|debuted|added|expanded)\b|\b(?:major|big|notable|significant)(?: product| feature)? (?:update|release|launch|change)\b|\bnew (?:features?|UI|release)\b/i;
const CLAIMS_SAME = /\b(unchanged|(?:the )?same (?:price|pricing|plans?|tiers?|rates?)|remain(?:ed|s)? (?:on|at|the same|unchanged|as (?:it|they) (?:was|were))|stayed (?:the same|at|on)|still (?:costs?|at|on|priced)|no (?:price )?change)\b/i;
const UNVERIFIED_STATED = /\bunverified\b|\bnot (?:be )?verif|\bcouldn['’]?t (?:be )?(?:verif|confirm)|\bcould not (?:be )?(?:verif|confirm)|\bcannot (?:be )?(?:verif|confirm)|\bunable to (?:verify|confirm)|\buncertain\b|\bno (?:current )?(?:evidence|price) (?:was )?found|\bno current evidence\b|\bunclear\b|\bcan['’]?t (?:say|tell) whether\b|\bcannot (?:say|tell) whether\b|\bno (?:current )?(?:public )?price (?:information|listed|found)\b|\bprice not found\b|\bcould(?:n['’]?t| not) be retrieved\b/i;
const OUTDATED_STATED = /\balready (?:out of date|outdated)\b|\bbefore (?:our|the|that) (?:conversation|discussion)\b|\bout of date when\b/i;
const TIMING_UNKNOWN_STATED = /\bundated\b|\bcan['’]?t (?:tell|say|show|determine) (?:when|whether)\b|\bcannot (?:tell|say|determine)\b|\bnot dated\b|\bwhen (?:it|this|that) changed\b/i;

export function buildGuardRules(input: { comparisons: Comparison[]; planStatus: PlanStatusNote[]; question: string }): GuardRule[] {
  const rules: GuardRule[] = [];
  // 1. Product updates that were not checked must not be reported as "none found". One rule per
  //    reason, naming every vendor it applies to, so the answer gets one sentence, not one per vendor.
  const notChecked = new Map<string, string[]>();
  for (const c of input.comparisons) {
    if (c.category !== "product_update" || c.status !== "uncertain" || !/^Not checked/.test(c.explanation)) continue;
    const reason = /returned no results/.test(c.explanation) ? "no_results" : "not_run";
    notChecked.set(reason, [...(notChecked.get(reason) ?? []), c.subject]);
  }
  for (const [reason, subjects] of notChecked) {
    const why =
      reason === "no_results"
        ? `the update search${subjects.length > 1 ? "es" : ""} returned no results`
        : "no update-focused search ran: the search budget went to pricing";
    rules.push({
      id: `updates-not-checked:${subjects.join(",")}`,
      offending: (s) => subjects.some((x) => mentions(s, x)) && RELEASE_WORDS.test(s) && NEGATIVE.test(s) && !COVERAGE_STATED.test(s),
      present: (a) => subjects.every((x) => sentenceAbout(a, x, COVERAGE_STATED)),
      statement: `I couldn't verify recent releases for ${listing(subjects)} (${why}). This doesn't establish that none occurred.`,
      place: "end",
    });
  }
  // 1b. Prices that couldn't be verified must not be called unchanged ("all five remained on the same
  //     pricing tiers" when three had no evidence). One grouped rule, one sentence.
  const unverified = input.comparisons.filter((c) => c.category === "pricing" && c.status === "uncertain" && c.dimension === "evidence" && c.evidenceIds.length === 0);
  if (unverified.length) {
    const labels = unverified.map((c) => planLabel(c.subject, c.attribute));
    rules.push({
      id: `prices-unverified:${unverified.map((c) => c.subject).join(",")}`,
      offending: (s) => unverified.some((c) => mentions(s, c.subject)) && CLAIMS_SAME.test(s) && !UNVERIFIED_STATED.test(s),
      present: (a) => unverified.every((c) => sentenceAbout(a, c.subject, UNVERIFIED_STATED)),
      statement: `I couldn't verify current prices for ${listing(labels)}: no retrievable page stated a price for ${labels.length > 1 ? "these plans" : "this plan"}, so I can't say whether ${labels.length > 1 ? "they" : "it"} changed.`,
      place: "end",
    });
  }
  // 1c. Launch claims need an update row: "HubSpot released a foundational product update on 12 Nov"
  //     when the row says nothing dated after the conversation was found (the page predates it).
  const noUpdate = input.comparisons.filter((c) => c.category === "product_update" && c.status === "uncertain" && c.attribute === "Major update" && !/^Not checked/.test(c.explanation));
  if (noUpdate.length) {
    rules.push({
      id: `launch-without-update:${noUpdate.map((c) => c.subject).join(",")}`,
      offending: (s) => noUpdate.some((c) => mentions(s, c.subject)) && LAUNCHED.test(s) && !NO_UPDATE_STATED.test(s) && !COVERAGE_STATED.test(s),
      present: () => true,
      statement: `Nothing dated after our conversation was found for ${listing(noUpdate.map((c) => c.subject))}; items in the sources are older or undated, so they aren't changes since then.`,
      place: "end",
    });
  }
  // A bare "Yes." answering "has anything changed since?" when no pricing difference is established
  // as after the conversation (only already-outdated or undated differences).
  const pricingRows = input.comparisons.filter((c) => c.category === "pricing");
  const sinceEstablished = pricingRows.some((c) => c.status === "changed" && c.changeTiming === "after_conversation");
  const timingDoubt = pricingRows.some((c) => c.historicalAccuracy === "already_outdated" || (c.status === "changed" && c.changeTiming === "unknown"));
  const updateChanged = input.comparisons.some((c) => c.category === "product_update" && c.status === "changed");
  if (timingDoubt && !sinceEstablished && !updateChanged) {
    rules.push({ id: "bare-yes", offending: (s) => /^\W*yes\W*$/i.test(s.trim()), present: () => true, statement: "", place: "end" });
  }
  // "The earlier answer was correct" is only supportable when no pricing row shows a difference.
  const differing = input.comparisons.filter((c) => c.category === "pricing" && (c.status === "changed" || c.historicalAccuracy === "already_outdated"));
  if (differing.length) {
    const names = (s: string) => input.comparisons.some((c) => mentions(s, c.subject));
    rules.push({
      id: "earlier-answer-correct",
      offending: (s) =>
        EARLIER_CORRECT.test(s) && (!names(s) || differing.some((c) => mentions(s, c.subject))) && !/\b(except|but|apart from|other than)\b/i.test(s),
      present: () => true,
      statement: "",
      place: "end",
    });
  }
  for (const c of input.comparisons) {
    if (c.category !== "pricing") continue;
    const label = planLabel(c.subject, c.attribute);
    const noYes = (s: string) => (mentions(s, c.subject) ? stripLeadingYes(s) : s);
    // 2. A claim shown (by a dated vendor page) to be out of date already must not be called correct, or "changed since".
    if (c.historicalAccuracy === "already_outdated") {
      rules.push({
        id: `already-outdated:${c.subject}:${c.attribute}`,
        offending: (s) => mentions(s, c.subject) && (CLAIMS_CORRECT.test(s) || CLAIMS_SINCE.test(s)) && !OUTDATED_STATED.test(s),
        present: (a) => sentenceAbout(a, c.subject, OUTDATED_STATED),
        statement: `${label}: ${c.explanation} ${cite(c.sourceIds)}`.trim(),
        place: "end",
        rewrite: noYes,
      });
    }
    // 2b. Different currency / terms: "not comparable" must not be presented as a price change.
    if (c.status === "not_comparable") {
      rules.push({
        id: `not-comparable:${c.subject}:${c.attribute}`,
        offending: (s) => mentions(s, c.subject) && CLAIMS_CHANGE.test(s) && !NOT_COMPARABLE_STATED.test(s),
        present: () => true,
        statement: `${label}: the vendor's page shows ${c.currentValue ?? "a price"}, which is on different terms from the earlier "${c.previousValue ?? ""}" (${c.explanation.replace(/\.$/, "")}), so this isn't evidence of a price change ${cite(c.sourceIds)}.`.replace(/\s+\./, "."),
        place: "end",
      });
    }
    // 3. A difference on undated pages must not be presented as a change *since* the conversation.
    if (c.status === "changed" && c.changeTiming === "unknown") {
      rules.push({
        id: `timing-unknown:${c.subject}:${c.attribute}`,
        offending: (s) => mentions(s, c.subject) && CLAIMS_SINCE.test(s) && !TIMING_UNKNOWN_STATED.test(s),
        present: (a) => sentenceAbout(a, c.subject, TIMING_UNKNOWN_STATED),
        statement: `${label}: the current ${c.dimension === "pricing_model" ? "pricing" : "price"} (${c.currentValue ?? "see the table"}) no longer matches the earlier "${c.previousValue ?? ""}", but the vendor's pages are undated, so I can't tell whether it changed before or after our conversation ${cite(c.sourceIds)}.`,
        place: "end",
        rewrite: noYes,
      });
    }
  }
  // 4. A legacy plan the user asked about (or the answer names) must be presented as legacy,
  //    including that new customers can't buy it and the closest current tier when the vendor states one.
  for (const n of input.planStatus) {
    const normQuestion = normalizeForMatch(input.question);
    const plan = n.plan;
    const relevant = (answer: string) => mentionedIn(normQuestion, plan, n.subject) || mentionedIn(normalizeForMatch(answer), plan, n.subject);
    const succAmount = n.successor ? extractNumbers(n.successor.value).find((x) => x !== 0) : undefined;
    const newCustomers = NEW_CUSTOMER_WORDING.test(n.statusQuote);
    rules.push({
      id: `legacy-plan:${n.subject}:${plan}`,
      offending: () => false,
      present: (a) => {
        if (!relevant(a)) return true; // not about this plan: nothing to add
        const t = normalizeForMatch(a);
        if (!/\blegacy\b/.test(t)) return false;
        if (newCustomers && !NEW_CUSTOMER_WORDING.test(a)) return false;
        if (n.successor && !(mentionedIn(t, n.successor.plan, n.subject) && succAmount !== undefined && extractNumbers(a).includes(succAmount))) return false;
        return true;
      },
      statement: [
        `${planLabel(n.subject, plan)} (${n.value}) is a legacy plan${newCustomers ? " that new customers can no longer buy" : ""}: "${truncate(n.statusQuote, 160)}" [${n.sourceId}].`,
        n.successor ? `The closest current tier is ${n.successor.plan} at ${n.successor.value} [${n.successor.sourceId}].` : "",
      ]
        .filter(Boolean)
        .join(" "),
      place: { after: (s) => mentionedIn(normalizeForMatch(s), plan, n.subject) },
    });
  }
  return rules;
}

/** Splits markdown text into sentences (line structure is handled by the caller). */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n/)
    .flatMap((line) => line.split(/(?<=[.!?](?:\s*\[S\d+\])*)\s+(?=[A-Z*"“(])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Applies the rules. Returns the new text and the ids of the rules that changed it.
 */
export function enforceAnswerFacts(answer: string, rules: GuardRule[]): { text: string; applied: string[] } {
  const applied: string[] = [];
  // Work line by line so markdown bullets and paragraphs survive.
  // Markdown table rows are one unit: never split, rewritten or replaced in place (prose inside a
  // table breaks it). An offending row is removed and the rule's statement goes after the answer.
  const isTableRow = (l: string) => /^\s*\|/.test(l);
  let lines = answer
    .split("\n")
    .map((line) => ({ line, sentences: isTableRow(line) ? [line] : line.split(/(?<=[.!?](?:\s*\[S\d+\])*)\s+(?=[A-Z*"“(])/), table: isTableRow(line), drop: false }));
  const append: string[] = [];
  for (const rule of rules) {
    let replaced = false;
    let droppedRow = false;
    lines = lines.map((l) => {
      if (l.drop) return l;
      if (l.table) {
        if (!rule.offending(l.line.replace(/\|/g, " "))) return l;
        droppedRow = true;
        return { ...l, drop: true };
      }
      const { sentences } = l;
      const kept: string[] = [];
      for (const original of sentences) {
        const s = rule.rewrite ? rule.rewrite(original) : original;
        if (s !== original && !applied.includes(rule.id)) applied.push(rule.id);
        const bare = s.replace(/^\s*(?:[-*]|\d+\.)\s+/, "");
        if (rule.offending(bare)) {
          if (!replaced) {
            const prefix = s.match(/^\s*(?:[-*]|\d+\.)\s+/)?.[0] ?? "";
            if (rule.statement) kept.push(prefix + rule.statement);
            replaced = true;
          }
          continue;
        }
        kept.push(s);
      }
      return { ...l, line: kept.join(" "), sentences: kept };
    });
    if (replaced) {
      if (!applied.includes(rule.id)) applied.push(rule.id);
      continue;
    }
    if (droppedRow) {
      if (!applied.includes(rule.id)) applied.push(rule.id);
      if (rule.statement) append.push(rule.statement);
      continue;
    }
    const current = lines.filter((l) => !l.drop).map((l) => l.line).join("\n");
    if (rule.present(current)) continue;
    if (!applied.includes(rule.id)) applied.push(rule.id);
    if (rule.place !== "end") {
      const after = rule.place.after;
      const at = lines.findIndex((l) => !l.table && !l.drop && l.sentences.some((s) => after(s)));
      if (at >= 0) {
        const l = lines[at]!;
        const i = l.sentences.findIndex((s) => after(s));
        const sentences = [...l.sentences.slice(0, i + 1), rule.statement, ...l.sentences.slice(i + 1)];
        lines[at] = { ...l, line: sentences.join(" "), sentences };
        continue;
      }
    }
    append.push(rule.statement);
  }
  let text = lines
    .filter((l) => !l.drop)
    .map((l) => l.line)
    .filter((l, i, arr) => !(l.trim() === "" && arr[i - 1]?.trim() === "" ) && !/^\s*(?:[-*]|\d+\.)\s*$/.test(l))
    .join("\n")
    .trimEnd();
  if (append.length) text += `\n\n${append.join("\n\n")}`;
  return { text, applied };
}

const MONEY = /(?:[$€£₹¥]|\b(?:USD|EUR|GBP|INR)\s?)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:USD|EUR|GBP|INR)\b/g;

/** Currency amounts stated in a piece of text. */
export function moneyAmounts(text: string): number[] {
  return [...text.matchAll(MONEY)].map((m) => Number.parseFloat((m[1] ?? m[2]!).replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

/**
 * Removes sentences that state a price found nowhere in what the answer may rely on: verified
 * evidence, the comparison rows, retrieved source text, or the earlier conversation. A multiple
 * of a supported price by a count named in the question or the sentence ("10 developers" × $19)
 * is allowed. Live 2026-11-20: "Cursor Pro is $25 per month" when no retrieved page said $25.
 */
export function dropUnsupportedPrices(answer: string, supportText: string, question: string): { text: string; removed: string[] } {
  const supported = new Set(extractNumbers(supportText).map((n) => Math.round(n * 1000)));
  const counts = (s: string) => extractNumbers(`${question} ${s}`).filter((n) => Number.isInteger(n) && n >= 2 && n <= 1000);
  const isSupported = (amount: number, sentence: string) =>
    amount === 0 || supported.has(Math.round(amount * 1000)) || counts(sentence).some((k) => [...supported].some((v) => Math.abs((v / 1000) * k - amount) < 0.01 || Math.abs((v / 1000) * k * 12 - amount) < 0.01));
  const removed: string[] = [];
  const lines = answer.split("\n").map((line) => {
    if (/^\s*\|/.test(line)) {
      const bad = moneyAmounts(line).some((a) => !isSupported(a, line));
      if (bad) removed.push(line.trim());
      return bad ? null : line;
    }
    const parts = line.split(/(?<=[.!?](?:\s*\[S\d+\])*)\s+(?=[A-Z*"“(])/);
    const kept = parts.filter((s) => {
      const bad = moneyAmounts(s).some((a) => !isSupported(a, s));
      if (bad) removed.push(s.trim());
      return !bad;
    });
    if (parts.length && kept.length === 0 && line.trim()) return /^\s*(?:[-*]|\d+\.)\s/.test(line) ? null : "";
    return kept.join(" ");
  });
  const text = lines
    .filter((l): l is string => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Never empty an answer: if everything would go, keep the original (the table still carries the verdicts).
  return text ? { text, removed } : { text: answer, removed: [] };
}
