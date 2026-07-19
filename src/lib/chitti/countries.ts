// countries.ts — a pure, browser-only fuzzy country/region resolver.
//
// Users and the model name countries loosely: "US", "USA", "America", "UK",
// "Holland", "Korea", or region-ish terms ("Sub-Saharan Africa", "EU", "euro
// area"). The fetch tools, however, speak the World Bank API's ISO3 codes
// (plus its aggregate codes like WLD, EUU, SSF). resolveCountry() bridges the
// two: loose text in, a canonical {code, name} out, or null when it cannot be
// resolved with confidence.
//
// The canonical base is data/worldbank/countries.json (the same list the tools
// already ship): it carries ISO3 (`id`), ISO2 (`iso2`), and the WB display name
// for every country AND aggregate, so exact code / ISO2 / name matching is all
// derived from that one file — no hand-maintained code or name tables. Only the
// alias table below is curated by hand, and it is kept deliberately compact
// because it ships to the browser.
//
// Resolution layers, tried in order (first hit wins):
//   1. exact ISO3 code   — "USA", "SSF", "WLD"  → itself
//   2. exact ISO2 code   — "US" → USA, "GB" → GBR, "EU" → EUU
//   3. exact name        — "Germany" → DEU, "Niger" → NER, "World" → WLD
//                          (case- and punctuation-insensitive)
//   4. curated alias     — "America"/"the states" → USA, "Britain" → GBR,
//                          "Korea" → KOR, "Holland" → NLD, "euro area" → EMU …
//   5. conservative fuzzy — a whole-word (token) or name-prefix match that is
//                          UNIQUE across the catalog. Ambiguous or absent → null.
//
// Design bias: prefer returning null over guessing wrong. The fuzzy layer only
// fires when exactly one country matches, so "Iran" never bleeds into "Ireland"
// and "Niger" never bleeds into "Nigeria" (both of those resolve to themselves
// at the exact-name layer anyway). Deliberately ambiguous bare inputs are
// disambiguated ONLY by the alias table's explicit, documented choice — e.g.
// bare "Korea" → KOR (South Korea), never PRK; callers wanting the North must
// say "North Korea"/"DPRK".

import countriesData from '../../data/worldbank/countries.json';

interface RawCountry {
  id: string; // ISO3 (or a WB aggregate code)
  iso2: string;
  name: string;
  region: string;
  income: string;
}

export type MatchKind = 'exact' | 'alias' | 'fuzzy';

export interface ResolvedCountry {
  code: string; // canonical ISO3 / WB aggregate code, e.g. "USA", "GBR", "WLD"
  name: string; // canonical WB display name, e.g. "United States"
  matched: MatchKind;
}

const RAW = countriesData as RawCountry[];

// Normalize for case/punctuation-insensitive comparison: lowercase, every run
// of non-alphanumerics collapses to a single space, ends trimmed. Mirrors the
// scorer's normalize() in tools.ts (kept local to avoid a cross-module import
// cycle). "Côte d'Ivoire" and "cote d ivoire" both → "cote d ivoire".
function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics (é → e)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ── Indexes built once at module load ────────────────────────────────────
const byIso3 = new Map<string, RawCountry>();
const byIso2 = new Map<string, RawCountry>();
const byName = new Map<string, RawCountry>();
for (const c of RAW) {
  byIso3.set(c.id.toUpperCase(), c);
  if (c.iso2) byIso2.set(c.iso2.toUpperCase(), c);
  byName.set(normalize(c.name), c);
}

// Canonical (trimmed) display name — some WB aggregate names carry a trailing
// space ("Sub-Saharan Africa ").
function displayName(c: RawCountry): string {
  return c.name.trim();
}

function resolved(c: RawCountry, matched: MatchKind): ResolvedCountry {
  return { code: c.id.toUpperCase(), name: displayName(c), matched };
}

// ── Curated alias table ──────────────────────────────────────────────────
// Keys are already normalized (lowercase, single-spaced). Values are ISO3 / WB
// aggregate codes. Kept compact: only loose forms that the exact/ISO2/name and
// fuzzy layers do NOT already cover. Comments flag the non-obvious choices.
const ALIASES: Record<string, string> = {
  // United States
  usa: 'USA',
  us: 'USA',
  america: 'USA',
  american: 'USA',
  'united states of america': 'USA',
  'the states': 'USA',
  states: 'USA',

  // United Kingdom — WB name is "United Kingdom"; these are the colloquial forms.
  uk: 'GBR',
  britain: 'GBR',
  'great britain': 'GBR',
  'the uk': 'GBR',
  england: 'GBR', // loose but overwhelmingly means GBR in these queries
  british: 'GBR',

  // Korea — DOCUMENTED ambiguity choice: bare "Korea" → KOR (South Korea).
  // The North must be named explicitly.
  korea: 'KOR',
  'south korea': 'KOR',
  's korea': 'KOR',
  'republic of korea': 'KOR',
  rok: 'KOR',
  korean: 'KOR',
  'north korea': 'PRK',
  'n korea': 'PRK',
  dprk: 'PRK',

  // Netherlands
  holland: 'NLD',
  'the netherlands': 'NLD',
  dutch: 'NLD',

  // Russia (WB name "Russian Federation")
  russia: 'RUS',
  russian: 'RUS',

  // Other common loose / former names
  'ivory coast': 'CIV', // WB name "Cote d'Ivoire"
  burma: 'MMR', // WB name "Myanmar"
  czechia: 'CZE',
  'czech republic': 'CZE',
  czech: 'CZE',
  slovakia: 'SVK', // WB name "Slovak Republic"
  turkey: 'TUR', // WB name "Turkiye"
  laos: 'LAO', // WB name "Lao PDR"
  syria: 'SYR', // WB name "Syrian Arab Republic"
  vietnam: 'VNM', // WB name "Viet Nam"
  kyrgyzstan: 'KGZ', // WB name "Kyrgyz Republic"
  'cape verde': 'CPV', // WB name "Cabo Verde"
  uae: 'ARE',
  emirates: 'ARE',
  chinese: 'CHN',
  swiss: 'CHE',

  // Congo — DOCUMENTED choice: bare "Congo" → COG (Republic of the Congo,
  // "Congo, Rep."). The DRC must be named as such.
  congo: 'COG',
  'republic of congo': 'COG',
  'congo republic': 'COG',
  'congo brazzaville': 'COG',
  drc: 'COD',
  'dr congo': 'COD',
  'democratic republic of congo': 'COD',
  'congo kinshasa': 'COD',

  // Aggregates / regions. Most also resolve via ISO2 or exact name; these cover
  // the shorter colloquial forms the model and users actually type.
  eu: 'EUU', // also EUU's ISO2, but list it so intent is explicit
  'european union': 'EUU',
  eurozone: 'EMU',
  'euro zone': 'EMU',
  'euro area': 'EMU',
  world: 'WLD',
  global: 'WLD',
  worldwide: 'WLD',
  'the world': 'WLD',
  'sub saharan africa': 'SSF',
  'subsaharan africa': 'SSF',
  ssa: 'SSF',
  'latin america': 'LCN',
  latam: 'LCN',
  'latin america and caribbean': 'LCN',
  'middle east': 'MEA',
  mena: 'MEA',
  'middle east and north africa': 'MEA',
  'south asia': 'SAS',
  'east asia': 'EAS',
  'east asia and pacific': 'EAS',
};

// Resolve a curated alias by its ISO3/aggregate value to a RawCountry.
function countryForCode(code: string): RawCountry | undefined {
  return byIso3.get(code.toUpperCase());
}

// ── Conservative fuzzy layer ─────────────────────────────────────────────
// Returns a country ONLY when exactly one catalog entry matches `norm` as a
// whole word (token) in its name, or has a name beginning with `norm ` as a
// prefix. Any ambiguity (>1 match) or no match → null. `norm` shorter than 4
// chars is refused outright so a tiny fragment can't latch onto an incidental
// token. This is what lets "iran" → IRN while "iran"/"ireland" never cross, and
// keeps distinct-but-similar countries (Niger/Nigeria, the four Guineas) apart.
function fuzzyResolve(norm: string): RawCountry | null {
  if (norm.length < 4) return null;
  const hits: RawCountry[] = [];
  const seen = new Set<string>();
  for (const c of RAW) {
    const nn = normalize(c.name);
    const isToken = nn.split(' ').includes(norm);
    const isPrefix = nn.startsWith(norm + ' ');
    if ((isToken || isPrefix) && !seen.has(c.id)) {
      seen.add(c.id);
      hits.push(c);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

// ── Public API ───────────────────────────────────────────────────────────

// Resolve one loose country/region string to a canonical {code, name, matched},
// or null when it cannot be resolved with confidence.
export function resolveCountry(input: string): ResolvedCountry | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();

  // 1. exact ISO3 code (also covers WB aggregate codes: WLD, EUU, SSF…)
  const iso3 = byIso3.get(upper);
  if (iso3) return resolved(iso3, 'exact');

  // 2. exact ISO2 code (US → USA, GB → GBR, EU → EUU)
  const iso2 = byIso2.get(upper);
  if (iso2) return resolved(iso2, 'exact');

  const norm = normalize(raw);
  if (!norm) return null;

  // 3. exact name (case/punctuation-insensitive)
  const named = byName.get(norm);
  if (named) return resolved(named, 'exact');

  // 4. curated alias
  const aliasCode = ALIASES[norm];
  if (aliasCode) {
    const c = countryForCode(aliasCode);
    if (c) return resolved(c, 'alias');
  }

  // 5. conservative fuzzy (unique token / prefix)
  const fuzzy = fuzzyResolve(norm);
  if (fuzzy) return resolved(fuzzy, 'fuzzy');

  return null;
}

// A single resolution applied to a code that was passed to a fetch tool: what
// the caller sent, and what it became. Only emitted when resolution actually
// CHANGED the code (case-insensitively), so the receipt notes real work.
export interface CountryResolution {
  from: string; // the raw input, e.g. "UK" or "Korea"
  code: string; // canonical code used, e.g. "GBR"
  name: string; // canonical name, e.g. "United Kingdom"
  matched: MatchKind;
}

// Resolve a list of loose country inputs (as the fetch tools receive them) to
// the codes to actually query. Anything that cannot be resolved is passed
// through UNCHANGED — resolution never blocks a query. `changes` lists only the
// inputs whose code was rewritten, for the trace receipt.
export function resolveCountryList(inputs: string[]): {
  codes: string[];
  changes: CountryResolution[];
} {
  const codes: string[] = [];
  const changes: CountryResolution[] = [];
  for (const input of inputs) {
    const raw = String(input ?? '').trim();
    const r = resolveCountry(raw);
    if (r && r.code.toUpperCase() !== raw.toUpperCase()) {
      codes.push(r.code);
      changes.push({ from: raw, code: r.code, name: r.name, matched: r.matched });
    } else {
      // Either unresolved (pass through as-is) or already the canonical code.
      codes.push(raw);
    }
  }
  return { codes, changes };
}

// Render the `changes` from resolveCountryList as a compact receipt note, e.g.
// "UK → GBR (United Kingdom), Korea → KOR (Korea, Rep.)". Empty string when
// nothing changed, so callers can prefix it only when it carries information.
export function formatResolutions(changes: CountryResolution[]): string {
  return changes.map((c) => `${c.from} → ${c.code} (${c.name})`).join(', ');
}
