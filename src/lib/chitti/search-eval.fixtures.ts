// search-eval.fixtures.ts — a curated offline eval set for find_series.
//
// Each case maps a realistic user query to the ONE series a good search should
// surface first, identified by (source, id). Expectations reference only series
// that actually ship in the offline catalogs: World Bank's indicators.json, and
// the curated OWID/IMF lists in tools.ts. No invented ids.
//
// This file doubles as documentation of what search is supposed to handle:
// plain phrasings, abbreviations ("gdp pc"), synonyms ("carbon output"), and
// colloquial questions ("how many people are online"). The companion test
// (search-eval.test.ts) runs every case through the real search path with
// fetch stubbed offline and asserts a top-1/top-3 hit-rate floor, so a scoring
// or synonym regression turns red instead of silently degrading.

export interface EvalCase {
  query: string;
  // Expected registry source id ('worldbank' | 'owid' | 'imf') and the fetch
  // id the search should return (plain WB code, "owid:<slug>", or "imf:<code>").
  source: 'worldbank' | 'owid' | 'imf';
  id: string;
  // Active databases for this query (mirrors the user's DB selection). Omit for
  // "all sources on" — the common case and the harder cross-source ranking test.
  active?: string[];
  // Why this case exists / what makes it interesting. Documentation only.
  note?: string;
}

export const EVAL_CASES: EvalCase[] = [
  // ── Economy / macro (World Bank) ──────────────────────────────────────
  { query: 'gdp per person in france', source: 'worldbank', id: 'NY.GDP.PCAP.CD', note: 'colloquial "per person" for per capita' },
  { query: 'gdp pc', source: 'worldbank', id: 'NY.GDP.PCAP.CD', note: 'abbreviation "pc" → per capita' },
  { query: 'economic output', source: 'worldbank', id: 'NY.GDP.MKTP.CD', note: 'synonym: output/economic → gdp' },
  // World-Bank-only sessions: the plain historical series, not IMF's identically
  // named "Inflation rate"/"Unemployment rate" forecast series.
  { query: 'inflation rate', source: 'worldbank', id: 'FP.CPI.TOTL.ZG', active: ['worldbank'] },
  { query: 'consumer prices index', source: 'worldbank', id: 'FP.CPI.TOTL.ZG', note: 'synonym: consumer prices → inflation' },
  { query: 'unemployment rate', source: 'worldbank', id: 'SL.UEM.TOTL.ZS', active: ['worldbank'] },
  { query: 'jobless rate', source: 'worldbank', id: 'SL.UEM.TOTL.ZS', note: 'synonym: jobless → unemployment' },
  { query: 'government debt', source: 'worldbank', id: 'GC.DOD.TOTL.GD.ZS' },
  { query: 'exports share of gdp', source: 'worldbank', id: 'NE.EXP.GNFS.ZS' },
  { query: 'foreign direct investment', source: 'worldbank', id: 'BX.KLT.DINV.WD.GD.ZS' },
  { query: 'gini coefficient', source: 'worldbank', id: 'SI.POV.GINI', note: 'colloquial name for Gini index' },
  { query: 'military spending', source: 'worldbank', id: 'MS.MIL.XPND.GD.ZS', note: 'synonym: spending → expenditure' },

  // ── Macro forecasts (IMF) — all sources on, IMF must win on "forecast" ─
  { query: 'inflation forecast', source: 'imf', id: 'imf:PCPIPCH', note: 'forecast keyword should route to IMF over WB' },
  { query: 'gdp growth projection', source: 'imf', id: 'imf:NGDP_RPCH', note: 'synonym: projection → forecast (IMF)' },

  // ── Health (World Bank) ───────────────────────────────────────────────
  { query: 'life expectancy', source: 'worldbank', id: 'SP.DYN.LE00.IN' },
  { query: 'longevity', source: 'worldbank', id: 'SP.DYN.LE00.IN', note: 'synonym: longevity → life expectancy' },
  { query: 'infant deaths', source: 'worldbank', id: 'SP.DYN.IMRT.IN', note: 'synonym: deaths → mortality' },
  { query: 'maternal mortality', source: 'worldbank', id: 'SH.STA.MMRT' },
  { query: 'number of doctors', source: 'worldbank', id: 'SH.MED.PHYS.ZS', note: 'synonym: doctors → physicians' },
  { query: 'measles vaccination', source: 'worldbank', id: 'SH.IMM.MEAS', note: 'synonym: vaccination → immunization' },

  // ── Population & demographics (World Bank) ────────────────────────────
  { query: 'total population', source: 'worldbank', id: 'SP.POP.TOTL' },
  { query: 'population growth', source: 'worldbank', id: 'SP.POP.GROW' },
  { query: 'fertility rate', source: 'worldbank', id: 'SP.DYN.TFRT.IN' },
  { query: 'urban population', source: 'worldbank', id: 'SP.URB.TOTL.IN.ZS' },
  { query: 'aging population', source: 'worldbank', id: 'SP.POP.65UP.TO.ZS', note: 'synonym: aging → ages 65+' },

  // ── Education (World Bank) ────────────────────────────────────────────
  { query: 'secondary school enrollment', source: 'worldbank', id: 'SE.SEC.ENRR' },

  // ── Environment & energy ──────────────────────────────────────────────
  { query: 'co2 emissions per capita', source: 'owid', id: 'owid:co-emissions-per-capita' },
  { query: 'annual co2 emissions', source: 'owid', id: 'owid:annual-co2-emissions-per-country' },
  { query: 'carbon output', source: 'worldbank', id: 'EN.GHG.CO2.MT.CE.AR5', note: 'synonym: carbon → co2/emissions' },
  { query: 'renewable energy consumption', source: 'worldbank', id: 'EG.FEC.RNEW.ZS', note: 'WB = total-energy share; OWID below = electricity only' },
  { query: 'share of electricity from renewables', source: 'owid', id: 'owid:share-electricity-renewables' },
  { query: 'forest cover', source: 'worldbank', id: 'AG.LND.FRST.ZS', note: 'synonym: cover → area' },

  // ── Technology & infrastructure (World Bank) ──────────────────────────
  { query: 'internet users', source: 'worldbank', id: 'IT.NET.USER.ZS' },
  { query: 'how many people are online', source: 'worldbank', id: 'IT.NET.USER.ZS', note: 'colloquial: online → internet' },
  { query: 'mobile phone subscriptions', source: 'worldbank', id: 'IT.CEL.SETS.P2', note: 'synonym: phone → mobile/cellular' },
  { query: 'access to electricity', source: 'worldbank', id: 'EG.ELC.ACCS.ZS' },
  { query: 'women in parliament', source: 'worldbank', id: 'SG.GEN.PARL.ZS' },

  // ── Society & wellbeing (OWID) ────────────────────────────────────────
  { query: 'child mortality', source: 'owid', id: 'owid:child-mortality', note: 'OWID names it "child"; WB says "under-5"' },
  { query: 'happiness', source: 'owid', id: 'owid:happiness-cantril-ladder' },
  { query: 'life satisfaction', source: 'owid', id: 'owid:happiness-cantril-ladder', note: 'synonym expansion of happiness' },
  { query: 'human development index', source: 'owid', id: 'owid:human-development-index' },
  { query: 'hdi', source: 'owid', id: 'owid:human-development-index', note: 'abbreviation → human development' },
  { query: 'homicide rate', source: 'owid', id: 'owid:homicide-rate-unodc' },
  { query: 'extreme poverty', source: 'owid', id: 'owid:share-of-population-in-extreme-poverty' },
  { query: 'calories per person', source: 'owid', id: 'owid:daily-per-capita-caloric-supply' },

  // ── Newly covered OWID topics (expanded curated grapher catalog) ──────
  // All slugs below are real OWID grapher slugs and are absent from the World
  // Bank curated set, so they win cross-source with every database on.
  { query: 'global temperature anomaly', source: 'owid', id: 'owid:temperature-anomaly', note: 'climate: not in World Bank catalog' },
  { query: 'plastic waste per capita', source: 'owid', id: 'owid:plastic-waste-per-capita' },
  { query: 'cumulative co2 emissions', source: 'owid', id: 'owid:cumulative-co2-emissions', note: 'distinct from annual/per-capita CO2' },
  { query: 'consumption based co2 emissions', source: 'owid', id: 'owid:consumption-co2-per-capita', note: 'consumption- vs production-based accounting' },
  { query: 'political regime', source: 'owid', id: 'owid:political-regime', note: 'governance/democracy classification' },
  { query: 'median age', source: 'owid', id: 'owid:median-age' },
  { query: 'prevalence of undernourishment', source: 'owid', id: 'owid:prevalence-of-undernourishment', note: 'food security: not in the World Bank curated set' },
];
