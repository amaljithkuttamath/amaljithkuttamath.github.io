// fastpath.ts — answering the easy questions without a model.
//
// WHY: Chitti's cheapest, most common question is "this indicator, these
// countries, these years, charted". Routing it through the agent costs an API
// key, four to six chained tool calls on a model that may fumble multi-step
// tool use, and a verifier pass — to produce a chart the app already has every
// deterministic piece to build: `findSeriesWithReceipt` (scoring + the live
// search APIs), `adapter.fetchSeries`, `buildCitation`, `buildOption`. None of
// them involve an LLM. So for the questions we can parse with confidence, we
// skip the model entirely: the answer is instant, free, needs no key, and
// cannot hallucinate, because nothing in the path is capable of inventing a
// number.
//
// THE DESIGN RULE IS "REFUSE, DON'T GUESS." A wrong fast-path answer is much
// worse than no fast path: the user asked one thing and silently got another,
// with a chart that looks authoritative. So `parseFastPath` is deliberately
// conservative and returns null on ANY doubt — every rejection simply falls
// through to the agent, which is exactly where an ambiguous question belongs.
// When adding patterns here, the question to ask is never "could we handle
// this?" but "would we handle it wrong?".
import { adapterOfId } from './sources/index';
import { findSeriesWithReceipt } from './sources/index';
import { scoreSeries, unmatchedTerms } from './scoring';
import { searchKb, KB_MIN_SCORE, type KbHit } from './kb';
import { extractCountryMentions } from './planner';
import { buildCitation } from './dashboards-agent';
import { growthStats, type ChartSpec, type Citation, type DataRow } from './tools';
import type { TraceEvent } from './receipts';
import type { SeriesHit } from './sources/types';

// The parsed shape of a fast-path question. Everything the deterministic
// pipeline needs and nothing else.
export interface FastPathPlan {
  // What to search the catalogs for — the question with countries, years and
  // framing words removed.
  indicatorQuery: string;
  countries: string[]; // resolved ISO3 codes, in mention order
  countryNames: string[];
  yearStart?: number;
  yearEnd?: number;
  // 'line' for a series over time, 'bar' for a single-year comparison.
  chartType: 'line' | 'bar';
}

// Phrases that mean the question needs reasoning, ranking, computation across
// entities, or an action — all of which are the agent's job. Any hit rejects
// the question outright. Grouped by why they disqualify, so the list stays
// reviewable rather than becoming a pile of regexes.
const AGENT_ONLY = [
  // Ranking / superlatives / cross-country computation.
  /\b(rank(?:ed|ing)?|top \d+|bottom \d+|fastest|slowest|most|least|highest|lowest|biggest|largest|smallest|best|worst|which countr(?:y|ies)|who (?:has|had)|every countr(?:y|ies)?|all countries)\b/,
  // Relationships between two series.
  /\b(correlat\w*|relationship|versus|vs\.?|against|compared with|driven by|explain(?:s|ed)? the|cause[sd]?)\b/,
  // Conceptual / open-ended.
  /\b(what does|what is meant|why|how come|explain|meaning of|define|should i|do you think)\b/,
  // Projection / speculation — the fast path only reports fetched history.
  /\b(project(?:ed|ion|ions)?|forecast\w*|predict\w*|expect(?:ed)? to|by 20[3-9]\d)\b/,
  // Actions that need the agent's tools.
  /\b(save|pin|dashboard|export|write|download|remember)\b/,
  // Aggregation the fast path does not do.
  /\b(average of|sum of|total across|per capita adjusted|share of world)\b/,
];

// Framing words that carry no indicator meaning. Stripped before searching so
// "chart the GDP per capita of India" searches "gdp per capita", not the verb.
const FRAMING = new Set([
  'chart', 'charts', 'graph', 'plot', 'show', 'shows', 'showing', 'display',
  'give', 'gimme', 'get', 'fetch', 'pull', 'draw', 'make', 'trend', 'trends',
  'me', 'us', 'a', 'an', 'the', 'of', 'for', 'in', 'on', 'at', 'to', 'from',
  'and', 'with', 'please', 'can', 'you', 'i', 'want', 'need', 'see', 'look',
  'how', 'has', 'have', 'had', 'did', 'does', 'do', 'is', 'are', 'was', 'were',
  'been', 'be', 'changed', 'change', 'changing', 'over', 'time', 'since',
  'between', 'during', 'until', 'through', 'up', 'data', 'numbers', 'figures',
  'statistics', 'stats', 'series', 'indicator', 'value', 'values', 'level',
  'levels', 'what', 'whats', 'compare', 'comparison', 'across', 'by', 'year',
  'years', 'yearly', 'annual', 'annually', 'last', 'past', 'recent', 'today',
  'now', 'currently', 'about', 'its', 'their', 'his', 'her',
]);

// A plausible data year. Below 1800 is almost certainly not a year in this
// domain, and a future year is not history the sources can serve.
function plausibleYear(n: number, thisYear: number): boolean {
  return n >= 1800 && n <= thisYear;
}

// Pull the year bounds out of a question. Returns the bounds plus the word
// indices consumed, so the caller can strip them from the indicator phrase.
// Recognises the forms people actually type; anything else yields no bounds
// (which is valid — the sources then serve their full range).
export function parseYears(
  question: string,
  thisYear: number
): { yearStart?: number; yearEnd?: number; single?: number; used: number[] } {
  const q = String(question ?? '').toLowerCase();
  const used: number[] = [];
  const collect = (...ys: number[]) => { for (const y of ys) used.push(y); };

  // "from 1990 to 2020" / "between 1990 and 2020" / "1990-2020" / "1990 to 2020"
  const range = q.match(/\b(?:from|between)?\s*(\d{4})\s*(?:-|–|—|to|and|until|through)\s*(\d{4})\b/);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (plausibleYear(a, thisYear) && plausibleYear(b, thisYear) && a < b) {
      collect(a, b);
      return { yearStart: a, yearEnd: b, used };
    }
  }

  // "since 2000" / "after 2000" / "from 2000"
  const since = q.match(/\b(?:since|after|from|starting in)\s+(\d{4})\b/);
  if (since) {
    const a = Number(since[1]);
    if (plausibleYear(a, thisYear)) {
      collect(a);
      return { yearStart: a, used };
    }
  }

  // "in the last 20 years" / "over the past 15 years"
  const lastN = q.match(/\b(?:last|past)\s+(\d{1,3})\s+years?\b/);
  if (lastN) {
    const n = Number(lastN[1]);
    if (n >= 2 && n <= 200) return { yearStart: thisYear - n, used };
  }

  // "before 2010" / "up to 2010"
  const before = q.match(/\b(?:before|up to|until|through)\s+(\d{4})\b/);
  if (before) {
    const b = Number(before[1]);
    if (plausibleYear(b, thisYear)) {
      collect(b);
      return { yearEnd: b, used };
    }
  }

  // "in 2019" / "for 2019" / a lone year — a single-year snapshot.
  const one = q.match(/\b(?:in|for|during|at)\s+(\d{4})\b/) || q.match(/\b(\d{4})\b/);
  if (one) {
    const y = Number(one[1]);
    if (plausibleYear(y, thisYear)) {
      collect(y);
      return { yearStart: y, yearEnd: y, single: y, used };
    }
  }

  return { used };
}

// Parse a question into a fast-path plan, or null to hand it to the agent.
// `thisYear` is injected rather than read from the clock so the unit table is
// deterministic.
export function parseFastPath(
  question: string,
  thisYear: number = new Date().getFullYear()
): FastPathPlan | null {
  // "&" and the wordier joiners are rewritten to "and" up front: "&" has no
  // letters, so the tokenizer dropped it and "GDP & inflation in India" reached
  // Gate 4 with nothing between its two indicators.
  const raw = String(question ?? '')
    .trim()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\b(?:as well as|along with|together with)\b/gi, 'and');
  if (raw.length < 6 || raw.length > 200) return null;
  const lower = raw.toLowerCase();

  // Gate 1: anything that needs reasoning, ranking or an action is the agent's.
  for (const re of AGENT_ONLY) if (re.test(lower)) return null;

  // Gate 2: a question with no country in it is either "every country" (an
  // aggregation the fast path deliberately does not do) or too vague to serve.
  const { words, rawWords, mentions } = extractCountryMentions(raw);
  if (!mentions.length) return null;
  const seen = new Set<string>();
  const unique = mentions.filter((m) => (seen.has(m.code) ? false : (seen.add(m.code), true)));
  // More than a handful of named countries is a comparison the agent frames
  // better (and a chart nobody can read).
  if (unique.length > 6) return null;

  // A lowercase "us" after a preposition or joiner ("gdp of the us and china")
  // is almost certainly the country, but cannot be told from the pronoun with
  // confidence — so it is not resolved, and the question is not answered
  // without it either.
  if (!seen.has('USA') && /\b(?:the|in|of|for|and|between)\s+u\.?s\b/.test(lower)) return null;

  const years = parseYears(raw, thisYear);

  // Gate 2b: every number in the question must be one the year parser used.
  // Bare numeric tokens are dropped by the tokenizer, so an unused one is a
  // part of the question about to be silently ignored: "ages 0-14" charted the
  // 65-and-over series, "in 2050" a full history, "2010 2020" a single year,
  // "from 2020 to 2010" an open range. One rule covers all of them.
  const spare = [...years.used];
  const numbered =
    !years.used.length && years.yearStart !== undefined
      ? lower.replace(/\b(?:last|past)\s+\d{1,3}\s+years?\b/, ' ')
      : lower;
  for (const token of numbered.split(/\s+/)) {
    if (/[a-z]/.test(token)) continue;
    for (const run of token.match(/\d+/g) ?? []) {
      const at = spare.indexOf(Number(run));
      if (at === -1) return null;
      spare.splice(at, 1);
    }
  }

  // The indicator phrase: everything that is not a country mention, a year, or
  // a framing word. Country spans are removed by index, so "United States" goes
  // in one piece and never leaves "united" behind to poison the search.
  const covered = new Set<number>();
  for (const m of mentions) for (let i = m.start; i < m.end; i++) covered.add(i);
  // Kept on rawWords so "CO2" survives as "CO2" rather than "CO".
  const residual = rawWords.filter((_, i) => !covered.has(i)).filter((w) => !/^\d+$/.test(w));
  const terms = residual.filter((w) => !FRAMING.has(w.toLowerCase()));
  const indicatorQuery = terms.join(' ').trim();

  // Gate 3: nothing recognisable left to search for. "Show me India" has no
  // indicator; that is a question for the agent, not a guess at GDP.
  if (indicatorQuery.length < 3 || terms.length === 0) return null;

  // Gate 4: two indicators in one question ("GDP and population in India") —
  // the fast path fetches exactly one series, so it must not silently answer
  // half the question. Tested on the residual BEFORE framing words are removed:
  // "and" is itself a framing word, so by the time it reaches indicatorQuery it
  // is long gone. A conjunction only disqualifies when it genuinely joins two
  // content phrases — in "Japan and Korea" the countries are already stripped,
  // leaving nothing content-bearing after "and", which is the case we want to
  // keep (two countries, one indicator, a perfectly good fast-path question).
  const conj = residual.findIndex((w) => /^(and|or|plus|versus|vs)$/i.test(w));
  if (conj !== -1) {
    const contentBefore = residual.slice(0, conj).some((w) => !FRAMING.has(w.toLowerCase()));
    const contentAfter = residual.slice(conj + 1).some((w) => !FRAMING.has(w.toLowerCase()));
    if (contentBefore && contentAfter) return null;
  }

  return {
    indicatorQuery,
    countries: unique.map((m) => m.code),
    countryNames: unique.map((m) => m.name),
    ...(years.yearStart !== undefined ? { yearStart: years.yearStart } : {}),
    ...(years.yearEnd !== undefined ? { yearEnd: years.yearEnd } : {}),
    // A single named year is a snapshot across countries (bar); anything else
    // is a series over time (line).
    chartType: years.single !== undefined ? 'bar' : 'line',
  };
}

// How well the top search hit must match before the fast path will commit to
// it. Below this we do NOT chart a maybe — we hand the question to the agent,
// which can search again, reason about the mismatch, and pick a better id.
//
// Calibrated against the curated catalog rather than guessed. In `scoring.ts` an
// exact phrase hit is +10 and each distinct matched term is +2, so 4 means "the
// phrase appears, or at least two content terms do". Measured: "gdp per capita"
// 22, "inflation" 21, "life expectancy" 20, "population" 18, "literacy rate" 18,
// "CO2 emissions per capita" 10, "unemployment rate" 4, "electricity access" 4 —
// all fire. "child mortality" and "internet users" score 2 (the catalog words
// them "under-5" and "Individuals using the Internet") and so does nonsense like
// "banana exports" — the low end cannot be separated by score, so all three are
// refused and escalate to the agent.
//
// That means the threshold deliberately UNDER-fires: it turns away some good
// matches to guarantee it never charts a bad one. That is the correct direction
// for this trade — a wrong fast answer is worse than a slower right one.
export const MIN_MATCH_SCORE = 4;

export interface FastPathResult {
  plan: FastPathPlan;
  hit: SeriesHit;
  spec: ChartSpec;
  rows: DataRow[];
  citations: Citation[];
  // A factual sentence built from the fetched values — NOT model insight, and
  // never presented as such.
  summary: string;
  // The completed step list, so the caller can render the same receipt the
  // agent's turns show. Identical TraceEvent shape; there are simply no model
  // steps in it, because none happened.
  trace: TraceEvent[];
  // Other series the same phrase fits — the rest of an ambiguous choice after
  // the user picked one, or the series a tuned leaf beat in a tie. Never a
  // reason to chart them; the UI offers them as "switch to" choices. Empty
  // when the phrase had one clear reading.
  alternatives: SeriesCandidate[];
}

// One series the fast path could look up, as offered to the user when a phrase
// fits more than one. Everything here comes from the knowledge base; nothing is
// fetched to build it.
export interface SeriesCandidate {
  id: string;
  name: string;
  source: string;
}

// At most this many series are offered for one ambiguous phrase. More than a
// handful stops being a choice and becomes a search, which is the agent's job.
export const MAX_CANDIDATES = 4;

// Why the fast path declined, when it declined after starting. Surfaced so the
// caller can escalate honestly rather than showing a dead end.
export type FastPathMiss =
  | { ok: false; reason: 'no-match' }
  | { ok: false; reason: 'weak-match'; best: SeriesHit }
  | { ok: false; reason: 'no-data'; hit: SeriesHit }
  // The phrase fits several series equally well. Nothing was fetched or
  // charted: the caller offers `candidates` and re-runs with the one the user
  // picks (`runFastPath(plan, { chosen })`). Only raised when at least two
  // candidates answer every word of the phrase; otherwise it stays a no-match.
  | { ok: false; reason: 'ambiguous'; phrase: string; candidates: SeriesCandidate[] };

// Run a parsed plan with NO model call: search, fetch, chart, cite. Streams the
// same TraceEvent shape the agent does, so the receipt UI renders it unchanged
// — the user sees the identical timeline, minus the model steps that aren't
// there. Returns a miss (never a guess) when the data doesn't support an answer.
export async function runFastPath(
  plan: FastPathPlan,
  opts: {
    sources?: string[];
    onTrace?: (events: TraceEvent[]) => void;
    signal?: AbortSignal;
    // A series the USER picked (from an ambiguous choice, a "switch to" row,
    // or the series an earlier direct answer used). Skips the search: the
    // choice is the person's, so there is nothing left to guess.
    chosen?: SeriesCandidate;
  } = {}
): Promise<FastPathResult | FastPathMiss> {
  const trace: TraceEvent[] = [];
  const push = (ev: TraceEvent) => { trace.push(ev); opts.onTrace?.([...trace]); };
  const settle = (ev: TraceEvent, status: 'ok' | 'error', detail: string) => {
    ev.status = status;
    ev.detail = detail;
    // Measured, not estimated: push time to settle time on this machine.
    ev.durationMs = Math.max(0, Date.now() - ev.ts);
    opts.onTrace?.([...trace]);
  };

  // 1. Find the series — the same cross-source search the agent's find_series
  //    tool calls, receipt and all.
  const findEv: TraceEvent = {
    tool: 'find_series',
    argSummary: plan.indicatorQuery,
    status: 'running',
    ts: Date.now(),
  };
  push(findEv);

  // ── Knowledge base first ────────────────────────────────────────────────
  // The KB is consulted BEFORE the flat catalogue search, not as its fallback.
  // Fallback ordering was wrong for a reason worth recording: flat scoring is
  // not merely weaker, it is sometimes confidently WRONG — "how long people
  // live" returns the child-mortality series at a score that clears the bar, so
  // a KB kept in reserve never gets a say on the query it would have fixed.
  // Where the KB has authored vocabulary it is the better answer; where it does
  // not, the flat search still reaches catalogues far larger than the shortlist.
  // It also costs no request, so a KB hit skips a network round trip entirely.
  let hit: SeriesHit | null = null;
  let via = '';
  let alternatives: SeriesCandidate[] = [];
  const ranked = searchKb(plan.indicatorQuery, opts.sources);
  if (opts.chosen) {
    if (!opts.chosen.id || !adapterOfId(opts.chosen.id)) {
      settle(findEv, 'error', 'chosen series is not available');
      return { ok: false, reason: 'no-match' };
    }
    hit = { id: opts.chosen.id, name: opts.chosen.name || opts.chosen.id, source: opts.chosen.source };
    via = ' · chosen by you';
    // The same choices the unchosen lookup would have offered — the ambiguous
    // candidates, or the tuned winner and its ties — minus the one in use.
    const pick = pickKbHit(ranked);
    const offered =
      pick === 'ambiguous'
        ? kbCandidates(ranked)
        : pick
          ? [{ id: pick.seriesId, name: pick.name, source: pick.source }, ...tiedAlternatives(ranked, pick)]
          : [];
    alternatives = offered.filter((c) => c.id !== opts.chosen!.id);
  } else {
    const kbHit = pickKbHit(ranked);
    if (kbHit === 'ambiguous') {
      const candidates = kbCandidates(ranked);
      if (candidates.length >= 2) {
        settle(findEv, 'error', `more than one series fits: ${candidates.map((c) => c.name).join('; ')}`);
        return { ok: false, reason: 'ambiguous', phrase: plan.indicatorQuery, candidates };
      }
      settle(findEv, 'error', 'more than one series fits');
      return { ok: false, reason: 'no-match' };
    }
    if (kbHit) {
      hit = { id: kbHit.seriesId, name: kbHit.name, source: kbHit.source };
      // The route is the explanation a similarity score cannot give — show it.
      via = ' · via ' + kbHit.path.slice(1).join(' › ');
      alternatives = tiedAlternatives(ranked, kbHit);
    }
  }

  if (!hit) {
    const { hits, receipt } = await findSeriesWithReceipt(plan.indicatorQuery, opts.sources, opts.signal);
    findEv.receipt = receipt;
    if (!hits.length) {
      settle(findEv, 'error', 'no matching series');
      return { ok: false, reason: 'no-match' };
    }
    const best = hits[0];
    // Commit only to a confident match. `scoreSeries` is the same scorer that
    // ranked the hits, so this is a threshold on the ranking we already trust.
    if (scoreSeries(plan.indicatorQuery, best.id, best.name) < MIN_MATCH_SCORE) {
      settle(findEv, 'error', `best match too weak (${best.name})`);
      return { ok: false, reason: 'weak-match', best };
    }
    // Same rule as the KB route: a word of the question that the chosen series
    // says nothing about is a qualifier we would be silently dropping.
    if (unmatchedTerms(plan.indicatorQuery, best.id, best.name).length) {
      settle(findEv, 'error', `best match ignores part of the question (${best.name})`);
      return { ok: false, reason: 'weak-match', best };
    }
    hit = best;
  }
  settle(findEv, 'ok', `${hit.name} (${hit.id})${via}`);

  // 2. Fetch it, through the id's own adapter — the same router path a live
  //    run takes.
  const adapter = adapterOfId(hit.id);
  if (!adapter) return { ok: false, reason: 'no-match' };
  const fetchEv: TraceEvent = {
    tool: 'fetch_series',
    argSummary: `${hit.id} · ${plan.countries.join(', ')}`,
    status: 'running',
    ts: Date.now(),
  };
  push(fetchEv);
  const result = await adapter.fetchSeries(
    hit.id,
    plan.countries,
    plan.yearStart,
    plan.yearEnd,
    opts.signal
  );
  const rows: DataRow[] = (result.rows || [])
    .map((r) => ({ ...r, indicator: hit.id }))
    .filter((r) => r.value !== null);
  if (!rows.length) {
    settle(fetchEv, 'error', 'no values for those countries/years');
    return { ok: false, reason: 'no-data', hit };
  }
  settle(fetchEv, 'ok', `${rows.length} rows`);

  const nid = adapter.normalizeId(hit.id);
  const citations = [
    buildCitation(
      `${adapter.citationSource}:${nid}:${plan.countries.join(',')}:${plan.yearStart ?? ''}-${plan.yearEnd ?? ''}`,
      adapter.citationSource,
      nid,
      plan.countries,
      plan.yearStart,
      plan.yearEnd,
      rows.length,
      result.requestUrl || '',
      result.sourceUpdated,
      result.mirroredAt
    ),
  ];

  // 3. Chart it. Deterministic: the spec is a direct projection of the rows.
  const chartEv: TraceEvent = {
    tool: 'render_chart',
    argSummary: plan.chartType,
    status: 'running',
    ts: Date.now(),
  };
  push(chartEv);
  const label = pickLabel(hit.name, adapter.indicatorLabel(nid, result), nid);
  const spec = buildFastSpec(plan, rows, label);
  settle(chartEv, 'ok', `${spec.series.length} series`);

  return {
    plan, hit, spec, rows, citations, trace, alternatives,
    summary: buildFastSummary(plan, rows, label),
  };
}

// Decide whether the knowledge base's ranking is safe to act on with no model.
//
//   null        the KB has no confident match — try the flat catalogue search.
//   'ambiguous' the KB matched, but committing would be a guess — refuse, and
//               do NOT fall back to flat search, which is weaker still.
//   a hit       commit.
//
// Two ways a top hit is a guess. (1) It leaves a word of the question
// unanswered: "adult mortality" clears the bar on the INFANT series through
// "mortality" alone, "life expectancy of women" on the total. (2) It only wins
// a tie on catalogue order: "rural population" tied "Rural population" with
// "Rural population living in areas where elevation is below 5 meters" and
// charted the latter. A tie a TUNED leaf wins is different — the authored core
// sits first in the tree precisely so it wins conflicts ("life expectancy" →
// the total series, not the male one), and the retrieval eval pins that order.
// Pure — exported for its unit table.
export function pickKbHit(hits: KbHit[]): KbHit | 'ambiguous' | null {
  const top = hits[0];
  if (!top || top.score < KB_MIN_SCORE) return null;
  if (top.unmatched.length) return 'ambiguous';
  const tied = hits.some((h) => h.seriesId !== top.seriesId && h.score >= top.score);
  if (tied && !top.tuned) return 'ambiguous';
  return top;
}

// The series an ambiguous ranking offers as a choice: every distinct hit that
// clears the KB bar AND answers every word of the phrase, best first, capped at
// MAX_CANDIDATES. A hit that leaves a word unanswered is not offered — picking
// it would be choosing to drop part of the question. Pure — exported for its
// unit table.
//
// Within one score the shorter (more general) name comes first, so "Rural
// population" is offered before "Rural population living in areas where
// elevation is below 5 meters". That is display order only — nothing here is
// committed to; the user still picks.
export function kbCandidates(hits: KbHit[]): SeriesCandidate[] {
  const eligible: KbHit[] = [];
  for (const h of hits) {
    if (h.score < KB_MIN_SCORE || h.unmatched.length) continue;
    if (eligible.some((c) => c.seriesId === h.seriesId)) continue;
    eligible.push(h);
  }
  return eligible
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, MAX_CANDIDATES)
    .map((h) => ({ id: h.seriesId, name: h.name, source: h.source }));
}

// The series a tuned leaf beat only by winning a tie (the "core wins" rule):
// charting the tuned one is still right, but the tie is disclosed so the user
// can switch. Same eligibility as kbCandidates, and only exact ties. Pure.
export function tiedAlternatives(hits: KbHit[], top: KbHit): SeriesCandidate[] {
  return kbCandidates(hits.filter((h) => h.seriesId !== top.seriesId && h.score >= top.score));
}

// Choose the human label for the chart title, axis and summary.
//
// The search hit's name wins. `SourceAdapter.indicatorLabel` exists to feed the
// session's indicator map, where the UI later enriches a bare id through
// INDICATOR_MAP — so World Bank implements it as `(nid) => nid` and returns a
// raw code like "NY.GDP.PCAP.CD". The fast path has no such enrichment step, so
// preferring it produced answers reading "India: NY.GDP.PCAP.CD rose from…".
// The catalog name ("GDP per capita (current US$)") is human by construction for
// every source; the adapter label is the fallback, and the id the last resort.
// Pure — exported for its unit table.
export function pickLabel(hitName: string, adapterLabel: string, nid: string): string {
  const hit = (hitName || '').trim();
  // A "name" that is just the id repeated is no better than no name.
  if (hit && hit.toLowerCase() !== nid.toLowerCase()) return hit;
  const adapted = (adapterLabel || '').trim();
  if (adapted && adapted.toLowerCase() !== nid.toLowerCase()) return adapted;
  return nid;
}

// Build the chart spec from fetched rows. Pure — exported for its unit table.
export function buildFastSpec(plan: FastPathPlan, rows: DataRow[], label: string): ChartSpec {
  if (plan.chartType === 'bar') {
    // Single-year snapshot: one bar per country, ordered as asked.
    const byIso = new Map(rows.map((r) => [r.iso3, r]));
    const data: [string, number][] = [];
    for (const code of plan.countries) {
      const r = byIso.get(code);
      if (r && r.value !== null) data.push([r.country, r.value]);
    }
    return {
      type: 'bar',
      title: `${label}${plan.yearStart ? `, ${plan.yearStart}` : ''}`,
      x_axis: 'Country',
      y_axis: label,
      series: [{ name: label, data }],
    };
  }
  // Time series: one line per country, years ascending.
  const byCountry = new Map<string, DataRow[]>();
  for (const r of rows) {
    const list = byCountry.get(r.iso3) || [];
    list.push(r);
    byCountry.set(r.iso3, list);
  }
  const series = plan.countries
    .map((code) => byCountry.get(code))
    .filter((list): list is DataRow[] => !!list && list.length > 0)
    .map((list) => {
      const sorted = [...list].sort((a, b) => a.year - b.year);
      return {
        name: sorted[0].country,
        data: sorted.map((r) => [r.year, r.value as number] as [number, number]),
      };
    });
  const years = rows.map((r) => r.year);
  const span = years.length ? `, ${Math.min(...years)}–${Math.max(...years)}` : '';
  return {
    type: 'line',
    title: `${label}${span}`,
    x_axis: 'Year',
    y_axis: label,
    series,
  };
}

const num = (n: number): string =>
  n.toLocaleString('en-US', { maximumFractionDigits: 2 });

// A factual sentence derived ENTIRELY from the fetched rows — first and last
// values, the change between them. It states what the data says and stops.
// It is deliberately not "insight": no model ran, so nothing here may read as
// interpretation the app cannot back up.
//
// It is written to be READ, not parsed: "X rose in all three countries between
// 1960 and 2023: Japan from 67.86 to 83.68 (+23.3%), …" rather than a row of
// "67.86 → 83.68" fragments. Every word is still computed — "rose in all
// three" is a count of the signs of the changes, and when the directions
// differ the sentence says so per country instead of generalising. Countries
// appear in the order the question named them. Pure; exported for its unit
// table.
const COUNT_WORDS = ['', '', 'both', 'all three', 'all four', 'all five', 'all six'];

// How one endpoint-to-endpoint change is quoted. A series measured in percent
// reports the difference in percentage points: "+25%" for a move from 4% to 5%
// reads as 25 points to most people, which is the wrong number.
function changeNote(s: { absChange: number; pctChange: number | null }, percentUnit: boolean): string {
  const sign = (n: number) => (n >= 0 ? '+' : '−') + num(Math.abs(n));
  if (percentUnit) return ` (${sign(s.absChange)} percentage ${num(Math.abs(s.absChange)) === '1' ? 'point' : 'points'})`;
  if (s.pctChange === null) return '';
  return ` (${sign(Math.round(s.pctChange * 10) / 10)}%)`;
}

// "A", "A and B", "A, B and C".
function listOf(items: string[]): string {
  if (items.length < 3) return items.join(' and ');
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

export function buildFastSummary(plan: FastPathPlan, rows: DataRow[], label: string): string {
  if (plan.chartType === 'bar') {
    const sorted = [...rows].sort((a, b) => (b.value as number) - (a.value as number));
    if (!sorted.length) return '';
    const year = sorted[0].year;
    if (sorted.length === 1) {
      return `${label} in ${sorted[0].country} was ${num(sorted[0].value as number)} in ${year}.`;
    }
    const hi = sorted[0];
    const lo = sorted[sorted.length - 1];
    return (
      `${label} in ${year}: ${hi.country} is highest at ${num(hi.value as number)} and ` +
      `${lo.country} lowest at ${num(lo.value as number)}.`
    );
  }
  const order = (iso3: string) => {
    const at = plan.countries.indexOf(iso3);
    return at === -1 ? plan.countries.length : at;
  };
  const stats = growthStats(rows)
    .filter((s) => s.firstYear !== s.lastYear)
    .sort((a, b) => order(a.iso3) - order(b.iso3));
  if (!stats.length) return '';
  const percentUnit = /%/.test(label);
  const dirOf = (s: { absChange: number }) => (s.absChange > 0 ? 'rose' : s.absChange < 0 ? 'fell' : 'was unchanged');
  if (stats.length === 1) {
    const s = stats[0];
    if (s.absChange === 0)
      return `${label} in ${s.country} was ${num(s.firstValue)} in both ${s.firstYear} and ${s.lastYear}.`;
    return `${label} in ${s.country} ${dirOf(s)} from ${num(s.firstValue)} in ${s.firstYear} to ${num(s.lastValue)} in ${s.lastYear}${changeNote(s, percentUnit)}.`;
  }
  // One shared span is stated once only when every country actually has it.
  // Otherwise each country carries its own years: stamping India's 1960–2023
  // on South Sudan's 2011–2019 change misdates the number.
  const first = stats[0];
  const shared = stats.every((s) => s.firstYear === first.firstYear && s.lastYear === first.lastYear);
  const sameDir = stats.every((s) => dirOf(s) === dirOf(first)) && first.absChange !== 0;
  const years = (s: (typeof stats)[number]) => (shared ? '' : ` between ${s.firstYear} and ${s.lastYear}`);
  if (sameDir) {
    const all = COUNT_WORDS[stats.length] ?? `all ${stats.length}`;
    const parts = stats.map(
      (s) => `${s.country} from ${num(s.firstValue)} to ${num(s.lastValue)}${changeNote(s, percentUnit)}${years(s)}`
    );
    const span = shared ? ` between ${first.firstYear} and ${first.lastYear}` : '';
    return `${label} ${dirOf(first)} in ${all} countries${span}: ${listOf(parts)}.`;
  }
  // Directions differ: no summary verb, each country states its own.
  const parts = stats.map((s) =>
    s.absChange === 0
      ? `${s.country} was unchanged at ${num(s.firstValue)}${years(s)}`
      : `${s.country} ${dirOf(s)} from ${num(s.firstValue)} to ${num(s.lastValue)}${changeNote(s, percentUnit)}${years(s)}`
  );
  const span = shared ? `, ${first.firstYear} to ${first.lastYear}` : '';
  return `${label}${span}: ${parts.join('; ')}.`;
}
