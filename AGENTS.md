# AGENTS.md

Orientation for coding agents working in this repository. Humans: this is a
concise map — the authoritative deep-dive for the main app is
[`src/lib/chitti/ARCHITECTURE.md`](src/lib/chitti/ARCHITECTURE.md).

## What this repo is

`amaljithkuttamath.github.io` — a personal site built with **Astro 5**, shipped
as a **static site** to **GitHub Pages**. There is **no backend**: every page is
prerendered, and the interactive apps run entirely in the browser.

The largest, most complex piece is **Chitti** (`src/lib/chitti/`), a
browser-only, bring-your-own-key (BYOK) data-analyst agent: it fetches real
numbers live from free institutional APIs (World Bank, Our World in Data, IMF
DataMapper, WHO GHO), computes over them, renders a chart, and verifies the
answer. Most agent work in this repo is in Chitti — read its ARCHITECTURE.md
before changing it.

## Commands

```bash
npm install          # install deps
npm run dev          # local dev server (astro dev)
npm test             # run the full vitest suite (npx vitest run) — 690+ tests
npm run build        # production build (astro build) — run before deploying UI/template edits
npm run demos:refresh   # re-fetch Chitti's empty-state demo answers (needs network)
npm run kb:refresh      # re-fetch the World Bank catalogue into the knowledge base (needs network)
npm run mirror:refresh  # recapture the same-origin World Bank data snapshot (needs network)
```

- **Always run `npm test` before committing.** The suite is fast (~2–3s) and
  the coverage is deliberately high; a green run is the contract.
- After editing a `.astro` file (markup/CSS), also run `npm run build` — vitest
  does not compile the Astro templates, so the build is what catches template
  errors.
- There is no separate lint step. `tsc --noEmit` reports some **pre-existing**
  errors (a CDN `import` in `ui/charts.ts`, a couple of casts); the project
  builds via Vite/esbuild, not strict `tsc`. Don't treat those as yours — only
  fix type errors your change introduces.

## Chitti layout (`src/lib/chitti/`)

Three layers, kept acyclic (full map in `ARCHITECTURE.md`):

- **Data / source layer** — `core.ts` (the bottom: bundled reference tables,
  `DataRow`/`ChartSpec`, `listCountries`, `ApiRejection` — imports nothing from
  the app), `sources/*` (World Bank, OWID, IMF, WHO adapters behind one
  `SourceAdapter` interface), `scoring.ts`, `csv.ts`, `schemas.ts`, `tools.ts`
  (facade + citations).
- **Agent layer** — `session.ts` (the loop: `ask`/`dispatch`/`routeFetch`/
  `runSubAgent`), `providers.ts` (the BYOK LLM client + retry/fallback),
  `planner.ts`, `verifier.ts`, `spec.ts`, `okf.ts`, `dashboard.ts`,
  `fastpath.ts` (the no-model direct answer — see below),
  `agent.ts` (facade re-exporting `session` + the split modules).
- **UI layer** — `ui/*`, all loaded by `src/pages/apps/chitti.astro` via one
  `import './boot'`. `ui/state.ts` owns all shared state; `ui/boot.ts` is the
  composition root.

## Conventions & gotchas

- **Pure helpers are exported for tests.** Parsing/normalizing/formatting logic
  is factored into pure functions (`normalizeSpec`, `parseVerifierVerdict`,
  `resolveFetchArgs`, `salvageToolCall`, `buildFindingOkf`, …) and unit-tested
  directly. Follow that pattern: put new logic in a pure function with tests,
  not buried in a closure.
- **Defensive parsing everywhere.** Model output and external API bodies are
  untrusted — never dereference without a shape guard; never let a malformed
  response throw out of a turn.
- **The service worker is hand-mirrored.** `sw-cache.ts` is the testable policy;
  `public/apps/chitti/sw.js` is a plain browser file that **mirrors it by hand**.
  If you change caching policy, update **both** and keep `sw-cache.test.ts`
  green. Provider/data hosts must always be `bypass` (never cached).
- **Attribute-context HTML uses `escapeHtml` (escapes quotes), not `esc`.** `esc`
  only escapes `&<>`; using it inside an HTML attribute is an injection bug.
- **BYOK / zero-backend / privacy.** No server, no telemetry, no secrets in the
  repo. Keys live only in the browser; the share/export formats whitelist fields
  (never keys, trace, or the VFS).
- **The fast path refuses rather than guesses.** `fastpath.ts` answers
  "indicator × countries × years" questions with NO model call — no key, no
  cost, nothing that can hallucinate — by driving `findSeriesWithReceipt` →
  `adapter.fetchSeries` → a deterministic spec. `handleAskSubmit` tries it
  *before* the key gate; a miss falls through to the agent, which is where
  ambiguous questions belong. When touching `parseFastPath`, the question is
  never "could we handle this?" but **"would we handle it wrong?"** — a wrong
  fast answer is worse than a slower right one, so every gate errs toward
  refusing. `MIN_MATCH_SCORE` is calibrated against the curated catalog (see its
  comment) and deliberately under-fires.
- **The knowledge base has two tiers, and the tuned one wins.** `kb.ts` resolves
  a phrase to a series by navigating a hierarchy rather than scoring a flat list
  — a leaf inherits its ancestors' vocabulary, so "child mortality" reaches an
  under-5 series whose own name never says "child". Its hand-authored core
  (groups + aliases) is small, covered by the retrieval eval in `kb.test.ts`,
  and **always wins on conflict**; `src/data/chitti/kb.json` carries the long
  tail of the World Bank catalogue and can only ADD indicators the core never
  placed. That ordering is what keeps the eval meaningful. Aliases are authored
  and that is fine — an alias is a claim about language, not about the world —
  but generated descriptions come from the source's own `sourceNote`, never
  from a model. **When you change retrieval, run the eval**: it is a regression
  table, and one case asserts it still holds with a generated tier present.
- **Demo answers are fetched, never authored.** `src/data/chitti/demos.json`
  holds the key-free worked examples on Chitti's empty state. It is written
  **only** by `npm run demos:refresh` (`scripts/gen-chitti-demos.mjs`), which
  drives the real adapters/compute helpers/citation builder and fails loudly
  rather than emitting a partial or invented series. **Never hand-edit numbers
  into that file** — a fabricated example in a provenance tool is the app lying
  at the exact moment a first-time visitor decides whether to trust it. That
  rule covers the PROSE too: every clause of a demo's answer is derived from a
  computed number (the correlation's strength word from `|r|`, "N of the ten
  more than halved" from a count), because a hand-written finding sitting above
  fetched data is the same lie in a softer form. The demos render through the
  same `restoreSharedAnswer` path a `#share=` link uses, and through the same
  `cleanShareState` whitelist. The generator needs outbound access to the source
  APIs, which a sandbox often lacks — run the **Refresh Chitti demos** workflow
  from the Actions tab instead and merge the PR it opens.
- **Test a recipe before spending a workflow run on it.** Because the generator
  only ever executes on a runner, that runner used to be the first place recipe
  logic ran, and two bugs shipped that way: an authored `n >= 50` correlation
  floor with no basis in the data, and an aggregate filter testing membership in
  `COUNTRIES` — which holds all 78 World Bank aggregates — while its comment
  claimed the opposite. Both are analysis bugs, and analysis needs no network.
  `scripts/gen-chitti-demos.test.ts` drives each recipe offline through its one
  outbound seam (`lib.adapterOfId`) against a synthetic series shaped like real
  World Bank data — broad history, partial final year, aggregates mixed in. Add
  a case there when you add a recipe.
- **Never correlate on the latest shared year.** `correlate` defaults to it, and
  on World Bank data that is a trap: the final year of a pull is a partial
  release, so two series ending in different partial years overlap on whoever
  filed early and the resulting `r` describes reporting speed. Use
  `pairCoverage` (`eda.ts`) — the pair-wise analogue of `latestUsableYear`, same
  60% floor — and refuse when it returns `null` rather than settling for the
  least-bad year.
- **The data snapshot is an accelerator, never a gate.** `sources/mirror.ts`
  serves the 50 curated World Bank series from same-origin files under
  `public/apps/chitti/mirror/` — no CORS, no rate limit, no key, cacheable,
  offline — so the key-free first run no longer depends on a public API that
  throttles. Two rules keep it honest, and both are covered by tests. **Missing
  is never wrong**: an id absent from the manifest, a 404, a payload that fails
  its shape check all return `null` and fall through to the live API, so the
  snapshot can only make an answer faster, never different. **A snapshot says
  so**: the result carries `mirroredAt`, the citation renders `snapshot <date>`
  in place of `fetched`, keeps the upstream World Bank URL, and the reference
  heading drops its "fetched live" claim (`citationsHeadline`). `mirroredAt`
  must survive `cleanShareState`, or a share link would re-render a snapshot as
  a live fetch. Only the manifest is bundled; the data files are fetched at
  runtime, which is why this does not cost every page load the way `kb.json`
  and `demos.json` do.
- **`fetchWorldbank` walks pages.** The API paginates and reports the count in
  the response header; reading only page one silently truncated any pull over
  `PER_PAGE` rows, and since rows arrive ordered by country, what vanished was
  whole countries off the end of the alphabet. A 60-country batch across
  1960–2024 is 3,900 rows. If you touch that function, keep the page walk and
  its pacing.
- **Adapters import from `core.ts`, never from `tools.ts`.** `tools.ts` is a
  facade that re-exports `./sources`, so an adapter importing values back from
  it closes the loop `adapter → tools → sources/index → adapter`. Because
  `sources/index` builds `SOURCES` at module scope, the module you enter the
  loop through decides whether that array holds a real adapter or `undefined` —
  entering via `tools.ts` worked, so the app and the whole suite stayed green
  while entering via an adapter file threw `Cannot read properties of undefined
  (reading 'usesSharedCatalog')`. That is not hypothetical: it broke a test,
  was worked around there instead of fixed, and then broke the snapshot
  workflow on the runner, whose generator loads `sources/worldbank.ts` as its
  entry point. `mirror.test.ts` now imports each source module first, in turn,
  as the regression guard.
- **The eval suite asserts behaviour, never a number.** `evals.ts` holds the
  in-app suite (run from the header's Evals button or `/evals run` in the
  composer); it drives real questions through the real pipeline and grades each
  one across six stages — routed → resolved → fetched → charted → cited →
  correct — so a failure names the layer that broke rather than just the case.
  A case may assert which series answers a question, which countries come back,
  and a row floor; **never a value**, for the same reason the demos file is
  generated and not authored. Expected ids are a LIST, because more than one
  source can legitimately hold a series. Roughly a third of the cases are
  questions the fast path must REFUSE — an over-fire is a failure, not a win —
  and "not run" (an agent case with no key) is never counted as a pass. Run it
  before and after touching retrieval (`kb.ts`, `scoring.ts`, a KB refresh), the
  fast path's gates, `normalizeSpec`, or a source adapter, and paste the copied
  Markdown into the PR. It needs the network and a key, so it is **not** a CI
  gate. Full design: `docs/superpowers/specs/2026-08-07-chitti-evals-funnel.md`.
- **The layering is asserted, not just described.** `layering.test.ts` walks the
  real import graph and fails on any runtime cycle (type-only imports are erased
  and don't count). It exists because "kept acyclic" was written in two docs
  while a cycle had been live for a while: a runtime cycle is not a compile
  error and not a test failure — it only shows as a half-initialised module, and
  only when entered through the wrong file, so the app stayed green and a CI
  runner was the first thing to notice. If it fails, move the shared value into
  `core.ts` rather than reordering imports.
- **Don't reintroduce cycles** in the module layering, and keep cross-module
  reassignable state on the exported `run` object in `ui/state.ts`.

## Tracing (optional, off by default)

Chitti can export each completed turn to **LangSmith** as a run tree (root
`chitti.turn` chain + one child run per tool/LLM step), built from the same
`TraceEvent` stream the UI shows. It is **off unless `PUBLIC_LANGSMITH_TRACING=1`**
at build time, so the shipped site sends nothing.

- The pure builder is `src/lib/chitti/tracing.ts` (`buildTurnRuns`, unit-tested);
  the exporter fires fire-and-forget in `ui/composer.ts`'s `finally`.
- **The API key never touches the browser.** The exporter POSTs to a same-origin
  relay (`/langsmith/...`); the relay injects `LANGSMITH_API_KEY` server-side. In
  `npm run dev` that relay is the Vite proxy in `astro.config.mjs`, which reads
  the key from a local, gitignored `.env` (see `.env.example`). A static build
  has no relay — to trace the deployed site, stand up a serverless relay and set
  `PUBLIC_LANGSMITH_INGEST_URL` to it. **Never** reference the non-`PUBLIC_` key
  from client code (Vite would inline it into the public bundle).

## Deploy

Pushing to **`main`** triggers two GitHub Actions workflows — **CI** and
**Deploy to GitHub Pages** — and publishes the site. Confirm both are green
after a push. Feature work happens on a branch; `main` is production.

Two further workflows are manual (`workflow_dispatch` only), both on the same
pattern: fetch on a runner — which has the network access a sandbox may not —
validate with the suite and a build, then open a PR. Neither pushes to `main`,
and both skip the PR when only the timestamps moved.

- **Refresh Chitti demos** — the empty-state demo answers.
- **Refresh Chitti knowledge base** — the long tail of the World Bank
  catalogue. The validation is the point: the suite carries the retrieval eval,
  so a catalogue refresh that would shift an answer fails on the runner instead
  of landing.
- **Refresh Chitti data snapshot** — the same-origin capture of the curated
  series. Unlike the other two it tolerates a partial result: an indicator it
  cannot fetch is left out of the manifest and served live, so the log's tail
  (which names every skipped indicator) is the thing to read. It fails only when
  nothing at all was captured.

Note that CI does **not** re-run on those PRs (GitHub does not trigger
`pull_request` workflows for `GITHUB_TOKEN`-authored PRs), which is why each
workflow runs the tests and build itself before opening one.

<!-- Convention adopted from langchain-ai/openwiki (an agent-facing AGENTS.md).
     Kept hand-authored — this repo has no doc-generation pipeline. -->
