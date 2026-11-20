import { normalizeUrl } from "../search/normalize";

/**
 * Streaming citation sanitiser. Passes text through unchanged except for
 * bracketed citations: `[S3]`, `[S1, S4]`, `[S2][S5]`. Citations referring
 * to sources that were not actually retrieved are removed before they reach
 * the user; valid ones are normalised to `[S1][S4]`.
 *
 * Also normalises the variants models actually produce: `[ S4 ]`,
 * fullwidth `【S4】`, and browsing-style `[S4†L10-L12]`.
 *
 * Holds back at most a short partial bracket between chunks.
 */
const OPEN = new Set(["[", "【"]);
const CLOSE = new Set(["]", "】"]);
/** A bracket that could still become a citation: S-ids, separators, ranges, spaces, and †-suffixes. */
const PARTIAL = /^[[【]\s*(S[0-9S,;\s†Ll\-‐‑–—]*|\d[\d,;\s]*)?$/i;
const RANGE = /^S(\d+)\s*[-‐‑–—]\s*S?(\d+)$/i;

export class CitationFilter {
  private buffer = "";
  readonly used = new Set<string>();
  readonly removed: string[] = [];

  constructor(private readonly validIds: Set<string>) {}

  push(chunk: string): string {
    let out = "";
    for (const ch of chunk) {
      if (this.buffer) {
        this.buffer += ch;
        if (CLOSE.has(ch)) {
          out += this.resolve(this.buffer);
          this.buffer = "";
        } else if (!PARTIAL.test(this.buffer) || this.buffer.length > 48) {
          out += this.buffer;
          this.buffer = "";
        }
      } else if (OPEN.has(ch)) {
        this.buffer = ch;
      } else {
        out += ch;
      }
    }
    return out;
  }

  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }

  private resolve(bracket: string): string {
    // Models sometimes drop the "S" ("[5][6]"). Treat bare numbers as citations only if every
    // number maps to a retrieved source; otherwise leave the text untouched (e.g. "[1950]").
    const bare = /^[[【]\s*(\d+(\s*[,;]\s*\d+)*)\s*[\]】]$/.exec(bracket);
    if (bare) {
      const nums = bare[1]!.split(/[,;]/).map((n) => `S${n.trim()}`);
      if (!nums.every((id) => this.validIds.has(id))) return bracket;
      for (const id of nums) this.used.add(id);
      return nums.map((id) => `[${id}]`).join("");
    }
    const ids = bracket
      .slice(1, -1)
      .replace(/†[^\s,;]*/g, "")
      .split(/[,;\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .flatMap((s) => {
        const r = RANGE.exec(s);
        if (!r) return [s];
        const [a, b] = [Number(r[1]), Number(r[2])];
        return b >= a && b - a <= 10 ? Array.from({ length: b - a + 1 }, (_, i) => `S${a + i}`) : [s];
      });
    if (ids.length === 0 || !ids.every((id) => /^S\d+$/.test(id))) return bracket; // not a citation (e.g. "[1]" or "[see]")
    const valid = ids.filter((id) => this.validIds.has(id));
    for (const id of ids) if (!this.validIds.has(id)) this.removed.push(id);
    for (const id of valid) this.used.add(id);
    return valid.map((id) => `[${id}]`).join("");
  }
}

/**
 * Streaming URL guard: holds back anything that looks like a URL until it is
 * complete, then passes it only if it is one of the retrieved sources. Invented
 * links therefore never reach the user, even transiently while streaming.
 */
export class StreamUrlFilter {
  private buffer = "";
  readonly removed: string[] = [];
  private readonly allowed: Set<string>;

  constructor(sourceUrls: string[]) {
    this.allowed = new Set(sourceUrls.map((u) => normalizeUrl(u)).filter((u): u is string => Boolean(u)));
  }

  push(chunk: string): string {
    let out = "";
    for (const ch of chunk) {
      if (this.buffer) {
        const isPrefix = "https://".startsWith(this.buffer + ch) || "http://".startsWith(this.buffer + ch);
        const inUrl = /^https?:\/\//.test(this.buffer);
        if (isPrefix) {
          this.buffer += ch;
        } else if (inUrl && !/[\s<>)\]"'`]/.test(ch)) {
          this.buffer += ch;
        } else if (inUrl) {
          out += this.resolve() + ch;
        } else {
          out += this.buffer;
          this.buffer = "";
          out += this.startOrEmit(ch);
        }
      } else {
        out += this.startOrEmit(ch);
      }
    }
    return out;
  }

  flush(): string {
    if (!this.buffer) return "";
    return /^https?:\/\//.test(this.buffer) ? this.resolve() : this.take();
  }

  private startOrEmit(ch: string): string {
    if (ch === "h") {
      this.buffer = "h";
      return "";
    }
    return ch;
  }

  private take(): string {
    const b = this.buffer;
    this.buffer = "";
    return b;
  }

  private resolve(): string {
    const raw = this.take();
    const trailing = /[.,;:!?]+$/.exec(raw)?.[0] ?? "";
    const url = trailing ? raw.slice(0, -trailing.length) : raw;
    const n = normalizeUrl(url);
    if (n && this.allowed.has(n)) return raw;
    this.removed.push(url);
    return trailing;
  }
}

/**
 * Deterministic citation repair. Models sometimes state verified facts without
 * citing them. A sentence that has no citation, names an evidence item's
 * subject, and states a number from that item's verified value gets that
 * item's source id appended. It only ever attaches sources that contain the
 * stated value (evidence is quote-verified), so it can't invent support.
 */
export function attachMissingCitations(
  text: string,
  evidence: Array<{ subject: string; value: string; sourceId: string; category: string }>,
): string {
  const numbers = (s: string) => [...s.replace(/,(?=\d{3}\b)/g, "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((n) => n !== 0);
  // Only amounts written as prices count ("$19", "€25", "19 USD"), never counts like "10 developers".
  const prices = (s: string) =>
    [...s.replace(/,(?=\d{3}\b)/g, "").matchAll(/[$€£₹¥]\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s?(?:usd|eur|gbp|inr)\b/gi)]
      .map((m) => Number(m[1] ?? m[2]))
      .filter((n) => n !== 0);
  const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const parts = text.split(/(?<=[.!?])(?=\s)|(?=\n)/);
  return parts
    .map((sentence) => {
      if (/\[S\d+\]/.test(sentence)) return sentence;
      const lower = sentence.toLowerCase();
      const nums = new Set(prices(sentence));
      if (nums.size === 0) return sentence;
      const ids: string[] = [];
      for (const e of evidence) {
        if (e.category !== "pricing" || ids.includes(e.sourceId)) continue;
        const subj = tokens(e.subject)[0];
        if (!subj || !lower.includes(subj)) continue;
        if (!numbers(e.value).some((n) => nums.has(n))) continue;
        ids.push(e.sourceId);
        if (ids.length === 2) break;
      }
      if (ids.length === 0) return sentence;
      return sentence.replace(/([.!?]?)(\s*)$/, `${ids.map((id) => ` [${id}]`).join("")}$1$2`);
    })
    .join("");
}

/**
 * Final pass over the complete answer: removes links/URLs that don't
 * belong to retrieved sources (the model must cite with [S#], not invent links)
 * and tidies whitespace left by removed citations.
 */
export function finalizeAnswer(text: string, sourceUrls: string[]): { text: string; removedUrls: string[] } {
  const allowed = new Set(sourceUrls.map((u) => normalizeUrl(u)).filter((u): u is string => Boolean(u)));
  const removedUrls: string[] = [];
  let out = text.replace(/\[([^\]]+)\]\((\S+?)\)/g, (m, label: string, url: string) => {
    const n = normalizeUrl(url);
    if (n && allowed.has(n)) return m;
    removedUrls.push(url);
    return label;
  });
  out = out.replace(/(?<!\()\bhttps?:\/\/[^\s)<>\]]+/g, (match) => {
    const trailing = /[.,;:!?]+$/.exec(match)?.[0] ?? "";
    const url = trailing ? match.slice(0, -trailing.length) : match;
    const n = normalizeUrl(url);
    if (n && allowed.has(n)) return match;
    removedUrls.push(url);
    return trailing;
  });
  out = out.replace(/\[([^\]]+)\]\(\s*\)/g, "$1"); // links emptied by the streaming URL guard
  // Placeholder "citations" the model writes when it has no source id (live 2026-11-19: "[unspecified evidence]").
  out = out.replace(/\s*\[(?:unspecified|unknown|no|missing|unverified|citation needed|source needed|needs? (?:a )?source)\b[^\]\n]{0,40}\](?!\()/gi, "");
  out = out.replace(/(\[S\d+\])(?:\s*\1)+/g, "$1"); // "[S1][S1][S1]" → "[S1]"
  // The model sometimes cites our own context tags ("[comparisons]", "[evidence]") instead of a source id.
  out = out.replace(/\s*\[(?:comparisons?|evidence|sources?|memory|notes?|offering|plan_status|table)\](?!\()/gi, "");
  // Fullwidth-bracket fragments that aren't source ids ("【comparisons]", "【table】").
  out = out.replace(/\s*【(?!\s*S\d)[^】\]\n]{0,40}[】\]]/g, "");
  // A citation-only fragment after a cited sentence ("… [S5]. [S5][S6][S7]") adds nothing readable.
  out = out.replace(/(\[S\d+\]\s*[.!?])[ \t]+(?:\[S\d+\]\s*)+(?=\n|$)/g, "$1");
  // An odd number of "**" on a line leaves a stray marker in the rendered text: drop the last one.
  out = out
    .split("\n")
    .map((line) => ((line.match(/\*\*/g) ?? []).length % 2 === 1 ? line.replace(/\*\*(?!.*\*\*)/, "") : line))
    .join("\n");
  out = out.replace(/[ \t]+([.,;:])/g, "$1").replace(/[ \t]{2,}/g, " ");
  return { text: out.trim(), removedUrls };
}
