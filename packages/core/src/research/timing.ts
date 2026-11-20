import { DATE_RE, MARKER_RE, pageDate, stripImages } from "../search/page-date";
import type { Evidence, PageDate, SearchResult } from "../shared/types";
import { normalizeLoose } from "./evidence";
import { parsePrice } from "./price";

/**
 * Historical-timing evidence (deterministic, no LLM).
 *
 * Vendor pricing pages are rarely dated, so "the price is different now" says nothing about
 * *when* it changed. When a comparison finds a difference on undated pages, one bounded timing
 * search looks for a vendor-owned page that dates itself (URL slug, "last updated" line, blog
 * byline) and already shows the plan in its current shape. Such evidence can only show that the
 * earlier answer was already out of date; it is never used as the current price.
 */

const PRICE_PHRASE = /[$€£₹¥]\s?\d+(?:[.,]\d+)?(?:\s*(?:\/|per)\s*[A-Za-z]+(?:[- ][A-Za-z]+)?)?/;

/**
 * The first price stated right after a whole-word mention of `plan` (within ~160 chars), as
 * written in the page. Brand words are ignored ("Neon Launch" → "launch").
 */
export function priceAfterPlan(text: string, plan: string, subject = ""): { span: string; price: string } | null {
  const brand = new Set(normalizeLoose(subject).split(" ").filter((t) => t.length >= 3));
  const all = normalizeLoose(plan)
    .split(" ")
    .filter((t) => t && !["plan", "plans", "tier", "the"].includes(t));
  let core = all.filter((t) => !brand.has(t));
  // The model sometimes folds the plan into the vendor name (subject "Neon Launch", plan "Neon Launch"):
  // then the plan is what follows the first (vendor) word.
  if (core.length === 0 && all.length > 1) core = all.slice(1);
  if (core.length === 0) return null;
  const re = new RegExp(`(^|[^A-Za-z0-9+])(${core.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^A-Za-z0-9+]+")})(?![A-Za-z0-9+])`, "gi");
  for (const m of text.matchAll(re)) {
    const start = m.index + m[1]!.length;
    const window = text.slice(start, start + 160);
    const p = PRICE_PHRASE.exec(window.slice(m[2]!.length));
    if (!p) continue;
    const end = m[2]!.length + p.index + p[0].length;
    return { span: window.slice(0, end).replace(/\s+/g, " ").trim(), price: p[0].trim() };
  }
  return null;
}

export interface TimingFinding {
  result: SearchResult & { pageDate: PageDate };
  /** Verbatim excerpt kept as the source's content (date line + price span). */
  excerpt: string;
  evidence: Omit<Evidence, "id" | "sourceId" | "sourceKind">;
}

/**
 * Self-dated, vendor-owned pages that already show the plan in its current shape: usage-based for
 * a pricing-model change, the same amount for a price change.
 */
export function timingEvidence(
  results: SearchResult[],
  opts: {
    subject: string;
    plan: string;
    currentValue: string;
    dimension: "pricing_model" | "price_amount";
    isVendorOwned: (r: SearchResult) => boolean;
    now: Date;
  },
): TimingFinding[] {
  const cur = parsePrice(opts.currentValue);
  const out: TimingFinding[] = [];
  for (const r of results) {
    if (!opts.isVendorOwned(r)) continue;
    const text = r.content ?? r.snippet;
    const date: PageDate | null = r.publishedAt ? { date: r.publishedAt, basis: "page_text" } : (r.pageDate ?? pageDate(r.url, text, { now: opts.now, fullText: true }));
    if (!date) continue;
    const hit = priceAfterPlan(text, opts.plan, opts.subject);
    if (!hit) continue;
    const p = parsePrice(hit.price);
    const sameShape =
      opts.dimension === "pricing_model" ? p.usageUnit !== null && cur.usageUnit !== null : p.amount !== null && cur.amount !== null && Math.abs(p.amount - cur.amount) < 0.005;
    if (!sameShape) continue;
    const dateLine = date.basis === "url" ? null : ((date.basis === "page_text" ? MARKER_RE : DATE_RE).exec(stripImages(text))?.[0] ?? null);
    out.push({
      result: { ...r, pageDate: date },
      excerpt: [dateLine, hit.span].filter(Boolean).join("\n…\n"),
      evidence: {
        claim: `${opts.subject} ${opts.plan}: ${hit.price}`,
        subject: opts.subject,
        category: "pricing",
        attribute: opts.plan,
        value: hit.price,
        quote: hit.span,
        sourceUrl: r.url,
        sourceTitle: r.title,
        publishedAt: r.publishedAt,
        pageDate: date,
        retrievedAt: r.retrievedAt,
        evidenceType: "historical",
        strength: "strong",
        planVerified: true,
      },
    });
  }
  return out;
}
