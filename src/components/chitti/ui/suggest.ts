// Type-ahead for the composer: pure and offline. Matches the phrase being typed
// against the knowledge base (searchKb) and the country list, and says what
// sending would do (parseFastPath → pickKbHit) — the same deterministic steps
// the direct path runs, so the preview cannot promise something the send
// would not do. No network, no model.
import { searchKb, buildKb, KB_MIN_SCORE, type KbNode } from "../../../lib/chitti/kb";
import { parseFastPath, pickKbHit, kbCandidates } from "../../../lib/chitti/fastpath";
import { COUNTRIES } from "../../../lib/chitti/core";
import { SOURCES } from "../../../lib/chitti/tools";
import { extractCountryMentions } from "../../../lib/chitti/planner";

export interface IndicatorSuggestion {
  kind: "indicator";
  id: string;
  name: string;
  source: string;
  /** Set when the match came through an alias or group word, not the name. */
  alsoCalled?: string;
  /** What choosing it puts into the message. */
  insert: string;
}
export interface CountrySuggestion {
  kind: "country";
  id: string;
  name: string;
  insert: string;
}
export type Suggestion = IndicatorSuggestion | CountrySuggestion;

export type Preview =
  | { kind: "direct"; source: string }
  | { kind: "choose" }
  | { kind: "try-direct" }
  | { kind: "model" }
  | null;

// Words that end the phrase being typed: what comes after one of these is the
// fragment the user is still writing.
const BOUNDARY = new Set([
  "in", "of", "for", "and", "since", "from", "between", "to", "until", "vs",
  "compare", "show", "chart", "plot", "graph", "me", "the", "how", "has", "what",
  "is", "was", "did", "across", "with", "over", "about",
]);

const norm = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** The trailing words being typed (after the last boundary word, number or
 * recognised country), and where they start in the text. */
export function fragmentOf(text: string): { fragment: string; start: number } {
  const words = [...text.matchAll(/[^\s,;]+/g)];
  if (!words.length || /[\s,;]$/.test(text)) return { fragment: "", start: text.length };
  let i = words.length;
  while (i > 0) {
    const w = words[i - 1][0];
    const lw = norm(w);
    if (!lw || BOUNDARY.has(lw) || /^\d+$/.test(lw)) break;
    i--;
  }
  if (i === words.length) return { fragment: "", start: text.length };
  const start = words[i].index!;
  return { fragment: text.slice(start), start };
}

let cachedTree: { key: string; leaves: Map<string, string[]> } | null = null;
// Every leaf's inherited vocabulary (its own aliases first, then its group's),
// so a match can be explained: "also called child mortality".
function vocabulary(sources?: string[]): Map<string, string[]> {
  const key = (sources || []).join(",");
  if (cachedTree?.key === key) return cachedTree.leaves;
  const leaves = new Map<string, string[]>();
  const walk = (node: KbNode, trail: KbNode[]) => {
    if (node.seriesId) {
      const words = [...node.aliases, ...[...trail].reverse().flatMap((n) => n.aliases)];
      if (!leaves.has(node.seriesId)) leaves.set(node.seriesId, words);
      return;
    }
    for (const c of node.children) walk(c, [...trail, node]);
  };
  walk(buildKb(sources), []);
  cachedTree = { key, leaves };
  return leaves;
}

// Every term of the query starts a word of the haystack (prefixes count, so
// "child mort" finds "child mortality") — the scorer's own start-of-word rule.
function covers(haystack: string, query: string): boolean {
  const words = norm(haystack).split(" ");
  return norm(query)
    .split(" ")
    .filter(Boolean)
    .every((t) => words.some((w) => w.startsWith(t)));
}

const plainName = (name: string) => name.replace(/\s*\([^)]*\)/g, "").trim();

export function suggest(text: string, sources?: string[], limit = 4): Suggestion[] {
  const { fragment } = fragmentOf(text);
  const query = norm(fragment);
  if (query.length < 2) return [];
  // Countries: a name (or one of its words) that starts with the fragment.
  const mentioned = new Set(extractCountryMentions(text.slice(0, Math.max(0, text.length - fragment.length))).mentions.map((m) => m.code));
  const countries = COUNTRIES.filter(
    (c) => c.region !== "Aggregates" && !mentioned.has(c.id) && (norm(c.name).startsWith(query) || norm(c.name).split(" ").some((w) => w.startsWith(query) && query.length >= 3)),
  )
    .sort((a, b) => Number(!norm(b.name).startsWith(query)) - Number(!norm(a.name).startsWith(query)) || a.name.length - b.name.length)
    .slice(0, 3)
    .map<CountrySuggestion>((c) => ({ kind: "country", id: c.id, name: c.name, insert: c.name }));
  // A fragment that is plainly the start of a country name is a country.
  if (countries.some((c) => norm(c.name).startsWith(query))) return countries;
  // Indicators: the KB's own ranking, shown only for real matches. Ties are
  // listed general-first (shorter name), as the ambiguity choice lists them.
  const vocab = vocabulary(sources);
  const indicators: (IndicatorSuggestion & { score: number })[] = [];
  if (query.length >= 3)
    for (const hit of searchKb(query, sources, 16)) {
      if (hit.score < KB_MIN_SCORE / 2 || indicators.some((s) => s.id === hit.seriesId)) continue;
      const byName = covers(hit.name, query);
      const alias = byName ? undefined : (vocab.get(hit.seriesId) || []).find((a) => covers(a, query));
      if (!byName && !alias) continue;
      indicators.push({
        kind: "indicator",
        id: hit.seriesId,
        name: hit.name,
        source: hit.source,
        alsoCalled: alias,
        insert: plainName(hit.name),
        score: hit.score,
      });
    }
  indicators.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return [
    ...indicators.slice(0, limit).map(({ score: _score, ...rest }) => rest),
    ...countries,
  ];
}

/** Replace the fragment being typed with a chosen suggestion. */
export function applySuggestion(text: string, s: Suggestion): string {
  const { start } = fragmentOf(text);
  return `${text.slice(0, start)}${s.insert} `;
}

export const sourceLabel = (id: string) => SOURCES.find((s) => s.id === id)?.label || id;

/**
 * What sending this text would do. "direct" only when the knowledge base would
 * commit to one series — the same rule the send applies. "model" only when no
 * model is connected (with one connected, nothing needs saying).
 */
export function preview(
  text: string,
  sources: string[] | undefined,
  modelConnected: boolean,
  pinned?: IndicatorSuggestion | null,
): Preview {
  if (text.trim().length < 6) return null;
  if (pinned && pinnedPlan(text, pinned)) return { kind: "direct", source: sourceLabel(pinned.source) };
  const plan = parseFastPath(text);
  if (!plan) return modelConnected ? null : { kind: "model" };
  const hits = searchKb(plan.indicatorQuery, sources);
  const pick = pickKbHit(hits);
  if (pick === "ambiguous") return kbCandidates(hits).length >= 2 ? { kind: "choose" } : modelConnected ? null : { kind: "model" };
  if (pick) return { kind: "direct", source: sourceLabel(pick.source) };
  return { kind: "try-direct" };
}

/**
 * A series the user picked from the list is the user's choice, not a guess:
 * while its phrase is still in the message and the message parses as a direct
 * lookup, sending looks up exactly that series. Returns the plan to run, or
 * null when the message no longer says what was picked.
 */
export function pinnedPlan(text: string, pinned: IndicatorSuggestion) {
  if (!norm(text).includes(norm(pinned.insert))) return null;
  const plan = parseFastPath(text);
  return plan && covers(plan.indicatorQuery, pinned.insert) && covers(pinned.insert, plan.indicatorQuery) ? plan : null;
}
