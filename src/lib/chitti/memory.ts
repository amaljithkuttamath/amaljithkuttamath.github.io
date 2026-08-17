// memory.ts — Chitti's persistent memory layer: what it answered before, kept
// locally across sessions, and gated so it can never become an answer by itself.
//
// The whole design in one sentence: **a memory note is a receipt for a past
// answer, never a source of data.** Nothing here may be charted, cited, or
// entered in the evidence table. If a recalled number bears on the question, the
// agent re-fetches it and says what changed — that comparison is the only thing
// memory is for.
//
// This is deliberately NOT the context-variables story
// (docs/superpowers/specs/2026-07-27-chitti-context-variables-design.md), which
// keeps bindings session-scoped precisely so stale rows can't be dereferenced
// under a name that still looks fresh. A variable resolves to rows; a note
// cannot be resolved to anything. That is why one persists and the other does
// not.
//
// Three gates decide what a recall is allowed to say, after the pattern in
// "Designing a Persistent Knowledge Layer That Refuses to Guess": coverage
// (does the note's scope reach the question?), temporal (is it still fresh?),
// and contradiction (do two sources of equal authority disagree?). A
// cross-source disagreement is reported with BOTH sides and no winner, because
// recency cannot arbitrate between two different definitions of the same name.
//
// Pure and offline-testable: no DOM, no network, no module state. Persistence
// is a thin wrapper over an injected `StorageLike`, exactly as dashboard.ts
// does it, so tests pass a Map-backed fake.
import type { Citation, DataRow } from './tools';
import type { VerificationVerdict } from './verifier';
import { scoreSeries } from './scoring';
import type { StorageLike, SaveResult } from './dashboard';

// Bumped whenever the note shape changes incompatibly. parseNote gates on it:
// an unknown version yields null — a note we refuse to guess at.
export const MEMORY_VERSION = 1 as const;

// localStorage key namespace. One note per key: `chitti:mem:<id>`.
export const MEMORY_NS = 'chitti:mem:';

// The enable flag lives OUTSIDE the note namespace on purpose — a key under
// MEMORY_NS would be picked up by the prefix scan and parsed as a broken note.
export const MEMORY_ENABLED_KEY = 'chitti:memory:enabled';

// How many notes the browser keeps. Past this the oldest is evicted: memory is
// a working record, not an archive, and localStorage is a few MB per origin.
export const MEMORY_MAX_NOTES = 200;

// Facts held per note. They are a SAMPLE (endpoints per series×country), never
// the full series — a note's coverage claim is its citations' yearRange and
// rowCount, not this array.
export const MEMORY_MAX_FACTS = 40;

// Soft byte cap per note. Over it, facts are shed before anything else: the
// question, finding and citations are what make a note worth keeping.
export const MEMORY_NOTE_SOFT_CAP_BYTES = 24_000;

// Past this age a note is stamped STALE and the block tells the agent to
// re-fetch before using it. Institutional series revise on roughly this cadence.
export const MEMORY_STALE_DAYS = 30;

// At most this many notes reach the prompt, best-scoring first. Memory that
// costs more context than it saves is not worth having.
export const MEMORY_RECALL_LIMIT = 3;

// Minimum relevance for a note to be recalled at all, on scoreSeries's scale
// (a base term is 2, a synonym 1, an exact phrase 10). Four means two real
// topic terms landed, or a phrase reached through the synonym table — the same
// figure fastpath.ts calibrated for MIN_MATCH_SCORE against the same scorer.
//
// It sits where junk scores zero, which is the property that matters: "co2
// emissions in Brazil" shares nothing with a life-expectancy note, and a bare
// country name ("population of India") is 2, not enough on its own. What DOES
// get through at 4 is an adjacent note — the same indicator for another
// country. That is deliberate, and it is why the block prints each note's exact
// scope: a note whose scope line reads IND cannot be mistaken for an answer
// about China.
//
// Higher was tried first and is the wrong instinct here. Unlike the fast path,
// where a marginal hit produces a wrong ANSWER, a marginal recall produces a
// dated, scoped note the agent is told to re-fetch anyway. Tuned to 6, the
// layer barely fired at all — an inert memory is the worse failure.
export const MIN_RECALL_SCORE = 4;

// Two measurements of the same thing count as disagreeing past this relative
// gap. Absorbs float/rounding noise between a JSON number and a CSV parse
// without absorbing a real revision.
const VALUE_EPSILON = 0.005;

// ── Types ────────────────────────────────────────────────────────────────────

// One atomic remembered measurement. (series, country, year) → value is already
// Chitti's atom — it is a DataRow — which is what makes disagreement between
// two notes mechanically checkable instead of a comparison of prose.
export interface MemoryFact {
  nid: string; // normalized series id — the same "nid" a Citation carries
  iso3: string;
  year: number;
  value: number;
  source: Citation['source'];
}

export interface MemoryNote {
  v: typeof MEMORY_VERSION;
  id: string;
  question: string;
  finding: string;
  facts: MemoryFact[];
  // True when the cap meant some series×country pair got no fact at all. Never
  // let a capped note read as a complete record.
  factsTruncated: boolean;
  citations: Citation[];
  // From the turn's VerificationVerdict: true only on 'verified'. null when
  // verification did not run (an explanation turn). Never invented.
  verified: boolean | null;
  createdAt: string; // when CHITTI recorded the note
  // The DATA's own currency: the newest `sourceUpdated` across the citations,
  // or '' when no source reported one. Distinct from createdAt — a note taken
  // today can hold data whose vintage is two years old.
  asOf: string;
}

export type RecallCode =
  | 'MEM_HIT'
  | 'MEM_STALE'
  | 'MEM_OUT_OF_SCOPE'
  | 'MEM_CONFLICT'
  | 'MEM_MISS';

export interface RecalledNote {
  note: MemoryNote;
  code: 'MEM_HIT' | 'MEM_STALE';
  score: number;
  ageDays: number;
}

// Two sources of equal authority disagree about the same measurement. Neither
// supersedes the other, so both sides are carried and no winner is recorded
// anywhere in this shape — there is deliberately no `resolved` field to set.
export interface MemoryConflict {
  nid: string;
  iso3: string;
  year: number;
  sides: {
    value: number;
    source: string;
    sourceLabel: string;
    recordedAt: string;
    noteId: string;
  }[];
}

// The SAME source now says something different than it did. That is an upstream
// restatement, not a contradiction: the newer reading is in force and the older
// is recorded as superseded.
export interface MemoryRevision {
  nid: string;
  iso3: string;
  year: number;
  source: string;
  sourceLabel: string;
  older: { value: number; recordedAt: string };
  newer: { value: number; recordedAt: string };
}

export interface RecallResult {
  notes: RecalledNote[];
  conflicts: MemoryConflict[];
  revisions: MemoryRevision[];
  // Notes that scored well but whose scope does not reach the question. Kept
  // separately so the UI can say "I have something adjacent, and it does not
  // answer this" rather than silently showing nothing.
  dropped: { note: MemoryNote; code: 'MEM_OUT_OF_SCOPE'; reason: string }[];
  // The headline for the UI. Conflict outranks everything.
  code: RecallCode;
}

// ── Whitelist cleaning (the security boundary) ───────────────────────────────
// Each rebuilds an object from named fields only, exactly as dashboard.ts and
// share.ts do. Anything not named — an apiKey, a __proto__ key, an internal
// handle — is structurally incapable of surviving the copy. Do not replace with
// a blacklist/delete approach.

const CITE_SOURCES = new Set(['worldbank', 'owid', 'imf', 'who']);

function str(x: unknown): string {
  return typeof x === 'string' ? x : x == null ? '' : String(x);
}

function num(x: unknown): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function cleanCitation(c: unknown): Citation | null {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  const source = CITE_SOURCES.has(o.source as string)
    ? (o.source as Citation['source'])
    : null;
  if (!source) return null; // a citation with no recognized source is not one
  const yr = o.yearRange && typeof o.yearRange === 'object' ? (o.yearRange as Record<string, unknown>) : null;
  const out: Citation = {
    id: str(o.id),
    source,
    sourceLabel: str(o.sourceLabel),
    indicatorId: str(o.indicatorId),
    indicatorName: str(o.indicatorName),
    url: str(o.url),
    countries: Array.isArray(o.countries) ? o.countries.map(str) : [],
    yearRange: yr
      ? {
          ...(yr.start == null ? {} : { start: num(yr.start) }),
          ...(yr.end == null ? {} : { end: num(yr.end) }),
        }
      : null,
    fetchedAt: str(o.fetchedAt),
    rowCount: num(o.rowCount),
    cached: o.cached === true,
  };
  if (o.requestUrl != null) out.requestUrl = str(o.requestUrl);
  if (o.sourceUpdated != null) out.sourceUpdated = str(o.sourceUpdated);
  // A snapshot says so — mirroredAt must survive every round trip, or a stored
  // note would re-render a dated capture as a live fetch.
  if (o.mirroredAt != null) out.mirroredAt = str(o.mirroredAt);
  return out;
}

function cleanFact(f: unknown): MemoryFact | null {
  const o = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
  const source = CITE_SOURCES.has(o.source as string)
    ? (o.source as Citation['source'])
    : null;
  const nid = str(o.nid).trim().toLowerCase();
  const year = Number(o.year);
  const value = Number(o.value);
  // A fact with no source, no series, no year or no number is not a fact. It is
  // dropped rather than defaulted — a zeroed measurement would be a lie.
  if (!source || !nid || !Number.isFinite(year) || !Number.isFinite(value)) return null;
  return { nid, iso3: str(o.iso3).trim().toUpperCase(), year, value, source };
}

export function cleanNote(input: unknown): MemoryNote | null {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return null;
  const facts = (Array.isArray(o.facts) ? o.facts : [])
    .map(cleanFact)
    .filter((f): f is MemoryFact => f !== null);
  const citations = (Array.isArray(o.citations) ? o.citations : [])
    .map(cleanCitation)
    .filter((c): c is Citation => c !== null);
  return {
    v: MEMORY_VERSION,
    id,
    question: str(o.question),
    finding: str(o.finding),
    facts,
    factsTruncated: o.factsTruncated === true,
    citations,
    verified: o.verified === true ? true : o.verified === false ? false : null,
    createdAt: str(o.createdAt),
    asOf: str(o.asOf),
  };
}

export function serializeNote(note: MemoryNote): string {
  return JSON.stringify(cleanNote(note));
}

// Parse one stored note. Malformed input or an unknown version yields null —
// never a throw, never a half-built object.
export function parseNote(raw: string): MemoryNote | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if ((parsed as Record<string, unknown>).v !== MEMORY_VERSION) return null;
  return cleanNote(parsed);
}

export function noteBytes(note: MemoryNote): number {
  return new TextEncoder().encode(serializeNote(note)).length;
}

// ── Building a note from a finished turn ─────────────────────────────────────

// Map each fetched series id to the citation that vouches for it. A fact whose
// series has no citation is not remembered at all: memory holds only what the
// evidence ledger already stands behind.
function sourceIndex(citations: Citation[]): Map<string, Citation> {
  const idx = new Map<string, Citation>();
  for (const c of citations) {
    const nid = String(c.indicatorId ?? '').trim().toLowerCase();
    if (nid && !idx.has(nid)) idx.set(nid, c);
  }
  return idx;
}

// Endpoint facts: the first and last reported year for each series×country.
// Endpoints are what a finding's claims actually rest on ("rose from X to Y"),
// and they bound the note's coverage for the scope gate. Interior years are not
// kept — the citation's yearRange and rowCount are the coverage claim, not this.
export function factsFromRows(
  rows: DataRow[],
  citations: Citation[],
  limit: number = MEMORY_MAX_FACTS
): { facts: MemoryFact[]; truncated: boolean } {
  const idx = sourceIndex(citations);
  // Group by series×country, tracking only the extremes as we go.
  const groups = new Map<string, { nid: string; iso3: string; lo: DataRow; hi: DataRow }>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const value = Number(r.value);
    const year = Number(r.year);
    // A null value is a reporting gap, not a measurement — it can never be a
    // fact, and charting one as zero is the exact failure this app avoids.
    if (r.value == null || !Number.isFinite(value) || !Number.isFinite(year)) continue;
    const nid = String(r.indicator ?? '').trim().toLowerCase();
    if (!nid || !idx.has(nid)) continue; // no receipt, no memory
    const iso3 = String(r.iso3 ?? '').trim().toUpperCase();
    const key = nid + '|' + iso3;
    const g = groups.get(key);
    if (!g) groups.set(key, { nid, iso3, lo: r, hi: r });
    else {
      if (year < Number(g.lo.year)) g.lo = r;
      if (year > Number(g.hi.year)) g.hi = r;
    }
  }

  const facts: MemoryFact[] = [];
  let truncated = false;
  for (const g of groups.values()) {
    const source = idx.get(g.nid)!.source;
    const ends = g.lo === g.hi ? [g.lo] : [g.lo, g.hi];
    // Never split a pair: a lone endpoint would read as the whole series.
    if (facts.length + ends.length > limit) {
      truncated = true;
      continue;
    }
    for (const r of ends)
      facts.push({
        nid: g.nid,
        iso3: g.iso3,
        year: Number(r.year),
        value: Number(r.value),
        source,
      });
  }
  return { facts, truncated };
}

export interface BuildNoteInput {
  id: string;
  question: string;
  finding: string;
  rows: DataRow[];
  citations: Citation[];
  verification: VerificationVerdict | null;
  // ISO timestamp, passed in rather than read from the clock here, so the
  // output is deterministic and unit-testable.
  createdAt: string;
}

// The newest source vintage across the citations — the data's own currency.
// '' when no source reported one; never invented.
function latestSourceUpdated(citations: Citation[]): string {
  let best = '';
  for (const c of citations) {
    const s = String(c.sourceUpdated ?? '');
    if (s && s > best) best = s;
  }
  return best;
}

// Build the note for one completed turn, or null when the turn produced nothing
// worth remembering.
//
// The rule that carries the whole provenance story: **a note is written only
// when the turn produced citations.** An explanation turn writes nothing. So
// facts can only come from rows the evidence ledger already vouches for, and a
// model-invented number is structurally incapable of becoming one — there is no
// `derived` flag here to forget, because derived content never gets in.
export function buildNote(input: BuildNoteInput): MemoryNote | null {
  const citations = (Array.isArray(input.citations) ? input.citations : [])
    .map(cleanCitation)
    .filter((c): c is Citation => c !== null);
  if (!citations.length) return null;
  const question = String(input.question ?? '').trim();
  if (!question) return null;

  const { facts, truncated } = factsFromRows(input.rows ?? [], citations);
  const status = input.verification?.status;
  const note: MemoryNote = {
    v: MEMORY_VERSION,
    id: input.id,
    question,
    finding: String(input.finding ?? '').trim(),
    facts,
    factsTruncated: truncated,
    citations,
    verified: status === 'verified' ? true : status === 'unverified' ? false : null,
    createdAt: input.createdAt,
    asOf: latestSourceUpdated(citations),
  };

  // Shed facts before anything else if the note is over the soft cap: the
  // question, finding and citations are what make it worth keeping.
  if (noteBytes(note) > MEMORY_NOTE_SOFT_CAP_BYTES) {
    const half = factsFromRows(input.rows ?? [], citations, Math.floor(MEMORY_MAX_FACTS / 4));
    note.facts = half.facts;
    note.factsTruncated = true;
    if (noteBytes(note) > MEMORY_NOTE_SOFT_CAP_BYTES) note.facts = [];
  }
  return note;
}

// ── Recall + the three gates ─────────────────────────────────────────────────

function daysBetween(fromIso: string, now: Date): number {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY; // undatable = stale
  return (now.getTime() - t) / 86_400_000;
}

// The haystack one note presents to the scorer: its own question plus the names
// and ids of the series behind it, so "child mortality" can reach a note whose
// question said "under-5 deaths".
function noteHaystack(note: MemoryNote): { id: string; name: string } {
  const ids = note.citations.map((c) => c.indicatorId).filter(Boolean).join(' ');
  const names = note.citations.map((c) => c.indicatorName).filter(Boolean).join(' ');
  return { id: ids, name: note.question + ' ' + names };
}

// Every 4-digit year named in the question. The coverage gate's only mechanical
// input — deliberately simple, because a wrong parse here would drop a good
// note, and dropping is the safe direction.
export function questionYears(question: string): number[] {
  const out: number[] = [];
  for (const m of String(question ?? '').matchAll(/\b(?:19|20)\d{2}\b/g)) out.push(Number(m[0]));
  return out;
}

function factYearRange(note: MemoryNote): { lo: number; hi: number } | null {
  if (!note.facts.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const f of note.facts) {
    if (f.year < lo) lo = f.year;
    if (f.year > hi) hi = f.year;
  }
  return { lo, hi };
}

function differs(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) > Math.max(1e-9, VALUE_EPSILON * scale);
}

interface Claim {
  value: number;
  source: string;
  sourceLabel: string;
  recordedAt: string;
  noteId: string;
}

function sourceLabelOf(note: MemoryNote, source: string): string {
  return note.citations.find((c) => c.source === source)?.sourceLabel ?? source;
}

// Compare the facts the recalled notes hold, and classify every disagreement.
//
// Same measurement, DIFFERENT sources → a contradiction. Both sides are
// returned and neither is chosen: World Bank and WHO life expectancy are
// different definitions wearing the same name, and being more recent does not
// make one of them right.
//
// Same measurement, SAME source → a revision. The source restated itself; the
// newer reading is in force and the older is recorded as superseded.
export function compareFacts(notes: MemoryNote[]): {
  conflicts: MemoryConflict[];
  revisions: MemoryRevision[];
} {
  const groups = new Map<string, Claim[]>();
  for (const note of notes) {
    for (const f of note.facts) {
      const key = `${f.nid}|${f.iso3}|${f.year}`;
      const claim: Claim = {
        value: f.value,
        source: f.source,
        sourceLabel: sourceLabelOf(note, f.source),
        recordedAt: note.createdAt,
        noteId: note.id,
      };
      const arr = groups.get(key);
      if (arr) arr.push(claim);
      else groups.set(key, [claim]);
    }
  }

  const conflicts: MemoryConflict[] = [];
  const revisions: MemoryRevision[] = [];
  for (const [key, claims] of groups) {
    if (claims.length < 2) continue;
    const [nid, iso3, yearStr] = key.split('|');
    const year = Number(yearStr);

    // Each source's current claim = its newest recording.
    const bySource = new Map<string, Claim[]>();
    for (const c of claims) {
      const arr = bySource.get(c.source);
      if (arr) arr.push(c);
      else bySource.set(c.source, [c]);
    }
    const current: Claim[] = [];
    for (const arr of bySource.values()) {
      const sorted = [...arr].sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1));
      current.push(sorted[0]);
    }

    const crossSource =
      current.length > 1 && current.some((c) => differs(c.value, current[0].value));
    if (crossSource) {
      conflicts.push({ nid, iso3, year, sides: current });
      continue; // a contradiction outranks any revision inside it
    }

    for (const [source, arr] of bySource) {
      if (arr.length < 2) continue;
      const sorted = [...arr].sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : 1));
      const oldest = sorted[0];
      const newest = sorted[sorted.length - 1];
      if (!differs(oldest.value, newest.value)) continue;
      revisions.push({
        nid,
        iso3,
        year,
        source,
        sourceLabel: newest.sourceLabel,
        older: { value: oldest.value, recordedAt: oldest.recordedAt },
        newer: { value: newest.value, recordedAt: newest.recordedAt },
      });
    }
  }
  return { conflicts, revisions };
}

// Find what memory holds about this question, and gate it.
//
// Pure: the same (notes, question, now) always yields the same result.
export function recall(notes: MemoryNote[], question: string, now: Date): RecallResult {
  const q = String(question ?? '').trim();
  const empty: RecallResult = {
    notes: [],
    conflicts: [],
    revisions: [],
    dropped: [],
    code: 'MEM_MISS',
  };
  if (!q || !Array.isArray(notes) || !notes.length) return empty;

  const years = questionYears(q);
  const scored: RecalledNote[] = [];
  const dropped: RecallResult['dropped'] = [];

  for (const note of notes) {
    if (!note) continue;
    const hay = noteHaystack(note);
    const score = scoreSeries(q, hay.id, hay.name);
    if (score < MIN_RECALL_SCORE) continue;

    // ── Coverage gate ──────────────────────────────────────────────────────
    // A note about 2000–2023 says nothing about 2025. When the question names
    // years and NONE of them fall inside what the note actually measured, the
    // note is out of scope — it is not a weaker answer, it is no answer.
    const range = factYearRange(note);
    if (years.length && range && !years.some((y) => y >= range.lo && y <= range.hi)) {
      dropped.push({
        note,
        code: 'MEM_OUT_OF_SCOPE',
        reason: `recorded ${range.lo}–${range.hi}; the question asks about ${years.join(', ')}`,
      });
      continue;
    }

    // ── Temporal gate ──────────────────────────────────────────────────────
    const ageDays = daysBetween(note.createdAt, now);
    scored.push({
      note,
      code: ageDays > MEMORY_STALE_DAYS ? 'MEM_STALE' : 'MEM_HIT',
      score,
      ageDays,
    });
  }

  scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.note.createdAt < b.note.createdAt ? 1 : -1
  );
  const kept = scored.slice(0, MEMORY_RECALL_LIMIT);

  // ── Contradiction gate ───────────────────────────────────────────────────
  const { conflicts, revisions } = compareFacts(kept.map((r) => r.note));

  const code: RecallCode = conflicts.length
    ? 'MEM_CONFLICT'
    : kept.length
      ? kept.every((r) => r.code === 'MEM_STALE')
        ? 'MEM_STALE'
        : 'MEM_HIT'
      : dropped.length
        ? 'MEM_OUT_OF_SCOPE'
        : 'MEM_MISS';

  return { notes: kept, conflicts, revisions, dropped, code };
}

// ── The block that reaches the model ─────────────────────────────────────────

function isoDate(s: string): string {
  return String(s ?? '').slice(0, 10);
}

function scopeLine(note: MemoryNote): string {
  const parts: string[] = [];
  for (const c of note.citations.slice(0, 3)) {
    const countries = c.countries.length ? c.countries.join(', ') : 'all countries';
    const yr =
      c.yearRange && (c.yearRange.start != null || c.yearRange.end != null)
        ? `${c.yearRange.start ?? '…'}–${c.yearRange.end ?? '…'}`
        : 'all years';
    const vintage = c.sourceUpdated ? `, source updated ${isoDate(c.sourceUpdated)}` : '';
    const snapshot = c.mirroredAt ? `, snapshot ${isoDate(c.mirroredAt)}` : '';
    parts.push(`${c.indicatorId} · ${countries} · ${yr} (${c.sourceLabel}${vintage}${snapshot})`);
  }
  if (note.citations.length > 3) parts.push(`+${note.citations.length - 3} more series`);
  return parts.join('; ');
}

// A couple of the note's own endpoint numbers, so the agent can see whether
// anything moved once it re-fetches. Explicitly labelled "recorded", never
// "is" — this is the difference between a receipt and a measurement.
function recordedSample(note: MemoryNote): string {
  if (!note.facts.length) return '';
  const shown = note.facts.slice(0, 4).map((f) => `${f.iso3} ${f.year}: ${f.value}`);
  const more = note.facts.length > shown.length ? `, +${note.facts.length - shown.length} more` : '';
  const partial = note.factsTruncated ? ' (partial record)' : '';
  return `Recorded ${shown.join('; ')}${more}${partial}.`;
}

// Render the recall for the system message, or null when there is nothing to
// say. Returning null on a miss is load-bearing: an empty or irrelevant memory
// must cost zero prompt tokens, or the layer taxes every question to help a few.
export function buildRecallBlock(result: RecallResult): string | null {
  if (!result || (!result.notes.length && !result.conflicts.length)) return null;

  const lines: string[] = [
    'MEMORY — findings you recorded earlier in this browser. NOT evidence.',
    'A recorded number is a note about a past answer, never a fetched value: you may not chart it,',
    'cite it, or enter it in the evidence table. If it bears on this question, RE-FETCH and compare —',
    'saying what changed is the only thing memory is for. Answer from the fetch, every time.',
    '',
  ];

  for (const r of result.notes) {
    const stamp =
      r.code === 'MEM_STALE'
        ? `${isoDate(r.note.createdAt)} · STALE, ${Math.round(r.ageDays)} days old — re-fetch before using`
        : isoDate(r.note.createdAt);
    const verdict =
      r.note.verified === true ? ', verified' : r.note.verified === false ? ', NOT verified' : '';
    lines.push(`- [${stamp}] "${r.note.question}"${verdict}`);
    const scope = scopeLine(r.note);
    if (scope) lines.push(`  Scope: ${scope}`);
    const sample = recordedSample(r.note);
    if (sample) lines.push(`  ${sample}`);
  }

  if (result.revisions.length) {
    lines.push('', 'REVISED SINCE YOU RECORDED IT (the source restated itself; newer is in force):');
    for (const rev of result.revisions.slice(0, 5)) {
      lines.push(
        `- ${rev.nid} ${rev.iso3} ${rev.year}: ${rev.older.value} recorded ${isoDate(rev.older.recordedAt)}, ` +
          `now ${rev.newer.value} recorded ${isoDate(rev.newer.recordedAt)} (${rev.sourceLabel}).`
      );
    }
  }

  for (const c of result.conflicts.slice(0, 5)) {
    const sides = c.sides
      .map((s) => `${s.sourceLabel} recorded ${s.value} on ${isoDate(s.recordedAt)}`)
      .join('; ');
    lines.push(
      '',
      `UNRESOLVED CONFLICT (MEM_CONFLICT) — ${c.nid}, ${c.iso3}, ${c.year}:`,
      `  ${sides}.`,
      '  Neither supersedes the other — they are different definitions of the same name, and being',
      '  more recent does not make one right. Report BOTH and name BOTH sources. Do NOT pick one,',
      '  do not average them, and do not present either as the answer.'
    );
  }

  // `result.dropped` is deliberately NOT rendered here. The block exists to
  // change what the agent does, and an out-of-scope note changes nothing: the
  // agent never had it, and it was going to fetch either way. Telling it about
  // a note it cannot use is pure context cost. The drop belongs to the UI, so
  // the USER can see "I have something adjacent and it does not answer this"
  // rather than assuming Chitti forgot.
  return lines.join('\n');
}

// ── Storage ──────────────────────────────────────────────────────────────────
// Thin persistence over an injected StorageLike (real localStorage in the app,
// a Map-backed fake in tests) — the same wrapper shape dashboard.ts uses. Every
// write is try/caught so a quota failure surfaces as a result, never a throw;
// reads skip a malformed entry rather than failing the whole list.

function noteKey(id: string): string {
  return MEMORY_NS + id;
}

function namespacedKeys(store: StorageLike): string[] {
  const out: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(MEMORY_NS)) out.push(k);
  }
  return out;
}

// Every stored note, parsed, malformed entries skipped, newest first.
export function listNotes(store: StorageLike): MemoryNote[] {
  const out: MemoryNote[] = [];
  let keys: string[];
  try {
    keys = namespacedKeys(store);
  } catch {
    return [];
  }
  for (const k of keys) {
    try {
      const raw = store.getItem(k);
      const note = raw ? parseNote(raw) : null;
      if (note) out.push(note);
    } catch {
      /* skip a single unreadable entry */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export function saveNote(store: StorageLike, note: MemoryNote): SaveResult {
  try {
    // Evict oldest-first down to the cap before adding. Memory is a working
    // record, not an archive.
    const existing = listNotes(store); // newest first
    if (!existing.some((n) => n.id === note.id)) {
      while (existing.length >= MEMORY_MAX_NOTES) {
        const oldest = existing.pop();
        if (!oldest) break;
        store.removeItem(noteKey(oldest.id));
      }
    }
    store.setItem(noteKey(note.id), serializeNote(note));
    return { ok: true };
  } catch (err: any) {
    const quota =
      err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
    return {
      ok: false,
      error: quota
        ? 'Out of browser storage — clear Chitti’s memory in the config panel and try again.'
        : 'Could not record this finding: ' + (err?.message ?? String(err)),
    };
  }
}

export function deleteNote(store: StorageLike, id: string): void {
  try {
    store.removeItem(noteKey(id));
  } catch {
    /* deleting a missing/locked key is not an error worth surfacing */
  }
}

// Forget everything. The user's escape hatch, and the reason recording locally
// is defensible at all.
export function clearMemory(store: StorageLike): number {
  let n = 0;
  try {
    for (const k of namespacedKeys(store)) {
      store.removeItem(k);
      n++;
    }
  } catch {
    /* partial clear is still a clear; report what was removed */
  }
  return n;
}

// On by default: a memory the user has to find and switch on records nothing
// for the session where it would first have helped. Off is one click away, and
// nothing here ever leaves the browser.
export function memoryEnabled(store: StorageLike): boolean {
  try {
    return store.getItem(MEMORY_ENABLED_KEY) !== '0';
  } catch {
    return false; // a store we cannot read is a store we must not write
  }
}

export function setMemoryEnabled(store: StorageLike, on: boolean): void {
  try {
    store.setItem(MEMORY_ENABLED_KEY, on ? '1' : '0');
  } catch {
    /* a privacy mode that refuses writes simply keeps memory off */
  }
}

export type RememberResult =
  | { ok: true; note: MemoryNote }
  | { ok: false; reason: 'disabled' | 'nothing-to-record' | 'storage'; error?: string };

// Record one finished turn. Called from the composer's `finally`, so it must
// never throw and never care whether the turn succeeded.
export function rememberTurn(
  store: StorageLike | null,
  input: Omit<BuildNoteInput, 'id'> & { id?: string }
): RememberResult {
  if (!store) return { ok: false, reason: 'disabled' };
  if (!memoryEnabled(store)) return { ok: false, reason: 'disabled' };
  const id =
    input.id ??
    (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `mem_${crypto.randomUUID()}`
      : `mem_${Date.now().toString(36)}`);
  const note = buildNote({ ...input, id });
  // No citations means nothing was fetched, so there is nothing memory is
  // allowed to hold. An explanation turn records silently nothing.
  if (!note) return { ok: false, reason: 'nothing-to-record' };
  const saved = saveNote(store, note);
  if (!saved.ok) return { ok: false, reason: 'storage', error: saved.error };
  return { ok: true, note };
}

// What does memory have to say about this question? Null when memory is off or
// unreachable — distinct from a RecallResult whose code is MEM_MISS, which
// means memory looked and found nothing.
//
// The app calls this ONCE per turn and feeds the result to both consumers: the
// prompt (via buildRecallBlock) and the UI card. They must never disagree about
// what was recalled, and computing it twice is how that drift starts.
export function recallFor(
  store: StorageLike | null,
  question: string,
  now: Date
): RecallResult | null {
  if (!store || !memoryEnabled(store)) return null;
  return recall(listNotes(store), question, now);
}

export function recallBlockFor(
  store: StorageLike | null,
  question: string,
  now: Date
): string | null {
  const r = recallFor(store, question, now);
  return r ? buildRecallBlock(r) : null;
}
