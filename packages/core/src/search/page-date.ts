import type { PageDate } from "../shared/types";

/**
 * Dates a page states about itself (deterministic; never inferred):
 *  - a date slug in the URL (/changelog/2025-11-07, /2025/11/07/);
 *  - an explicit "Last updated <date>" / "Published <date>" line;
 *  - a blog byline: the first date in a /blog/ (news, press) page, within the first half of its
 *    FULL text. Only with full page text: excerpts can start inside a "related posts" list.
 * Used only to show that a value already existed before a conversation.
 */

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const DATE = `(?:${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+20\\d\\d|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+20\\d\\d|20\\d\\d-\\d\\d-\\d\\d)`;
export const DATE_RE = new RegExp(`\\b${DATE}\\b`, "i");
export const MARKER_RE = new RegExp(`\\b(?:last\\s+updated|published)(?:\\s+on)?:?\\s+(${DATE})\\b`, "i");

function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 ? dt.toISOString() : null;
}

const month = (name: string) => MONTHS[name.slice(0, 3).toLowerCase()];

/** "Aug 14, 2025", "14 August 2025" or "2025-08-14" → ISO timestamp (UTC midnight). */
export function parseDateText(s: string): string | null {
  const a = /(20\d\d)-(\d\d)-(\d\d)/.exec(s);
  if (a) return iso(Number(a[1]), Number(a[2]), Number(a[3]));
  const b = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d\d)/.exec(s);
  if (b && month(b[1]!)) return iso(Number(b[3]), month(b[1]!)!, Number(b[2]));
  const c = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(20\d\d)/.exec(s);
  if (c && month(c[2]!)) return iso(Number(c[3]), month(c[2]!)!, Number(c[1]));
  return null;
}

export const stripImages = (t: string): string => t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");

export function pageDate(url: string, text: string | undefined, opts: { now?: Date; fullText?: boolean } = {}): PageDate | null {
  const now = opts.now ?? new Date();
  const ok = (d: string | null): d is string => !!d && Date.parse(d) <= now.getTime() + 86_400_000 && Date.parse(d) >= Date.parse("2000-01-01");
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    /* keep raw */
  }
  const slug = /(?:^|[/=_-])(20\d\d)[-/](\d\d)[-/](\d\d)(?=$|[/#?&._-])/.exec(decoded);
  if (slug) {
    const d = iso(Number(slug[1]), Number(slug[2]), Number(slug[3]));
    if (ok(d)) return { date: d, basis: "url" };
  }
  const body = stripImages(text ?? "");
  const marker = MARKER_RE.exec(body);
  if (marker) {
    const d = parseDateText(marker[1]!);
    if (ok(d)) return { date: d, basis: "page_text" };
  }
  if (opts.fullText && /\/(blog|news|press|announcements?)\//i.test(decoded)) {
    const first = DATE_RE.exec(body);
    if (first && first.index < body.length / 2) {
      const d = parseDateText(first[0]);
      if (ok(d)) return { date: d, basis: "byline" };
    }
  }
  return null;
}

export function describePageDate(p: PageDate): string {
  const day = p.date.slice(0, 10);
  return p.basis === "url" ? `${day}, from its URL` : p.basis === "byline" ? `${day}, from its byline` : `${day}, from its "last updated" line`;
}
