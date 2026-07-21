// scoring.ts — the one weighted relevance scorer shared by every catalog
// (World Bank indicators, the OWID/IMF/WHO dataset catalog, and the live
// catalog fallbacks). Pure and offline-testable: no network, no module state.
//
// Plain substring term-counting missed real matches — "co2" never hits
// "CO-emissions…" because it isn't a literal substring — so we normalize
// punctuation to spaces and expand a small synonym map before scoring. No
// embeddings: this stays a browser-only static site, and a curated synonym
// list is both cheap and debuggable.

const SYNONYMS: Record<string, string[]> = {
  co2: ['carbon', 'emissions', 'greenhouse'],
  carbon: ['co2', 'emissions'],
  emissions: ['co2', 'carbon'],
  gdp: ['gross domestic product', 'economy', 'output'],
  economy: ['gdp', 'economic', 'output'],
  economic: ['gdp', 'economy', 'output'],
  output: ['gdp', 'economy'],
  gni: ['gross national income'],
  inflation: ['consumer prices', 'cpi'],
  unemployment: ['labor force', 'jobless', 'unemployed'],
  jobless: ['unemployment', 'unemployed'],
  unemployed: ['unemployment'],
  population: ['people', 'demographic', 'inhabitants'],
  people: ['population'],
  // "per person" is the colloquial "per capita"; the reverse is not added so
  // a plain "per capita" query doesn't drag in the one dataset named "person".
  person: ['capita'],
  pc: ['per capita'],
  mortality: ['death', 'deaths'],
  fertility: ['births', 'birth rate'],
  longevity: ['life expectancy'],
  lifespan: ['life expectancy'],
  // aging skews toward the "ages 65 and above" series, not a literal word.
  aging: ['ages', 'elderly', 'old', 'older'],
  ageing: ['ages', 'elderly', 'old', 'older'],
  doctors: ['physicians', 'medical'],
  physicians: ['doctors'],
  vaccination: ['immunization', 'vaccine'],
  vaccine: ['immunization', 'vaccination'],
  immunization: ['vaccination', 'vaccine'],
  spending: ['expenditure', 'expenses'],
  expenditure: ['spending'],
  // IMF is the forecast source — route "forecast/projection" phrasings there.
  forecast: ['projection', 'projected', 'forecasts', 'outlook'],
  forecasts: ['forecast', 'projection'],
  projection: ['forecast', 'forecasts', 'projected'],
  projected: ['forecast', 'projection'],
  internet: ['online', 'web', 'connectivity'],
  online: ['internet', 'web'],
  phone: ['mobile', 'cellular'],
  cellular: ['mobile', 'phone'],
  poverty: ['poor', 'income'],
  literacy: ['reading', 'education'],
  renewables: ['renewable', 'solar', 'wind', 'clean energy'],
  renewable: ['renewables', 'solar', 'wind', 'clean energy'],
  energy: ['electricity', 'power'],
  debt: ['borrowing', 'liabilities'],
  trade: ['exports', 'imports'],
  cover: ['area'],
  happiness: ['life satisfaction', 'wellbeing', 'cantril'],
  hdi: ['human development'],
};

// Function/units words that carry no topic signal. Dropped from per-term
// scoring so a short token can't win on an incidental substring hit — "in"
// (from "gdp in france") was matching "international", and "rate" (a units
// suffix on many indicator names) was outscoring the actual topic term. The
// full-phrase and name-prefix bonuses still use the raw query, so multi-word
// phrases like "gdp per capita" keep their exact-match weight.
const STOPWORDS = new Set([
  'in', 'of', 'the', 'a', 'an', 'to', 'for', 'and', 'or', 'how', 'many', 'much',
  'are', 'is', 'be', 'on', 'at', 'by', 'with', 'from', 'rate',
]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// The receipt for one scored series: not just the number, but WHICH query
// terms and synonym expansions actually landed. The UI surfaces this so the
// scorer's work ("matched 'gdp' → 'economy'") is visible instead of hidden.
export interface MatchExplanation {
  score: number;
  // Original query tokens that appeared verbatim in the id/name.
  matchedBase: string[];
  // Synonym expansions that fired: the original query term and the synonym
  // word that actually appeared in the haystack. e.g. gdp → economy.
  matchedSynonyms: { term: string; synonym: string }[];
}

// Weighted relevance of one series (id + name) to a query, PLUS which terms
// contributed. Pure and offline-testable. scoreSeries is the thin numeric
// wrapper, so the number and the explanation can never drift apart.
export function explainMatch(query: string, id: string, name: string): MatchExplanation {
  const q = normalize(query);
  if (!q) return { score: 0, matchedBase: [], matchedSynonyms: [] };
  const nName = normalize(name);
  const nId = normalize(id);
  const hay = nName + ' ' + nId;
  let score = 0;
  if (hay.includes(q)) score += 10; // exact phrase present
  if (nName.startsWith(q)) score += 6; // name leads with the query
  if (nId === q) score += 8; // id is exactly the query

  const base = new Set(q.split(' ').filter((w) => w && !STOPWORDS.has(w)));
  // Synonym word → the base term it expands from. First writer wins so a word
  // reachable from two base terms is attributed once (matches the old Set
  // dedup that kept scoring stable).
  const synOf = new Map<string, string>();
  for (const t of base)
    for (const syn of SYNONYMS[t] ?? [])
      for (const w of normalize(syn).split(' '))
        if (w && !base.has(w) && !synOf.has(w)) synOf.set(w, t);

  const matchedBase: string[] = [];
  const matchedSynonyms: { term: string; synonym: string }[] = [];
  for (const t of base) if (hay.includes(t)) { score += 2; matchedBase.push(t); } // originals weigh more
  for (const [w, t] of synOf) if (hay.includes(w)) { score += 1; matchedSynonyms.push({ term: t, synonym: w }); }
  return { score, matchedBase, matchedSynonyms };
}

// Weighted relevance of one series (id + name) to a query. 0 = no match.
export function scoreSeries(query: string, id: string, name: string): number {
  return explainMatch(query, id, name).score;
}
