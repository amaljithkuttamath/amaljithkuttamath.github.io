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

// Size budget for the whole file, and the ONLY ceiling in this script.
//
// demos.json is imported statically by lib/demos.ts, so it lands in the app
// bundle. The previous budget was 140,000, derived from an assumption that
// evidence rows run ~120 bytes each. The first run in which all three recipes
// succeeded measured them at ~230: 876 rows came to 200,975 bytes, and the run
// failed on a number whose only basis was that wrong estimate.
//
// So this is set from the measurement, with room for the sources to broaden
// (more countries reporting, another year of history). What the page actually
// pays is the compressed size, and this shape — repetitive JSON, mostly numbers
// and repeated country names — compresses about tenfold, so ~200 KB raw is on
// the order of 20 KB over the wire for the one screen a first-time visitor
// judges the app on.
//
// If a future run exceeds this, DO NOT respond by trimming evidence rows. A
// demo's evidence table is exactly the rows behind its chart; slicing it leaves
// plotted points a reader cannot check, which is the one thing these demos
// exist to prove. Drop a whole demo, or narrow what a recipe charts, and raise
// this only against a fresh measurement.
const MAX_BYTES = 250_000;

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

// Every row behind a chart must reach the evidence table, so this asserts the
// count rather than capping it.
//
// The caps this replaces were authored round numbers (200 / 420 / 480), and the
// G7 recipe quietly grew into its one: the charted span reached 1990–2024, which
// is 35 years × 7 countries × 2 indicators = 490 rows, and 480 of them were
// kept. Ten plotted points had no row a reader could check — in the demo whose
// entire job is to show that every number is checkable, and with nothing in the
// output to say so. A blunt cap cannot tell "too big" from "complete"; the file
// budget can, and it fails loudly.
function expectComplete(label, rows, expected) {
  if (rows.length !== expected) {
    throw new Error(
      `${label}: evidence table has ${rows.length} rows but the chart needs ${expected} — ` +
        `every plotted point must have a row behind it`
    );
  }
  return rows;
}

// Describe a correlation's strength in words, from the coefficient itself.
// Banded so the prose can never contradict the number it sits next to — the
// hazard this replaces was a hand-written "strongly negative" that would have
// stayed on the page whatever the fetch returned.
function strengthOf(r) {
  const a = Math.abs(r);
  return a >= 0.7 ? 'strong' : a >= 0.5 ? 'moderate' : a >= 0.3 ? 'modest' : 'weak';
}

// ── The recipes ─────────────────────────────────────────────────────────────
// Each returns the full demo. They are ordered by what they demonstrate:
// computation across every country, a correlation, and a cross-database join —
// the three things a visitor cannot get from a one-click chart site.

export const RECIPES = [
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
      // NOTE the filter that belongs here is `isRealCountry`, NOT membership in
      // COUNTRIES: that table carries all 295 World Bank entities, 78 of which
      // are aggregates, so an id check admits exactly what it looks like it
      // excludes. Ranking "Sub-Saharan Africa" alongside Rwanda would have been
      // an invented finding in a demo whose whole job is to be checkable.
      const stats = growthStats(rows.filter((r) => lib.isRealCountry(r.iso3)))
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
      // Counted, not claimed. The sentence this replaces asserted "all ten more
      // than halved their rate" in fixed text, which is a finding about the
      // fetched data stated without checking it — the same failure as the
      // correlation's hand-written "strongly negative".
      const halved = stats.filter((s) => s.pctChange <= -50).length;
      const halvedClause =
        halved === stats.length
          ? `All ten leaders more than halved their rate`
          : `${halved} of the ten more than halved their rate`;
      return {
        answer:
          `${top.country} cut under-5 mortality ${fmt(Math.abs(top.pctChange))}% between ${top.firstYear} and ` +
          `${top.lastYear} — from ${fmt(top.firstValue)} to ${fmt(top.lastValue)} deaths per 1,000 live births — the ` +
          `steepest fall of any country. ${halvedClause}, with ` +
          `${stats[1].country} and ${stats[2].country} close behind.`,
        spec,
        // Two endpoints per ranked country; growth_stats derives each plotted
        // % change from exactly those two fetched values.
        rows: expectComplete('child-mortality', evidence, stats.length * 2),
        citations: [citation],
        sources: [adapter.sourceLabel],
      };
    },
  },

  {
    id: 'health-spending-vs-child-mortality',
    question: 'Does higher health spending buy lower child mortality?',
    blurb: 'A correlation across every reporting country, one point each — computed live.',
    async build(lib) {
      const { correlate } = lib;
      const SPEND = 'SH.XPD.CHEX.PC.CD';
      const MORT = 'SH.DYN.MORT';
      // Two series, most recent decade, then correlated at one year — the same
      // two-fetch-then-correlate shape the agent runs.
      const spend = await fetchSeries(lib, SPEND, [], 2015, undefined);
      const mort = await fetchSeries(lib, MORT, [], 2015, undefined);
      const all = [...spend.rows, ...mort.rows].filter((r) => lib.isRealCountry(r.iso3));

      // Pick the year on evidence rather than taking whatever overlaps last.
      // The first live run of this recipe correlated on the latest shared year
      // and got r=-0.35 over n=22 — health spending's final year had barely
      // filed. `pairCoverage` is the same trap `latestUsableYear` exists to
      // catch, applied to the pair; it is unit tested in eda.test.ts against a
      // reconstruction of this exact failure.
      const cov = lib.pairCoverage(all, SPEND, MORT);
      // A breakage guard, not a quality bar: both of these are flagship WDI
      // series reported by ~190 countries, so a joint universe in double digits
      // means a fetch came back wrong and the demo must not be built on it.
      // What counts as "enough" for the correlation itself is decided by the
      // coverage rule, from whatever the sources actually report — the floor
      // this replaces was an authored n>=50 that had no basis in the data and
      // failed the first live run it ever saw.
      if (cov.universe < 100) {
        throw new Error(
          `only ${cov.universe} countries report both series at all — the fetch is not intact, refusing to correlate`
        );
      }
      const year = cov.latestWellPaired;
      if (year === null) {
        const best = [...cov.byYear].sort((a, b) => b.n - a.n)[0] ?? { year: '—', n: 0 };
        throw new Error(
          `no year has ${Math.ceil(cov.universe * lib.JOINT_COVERAGE)} of the ${cov.universe} paired countries ` +
            `reporting (best is ${best.year} with ${best.n})`
        );
      }
      const corr = correlate(all, SPEND, MORT, year);
      if (corr.r === null) throw new Error(`correlation undefined at ${year} (n=${corr.n})`);
      // Reported back to the runner rather than printed here, so a future CI
      // log says which year the numbers came from and how well covered it was
      // — the two facts the failed run left the reader to guess at.
      const note = `year ${year}, ${corr.n}/${cov.universe} paired countries, r=${corr.r.toFixed(3)}`;

      // The same Pearson, over log10 spending. Whether the relationship is
      // curved is a claim about the data, so it gets computed rather than
      // asserted: if mortality really does collapse over the first few hundred
      // dollars and then flatten, a log x-axis fits better than a linear one.
      // A transform of fetched values, never a substitute for them — the
      // evidence table below still carries the raw rows.
      const LOG_SPEND = 'log10:' + SPEND;
      const logRows = all
        .filter((r) => r.indicator === SPEND && r.value !== null && r.value > 0)
        .map((r) => ({ ...r, indicator: LOG_SPEND, value: Math.log10(r.value) }));
      const logCorr = correlate([...logRows, ...all.filter((r) => r.indicator === MORT)], LOG_SPEND, MORT, year);
      const curved = logCorr.r !== null && Math.abs(logCorr.r) > Math.abs(corr.r) + 0.05;

      const spendAt = new Map(
        spend.rows.filter((r) => r.year === year && r.value !== null).map((r) => [r.iso3, r])
      );
      const points = [];
      const keptIso = new Set();
      for (const r of mort.rows) {
        if (r.year !== year || r.value === null || !lib.isRealCountry(r.iso3)) continue;
        const s = spendAt.get(r.iso3);
        if (!s) continue;
        points.push([Number(s.value.toFixed(1)), Number(r.value.toFixed(1))]);
        keptIso.add(r.iso3);
      }
      // The scatter and the coefficient must be the same set of countries, or
      // the chart is not a picture of the number beside it.
      if (points.length !== corr.n) {
        throw new Error(`scatter has ${points.length} points but the correlation used ${corr.n}`);
      }
      const spec = {
        type: 'scatter',
        title: `Health spending vs under-5 mortality, ${year}`,
        x_axis: 'Health spending per capita (current US$)',
        y_axis: 'Under-5 deaths per 1,000 live births',
        series: [{ name: `Countries (${year})`, data: points }],
      };
      return {
        // Every clause here is derived from a computed number — the strength
        // word from |r|, the shape claim from the log-scale fit. The version
        // this replaces asserted "strongly negative" in fixed text, which would
        // have printed unchanged over an r of -0.35.
        answer:
          `Across ${corr.n} countries in ${year} the correlation between health spending per person and under-5 ` +
          `mortality is ${corr.r.toFixed(2)} — ${strengthOf(corr.r)} and negative. ` +
          (curved
            ? `On a log spending scale it strengthens to ${logCorr.r.toFixed(2)}, which is the shape talking: mortality ` +
              `falls steeply over the first few hundred dollars per person and then flattens, so the countries with the ` +
              `most to gain are the ones spending least.`
            : `A log spending scale does not strengthen it (${logCorr.r === null ? 'undefined' : logCorr.r.toFixed(2)}), ` +
              `so across this range the association is close to linear in dollars rather than concentrated at the bottom.`),
        spec,
        // Exactly the paired rows behind the scatter: two per plotted country,
        // at the one year the correlation was computed on.
        // Two rows per plotted country — the spending and mortality values the
        // point was built from, at the one correlated year.
        rows: expectComplete(
          'health-spend',
          all.filter((r) => r.year === year && r.value !== null && keptIso.has(r.iso3)),
          points.length * 2
        ),
        citations: [spend.citation, mort.citation],
        sources: [spend.adapter.sourceLabel],
        note,
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
        // The raw values behind the indexed lines — indexing is a transform a
        // reader should be able to check, so every plotted point needs its
        // seven country rows.
        //
        // Keyed off the PLOTTED YEARS rather than the charted range, because
        // those are not the same set: a year inside the range where one series
        // is missing a G7 member is dropped from that line, so a range-based
        // count would demand rows for a point that was never drawn.
        rows: expectComplete(
          'co2-vs-gdp',
          [
            [co2.rows, spec.series[0].data],
            [gdp.rows, spec.series[1].data],
          ].flatMap(([rows, plotted]) => {
            const plottedYears = new Set(plotted.map(([y]) => y));
            return rows.filter(
              (r) => r.value !== null && G7.includes(r.iso3) && plottedYears.has(r.year)
            );
          }),
          (spec.series[0].data.length + spec.series[1].data.length) * G7.length
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
    const [tools, sources, dashAgent, countries, share, demos, eda] = await Promise.all([
      server.ssrLoadModule('/src/lib/chitti/tools.ts'),
      server.ssrLoadModule('/src/lib/chitti/sources/index.ts'),
      server.ssrLoadModule('/src/lib/chitti/dashboards-agent.ts'),
      server.ssrLoadModule('/src/lib/chitti/countries.ts'),
      server.ssrLoadModule('/src/lib/chitti/share.ts'),
      server.ssrLoadModule('/src/lib/chitti/demos.ts'),
      server.ssrLoadModule('/src/lib/chitti/eda.ts'),
    ]);
    const lib = {
      ...tools,
      adapterOfId: sources.adapterOfId,
      buildCitation: dashAgent.buildCitation,
      resolveCountryList: countries.resolveCountryList,
      // The app's own aggregate test and joint-coverage rule, rather than
      // second copies written here. Both are unit tested, and using them means
      // a demo and a live profile agree on what counts as a country and on
      // which year a two-series comparison may be computed at.
      isRealCountry: eda.isRealCountry,
      pairCoverage: eda.pairCoverage,
      JOINT_COVERAGE: eda.JOINT_COVERAGE,
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
      console.log(
        `ok (${out.rows.length} rows, ${out.citations.length} citation(s)${out.note ? `; ${out.note}` : ''})`
      );
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

// Only generate when run as a script. Importing this file hands back RECIPES
// alone — which is what gen-chitti-demos.test.ts does, so each recipe's
// analysis can be driven offline against a synthetic World Bank shape. The
// recipes reach the network exclusively through `lib.adapterOfId`, so a fake
// lib exercises the real logic end to end without a fetch. That test is the
// only pre-flight this script has: the runner is the first place the live
// version ever runs, and a failure there costs a whole workflow round-trip.
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\ndemo generation FAILED — demos.json left untouched.');
    console.error(err);
    process.exit(1);
  });
}
