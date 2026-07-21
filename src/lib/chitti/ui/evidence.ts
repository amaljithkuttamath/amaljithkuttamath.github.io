// Evidence + answer rendering: the data table (+ CSV-linked chart<->row
// hover), citations ledger, the confidence-tinted finding, the answer-level
// verification cue, and the running token/cost total. Extracted verbatim.
// Table<->chart hover reaches into charts.ts (highlightPointForRow/
// downplayPointForRow); everything else is a pure render of its args + TurnBlock.
import type { TurnBlock } from './state';
import { INDICATOR_MAP } from './state';
import type { DataRow, Citation } from '../tools';
import type { AgentOutput, TraceEvent } from '../agent';
import { matchRowToPoint } from '../chart-link';
import { verificationCueText, verificationStampLabel } from '../a11y';
import { esc, mdToHtml, fmtRange, fmtFetchedAt, formatTokens } from './dom';
import { highlightPointForRow, downplayPointForRow } from './charts';

// ── Data table + CSV ───────────────────────────────────────────────────
export function renderTable(tb: TurnBlock, rows: DataRow[], csv: string) {
  tb.lastRows = rows;
  tb.lastCSV = csv;
  tb.activeRowIndex = -1; // fresh table DOM ⇒ no highlight carried over
  if (!rows.length) { tb.dataDetails.style.display = 'none'; return; }
  tb.dataDetails.style.display = 'block';
  tb.dataCount.textContent = String(rows.length);
  const head = '<thead><tr><th scope="col">Country</th><th scope="col">ISO3</th><th scope="col">Year</th><th scope="col">Value</th></tr></thead>';
  const shown = rows.slice(0, 500);
  const body =
    '<tbody>' +
    shown
      .map(
        (r, i) =>
          `<tr data-row="${i}"><td>${esc(r.country)}</td><td>${esc(r.iso3)}</td><td>${r.year}</td><td>${
            r.value === null ? '—' : r.value
          }</td></tr>`
      )
      .join('') +
    (rows.length > 500 ? `<tr><td colspan="4" class="ch-table-more">… ${rows.length - 500} more rows (in CSV)</td></tr>` : '') +
    '</tbody>';
  tb.tableEl.innerHTML = head + body;
  wireTableLinking(tb, shown);
}

// Make every evidence row that corresponds to a visible chart point
// interactive: hover/focus highlights the point (+ tooltip), leave/blur
// clears it, and the row becomes keyboard-focusable with an aria-label.
// Rows with no matching point (chart not built yet, scatter, or a value not
// plotted) are left as plain, inert text.
export function wireTableLinking(tb: TurnBlock, shown: DataRow[]) {
  if (!tb.lastSpec) return;
  for (const tr of tb.tableEl.querySelectorAll<HTMLTableRowElement>('tbody tr[data-row]')) {
    const idx = Number(tr.dataset.row);
    const row = shown[idx];
    if (!row || !matchRowToPoint(tb.lastSpec, row)) continue;
    tr.classList.add('ch-row-linkable');
    tr.tabIndex = 0;
    tr.setAttribute('aria-label', 'highlight this point on the chart');
    const enter = () => highlightPointForRow(tb, row);
    const leave = () => downplayPointForRow(tb, row);
    tr.addEventListener('pointerenter', enter);
    tr.addEventListener('pointerleave', leave);
    tr.addEventListener('focus', enter);
    tr.addEventListener('blur', leave);
  }
}


// ── Minimal markdown ────────────────────────────────────────────────────

// ── Confidence-tinted finding text ─────────────────────────────────────
// Per-word log-probability, when known. `null`/undefined means "no signal
// for this word" — rendered as plain default-color text, no tint, no
// underline, no title. Real logprobs are provider-dependent (OpenAI only,
// today — see the design spec's "Logprob availability is provider-
// dependent" section) and agent.ts/providers.ts do not plumb them through
// yet; wiring that up is explicitly a stretch goal/follow-up, not part of
// this pass. `runAgent()` never returns logprobs today, so in the live app
// this always takes the "no data" branch below and renders plain text —
// real graceful degradation, not a fallback that merely looks like one.
export interface WordLogprob { word: string; logprob: number }

// Below this logprob, a word is tinted "uncertain". Roughly -1.5 nats is a
// reasonable rule of thumb for "the model wasn't very sure of this token."
export const LOW_CONFIDENCE_THRESHOLD = -1.5;

export function renderFinding(tb: TurnBlock, text: string, logprobs?: WordLogprob[]) {
  tb.findingEl.textContent = '';
  if (!text) return;
  if (!logprobs || !logprobs.length) {
    // No confidence signal available for this run. Render the model's
    // markdown: full block rendering for prose explanations, inline-only
    // (bold/code/em) for the one-line finding.
    tb.findingEl.innerHTML = tb.findingEl.classList.contains('ch-finding-prose')
      ? mdToHtml(text)
      : inlineMd(esc(text));
    return;
  }
  // Confidence data is present: render word-by-word so low-confidence
  // words get the dotted-underline tint and a hover title with the exact
  // logprob value, per spec.
  logprobs.forEach((wl, i) => {
    const span = document.createElement('span');
    span.textContent = wl.word + (i < logprobs.length - 1 ? ' ' : '');
    if (wl.logprob < LOW_CONFIDENCE_THRESHOLD) {
      span.className = 'ch-conf-word ch-conf-word-lo';
      span.title = `logprob ${wl.logprob.toFixed(2)}`;
    }
    tb.findingEl.appendChild(span);
  });
}

// ── Answer-level verification cue ───────────────────────────────────────
// The three honest states, keyed off the structured verdict (never a
// defaulted pass). Verified → nothing here (the amber VERIFIED stamp lives in
// the trace receipt; the answer stays clean). Could-not-verify → a muted,
// dashed "unverified" tag naming the first doubted claim. Verification
// unavailable → a muted, dotted tag saying so plainly. Amber is never used
// here — it is reserved for the genuine stamp.
export function renderVerification(tb: TurnBlock, v: AgentOutput['verification']) {
  const el = tb.verifyEl;
  el.textContent = '';
  el.className = 'ch-verify';
  const text = verificationCueText(v);
  if (!text) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const tag = document.createElement('span');
  tag.className = 'ch-verify-tag';
  // The tag's own text is the full screen-reader equivalent — the dashed vs.
  // dotted border only tints the two states apart visually.
  el.classList.add(v!.status === 'unavailable' ? 'ch-verify-unavailable' : 'ch-verify-unverified');
  tag.textContent = text;
  el.appendChild(tag);
}

// ── Shared-answer verification (backlog #15) ─────────────────────────────
// A restored permalink has no live trace, so the amber VERIFIED stamp (which
// lives in the trace receipt on a live run) is never shown. Instead ALL three
// verdicts render here as a muted, "at time of generation" tag — a frozen
// snapshot must never masquerade as freshly verified.
export function renderSharedVerification(tb: TurnBlock, v: AgentOutput['verification']) {
  const el = tb.verifyEl;
  el.textContent = '';
  el.className = 'ch-verify ch-verify-shared';
  if (!v) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  let text: string;
  if (v.status === 'verified') {
    text = 'verified at time of generation — passed a second-model check';
  } else if (v.status === 'unavailable') {
    text = 'verification unavailable at time of generation — provider error';
    el.classList.add('ch-verify-unavailable');
  } else {
    const reason = v.issues && v.issues.length ? v.issues[0] : 'the finding could not be confirmed';
    text = 'could not verify at time of generation — ' + reason;
    el.classList.add('ch-verify-unverified');
  }
  const tag = document.createElement('span');
  tag.className = 'ch-verify-tag';
  tag.textContent = text;
  el.appendChild(tag);
}

// ── Running token + cost total ──────────────────────────────────────────
// Per spec: a dashed-rule totals line near the bottom of the rail,
// combining the run's total token count (summed from each trace event's
// own per-step `tokens`, which agent.ts already attributes one turn's
// usage to) with the run-level `estimateCost` dollar figure computed by
// agent.ts and returned once as `out.cost`.
export function renderRunningTotal(tb: TurnBlock, trace: TraceEvent[], cost: number) {
  const totalTokens = trace.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
  if (!totalTokens && !cost) { tb.railTotal.style.display = 'none'; return; }
  tb.railTotal.style.display = 'inline';
  const costTxt = cost > 0 ? `$${cost.toFixed(4)}` : 'free';
  tb.railTotal.textContent = `${formatTokens(totalTokens)} · ${costTxt}`;
}

// ── Citations ──────────────────────────────────────────────────────────
export function renderCitations(tb: TurnBlock, citations: Citation[]) {
  if (!citations.length) { tb.citeEl.style.display = 'none'; tb.citeEl.innerHTML = ''; return; }
  tb.citeEl.style.display = 'block';
  const rows = citations.map((c) => {
    const name = INDICATOR_MAP[c.indicatorId] || c.indicatorName || c.indicatorId;
    const where = c.countries.length ? c.countries.join(', ') : 'all countries';
    const vintage = c.sourceUpdated
      ? `<span class="ch-cite-vintage">source updated ${esc(c.sourceUpdated)}</span>`
      : '';
    return (
      '<li class="ch-cite-item">' +
      `<span class="ch-cite-src">${esc(c.sourceLabel)}</span>` +
      `<a class="ch-cite-ind" href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(name)} <span class="ch-cite-id">(${esc(c.indicatorId)})</span></a>` +
      '<span class="ch-cite-facets">' +
      `<span class="ch-cite-facet">${esc(where)}</span>` +
      `<span class="ch-cite-facet">${esc(fmtRange(c.yearRange))}</span>` +
      `<span class="ch-cite-facet">fetched ${esc(fmtFetchedAt(c.fetchedAt))}</span>` +
      vintage +
      '</span>' +
      '</li>'
    );
  });
  tb.citeEl.innerHTML =
    '<div class="ch-cite-head">References — every number fetched live &amp; cited</div>' +
    '<ol class="ch-cite-list">' + rows.join('') + '</ol>';
}
