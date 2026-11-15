/** Text helpers shared by retrieval, evidence validation and comparison. */

/**
 * Normalises text for robust verbatim matching: case-folds, unifies quotes,
 * dashes and whitespace, and strips markdown emphasis. Used to check that a
 * model-provided quote actually occurs in the source text.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[*_`#>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsNormalized(haystack: string, needle: string): boolean {
  const n = normalizeForMatch(needle);
  if (!n) return false;
  return normalizeForMatch(haystack).includes(n);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its last me my " +
    "of on or our since so that the their them then there these they this to us was we were what when where which who " +
    "why will with would you your about any anything changed change still correct today ask asked tell told answer " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august " +
    "september october november december yesterday week month day days ago earlier previous discussion discussed " +
    "talked shortlisted shipped something big has new latest current currently now please"
  ).split(" "),
);

/** Extracts lowercase keyword tokens (no stopwords, length ≥ 2). */
export function keywords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of text.toLowerCase().match(/[a-z0-9][a-z0-9.+-]*[a-z0-9]|[a-z0-9]/g) ?? []) {
    const tok = t.replace(/[.+-]+$/g, "");
    if (tok.length < 2 || STOPWORDS.has(tok) || /^\d+$/.test(tok)) continue;
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

const SUBJECT_FILLER = new Set(["the", "for", "and", "inc", "by", "of"]);

/** Significant lowercase tokens of a product/vendor name. */
export function subjectTokens(s: string): string[] {
  return normalizeForMatch(s)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !SUBJECT_FILLER.has(t));
}

/**
 * Subject equality: every significant token of the shorter name must appear
 * in the longer one. "HubSpot" ≈ "HubSpot Sales Hub", "Neon" ≈ "Neon Launch",
 * "AWS RDS" ≈ "AWS RDS for PostgreSQL", but "Google Cloud SQL" ≠ "Google Workspace".
 */
export function subjectMatches(a: string, b: string): boolean {
  const ta = subjectTokens(a);
  const tb = subjectTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const [small, large] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return small.every((t) => large.has(t));
}
