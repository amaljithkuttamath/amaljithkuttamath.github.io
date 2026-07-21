// Chart lifecycle: the ECharts CDN import cache (loadECharts), renderChart,
// the chart<->evidence-table linking glue, and the theme/resize observers that
// keep every live turn/dashboard chart in sync. Extracted verbatim. echartsMod
// is a module-level singleton import cache (shared, not per-turn); per-turn
// chart state lives on the TurnBlock. Registers the theme/resize observers on
// import, exactly as the monolith did at this point in its top-level run.
import type { TurnBlock } from './state';
import { liveChartTurns, liveDashCharts } from './state';
import type { ChartSpec, DataRow } from '../tools';
import { matchPointToRow, matchRowToPoint } from '../chart-link';
import { chartAriaLabel } from '../a11y';
import { prefersReducedMotion } from './dom';
import { buildOption } from './chart-option';

// ── ECharts (dynamic CDN import, dark-theme aware) ─────────────────────
// The loaded module itself stays a true module-level singleton; it's a
// shared CDN import cache, not per-turn state. Each turn's own chart
// instance and its last-rendered spec live on the TurnBlock instead
// (tb.chartInstance, tb.lastSpec).
export let echartsMod: any = null;

export async function loadECharts() {
  if (echartsMod) return echartsMod;
  echartsMod = await import(
    /* @vite-ignore */ 'https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.esm.min.js'
  );
  return echartsMod;
}




// ── Chart ↔ evidence-table linking ─────────────────────────────────────
// Pure index math lives in chart-link.ts (matchPointToRow / matchRowToPoint);
// this half is the DOM/ECharts glue. Nothing here calls the model or mutates
// agent state — it only connects a click/hover to the row that backs it.


// The <tr> elements currently rendered in this turn's evidence table, index
// aligned with the first tb.lastRows entries (the table caps at 500 rows).
export function tableRows(tb: TurnBlock): HTMLTableRowElement[] {
  return Array.from(tb.tableEl.querySelectorAll<HTMLTableRowElement>('tbody tr[data-row]'));
}

export function clearRowHighlight(tb: TurnBlock) {
  if (tb.activeRowIndex < 0) return;
  const prev = tb.tableEl.querySelector('tbody tr.ch-row-active');
  if (prev) prev.classList.remove('ch-row-active');
  tb.activeRowIndex = -1;
}

// Highlight the evidence row at lastRows[index] and bring it into view.
// Toggling: clicking the already-active row's point clears it instead.
export function highlightRow(tb: TurnBlock, index: number) {
  if (index < 0) return;
  if (tb.activeRowIndex === index) { clearRowHighlight(tb); return; }
  clearRowHighlight(tb);
  const rows = tableRows(tb);
  const tr = rows[index];
  if (!tr) return; // row is past the 500-row table cap — nothing to show
  tb.dataDetails.open = true; // reveal the collapsed evidence section
  tr.classList.add('ch-row-active');
  tb.activeRowIndex = index;
  tr.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

// Chart point → evidence row: the shared body of the chart-click handler,
// named so it's one code path whether triggered by a real ECharts click or
// an offline harness. Maps the (series,data) index to its backing row and
// toggles that row's highlight.
export function activateChartPoint(tb: TurnBlock, seriesIndex: number, dataIndex: number) {
  const row = matchPointToRow(tb.lastSpec, seriesIndex, dataIndex, tb.lastRows);
  if (!row) return;
  highlightRow(tb, tb.lastRows.indexOf(row));
}

// (Re)bind click + hover linking to tb.chartInstance. Called on every render
// (renderChart) and on theme re-init, always after a fresh init or with
// `off` first, so listeners never stack across turns.
export function bindChartLinking(tb: TurnBlock) {
  const chart = tb.chartInstance;
  if (!chart) return;
  chart.off('click');
  chart.on('click', (params: any) => {
    if (params?.componentType !== 'series') return;
    activateChartPoint(tb, params.seriesIndex, params.dataIndex);
  });
  // Click on empty chart space (no series target) clears the highlight.
  const zr = chart.getZr();
  zr.off('click');
  zr.on('click', (e: any) => { if (!e.target) clearRowHighlight(tb); });
}

// Table row → chart: highlight + tooltip for the matching point on hover /
// keyboard focus; clear on leave / blur. Graceful no-op when the row has no
// visible point (e.g. its series is hidden by the legend, or type=scatter).
export function highlightPointForRow(tb: TurnBlock, row: DataRow) {
  const chart = tb.chartInstance;
  if (!chart) return;
  const p = matchRowToPoint(tb.lastSpec, row);
  if (!p) return;
  chart.dispatchAction({ type: 'highlight', seriesIndex: p.seriesIndex, dataIndex: p.dataIndex });
  chart.dispatchAction({ type: 'showTip', seriesIndex: p.seriesIndex, dataIndex: p.dataIndex });
}
export function downplayPointForRow(tb: TurnBlock, row: DataRow) {
  const chart = tb.chartInstance;
  if (!chart) return;
  const p = matchRowToPoint(tb.lastSpec, row);
  if (!p) return;
  chart.dispatchAction({ type: 'downplay', seriesIndex: p.seriesIndex, dataIndex: p.dataIndex });
  chart.dispatchAction({ type: 'hideTip' });
}

export async function renderChart(tb: TurnBlock, spec: ChartSpec) {
  tb.lastSpec = spec;
  tb.canvasEl.classList.remove('ch-canvas-pending');
  tb.renderFlag.style.display = 'inline';
  // NOTE: this used to also do `chartWrap.style.display = 'block'` — a
  // leftover from before the chart moved into `.ch-canvas` (task 1), back
  // when `#ch-chart-wrap` literally wrapped the chart itself. That id now
  // belongs to the *answer* section (finding text, confidence badge, data
  // table, citations) below the panel, so flipping it here was prematurely
  // revealing an empty answer section mid-run, every time the chart
  // rendered. The canvas panel's own visibility is handled by `panel`
  // (`.ch-panel`, set to display:grid when the run starts) — the chart
  // itself needs no separate reveal.
  const echarts = await loadECharts();
  if (tb.chartInstance) tb.chartInstance.dispose();
  tb.chartInstance = echarts.init(tb.chartEl, null, { renderer: 'canvas' });
  tb.chartInstance.setOption(buildOption(spec));
  // A fresh chart instance and (soon) a fresh evidence table — drop any
  // highlight carried over from a previous render/turn, then (re)bind the
  // click/hover linking to this instance.
  clearRowHighlight(tb);
  bindChartLinking(tb);
  tb.chartTitle.textContent = spec.title;
  // The canvas reads as nothing to a screen reader, so the container carries
  // a text summary of what it plots (type + title + unit + series).
  tb.chartEl.setAttribute('aria-label', chartAriaLabel(spec));
  // Unit/axis description lives in the card header, not as an ECharts
  // y-axis `name` — long unit strings ("deaths per 1,000 live births")
  // were clipping against the container's left edge when rendered inside
  // the canvas.
  tb.chartUnit.textContent = spec.y_axis || '';
  tb.renderFlag.style.display = 'none';
}

// Turn blocks whose chart is still "live" (wired to theme/resize), i.e.


// Re-theme every live turn's chart if the site theme toggles.
const themeObserver = new MutationObserver(() => {
  for (const tb of liveChartTurns) {
    if (tb.chartInstance && tb.lastSpec) {
      tb.chartInstance.dispose();
      tb.chartInstance = echartsMod.init(tb.chartEl, null, { renderer: 'canvas' });
      tb.chartInstance.setOption(buildOption(tb.lastSpec));
      // New instance ⇒ its listeners are gone; re-bind linking. The table
      // DOM (and any active-row highlight) is untouched by a re-theme, so
      // don't clear it here — only re-wire the chart-side events.
      bindChartLinking(tb);
    }
  }
  // Dashboard tiles re-theme the same way (no chart↔table linking there).
  for (const t of liveDashCharts) {
    if (t.inst && echartsMod) {
      t.inst.dispose();
      t.inst = echartsMod.init(t.el, null, { renderer: 'canvas' });
      t.inst.setOption(buildOption(t.spec));
      t.el.setAttribute('aria-label', chartAriaLabel(t.spec));
    }
  }
});
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
window.addEventListener('resize', () => {
  for (const tb of liveChartTurns) tb.chartInstance?.resize();
  for (const t of liveDashCharts) t.inst?.resize();
});
