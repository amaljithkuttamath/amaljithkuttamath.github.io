// demos-view.ts — the worked examples on the empty state.
//
// The problem this solves: Chitti is BYOK, so a first-time visitor used to face
// a key form and an empty page — nothing on screen showed what the app produces
// until after they'd gone and got an API key. These cards let them see a real,
// finished, cited answer first, with no key and no model call: clicking one
// renders a pre-fetched answer state through the SAME path a `#share=` link
// uses (restoreSharedAnswer), so what they see is the genuine article — live
// chart, evidence table, citation ledger, working CSV download — not a mockup.
//
// Every card is built with textContent (never innerHTML) since the copy comes
// from a generated JSON file; nothing here can inject markup.
import { DEMOS, type Demo } from '../demos';
import { demosSection, demoCards, consoleEl, allTurns } from './state';
import { prefersReducedMotion } from './dom';
import { restoreSharedAnswer } from './restore';

// Guard against double-play (a second click while the first is still mounting
// its chart) and against playing a demo mid-run.
let playing = false;

// Render one card. It is a <button>: keyboard-reachable and announced as an
// action, because clicking it changes the whole view.
function demoCard(demo: Demo): HTMLButtonElement {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'ch-demo-card';
  card.dataset.demoId = demo.id;
  card.setAttribute('aria-label', `See the finished answer to: ${demo.question}`);

  const q = document.createElement('span');
  q.className = 'ch-demo-q';
  q.textContent = demo.question;
  card.appendChild(q);

  if (demo.blurb) {
    const blurb = document.createElement('span');
    blurb.className = 'ch-demo-blurb';
    blurb.textContent = demo.blurb;
    card.appendChild(blurb);
  }

  const foot = document.createElement('span');
  foot.className = 'ch-demo-foot';
  if (demo.sources.length) {
    const src = document.createElement('span');
    src.className = 'ch-demo-src';
    src.textContent = demo.sources.join(' · ');
    foot.appendChild(src);
  }
  const cue = document.createElement('span');
  cue.className = 'ch-demo-cue';
  // States the price plainly — this is the whole point of the section.
  cue.textContent = 'see it →';
  foot.appendChild(cue);
  card.appendChild(foot);

  card.addEventListener('click', () => { void playDemo(demo); });
  return card;
}

// Play a demo: hide the setup panel and render the frozen answer as the first
// turn in the thread. `restoreSharedAnswer` handles the rest of the empty→thread
// transition (console hidden, "+ new question" revealed, composer re-prompted),
// so this stays a thin wrapper — one render path for shared links and demos.
export async function playDemo(demo: Demo) {
  if (playing) return;
  playing = true;
  try {
    await restoreSharedAnswer(demo.state, 'demo');
    const tb = allTurns[allTurns.length - 1];
    tb?.root.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
  } catch (err) {
    // A demo that fails to render must never take the page down — fall back to
    // the plain empty state the visitor already had.
    console.error('demo render failed', err);
    consoleEl.style.display = '';
  } finally {
    playing = false;
  }
}

// Build the section on load. With no demos in the build (demos.json not yet
// generated) the whole section stays hidden rather than showing an empty shelf.
export function renderDemos() {
  if (!demosSection || !demoCards) return;
  if (!DEMOS.length) {
    demosSection.hidden = true;
    return;
  }
  demoCards.textContent = '';
  for (const demo of DEMOS) demoCards.appendChild(demoCard(demo));
  demosSection.hidden = false;
}
