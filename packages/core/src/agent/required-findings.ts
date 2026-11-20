/**
 * Required findings (deep pipeline). Instead of adding a text rule for each way the prose can drop
 * a result, code decides which computed rows the answer must mention: every change, and every
 * possible product update. They're given to the model as <must_mention>. After writing, any the
 * prose doesn't name (subject + a distinctive word of the finding) are appended, built from the row
 * with its citations. One general check replaces a growing list of special cases.
 * Live 2026-11-20: the CRM answer said "no additional features were noted" while the table had a
 * possible Zoho update.
 */
import type { Comparison } from "../shared/types";
import { textMentionsSubject } from "../research/evidence";
import { planLabel } from "../shared/text";

export interface RequiredFinding {
  subject: string;
  /** Words of which at least one must appear near the subject for the finding to count as stated. */
  keys: string[];
  statement: string;
}

const STOP = new Set(["with", "from", "that", "this", "plan", "plans", "price", "pricing", "month", "user", "seat", "billed", "annually", "monthly", "update", "updates", "possible", "major"]);

/** Distinctive words of a finding, excluding the subject's own name (naming the vendor isn't stating the finding). */
const keyWords = (s: string, subject: string) => {
  const own = new Set(subject.toLowerCase().split(/[^a-z0-9]+/));
  return [...new Set((s.toLowerCase().match(/[a-z0-9$€£₹¥.]+/g) ?? []).filter((w) => (w.length >= 4 || /\d/.test(w)) && !STOP.has(w) && !own.has(w)))].slice(0, 6);
};

export function requiredFindings(comparisons: Comparison[]): RequiredFinding[] {
  const out: RequiredFinding[] = [];
  for (const c of comparisons) {
    const cite = c.sourceIds.slice(0, 2).map((id) => `[${id}]`).join("");
    if (c.category === "pricing" && c.status === "changed" && c.currentValue) {
      out.push({
        subject: c.subject,
        keys: keyWords(c.currentValue, c.subject),
        statement: `${planLabel(c.subject, c.attribute)}: earlier ${c.previousValue ?? "unknown"}, now ${c.currentValue}${c.changeTiming === "unknown" ? " (when it changed is unknown)" : ""} ${cite}`.trim(),
      });
    } else if (c.category === "product_update" && c.currentValue && (c.status === "changed" || (c.status === "uncertain" && c.attribute === "Possible update"))) {
      const why = c.explanation.split(/(?<=[.;])\s/)[0]!.replace(/[.;]$/, "");
      out.push({
        subject: c.subject,
        keys: keyWords(c.currentValue, c.subject),
        statement: `${c.subject}: ${c.status === "changed" ? "update" : "possible update"}: ${c.currentValue} (${why.charAt(0).toLowerCase()}${why.slice(1)}) ${cite}`.trim(),
      });
    }
  }
  return out;
}

/** Is the finding stated? Some line names the subject and contains one of its key words. */
export function findingStated(answer: string, f: RequiredFinding): boolean {
  if (f.keys.length === 0) return answer.split("\n").some((l) => textMentionsSubject(l, f.subject));
  return answer
    .split(/\n|(?<=[.!?])\s+/)
    .some((s) => textMentionsSubject(s, f.subject) && f.keys.some((k) => s.toLowerCase().includes(k)));
}

/** Appends required findings the prose omitted. Returns the subjects that were added. */
export function ensureRequiredFindings(answer: string, findings: RequiredFinding[]): { text: string; added: string[] } {
  const missing = findings.filter((f) => !findingStated(answer, f));
  if (missing.length === 0) return { text: answer, added: [] };
  return {
    text: `${answer.trimEnd()}\n\n**Also found:**\n${missing.map((f) => `- ${f.statement}`).join("\n")}`,
    added: missing.map((f) => f.subject),
  };
}
