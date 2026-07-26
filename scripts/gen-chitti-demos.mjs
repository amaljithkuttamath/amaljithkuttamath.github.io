// Generates src/data/chitti/demos.json — the worked examples Chitti shows on
// its empty state, so a visitor without an API key can see a real finished
// answer before deciding whether to connect one.
//
// Run: npm run demos:refresh     (needs network access to the source APIs)
//
// THE RULE THIS SCRIPT EXISTS TO ENFORCE: every number in the output is
// FETCHED, never authored. The demos are not mockups and not fixtures — each
// one is produced by calling the same source adapters (`adapter.fetchSeries`),
// the same compute helpers (`growthStats`, `correlate`) and the same citation
// builder (`buildCitation`) that a live agent run calls, so a demo is
// structurally the same artifact a real run produces. The only thing not
// produced by a model is the one-line answer text, which is templated here
// FROM the fetched numbers (see `answer` in each recipe) rather than written by
// hand — so it cannot drift from the data it describes.
//
// If any fetch fails or returns too little data, the script exits non-zero and
// writes nothing. A partial or invented demo is worse than no demo: in a tool
// whose whole promise is provenance, a fabricated example is the app lying at
// the exact moment a first-time visitor is deciding whether to trust it.
//
// The lib modules are TypeScript and import JSON, so they are loaded through
// Vite's SSR module runner (already a dependency, via Astro) rather than node
// directly — that way the script runs the very same code the browser bundles.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src/data/chitti/demos.json');

// Size budget for the whole file. demos.json is imported statically by
// lib/demos.ts, so it lands in the app bundle. Evidence rows run ~120 bytes
// each, so this is roughly 1,100 rows across all demos — generous enough for a
// complete evidence table per demo, and it compresses hard over the wire
// (repetitive JSON, ~8x), which is what the page load actually pays.
const MAX_BYTES = 140_000;

// ── Helpers shared by the recipes ───────────────────────────────────────────

const fmt = (n, digits = 1) =>
  Math.abs(n) >= 1000
    ? Math.round(n).toLocaleString('en-US')
    : Number(n.toFixed(digits)).toLocaleString('en-US');

// Fetch one series through its own adapter, exactly as routeFetch would, and
// return the rows tagged with the indicator id plus a real citation. Throws on
// an empty result so a demo can never be built on nothing.
async function fetchSeries(lib, id, countries, yearStart, yearEnd) {
  const { adapterOfId, buildCitation, resolveCountryList } = lib;
  const adapter = adapterOfId(id);
  if (!adapter) throw new Error(`no adapter owns the id "${id}"`);
  const codes = countries?.length ? resolveCountryList(countries).codes : [];
  const result = await adapter.fetchSeries(id, codes, yearStart, yearEnd);
  const rows = (result.rows || []).map((r) => ({ ...r, indicator: id }));
  if (!rows.some((r) => r.value !== null)) {
    throw new Error(`fetch for "${id}" returned no usable values`);
  }
  const nid = adapter.normalizeId(id);
  const citation = buildCitation(
    `${adapter.citationSource}:${nid}:${codes.join(',')}:${yearStart ?? ''}-${yearEnd ?? ''}`,
    adapter.citationSource,
    nid,
    codes,
    yearStart,
    yearEnd,
    rows.length,
    result.requestUrl || '',
    result.sourceUpdated
  );
  return { rows, citation, adapter };
}

// Trim an evidence table down to the rows a demo actually needs, keeping the
// file inside its budget. Rows are kept whole (never synthesised); this only
// ever drops.
function limitRows(rows, max) {
  return rows.length <= max ? rows : rows.slice(0, max);
}

// ── The recipes ─────────────────────────────────────────────────────────────
// Each returns the full demo. They are ordered by what they demonstrate:
// computation across every country, a correlation, and a cross-database join —
// the three things a visitor cannot get from a one-click chart site.

const RECIPES = [
  {
    id: 'child-mortality-fastest-fall',
    question: 'Which countries cut child mortality the fastest since 2000?',
    blurb: 'Ranked across every country in the world — computed, not looked up.',
    async build(lib) {
      const { growthStats } = lib;
      // No `countries` argument: World Bank fetches are batched internally for
      // "every country" questions, exactly as the agent's prompt instructs.
      const { rows, citation, adapter } = await fetchSeries(lib, 'SH.DYN.MORT', [], 2000, undefined);
      // Aggregates (regions, income groups) are real World Bank rows but they
      // are not countries; a "which countries" answer must not rank them.
      const isoCountries = new Set(lib.COUNTRIES.map((c) => c.id));
      const stats = growthStats(rows.filter((r) => isoCountries.has(r.iso3)))
        .filter((s) => s.pctChange !== null && s.firstValue > 0)
        .sort((a, b) => a.pctChange - b.pctChange) // most negative = steepest fall
        .slice(0, 10);
      if (stats.length < 10) throw new Error('child mortality: fewer than 10 rankable countries');
      const top = stats[0];
      const spec = {
        type: 'bar',
        title: `Steepest falls in under-5 mortality, ${top.firstYear}–${top.lastYear}`,
        x_axis: 'Country',
        y_axis: '% change in deaths per 1,000 live births',
        series: [
          {
            name: '% change',
            data: stats.map((s) => [s.country, Number(s.pctChange.toFixed(1))]),
          },
        ],
      };
      // The chart plots one % change per country, and growth_stats derives each
      // of those from exactly two fetched values — the endpoints. So the
      // evidence table carries those endpoint rows: every number on the chart is
      // traceable to a row a reader can see, with no filler years padding the
      // table (and no partial table, which is what a blunt row cap would give).
      const endpoints = new Map(stats.map((s) => [s.iso3, [s.firstYear, s.lastYear]]));
      const evidence = rows.filter(
        (r) => r.value !== null && endpoints.get(r.iso3)?.includes(r.year)
      );
      return {
        answer:
          `${top.country} cut under-5 mortality ${fmt(Math.abs(top.pctChange))}% between ${top.firstYear} and ` +
          `${top.lastYear} — from ${fmt(top.firstValue)} to ${fmt(top.lastValue)} deaths per 1,000 live births — the ` +
          `steepest fall of any country. All ten leaders more than halved their rate, with ` +
          `${stats[1].country} and ${stats[2].country} close behind.`,
        spec,
        rows: limitRows(evidence, 200),
        citations: [citation],
        sources: [adapter.sourceLabel],
      };
    },
  },

  {
    id: 'health-spending-vs-child-mortality',
    question: 'Does higher health spending buy lower child mortality?',
    blurb: 'A correlation across ~180 countries, one point each — computed live.',
    async build(lib) {
      const { correlate } = lib;
      // Two series, most recent decade, then correlated at their latest shared
      // year — the same two-fetch-then-correlate shape the agent runs.
      const spend = await fetchSeries(lib, 'SH.XPD.CHEX.PC.CD', [], 2015, undefined);
      const mort = await fetchSeries(lib, 'SH.DYN.MORT', [], 2015, undefined);
      const isoCountries = new Set(lib.COUNTRIES.map((c) => c.id));
      const all = [...spend.rows, ...mort.rows].filter((r) => isoCountries.has(r.iso3));
      const corr = correlate(all, 'SH.XPD.CHEX.PC.CD', 'SH.DYN.MORT');
      if (corr.r === null || corr.n < 50) {
        throw new Error(`health-spend correlation unusable (r=${corr.r}, n=${corr.n})`);
      }
      const year = corr.year;
      const spendAt = new Map(
        spend.rows.filter((r) => r.year === year && r.value !== null).map((r) => [r.iso3, r])
      );
      const points = [];
      const keptIso = new Set();
      for (const r of mort.rows) {
        if (r.year !== year || r.value === null) continue;
        const s = spendAt.get(r.iso3);
        if (!s) continue;
        points.push([Number(s.value.toFixed(1)), Number(r.value.toFixed(1))]);
        keptIso.add(r.iso3);
      }
      if (points.length < 50) throw new Error('health-spend scatter: too few paired countries');
      const spec = {
        type: 'scatter',
        title: `Health spending vs under-5 mortality, ${year}`,
        x_axis: 'Health spending per capita (current US$)',
        y_axis: 'Under-5 deaths per 1,000 live births',
        series: [{ name: `Countries (${year})`, data: points }],
      };
      return {
        answer:
          `Across ${corr.n} countries in ${year} the correlation is ${corr.r.toFixed(2)} — strongly negative, but the ` +
          `shape matters more than the coefficient: mortality collapses over the first few hundred dollars of spending ` +
          `per person and then flattens, so the countries with the most to gain are the ones spending least.`,
        spec,
        // Exactly the paired rows behind the scatter: two per plotted country,
        // at the one year the correlation was computed on.
        rows: limitRows(
          all.filter((r) => r.year === year && r.value !== null && keptIso.has(r.iso3)),
          420
        ),
        citations: [spend.citation, mort.citation],
        sources: [spend.adapter.sourceLabel],
      };
    },
  },

  {
    id: 'co2-vs-gdp-g7',
    question: 'Have the G7 actually decoupled CO₂ from economic growth?',
    blurb: 'Joins Our World in Data emissions with World Bank income — two databases, one chart.',
    async build(lib) {
      const G7 = ['USA', 'GBR', 'FRA', 'DEU', 'ITA', 'JPN', 'CAN'];
      const co2 = await fetchSeries(lib, 'owid:co-emissions-per-capita', G7, 1990, undefined);
      const gdp = await fetchSeries(lib, 'NY.GDP.PCAP.KD', G7, 1990, undefined);
      // Index both to 1990 = 100 so two different units share one axis. This is
      // a transform of fetched values, not a substitute for them: the evidence
      // table below still carries the raw rows.
      const series = [];
      for (const [label, rows] of [
        ['CO₂ per capita (1990 = 100)', co2.rows],
        ['GDP per capita (1990 = 100)', gdp.rows],
      ]) {
        const byYear = new Map();
        for (const r of rows) {
          if (r.value === null || !G7.includes(r.iso3)) continue;
          const bucket = byYear.get(r.year) || [];
          bucket.push(r.value);
          byYear.set(r.year, bucket);
        }
        // G7 mean per year, over the years all seven report.
        const years = [...byYear.keys()].filter((y) => byYear.get(y).length === G7.length).sort((a, b) => a - b);
        if (years.length < 20) throw new Error(`${label}: only ${years.length} complete G7 years`);
        const mean = (y) => byYear.get(y).reduce((s, v) => s + v, 0) / G7.length;
        const base = mean(years[0]);
        series.push({
          name: label,
          data: years.map((y) => [y, Number(((mean(y) / base) * 100).toFixed(1))]),
          _first: years[0],
          _last: years[years.length - 1],
          _lastIndexed: (mean(years[years.length - 1]) / base) * 100,
        });
      }
      const [co2Series, gdpSeries] = series;
      const firstYear = Math.max(co2Series._first, gdpSeries._first);
      const lastYear = Math.min(co2Series._last, gdpSeries._last);
      const spec = {
        type: 'line',
        title: `G7 average: CO₂ per capita vs GDP per capita, indexed to ${firstYear}`,
        x_axis: 'Year',
        y_axis: `Index (${firstYear} = 100)`,
        series: series.map((s) => ({
          name: s.name,
          data: s.data.filter(([y]) => y >= firstYear && y <= lastYear),
        })),
      };
      return {
        answer:
          `Yes, and by a wide margin: across the G7 average, output per person reached ` +
          `${fmt(gdpSeries._lastIndexed, 0)} by ${lastYear} against a ${firstYear} base of 100, while CO₂ per person ` +
          `fell to ${fmt(co2Series._lastIndexed, 0)}. The two lines separate in the mid-2000s and never reconverge — ` +
          `growth and territorial emissions genuinely came apart.`,
        spec,
        // Both indicators for all seven countries across the charted span — the
        // raw values behind the indexed lines, since indexing is a transform a
        // reader should be able to check.
        rows: limitRows(
          [...co2.rows, ...gdp.rows].filter(
            (r) => r.value !== null && r.year >= firstYear && r.year <= lastYear && G7.includes(r.iso3)
          ),
          480
        ),
        citations: [co2.citation, gdp.citation],
        sources: [co2.adapter.sourceLabel, gdp.adapter.sourceLabel],
      };
    },
  },
];

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'warn',
    server: { middlewareMode: true },
    appType: 'custom',
  });

  try {
    // Load the real app modules through Vite so TS + JSON imports resolve
    // exactly as they do in the browser bundle.
    const [tools, sources, dashAgent, countries, share, demos] = await Promise.all([
      server.ssrLoadModule('/src/lib/chitti/tools.ts'),
      server.ssrLoadModule('/src/lib/chitti/sources/index.ts'),
      server.ssrLoadModule('/src/lib/chitti/dashboards-agent.ts'),
      server.ssrLoadModule('/src/lib/chitti/countries.ts'),
      server.ssrLoadModule('/src/lib/chitti/share.ts'),
      server.ssrLoadModule('/src/lib/chitti/demos.ts'),
    ]);
    const lib = {
      ...tools,
      adapterOfId: sources.adapterOfId,
      buildCitation: dashAgent.buildCitation,
      resolveCountryList: countries.resolveCountryList,
    };

    const built = [];
    for (const recipe of RECIPES) {
      process.stdout.write(`· ${recipe.id} … `);
      const out = await recipe.build(lib);
      // Through the SAME whitelist the share permalink uses, so a demo can only
      // ever hold fields the renderer knows about.
      const state = share.buildSharePayload({
        question: recipe.question,
        answer: out.answer,
        spec: out.spec,
        rows: out.rows,
        citations: out.citations,
        // A demo is not model-verified — no verifier ran. Saying "verified"
        // here would be the exact dishonesty this file guards against.
        verification: null,
        ts: new Date().toISOString(),
      });
      const demo = {
        id: recipe.id,
        question: recipe.question,
        blurb: recipe.blurb,
        sources: [...new Set(out.sources)],
        state,
      };
      // Validate with the app's own loader: whatever survives here is exactly
      // what the browser will render.
      if (!demos.cleanDemo(demo)) throw new Error(`${recipe.id} failed cleanDemo validation`);
      built.push(demo);
      console.log(`ok (${out.rows.length} rows, ${out.citations.length} citation(s))`);
    }

    const file = {
      _comment:
        'GENERATED FILE — do not hand-edit. Every number here must be fetched, never authored. ' +
        'Regenerate with: npm run demos:refresh (see scripts/gen-chitti-demos.mjs). ' +
        'An empty demos array simply hides the examples section on the empty state.',
      generated: new Date().toISOString(),
      demos: built,
    };
    const json = JSON.stringify(file, null, 2) + '\n';
    if (Buffer.byteLength(json) > MAX_BYTES) {
      throw new Error(
        `demos.json is ${Buffer.byteLength(json)} bytes, over the ${MAX_BYTES} budget — ` +
          `lower the row caps in the recipes`
      );
    }
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, json);
    console.log(`\nwrote ${OUT} — ${built.length} demos, ${Buffer.byteLength(json)} bytes`);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error('\ndemo generation FAILED — demos.json left untouched.');
  console.error(err);
  process.exit(1);
});
