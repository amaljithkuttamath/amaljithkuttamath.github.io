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
npm test             # run the full vitest suite (npx vitest run) — 500+ tests
npm run build        # production build (astro build) — run before deploying UI/template edits
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

- **Data / source layer** — `sources/*` (World Bank, OWID, IMF, WHO adapters
  behind one `SourceAdapter` interface), `scoring.ts`, `csv.ts`, `schemas.ts`,
  `tools.ts` (facade + core types/citations).
- **Agent layer** — `session.ts` (the loop: `ask`/`dispatch`/`routeFetch`/
  `runSubAgent`), `providers.ts` (the BYOK LLM client + retry/fallback),
  `planner.ts`, `verifier.ts`, `spec.ts`, `okf.ts`, `dashboard.ts`,
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
- **Don't reintroduce cycles** in the module layering, and keep cross-module
  reassignable state on the exported `run` object in `ui/state.ts`.

## Deploy

Pushing to **`main`** triggers two GitHub Actions workflows — **CI** and
**Deploy to GitHub Pages** — and publishes the site. Confirm both are green
after a push. Feature work happens on a branch; `main` is production.

<!-- Convention adopted from langchain-ai/openwiki (an agent-facing AGENTS.md).
     Kept hand-authored — this repo has no doc-generation pipeline. -->
