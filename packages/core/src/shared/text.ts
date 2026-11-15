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

/** Loose subject equality: "HubSpot Sales Hub" ≈ "hubspot", "Neon" ≈ "Neon Postgres". */
export function subjectMatches(a: string, b: string): boolean {
  const na = normalizeForMatch(a).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const nb = normalizeForMatch(b).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = na.split(" ");
  const tb = nb.split(" ");
  // the first significant token must match (brand name), e.g. "hubspot" / "aws"
  return ta[0] === tb[0] || na.includes(nb) || nb.includes(na);
}
