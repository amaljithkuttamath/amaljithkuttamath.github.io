// Generates the same-origin World Bank snapshot Chitti answers from without a
// key: one file per curated indicator under public/apps/chitti/mirror/, plus
// the bundled index at src/data/chitti/mirror-manifest.json.
//
// Run: npm run mirror:refresh    (needs network access to api.worldbank.org)
//
// WHY A SNAPSHOT AT ALL. See the header of src/lib/chitti/sources/mirror.ts for
// the product reason. The operational reason is this script's own history: the
// live API rate-limits, and a first run that sometimes fails is not a key-free
// first run.
//
// WHAT MAKES IT SAFE. Missing is never wrong. An indicator this script fails to
// fetch is simply absent from the manifest, and the app falls through to the
// live API for it — so a partial run degrades to today's behaviour rather than
// to a wrong answer. That is why this script, unlike the demo generator, does
// NOT abort the whole run on one failure: it writes what it actually got, names
// what it did not, and only fails hard when nothing succeeded (which means
// something systemic, not one bad series).
//
// WHAT IT NEVER DOES. It does not interpolate, backfill, or smooth. A null in
// the source is a null here. The only transform is rounding to 6 significant
// figures, which is recorded in each file's `precision` field — far beyond the
// precision these indicators are measured to, and it halves the payload.
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'public/apps/chitti/mirror');
const MANIFEST = resolve(ROOT, 'src/data/chitti/mirror-manifest.json');

// Significant figures kept per value. World Bank series carry float noise well
// past any real measurement precision (a per-capita figure arrives as
// 2500.1234567890123); 6 survives every statistic the app computes and halves
// the file.
const PRECISION = 6;

// Per-file ceiling. A curated indicator over ~295 entities × ~65 years lands
// near 95 KB; this catches a runaway before it is written, not after.
const MAX_FILE_BYTES = 400_000;

// Total ceiling across every mirrored indicator. These files are served, not
// bundled, so this guards the repository rather than the page load.
const MAX_TOTAL_BYTES = 8_000_000;

// Pause between indicators, on top of the pacing fetchWorldbank already does
// between its own batches and pages. A probe against the live API caught it
// serving five rapid requests and then refusing three in a row, so the cost of
// hurrying is not a slower run — it is a failed one, partway through, after the
// earlier indicators have already been paid for.
const INDICATOR_PACING_MS = 1200;

const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(PRECISION)) : null);

// Turn fetched rows into the mirror's column layout: one array per country,
// one slot per year from yearStart to yearEnd, nulls preserved. The layout is
// what makes the file small — the year is the INDEX, so it is never repeated,
// and country names are dropped because the app already bundles that table.
export function toMirrorColumns(rows, yearStart, yearEnd) {
  const span = yearEnd - yearStart + 1;
  const countries = {};
  for (const r of rows) {
    const iso3 = String(r.iso3 || '').trim();
    if (!iso3) continue;
    const year = Number(r.year);
    if (!Number.isFinite(year) || year < yearStart || year > yearEnd) continue;
    if (!countries[iso3]) countries[iso3] = new Array(span).fill(null);
    countries[iso3][year - yearStart] = round(r.value);
  }
  // A country with no value at any year is pure padding — drop it rather than
  // pay 65 nulls for the information "we know nothing about this place".
  for (const [iso3, values] of Object.entries(countries)) {
    if (!values.some((v) => v !== null)) delete countries[iso3];
  }
  return countries;
}

// The observed year range of a set of rows, so a file never claims a span it
// does not hold.
export function observedRange(rows) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    if (r.value === null || r.value === undefined) continue;
    const y = Number(r.year);
    if (!Number.isFinite(y)) continue;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? { yearStart: lo, yearEnd: hi } : null;
}

async function main() {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: 'warn',
    server: { middlewareMode: true },
    appType: 'custom',
  });

  try {
    // The real app modules, through Vite, so the snapshot is captured by the
    // very fetcher the browser uses — including its retry, pacing and page walk.
    const [tools, worldbank] = await Promise.all([
      server.ssrLoadModule('/src/lib/chitti/tools.ts'),
      server.ssrLoadModule('/src/lib/chitti/sources/worldbank.ts'),
    ]);
    const indicators = tools.INDICATORS;
    if (!Array.isArray(indicators) || !indicators.length) {
      throw new Error('no curated indicators to mirror — INDICATORS is empty');
    }

    mkdirSync(OUT_DIR, { recursive: true });
    const written = {};
    const failures = [];
    let totalBytes = 0;

    for (const [i, ind] of indicators.entries()) {
      process.stdout.write(`· [${i + 1}/${indicators.length}] ${ind.id} … `);
      if (i) await new Promise((r) => setTimeout(r, INDICATOR_PACING_MS));
      try {
        // Every country, full history: no year bounds, so the snapshot holds
        // whatever the source holds and no question can fall outside it for
        // being too old.
        const res = await worldbank.fetchWorldbankAll(ind.id);
        const rows = res.rows || [];
        const range = observedRange(rows);
        if (!range) throw new Error('no non-null values returned');
        const countries = toMirrorColumns(rows, range.yearStart, range.yearEnd);
        const countryCount = Object.keys(countries).length;
        if (!countryCount) throw new Error('no country had a usable value');

        const file = {
          _comment:
            'GENERATED FILE — do not hand-edit. A dated snapshot of one World Bank series, ' +
            'captured by scripts/gen-chitti-mirror.mjs from the URL in upstreamUrl. Values are ' +
            'rounded to `precision` significant figures; nulls are the source’s own gaps and ' +
            'are never filled. `countries` maps ISO3 to one value per year from yearStart to yearEnd.',
          indicator: ind.id,
          name: ind.name,
          upstreamUrl: res.requestUrl || '',
          mirroredAt: new Date().toISOString(),
          ...(res.sourceUpdated ? { sourceUpdated: res.sourceUpdated } : {}),
          precision: PRECISION,
          yearStart: range.yearStart,
          yearEnd: range.yearEnd,
          countries,
        };
        const json = JSON.stringify(file) + '\n';
        const bytes = Buffer.byteLength(json);
        if (bytes > MAX_FILE_BYTES) {
          throw new Error(`${bytes} bytes exceeds the ${MAX_FILE_BYTES} per-file budget`);
        }
        writeFileSync(join(OUT_DIR, `${ind.id}.json`), json);
        totalBytes += bytes;
        written[ind.id] = {
          yearStart: range.yearStart,
          yearEnd: range.yearEnd,
          ...(res.sourceUpdated ? { sourceUpdated: res.sourceUpdated } : {}),
        };
        console.log(
          `ok (${countryCount} entities, ${range.yearStart}–${range.yearEnd}, ${(bytes / 1024).toFixed(0)} KB)`
        );
      } catch (err) {
        // Recorded, not fatal. An indicator missing from the manifest is served
        // live, which is exactly what happens today.
        failures.push({ id: ind.id, reason: String(err?.message || err) });
        console.log(`SKIPPED — ${err?.message || err}`);
      }
    }

    if (!Object.keys(written).length) {
      throw new Error(
        `every one of the ${indicators.length} indicators failed — that is systemic, not a bad series`
      );
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`snapshot totals ${totalBytes} bytes, over the ${MAX_TOTAL_BYTES} budget`);
    }

    // Remove files for indicators no longer curated, so the served directory
    // never outlives the manifest that indexes it.
    for (const name of existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : []) {
      if (!name.endsWith('.json')) continue;
      if (!written[name.slice(0, -5)]) {
        rmSync(join(OUT_DIR, name));
        console.log(`· removed stale ${name}`);
      }
    }

    const manifest = {
      _comment:
        'GENERATED FILE — do not hand-edit. Lists which World Bank indicators have a same-origin ' +
        'snapshot under public/apps/chitti/mirror/. Only this index is bundled; the data files ' +
        'themselves are fetched at runtime. An empty indicators object simply means every fetch ' +
        'goes to the live API, which is the correct fallback in all cases. ' +
        'Regenerate with: npm run mirror:refresh (see scripts/gen-chitti-mirror.mjs).',
      generated: new Date().toISOString(),
      indicators: Object.fromEntries(Object.keys(written).sort().map((k) => [k, written[k]])),
    };
    mkdirSync(dirname(MANIFEST), { recursive: true });
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

    console.log(
      `\nwrote ${Object.keys(written).length}/${indicators.length} indicators, ` +
        `${(totalBytes / 1048576).toFixed(1)} MB total`
    );
    if (failures.length) {
      // Loud, and last, so it is the thing a reader of the CI log sees. These
      // are served live; nothing is wrong, but a growing list means the API is
      // degrading and the snapshot is quietly shrinking.
      console.log(`\n${failures.length} indicator(s) NOT mirrored (they will be fetched live):`);
      for (const f of failures) console.log(`  - ${f.id}: ${f.reason}`);
    }
  } finally {
    await server.close();
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('\nsnapshot generation FAILED.');
    console.error(err);
    process.exit(1);
  });
}
