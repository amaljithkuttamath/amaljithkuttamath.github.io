// Generates src/data/chitti/kb.json — the long tail of the World Bank
// catalogue for Chitti's knowledge base.
//
// Run: npm run kb:refresh        (needs network access to api.worldbank.org)
//
// WHY THIS NEEDS NO MODEL. The obvious way to extend a knowledge base is to
// have an LLM read each indicator and write a description and some aliases.
// That would mean a provider key in CI, a slow expensive pass, and — worst —
// vocabulary invented by a model sitting inside a tool whose entire promise is
// provenance. It is unnecessary: the World Bank's own `/v2/indicator` endpoint
// publishes, for every indicator, a `name`, its `topics`, and a `sourceNote`
// that is the institution's prose definition of what the series measures. That
// is better raw material than anything a model would produce, and it is
// FETCHED rather than authored. So this generator is deterministic: it fetches,
// filters, and writes. Nothing here decides what an indicator means.
//
// WHAT IT DOES NOT TOUCH. The hand-tuned core in src/lib/chitti/kb.ts — the
// groups and aliases that make "child mortality" resolve to an under-5 series —
// is not regenerated and not overridden. Generated entries only add indicators
// the core never placed. A regenerate can therefore broaden coverage but cannot
// silently change an answer the eval pins down, which is exactly why the
// workflow re-runs the eval before opening a PR.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'src/data/chitti/kb.json');
const WB = 'https://api.worldbank.org/v2';

// kb.json is imported statically by kb.ts, so it lands in the app bundle. This
// is the ceiling that keeps a catalogue refresh from quietly doubling the
// download. It compresses well (repetitive prose), but the cap is on raw bytes
// because that is what parses on load.
const MAX_BYTES = 320_000;

// The published definition, trimmed. Long enough to carry the vocabulary a
// searcher would use, short enough that a thousand of them stay in budget.
const NOTE_CHARS = 160;

// A description only earns its bytes if it says something the NAME does not.
// Many sourceNotes just restate the title ("Population, total" -> "Total
// population is based on the de facto definition of population..."), which
// costs budget and adds no way to find the series. Requiring a handful of genuinely
// new words keeps the ones that carry real vocabulary — the reason
// "aircraft passengers" finds an air-transport series — and drops the filler.
// Without this the full catalogue overruns the budget and EVERY description is
// dropped, losing the good ones along with the useless.
const NOTE_MIN_NEW_WORDS = 4;

function addsVocabulary(note, name) {
  const words = (t) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? []);
  const inName = words(name);
  let fresh = 0;
  for (const w of words(note)) if (!inName.has(w)) fresh++;
  return fresh >= NOTE_MIN_NEW_WORDS;
}

// Indicators whose id shape or topic makes them noise for a general audience:
// the World Bank catalogue includes large blocks of programme-internal and
// survey-instrument series that no one asks for by name.
const SKIP_TOPIC = /doing business|enterprise surveys|jobs diagnostics|wdi database archives/i;

// `source=2` is World Development Indicators — the World Bank's flagship
// database, and the one `searchIndicators` already queries for its live
// fallback. Without it the endpoint serves EVERY World Bank database at once:
// the first real run pulled ~6,000 topiced indicators and produced a 934KB
// file, three times the budget, before the guard refused to write it. Those
// extra thousands are programme-specific series from databases the app never
// fetches from, so including them would have bloated the bundle with ids that
// could not be charted. Pinning to WDI keeps the knowledge base over exactly
// the id space the rest of the app searches.
const SOURCE_WDI = 2;

async function fetchPage(page) {
  const url = `${WB}/indicator?format=json&per_page=500&source=${SOURCE_WDI}&page=${page}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`World Bank /indicator HTTP ${resp.status} (page ${page})`);
  const body = await resp.json();
  if (!Array.isArray(body) || body.length < 2 || !Array.isArray(body[1])) {
    throw new Error(`unexpected /indicator response shape on page ${page}`);
  }
  return { meta: body[0], rows: body[1] };
}

function clean(entry) {
  const seriesId = String(entry?.id ?? '').trim();
  const name = String(entry?.name ?? '').trim();
  if (!seriesId || !name) return null;
  // Only indicators the source itself files under a topic — an untopiced
  // indicator has nowhere to hang in the tree, and guessing a topic would be
  // exactly the invention this generator avoids.
  const topics = Array.isArray(entry?.topics) ? entry.topics : [];
  const topic = String(topics[0]?.value ?? '').trim();
  if (!topic || SKIP_TOPIC.test(topic)) return null;
  const note = String(entry?.sourceNote ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_CHARS);
  return note && addsVocabulary(note, name)
    ? { seriesId, name, topic, note }
    : { seriesId, name, topic };
}

async function main() {
  const first = await fetchPage(1);
  const pages = Number(first.meta?.pages) || 1;
  process.stdout.write(`· fetching ${pages} page(s) of the World Bank indicator catalogue\n`);

  const rows = [...first.rows];
  for (let p = 2; p <= pages; p++) {
    const next = await fetchPage(p);
    rows.push(...next.rows);
  }
  if (rows.length < 500) {
    // WDI carries well over a thousand indicators; a handful back means the API
    // changed shape or served an error body, and writing it would silently
    // shrink the knowledge base.
    throw new Error(`only ${rows.length} indicators returned — refusing to write a truncated catalogue`);
  }

  const seen = new Set();
  const entries = [];
  for (const r of rows) {
    const e = clean(r);
    if (!e || seen.has(e.seriesId)) continue;
    seen.add(e.seriesId);
    entries.push(e);
  }
  entries.sort((a, b) => a.seriesId.localeCompare(b.seriesId));
  console.log(`· ${rows.length} fetched → ${entries.length} usable (topiced, de-duplicated)`);

  let file = {
    _comment:
      'GENERATED FILE — do not hand-edit. The long tail of the World Bank catalogue, built from ' +
      "the API's own topic + description metadata by scripts/gen-chitti-kb.mjs. The hand-tuned core " +
      'lives in src/lib/chitti/kb.ts and always wins on conflict. Regenerate with: npm run kb:refresh. ' +
      'An empty entries array simply means the knowledge base is the authored core alone.',
    generated: new Date().toISOString(),
    entries,
  };
  let json = JSON.stringify(file, null, 2) + '\n';

  // Over budget: drop the descriptions before dropping indicators. Coverage —
  // being able to find a series at all — matters more than the extra vocabulary
  // its definition contributes.
  if (Buffer.byteLength(json) > MAX_BYTES) {
    const before = Buffer.byteLength(json);
    file = { ...file, entries: entries.map(({ seriesId, name, topic }) => ({ seriesId, name, topic })) };
    json = JSON.stringify(file, null, 2) + '\n';
    console.log(
      `· ${before} bytes exceeded the ${MAX_BYTES} budget — dropped descriptions, now ${Buffer.byteLength(json)}`
    );
  }
  if (Buffer.byteLength(json) > MAX_BYTES) {
    throw new Error(
      `kb.json is ${Buffer.byteLength(json)} bytes even without descriptions, over the ${MAX_BYTES} budget`
    );
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`\nwrote ${OUT} — ${file.entries.length} entries, ${Buffer.byteLength(json)} bytes`);
}

main().catch((err) => {
  console.error('\nknowledge-base generation FAILED — kb.json left untouched.');
  console.error(err);
  process.exit(1);
});
