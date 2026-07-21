// Restore-on-load: render a #share= answer or a #dash= dashboard captured in
// the URL fragment, plus the invalid-link error states. Extracted verbatim.
// Drives the app's own render path (createTurnBlock -> renderChart/renderTable/
// renderCitations/renderTrace ...) so a restored view is pixel-identical to a
// live one. maybeRestoreFromFragment() is invoked once from boot on load.
import type { TurnBlock } from './state';
import {
  consoleEl, allTurns, liveChartTurns, newConvoBtn, composerQ,
  dashView, dashViewTitle, dashViewBack, dashViewBody,
} from './state';
import { rowsToCSV } from '../tools';
import { decodeShareState, type ShareStateV1 } from '../share';
import { decodeDashShare, materializeSharedDashboard, type DashShareV1 } from '../dashboard-share';
import { fmtShareDate } from './dom';
import { createTurnBlock, renderQuestion, setStatus } from './turns';
import { renderTrace, renderFiles } from './trace';
import { renderChart } from './charts';
import { renderTable, renderCitations, renderFinding, renderVerification, renderSharedVerification, renderRunningTotal } from './evidence';
import { renderSharedDashboard, resetSharedDashState } from './dashboards-view';


export function renderShareBanner(tb: TurnBlock, state: ShareStateV1) {
  const el = tb.shareBanner;
  el.textContent = '';
  el.style.display = 'block';
  const lead = document.createElement('span');
  lead.className = 'ch-share-banner-lead';
  lead.textContent =
    `Shared answer — generated ${fmtShareDate(state.ts)} · data as fetched then` +
    (state.lossy ? ' · showing charted data only' : '');
  const link = document.createElement('a');
  link.className = 'ch-share-banner-link';
  // Clears the fragment and returns to the live app (a full reload to a clean
  // URL — no share state, fresh session).
  link.href = location.pathname;
  link.textContent = 'ask your own live question →';
  el.appendChild(lead);
  el.appendChild(document.createTextNode(' '));
  el.appendChild(link);
}

// Restore a full answer view from a decoded permalink — no agent run, no key.
// Reuses the live render paths (renderChart / renderTable / renderCitations),
// all of which write text via textContent or escape through esc() before any
// innerHTML, so nothing from the payload is ever injected as markup.
export async function restoreSharedAnswer(state: ShareStateV1) {
  const tb = createTurnBlock();
  tb.isShared = true;
  tb.question = state.q;
  allTurns.push(tb);
  renderShareBanner(tb, state);
  renderQuestion(tb, state.q);
  // No trace panel on a shared view (there is no run to show).
  if (state.spec) {
    liveChartTurns.push(tb); // keep it re-theming/resizing like a live chart
    tb.canvasEl.classList.remove('ch-canvas-pending');
    await renderChart(tb, state.spec);
    tb.renderFlag.style.display = 'none';
  }
  tb.answerSection.style.display = 'block';
  tb.metaSection.style.display = 'block';
  renderFinding(tb, state.answer);
  renderSharedVerification(tb, state.verification);
  renderTable(tb, state.rows, rowsToCSV(state.rows));
  renderCitations(tb, state.citations);
  // Hide the setup console and switch the composer to "new conversation".
  consoleEl.style.display = 'none';
  newConvoBtn.style.display = '';
  composerQ.placeholder = 'Ask your own live question…';
}

export function renderShareError() {
  consoleEl.style.display = 'none';
  const tb = createTurnBlock();
  allTurns.push(tb);
  const el = tb.shareBanner;
  el.style.display = 'block';
  el.classList.add('ch-share-banner-error');
  el.textContent = '';
  const lead = document.createElement('span');
  lead.className = 'ch-share-banner-lead';
  lead.textContent = 'This share link is invalid — it may be corrupted, truncated, or from a newer version.';
  const link = document.createElement('a');
  link.className = 'ch-share-banner-link';
  link.href = location.pathname;
  link.textContent = 'ask your own live question →';
  el.appendChild(lead);
  el.appendChild(document.createTextNode(' '));
  el.appendChild(link);
}

// Invalid #dash= link: open the dashboards overlay showing a clear error and a
// way back to the live app. No tiles, no controls — never a half-rendered view.
export function renderDashShareError() {
  resetSharedDashState();
  consoleEl.style.display = 'none';
  dashView.hidden = false;
  document.body.classList.add('ch-dashview-open');
  dashViewTitle.textContent = 'Shared dashboard';
  dashViewBack.setAttribute('aria-label', 'Leave shared dashboard');
  dashViewBody.innerHTML = '';
  const banner = document.createElement('div');
  banner.className = 'ch-share-banner ch-share-banner-error ch-dash-shared-banner';
  banner.setAttribute('role', 'note');
  banner.setAttribute('data-testid', 'dash-share-error');
  const lead = document.createElement('span');
  lead.className = 'ch-share-banner-lead';
  lead.textContent = 'This shared dashboard link is invalid — it may be corrupted, truncated, or from a newer version.';
  const link = document.createElement('a');
  link.className = 'ch-share-banner-link';
  link.href = location.pathname;
  link.textContent = 'open the live app →';
  banner.appendChild(lead);
  banner.appendChild(document.createTextNode(' '));
  banner.appendChild(link);
  dashViewBody.appendChild(banner);
  requestAnimationFrame(() => dashViewBack.focus());
}

// On load, if the URL carries a #share= fragment, restore that answer view
// instead of the empty app. Defensive: any decode failure shows a clear
// invalid-link state and never crashes the page or executes payload content.
export async function maybeRestoreFromFragment() {
  const hash = location.hash || '';
  // A URL carries only ONE of these fragments. #share= restores an answer view;
  // #dash= restores a read-only shared dashboard. Distinct prefixes, checked in
  // order; neither ever reaches a server (both are fragments).
  const share = hash.match(/^#share=(.+)$/);
  if (share) {
    let state: ShareStateV1 | null = null;
    try {
      state = await decodeShareState(decodeURIComponent(share[1]));
    } catch {
      state = null;
    }
    if (!state) { renderShareError(); return; }
    try {
      await restoreSharedAnswer(state);
    } catch (err) {
      console.error('share restore failed', err);
      renderShareError();
    }
    return;
  }
  const dash = hash.match(/^#dash=(.+)$/);
  if (dash) {
    let state: DashShareV1 | null = null;
    try {
      state = await decodeDashShare(decodeURIComponent(dash[1]));
    } catch {
      state = null;
    }
    if (!state) { renderDashShareError(); return; }
    try {
      consoleEl.style.display = 'none';
      renderSharedDashboard(state);
      requestAnimationFrame(() => dashViewBack.focus());
    } catch (err) {
      console.error('dashboard share restore failed', err);
      renderDashShareError();
    }
  }
}
