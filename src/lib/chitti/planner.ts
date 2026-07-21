// planner.ts — the gated insight-brief planner: the pure heuristic that decides
// whether a question earns one extra planning turn (needsPlan and its helpers),
// the defensive brief parser (parsePlanBrief), and the step check-off matcher
// (matchStepToEvent). All pure and exported for their unit tables.
import { resolveCountry } from './countries';
import { extractJsonObject } from './parse-json';

// ── Insight-brief planning (backlog #10) ──────────────────────────────────
// One step of a plan: what to do, and an optional hint of which tool family it
// maps to (used by matchStepToEvent to check the step off as execution runs).
export interface PlanStep {
  what: string;
  tool_hint?: 'find_series' | 'fetch_series' | 'execute_js' | 'delegate_source';
}

// The structured insight brief a gated planning turn commits to BEFORE the tool
// loop runs. `insight` is the specific story/claim to investigate (not a
// restatement of the question); the executor is handed it as a system-side note
// and the verifier judges the answer against it. Parsed defensively from the
// planner's raw text (parsePlanBrief); a malformed brief becomes `null` and the
// run proceeds exactly as it would with no plan.
export interface InsightBrief {
  insight: string;
  steps: PlanStep[];
  chart_intent?: string;
  sources_expected?: string[];
}

// ── Plan gating (pure, exported for tests) ────────────────────────────────
// Short words that collide with ISO2 country codes ("US", "IN", "NO", "IS") or
// are otherwise noise — excluded from single-token country detection so a
// stopword can never be miscounted as a country mention.
const COUNTRY_NOISE = new Set([
  'us', 'in', 'is', 'it', 'at', 'be', 'so', 'or', 'no', 'of', 'do', 'am', 'by',
  'as', 'an', 'on', 'to', 'we', 'the', 'and', 'a', 'i', 'me', 'my', 'id', 'im',
]);

// Count DISTINCT country/region mentions in a question, reusing the countries.ts
// resolver but guarding against its short-code noise: single tokens must be an
// explicit 3-letter ISO3 (all-caps in the original) or be at least 4 letters and
// not a stopword; 2–3 word spans are resolved greedily so "United States" counts
// once (never also as "states"). Exported for the heuristic's unit table.
export function countCountryMentions(question: string): number {
  const words = String(question ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ''))
    .filter(Boolean);
  const codes = new Set<string>();
  let i = 0;
  while (i < words.length) {
    let advanced = false;
    for (let n = Math.min(3, words.length - i); n >= 1; n--) {
      const span = words.slice(i, i + n);
      if (n === 1) {
        const w = span[0];
        const isExplicitIso3 = /^[A-Z]{3}$/.test(w); // e.g. "USA", "CHN", "GBR"
        if (!isExplicitIso3 && w.length < 4) continue;
        if (COUNTRY_NOISE.has(w.toLowerCase())) continue;
      }
      const r = resolveCountry(span.join(' '));
      // Single-token FUZZY matches are the heuristic's noise source (a common
      // word fuzzily hitting a country name/prefix), so reject them here — a
      // real country mention resolves via exact code, ISO2, exact name, or a
      // curated alias, all of which are kept. Multi-word spans may still fuzzy.
      if (r && !(n === 1 && r.matched === 'fuzzy')) {
        codes.add(r.code);
        i += n;
        advanced = true;
        break;
      }
    }
    if (!advanced) i += 1;
  }
  return codes.size;
}

// Distinct indicator-ish nouns in a question — a rough proxy for "how many data
// series this touches". A curated, lowercase-substring list (order-independent),
// intentionally small: it only needs to tell "one series" from "several".
const SERIES_NOUNS = [
  'gdp', 'inflation', 'population', 'mortality', 'life expectancy', 'unemployment',
  'poverty', 'inequality', 'emission', 'co2', 'carbon', 'literacy', 'fertility',
  'income', 'temperature', 'debt', 'trade', 'export', 'import', 'energy',
  'electricity', 'hiv', 'tuberculosis', 'malaria', 'vaccination', 'immunization',
  'immunisation', 'birth rate', 'death rate', 'gni', 'per capita', 'wage',
  'productivity', 'urbanization', 'urbanisation', 'internet', 'renewable',
  'gdp per capita',
];

function countSeriesNouns(q: string): number {
  let n = 0;
  for (const noun of SERIES_NOUNS) if (q.includes(noun)) n++;
  return n;
}

export function needsPlan(question: string, activeSourceCount: number = 1): boolean {
  const q = String(question ?? '').toLowerCase();
  if (!q.trim()) return false;

  // 0. Explicit user intent always wins (over-rides the conservative default).
  if (/\b(plan first|show (?:me )?your plan|make a plan|plan it out|lay out (?:a|your) plan)\b/.test(q)) {
    return true;
  }

  const countries = countCountryMentions(question);
  const seriesNouns = countSeriesNouns(q);

  // 1. Multi-entity comparison: an explicit comparative frame over ≥2 entities.
  const comparative =
    /\b(compare|comparison|compared to|versus|vs\.?|relative to|difference between|which countr(?:y|ies)|rank(?:ing)?|top \d+|side by side|against each other|better than|worse than)\b/.test(q);
  if (comparative && (countries >= 2 || seriesNouns >= 2)) return true;
  // Many named countries almost always means a cross-entity, multi-step answer.
  if (countries >= 3) return true;

  // 1b. A ranking frame ("rank / top N / which countries / highest") over a
  //     data series is inherently multi-entity (fetch many, then order them).
  const ranking =
    /\b(rank|ranking|top \d+|bottom \d+|which countr(?:y|ies)|highest|lowest|fastest|slowest)\b/.test(q);
  if (ranking && seriesNouns >= 1) return true;

  // 2. Trend / causality shapes with more than one thing in play.
  const causal =
    /\b(why|how has|how have|how did|what caused|what drove|driven by|because of|relationship between|linked to|tied to|impact of|effect of|contribut(?:e|ion) to)\b/.test(q) ||
    /\bsince \d{4}\b/.test(q) ||
    /correlat/.test(q);
  if (causal && (seriesNouns >= 2 || countries >= 2)) return true;

  // 3. Work that plainly spans more than one active source.
  if (activeSourceCount > 1 && (countries >= 2 || seriesNouns >= 2 || comparative)) return true;

  // 4. Length / conjunction complexity: a long prompt strung together with
  //    several conjunctions is doing more than one thing.
  const conjunctions = (q.match(/\b(and|then|also|as well as|along with|plus|followed by)\b/g) || []).length;
  const wordCount = q.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 26 && conjunctions >= 2) return true;

  return false;
}

// ── Plan brief parsing + step check-off (pure, exported for tests) ─────────
// ── Plan brief parsing + step check-off (pure, exported for tests) ─────────
// Map a tool name (or a step's tool_hint) to its coarse family, so a step
// checks off against any member of that family (a fetch step matches the
// router or any legacy per-source fetch; a compute step matches growth_stats /
// correlate / execute_js). Unknown tools pass through unchanged.
function canonicalToolFamily(tool: string): string {
  const t = String(tool ?? '').trim();
  if (t === 'fetch_series' || t === 'fetch_worldbank' || t === 'fetch_worldbank_all' || t === 'fetch_owid' || t === 'fetch_imf') {
    return 'fetch_series';
  }
  if (t === 'execute_js' || t === 'growth_stats' || t === 'correlate') return 'execute_js';
  return t;
}

// Significant keyword tokens (lowercase, ≥3 chars, not a stopword) for overlap
// matching. Splits on non-alphanumerics so "NY.GDP.MKTP.CD" → gdp, mktp, cd.
const MATCH_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'per', 'via', 'all', 'get', 'its',
  'over', 'each', 'then', 'that', 'this', 'data', 'series', 'chart', 'value',
  'values', 'find', 'fetch', 'call', 'use', 'show', 'year', 'years', 'countries',
  'country', 'compute', 'using', 'their',
]);

function keywordTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(s ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !MATCH_STOP.has(raw)) out.add(raw);
  }
  return out;
}

// Decide whether a trace event is plausibly the execution of a plan step. A
// cheap, deliberately-imperfect progress cue (NOT a contract): a tool_hint that
// matches the event's tool family checks the step off outright; otherwise a
// single shared distinctive keyword between the step text and the event's
// arg/detail is enough. Non-executor events (reasoning / verify / plan / the
// fallback note) never match anything. Pure + exported for the matcher table.
export function matchStepToEvent(
  step: PlanStep,
  ev: { tool?: string; argSummary?: string; detail?: string }
): boolean {
  if (!ev || !ev.tool) return false;
  const tool = ev.tool;
  if (tool === 'reasoning' || tool === 'verify' || tool === 'plan' || tool === 'fallback' || tool === 'llm') {
    return false;
  }
  const evFamily = canonicalToolFamily(tool);
  if (step.tool_hint && canonicalToolFamily(step.tool_hint) === evFamily) return true;
  const stepToks = keywordTokens(step.what);
  if (!stepToks.size) return false;
  const evToks = keywordTokens((ev.argSummary ?? '') + ' ' + (ev.detail ?? ''));
  for (const t of evToks) if (stepToks.has(t)) return true;
  return false;
}

// Parse the planner's raw text into an InsightBrief, DEFENSIVELY (same
// discipline as parseVerifierVerdict): a well-formed brief needs a non-empty
// `insight` string AND at least one step with a non-empty `what`. Anything
// missing those → null, meaning "no plan"; the run then proceeds exactly as it
// would today. Never throws, never fabricates a step, never invents an insight.
export function parsePlanBrief(raw: string): InsightBrief | null {
  const obj = extractJsonObject(String(raw ?? ''));
  if (!obj) return null;
  const insight = typeof obj.insight === 'string' ? obj.insight.trim() : '';
  if (!insight) return null;
  const rawSteps = Array.isArray(obj.steps) ? obj.steps : [];
  const steps: PlanStep[] = [];
  for (const s of rawSteps) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
    const what = typeof (s as Record<string, unknown>).what === 'string'
      ? String((s as Record<string, unknown>).what).trim()
      : '';
    if (!what) continue;
    const hint = (s as Record<string, unknown>).tool_hint;
    const step: PlanStep = { what };
    if (hint === 'find_series' || hint === 'fetch_series' || hint === 'execute_js' || hint === 'delegate_source') {
      step.tool_hint = hint;
    }
    steps.push(step);
    if (steps.length >= 8) break; // cap the card; a plan longer than this is noise
  }
  if (!steps.length) return null;
  const brief: InsightBrief = { insight, steps };
  if (typeof obj.chart_intent === 'string' && obj.chart_intent.trim()) {
    brief.chart_intent = obj.chart_intent.trim();
  }
  if (Array.isArray(obj.sources_expected)) {
    const src = (obj.sources_expected as unknown[])
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim());
    if (src.length) brief.sources_expected = src;
  }
  return brief;
}
