/**
 * Claim gate for search-grounded answers (lookup and research pipelines).
 *
 * The answer streams line by line. Before a line is shown, each sentence (or table row) is
 * checked: every checkable figure in it (numbers above 10, decimals, versions, and the numbers of
 * dates) must appear in a source it cites. Figures the user or the conversation supplied, and
 * today's date, are exempt.
 *
 *   supported  → shown as written
 *   repaired   → the figures are in a different retrieved source: shown with that citation
 *   unsupported→ the figures are in no retrieved source: removed, and recorded
 *
 * This is a lexical check of the facts most often hallucinated (figures, dates, versions). It
 * doesn't judge the meaning of sentences without figures; those still pass the citation and URL
 * filters. It needs no model call, so it adds no latency.
 */
import type { Source } from "../shared/types";
import { sourceText } from "../research/evidence";

export interface ClaimCheckItem {
  sentence: string;
  status: "supported" | "repaired" | "unsupported";
  sourceIds: string[];
  missing?: string[];
}

export interface ClaimCheck {
  /** Sentences/rows containing checkable figures. */
  checked: number;
  supported: number;
  repaired: number;
  removed: number;
  /** Sentences with citations but no checkable figures (passed through). */
  citedWithoutFigures: number;
  items: ClaimCheckItem[];
}

const CITATION = /\[(S\d+)\]/g;
const MAX_ITEMS = 40;

/** Figures in a text, normalised: "110,000" → "110000", "110k" → "110000", "v1.91.0" → "1.91.0". */
export function checkableFigures(text: string): string[] {
  const clean = text
    .replace(CITATION, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(/(\d)\s+(?=\d{3}\b)/g, "$1");
  const out: string[] = [];
  // Digits glued to letters are names, not figures ("p99", "H100", "S3"); a leading "v" marks a version.
  for (const m of clean.matchAll(/(?<![A-Za-z\d.])v?(\d+(?:\.\d+)*)\s?(k|K|thousand|M|million|B|billion|bn)?\b/g)) {
    const raw = m[1]!;
    const mult = m[2] ? ({ k: 1e3, K: 1e3, thousand: 1e3, M: 1e6, million: 1e6, B: 1e9, billion: 1e9, bn: 1e9 } as Record<string, number>)[m[2]]! : 1;
    if ((raw.match(/\./g) ?? []).length >= 2) {
      out.push(raw); // a version: compared as a string
      continue;
    }
    const value = Number.parseFloat(raw) * mult;
    if (!Number.isFinite(value)) continue;
    if (!raw.includes(".") && mult === 1 && value <= 10) continue; // small counts ("3 options") aren't checked
    out.push(String(Math.round(value * 1000) / 1000));
  }
  return [...new Set(out)];
}

/** Figures a source supports, including the parts of its publication date. */
function sourceFigures(s: Source): Set<string> {
  const dates = [s.publishedAt, s.pageDate?.date].filter(Boolean).map((d) => {
    const [y, m, day] = d!.slice(0, 10).split("-");
    return `${y} ${Number(m)} ${Number(day)}`;
  });
  const set = new Set(checkableFigures(`${sourceText(s)} ${dates.join(" ")}`));
  // "1.91" in an answer is supported by "1.91.0" in a source.
  for (const f of [...set]) if ((f.match(/\./g) ?? []).length >= 2) set.add(f.split(".").slice(0, 2).join("."));
  return set;
}

const isVersion = (f: string) => (f.match(/\./g) ?? []).length >= 2;
const isYear = (n: number) => Number.isInteger(n) && n >= 1900 && n <= 2100;

/**
 * Exact match, or a rounded large figure: answers write "≈112k" for "112,400". Figures of 1,000 or
 * more (years excluded) match a source value within 2%. Small figures, years and versions must match exactly.
 */
export function figureSupported(f: string, set: Set<string>): boolean {
  if (set.has(f)) return true;
  if (isVersion(f)) return false;
  const n = Number(f);
  if (!Number.isFinite(n) || n < 1000 || isYear(n)) return false;
  for (const s of set) {
    if (isVersion(s)) continue;
    const v = Number(s);
    if (Number.isFinite(v) && v > 0 && Math.abs(v - n) / v <= 0.02) return true;
  }
  return false;
}

export class ClaimGate {
  private buffer = "";
  private readonly figuresBySource: Map<string, Set<string>>;
  private readonly exempt: Set<string>;
  /** Counts the user gave ("10 developers", "20-person team"): totals derived from them are checkable. */
  private readonly counts: number[];
  readonly stats: ClaimCheck = { checked: 0, supported: 0, repaired: 0, removed: 0, citedWithoutFigures: 0, items: [] };

  /**
   * @param sources retrieved sources (ids as cited)
   * @param context text whose figures are exempt: the question, recent turns, today's date
   */
  constructor(
    private readonly sources: Source[],
    context: string,
    /** Text whose numbers are counts for derived totals (the user's words); defaults to `context`. */
    countsFrom?: string,
  ) {
    this.figuresBySource = new Map(sources.map((s) => [s.id, sourceFigures(s)]));
    this.exempt = new Set(checkableFigures(context));
    this.counts = [...new Set([...(countsFrom ?? context).matchAll(/(?<![\d.])(\d{1,6})(?![\d.])/g)].map((m) => Number(m[1])).filter((n) => n >= 2 && n <= 100_000 && !isYear(n)))];
  }

  /** Inside a fenced code block: code is passed through, never checked as claims. */
  private inFence = false;
  /** Part of the current line was already released (sentence by sentence). */
  private midLine = false;

  /**
   * Accepts streamed text and returns what is checked and safe to show: complete lines, and within
   * a paragraph every complete sentence (so the first words appear after the first sentence, not
   * after the whole paragraph). Table rows and code fences are released only as whole lines.
   */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    for (let idx = this.buffer.indexOf("\n"); idx >= 0; idx = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const continuation = this.midLine;
      this.midLine = false;
      const r = this.processLine(line, continuation);
      if (r !== null) out += `${r}\n`;
      else if (continuation) out += "\n";
    }
    if (this.inFence || !this.buffer || (!this.midLine && /^\s*(?:\||```|~~~)/.test(this.buffer))) return out;
    // Release the complete sentences of the paragraph being written.
    const boundaries = [...this.buffer.matchAll(/(?<=[.!?](?:\s*\[S\d+\])*)\s+(?=[A-Z*"“(\d])/g)];
    const last = boundaries.at(-1);
    if (!last) return out;
    const head = this.buffer.slice(0, last.index);
    this.buffer = this.buffer.slice(last.index + last[0].length);
    const prefix = this.midLine ? "" : (head.match(/^\s*(?:[-*+]|\d+\.)\s+|^\s*#+\s+|^\s*>\s*/)?.[0] ?? "");
    const kept = this.checkSentences(head.slice(prefix.length));
    if (prefix || kept) out += `${prefix}${kept}${kept ? " " : ""}`;
    this.midLine = true;
    return out;
  }

  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    const continuation = this.midLine;
    this.midLine = false;
    if (!rest) return "";
    return this.processLine(rest, continuation) ?? "";
  }

  private processLine(line: string, continuation: boolean): string | null {
    if (!continuation && /^\s*(?:```|~~~)/.test(line)) {
      this.inFence = !this.inFence;
      return line;
    }
    if (this.inFence) return line;
    if (continuation) {
      const kept = this.checkSentences(line);
      return kept || null;
    }
    return this.checkLine(line);
  }

  private checkSentences(text: string): string {
    return text
      .split(/(?<=[.!?](?:\s*\[S\d+\])*)\s+(?=[A-Z*"“(\d])/)
      .map((s) => this.checkUnit(s, false))
      .filter((s): s is string => s !== null && s.trim() !== "")
      .join(" ");
  }

  /** Checks one line; returns null when the whole line was removed. */
  private checkLine(line: string): string | null {
    if (!line.trim() || /^\s*\|?\s*:?-{2,}/.test(line)) return line; // blank or table separator
    if (/^\s*\|/.test(line)) return this.checkTableRow(line);
    const prefix = line.match(/^\s*(?:[-*+]|\d+\.)\s+|^\s*#+\s+|^\s*>\s*/)?.[0] ?? "";
    const body = line.slice(prefix.length);
    const sentences = body.split(/(?<=[.!?](?:\s*\[S\d+\])*)\s+(?=[A-Z*"“(\d])/);
    const kept = sentences.map((s) => this.checkUnit(s, false)).filter((s): s is string => s !== null);
    if (kept.length === 0) return null;
    return prefix + kept.join(" ");
  }

  private checkUnit(unit: string, tableRow: boolean): string | null {
    const figures = checkableFigures(unit).filter((f) => !this.exempt.has(f));
    const cited = [...new Set([...unit.matchAll(CITATION)].map((m) => m[1]!))].filter((id) => this.figuresBySource.has(id));
    if (figures.length === 0) {
      if (cited.length) this.stats.citedWithoutFigures++;
      return unit;
    }
    this.stats.checked++;
    const supportedBy = (ids: string[]) => this.unsupported(figures, ids);
    const missing = supportedBy(cited);
    if (missing.length === 0) {
      this.stats.supported++;
      this.record({ sentence: unit, status: "supported", sourceIds: cited });
      return unit;
    }
    // Repair: the smallest set of other sources (≤ 2) that supports every figure.
    const others = this.sources.map((s) => s.id);
    let repair: string[] | null = null;
    for (const a of others) {
      if (supportedBy([...cited, a]).length === 0) {
        repair = [a];
        break;
      }
    }
    if (!repair) {
      outer: for (const a of others) {
        for (const b of others) {
          if (a < b && supportedBy([...cited, a, b]).length === 0) {
            repair = [a, b];
            break outer;
          }
        }
      }
    }
    if (repair) {
      this.stats.repaired++;
      const tags = repair.map((id) => `[${id}]`).join("");
      const fixed = tableRow ? unit.replace(/\s*\|\s*$/, ` ${tags} |`) : /[.!?]$/.test(unit.trim()) ? unit.trim().replace(/([.!?])$/, ` ${tags}$1`) : `${unit.trimEnd()} ${tags}`;
      this.record({ sentence: unit, status: "repaired", sourceIds: [...cited, ...repair] });
      return fixed;
    }
    this.stats.removed++;
    this.record({ sentence: unit, status: "unsupported", sourceIds: cited, missing });
    return null;
  }

  /** Figures not supported by the given sources, directly or as a total derived from a count the user gave. */
  private unsupported(figures: string[], ids: string[]): string[] {
    const sets = ids.map((id) => this.figuresBySource.get(id)).filter((x): x is Set<string> => Boolean(x));
    return figures.filter((f) => !sets.some((set) => figureSupported(f, set)) && !this.derived(f, sets));
  }

  /**
   * A total derived from source figures and a count the user gave: v × k, v × k × 12, or base + v × k
   * ("10 seats at $19 = $190"; "$80 base + $40 × 10 seats = $480"). Live 2026-11-20: a comparison
   * table lost every row to totals like these.
   */
  private derived(f: string, sets: Array<Set<string>>): boolean {
    if (this.counts.length === 0 || isVersion(f)) return false;
    const n = Number(f);
    if (!Number.isFinite(n) || isYear(n)) return false;
    const vals = [...new Set(sets.flatMap((set) => [...set].filter((x) => !isVersion(x)).map(Number)))].filter((v) => Number.isFinite(v) && v > 0);
    const close = (x: number) => Math.abs(x - n) <= Math.max(0.01, n * 0.005);
    for (const v of vals) {
      for (const k of this.counts) {
        if (close(v * k) || close(v * k * 12)) return true;
        for (const b of vals) if (b !== v && close(b + v * k)) return true;
      }
    }
    return false;
  }

  /**
   * Table rows are checked cell by cell (the first column is the row label). A cell whose figures no
   * source supports becomes "not verified" instead of the whole row disappearing.
   */
  private checkTableRow(line: string): string {
    const cells = line.split("|");
    const rowCited = [...new Set([...line.matchAll(CITATION)].map((m) => m[1]!))].filter((id) => this.figuresBySource.has(id));
    const label = (cells[1] ?? "").trim();
    for (let i = 2; i < cells.length - 1; i++) {
      const cell = cells[i]!;
      const figures = checkableFigures(cell).filter((f) => !this.exempt.has(f));
      if (figures.length === 0) continue;
      this.stats.checked++;
      const own = [...new Set([...cell.matchAll(CITATION)].map((m) => m[1]!))].filter((id) => this.figuresBySource.has(id));
      const cited = own.length ? own : rowCited;
      const missing = this.unsupported(figures, cited);
      const text = `${label} | ${cell.trim()}`;
      if (missing.length === 0) {
        this.stats.supported++;
        this.record({ sentence: text, status: "supported", sourceIds: cited });
        continue;
      }
      const fix = this.sources.map((x) => x.id).find((id) => this.unsupported(figures, [...cited, id]).length === 0);
      if (fix) {
        this.stats.repaired++;
        cells[i] = ` ${cell.trim()} [${fix}] `;
        this.record({ sentence: text, status: "repaired", sourceIds: [...cited, fix] });
        continue;
      }
      this.stats.removed++;
      cells[i] = " not verified ";
      this.record({ sentence: text, status: "unsupported", sourceIds: cited, missing });
    }
    return cells.join("|");
  }

  private record(item: ClaimCheckItem) {
    if (this.stats.items.length < MAX_ITEMS) this.stats.items.push({ ...item, sentence: item.sentence.slice(0, 300) });
  }
}
