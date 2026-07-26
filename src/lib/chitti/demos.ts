// demos.ts — the pre-baked example answers shown on the empty state.
//
// WHY THIS EXISTS: Chitti is bring-your-own-key, so before this the first thing
// every visitor met was a credentials form and a blank page. Nothing in the app
// demonstrated what it does until you had already paid the setup cost. But the
// app already knows how to render a complete answer with no key and no agent
// run — that is exactly what a `#share=` permalink does (ui/restore.ts). A demo
// is that same frozen-answer state, shipped with the app instead of arriving in
// a URL, so the empty state can show real finished work.
//
// HONESTY RULE — the one thing that must never be relaxed: every number in
// `src/data/chitti/demos.json` is FETCHED, never authored. The file is produced
// only by `npm run demos:refresh` (scripts/gen-chitti-demos.mjs), which calls
// the same source adapters and the same compute helpers the live agent calls,
// and fails loudly rather than emitting a partial or invented series. Nobody —
// human or agent — should hand-edit numbers into that file. A fabricated demo
// in a provenance tool is worse than no demo: it would be the app lying in the
// one place a first-time visitor is deciding whether to trust it.
//
// The demo state is validated through `cleanShareState` — the exact same
// whitelist the `#share=` decoder uses — so a malformed or tampered demos.json
// can only ever produce a dropped demo, never a broken or unsafe render.
import { cleanShareState, type ShareStateV1 } from './share';
import demosData from '../../data/chitti/demos.json';

// A demo = the card copy shown on the empty state + the answer state that card
// plays. `sources` is display-only (the labels of the databases the answer drew
// from); the authoritative provenance is the citations inside `state`.
export interface Demo {
  id: string;
  question: string;
  // One line under the question: what this example shows off. Written to name
  // the capability, not to restate the question.
  blurb: string;
  sources: string[];
  state: ShareStateV1;
}

export interface DemosFile {
  // ISO timestamp of the generator run that produced the file, or null when no
  // generator has run yet (the committed placeholder).
  generated: string | null;
  demos: Demo[];
}

function str(x: unknown): string {
  return typeof x === 'string' ? x : '';
}

// Rebuild one demo from untrusted JSON, or null if it can't be rendered. A demo
// with no chart spec AND no answer text is worthless as a demonstration, so it
// is dropped rather than shown as an empty card.
export function cleanDemo(input: unknown): Demo | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const id = str(o.id).trim();
  const question = str(o.question).trim();
  if (!id || !question) return null;
  const state = cleanShareState(o.state);
  if (!state) return null;
  if (!state.spec && !state.answer.trim()) return null;
  return {
    id,
    question,
    blurb: str(o.blurb).trim(),
    sources: Array.isArray(o.sources) ? o.sources.map(str).filter(Boolean) : [],
    state,
  };
}

// Rebuild the whole file. Any demo that fails validation is skipped; the rest
// still render (one bad entry never blanks the empty state).
export function cleanDemos(input: unknown): DemosFile {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const list = Array.isArray(o.demos) ? o.demos : [];
  const demos: Demo[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const demo = cleanDemo(raw);
    if (!demo || seen.has(demo.id)) continue;
    seen.add(demo.id);
    demos.push(demo);
  }
  const generated = str(o.generated);
  return {
    generated: generated && !Number.isNaN(Date.parse(generated)) ? generated : null,
    demos,
  };
}

// The demos this build ships with. Empty until `npm run demos:refresh` has been
// run and its output committed — the UI hides the whole section in that case
// rather than showing an empty shelf.
export const DEMOS: Demo[] = cleanDemos(demosData).demos;
