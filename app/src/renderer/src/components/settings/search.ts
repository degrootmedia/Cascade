/**
 * Fuzzy search for the Settings rail. Pure functions (no React) so the scorer
 * and the highlighter are unit-tested directly. The scorer is a small
 * subsequence matcher with a word-boundary bonus — no new dependency.
 */
import type { SettingsCategory, SettingsSection } from "./types.js";

/** Fold a string for matching: lowercase, non-alphanumerics → single space. */
export function fold(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** True when `needle` appears in `hay` as a subsequence (typo tolerance). */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/**
 * Score `query` against `text`. 0 = no match; higher = better. Ranked:
 * all-tokens-as-word-prefixes > contiguous phrase (word-start gets a bonus) >
 * all tokens as substrings > subsequence. Exported for tests.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = fold(query);
  if (!q) return 1;
  const t = fold(text);
  if (!t) return 0;
  const tokens = q.split(" ").filter(Boolean);
  const words = t.split(" ").filter(Boolean);
  const qc = tokens.join("");
  const tc = words.join("");
  if (!qc) return 1;

  const allWordPrefixes = tokens.every((tok) => words.some((w) => w.startsWith(tok)));
  if (tokens.length > 1 && allWordPrefixes) return 900;

  const at = tc.indexOf(qc);
  if (at >= 0) {
    const boundary = words.some((w) => w.startsWith(qc)) ? 60 : 0;
    return 800 + boundary - Math.min(at, 80);
  }

  if (tokens.every((tok) => tc.includes(tok))) return 600 + (allWordPrefixes ? 40 : 0);

  if (isSubsequence(qc, tc)) {
    const initials = words.map((w) => w[0]).join("");
    return 400 + (isSubsequence(qc, initials) ? 30 : 0);
  }
  return 0;
}

/** Everything a section is searchable by (title, description, keywords). */
export function sectionSearchText(section: SettingsSection): string {
  return [section.title, section.description ?? "", section.keywords.join(" ")].join(" ");
}

export interface SectionMatch {
  section: SettingsSection;
  score: number;
}

export interface CategoryMatches {
  category: SettingsCategory;
  sections: SectionMatch[];
}

/**
 * Filter the registry by `query`. A section matches on its own text or its
 * category title; categories with no matches drop out. An empty query returns
 * every section in registry order. Matching sections are ranked best-first
 * within their category.
 */
export function matchSections(categories: SettingsCategory[], query: string): CategoryMatches[] {
  const q = query.trim();
  if (!q) {
    return categories.map((category) => ({
      category,
      sections: category.sections.map((section) => ({ section, score: 1 })),
    }));
  }
  const out: CategoryMatches[] = [];
  for (const category of categories) {
    const categoryScore = fuzzyScore(q, category.title);
    const matched: SectionMatch[] = [];
    for (const section of category.sections) {
      const score = Math.max(fuzzyScore(q, sectionSearchText(section)), categoryScore);
      if (score > 0) matched.push({ section, score });
    }
    if (matched.length) {
      matched.sort((a, b) => b.score - a.score);
      out.push({ category, sections: matched });
    }
  }
  // Rank categories by their best hit so a strong match in a later group
  // (e.g. "cli" → CLI Tools) surfaces above an incidental earlier one.
  return out
    .map((group, index) => ({ group, index, best: group.sections[0]?.score ?? 0 }))
    .sort((a, b) => b.best - a.best || a.index - b.index)
    .map((x) => x.group);
}

/** A run of label text, flagged when it matches the query. */
export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * Split `text` into segments, flagging the runs that match `query` (the whole
 * phrase plus each token). Used by `SettingField` to highlight matching labels.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  const q = query.trim();
  if (!q || !text) return [{ text, hit: false }];
  const terms = [q, ...q.split(/\s+/).filter(Boolean)].filter((t) => t.length >= 2);
  if (!terms.length) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const hits: boolean[] = new Array(text.length).fill(false);
  for (const term of terms) {
    const t = term.toLowerCase();
    let from = 0;
    for (;;) {
      const i = lower.indexOf(t, from);
      if (i < 0) break;
      for (let k = i; k < i + t.length; k++) hits[k] = true;
      from = i + t.length;
    }
  }
  if (!hits.some(Boolean)) return [{ text, hit: false }];
  const out: HighlightSegment[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || hits[i] !== hits[start]) {
      out.push({ text: text.slice(start, i), hit: hits[start] });
      start = i;
    }
  }
  return out;
}
