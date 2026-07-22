import type { ChartSpec, DataRow, Citation } from '../tools';
import { rowsToCSV } from '../tools';
import type { AgentOutput, TraceEvent, ChittiSession } from '../agent';
import {
  createDashboard, addTile, makeTile, listDashboards, loadDashboard, saveDashboard,
  deleteDashboard, serializeDashboard,
} from '../dashboard';
import { encodeDashShare, parseImportedDashboard } from '../dashboard-share';
import { run, allTurns, liveChartTurns, consoleEl, keyIn, dashStore, dashView } from './state';
import { createTurnBlock, renderQuestion } from './turns';
import { renderTrace, renderFiles } from './trace';
import { renderChart, activateChartPoint } from './charts';
import { renderTable, renderCitations, renderFinding, renderVerification } from './evidence';
import { buildShareUrl } from './actions';
import { lockSources } from './config';
import {
  openDashboards, openDashboard, updateDashNavCount, importParsedDashboard,
} from './dashboards-view';

// Test-only seam. When the page is opened with ?chittidebug in the URL, the
// real render path (createTurnBlock → renderQuestion/renderChart/renderTable)
// is exposed so an offline harness can stage a turn through the ACTUAL
// functions — same DOM, same chart↔table linking — without an LLM call. The
// guard is false in normal use, so nothing is exposed in production; it hands
// out render helpers only, never agent/provider/session internals.
export function installDebugSeam() {
  if (new URLSearchParams(location.search).has('chittidebug')) {
    const dbg: any = {
      async stage(
        question: string,
        spec: ChartSpec,
        rows: DataRow[],
        opts?: { finding?: string; citations?: Citation[]; verification?: AgentOutput['verification'] }
      ) {
        const tb = createTurnBlock();
        allTurns.push(tb);
        liveChartTurns.push(tb);
        consoleEl.style.display = 'none';
        tb.panel.style.display = 'block';
        tb.question = question;
        renderQuestion(tb, question);
        await renderChart(tb, spec);
        tb.metaSection.style.display = 'block';
        tb.answerSection.style.display = 'block';
        const finding = opts?.finding ?? 'Staged turn (offline harness).';
        renderFinding(tb, finding);
        if (opts?.verification !== undefined) renderVerification(tb, opts.verification);
        renderTable(tb, rows, rowsToCSV(rows));
        if (opts?.citations && opts.citations.length) renderCitations(tb, opts.citations);
        tb.dataDetails.open = true;
        // Capture the answer state and reveal the share action, exactly as the
        // live completion path does, so the harness can exercise real sharing.
        tb.lastFinding = finding;
        tb.lastCitations = opts?.citations ?? [];
        tb.lastVerification = opts?.verification ?? null;
        tb.shareBtn.style.display = '';
        tb.mdBtn.style.display = '';
        tb.pinBtn.style.display = '';
        dbg.chart = tb.chartInstance;
        dbg.tb = tb;
        return tb.root;
      },
      // Dashboard test hooks: open the view, and clear all saved dashboards so a
      // headless harness starts from a known-empty state. Render helpers only —
      // still no agent/provider/session internals exposed.
      openDashboards() {
        openDashboards();
      },
      clearDashboards() {
        if (!dashStore) return;
        for (const d of listDashboards(dashStore)) deleteDashboard(dashStore, d.id);
        updateDashNavCount();
      },
      // Seed a two-tile dashboard (built through the REAL makeTile/addTile ops,
      // with genuine World Bank citations) so the offline harness can exercise
      // the refresh flow: overriding window.fetch to succeed for one indicator
      // and fail for the other yields a live one-✓-one-✗ refresh log with a
      // stale-marked tile — no LLM, no live egress. Returns the dashboard id.
      seedRefreshFixture(): string | null {
        if (!dashStore) return null;
        const mk = (title: string, indicatorId: string) =>
          makeTile({
            title,
            spec: {
              type: 'line', title, y_axis: 'per 1,000',
              series: [{ name: 'India', data: [[2000, 66.6], [2010, 41.9], [2020, 27.3]] }],
            },
            rows: [
              { country: 'India', iso3: 'IND', year: 2000, value: 66.6, indicator: indicatorId },
              { country: 'India', iso3: 'IND', year: 2010, value: 41.9, indicator: indicatorId },
              { country: 'India', iso3: 'IND', year: 2020, value: 27.3, indicator: indicatorId },
            ],
            citations: [{
              id: `wb:${indicatorId}|IND|2000:2020`, source: 'worldbank', sourceLabel: 'World Bank Open Data',
              indicatorId, indicatorName: title, url: `https://data.worldbank.org/indicator/${indicatorId}`,
              countries: ['IND'], yearRange: { start: 2000, end: 2020 },
              fetchedAt: '2026-07-01T00:00:00.000Z', sourceUpdated: '2024-06-01', rowCount: 3, cached: false,
            }],
          });
        let d = createDashboard('Health board');
        d = addTile(d, mk('GDP per capita', 'SP.DYN.IMRT.IN'));
        d = addTile(d, mk('life expectancy', 'SP.DYN.LE00.IN'));
        saveDashboard(dashStore, d);
        updateDashNavCount();
        return d.id;
      },
      openDashboardById(id: string) {
        if (dashView.hidden) openDashboards();
        openDashboard(id);
      },
      // Build the #dash= permalink for a saved dashboard without touching the
      // clipboard, so a headless harness can capture it and open it in a fresh
      // page to screenshot the read-only shared view. Returns null when the
      // dashboard is missing or too large to fit a link.
      async dashShareUrl(id: string): Promise<string | null> {
        if (!dashStore) return null;
        const dash = loadDashboard(dashStore, id);
        if (!dash) return null;
        const enc = await encodeDashShare(dash);
        return enc.ok ? location.origin + location.pathname + '#dash=' + enc.payload : null;
      },
      // Export a saved dashboard's JSON (the exact bytes the .json download
      // carries), so the harness can exercise export→import without file IO.
      exportDashboardJson(id: string): string | null {
        if (!dashStore) return null;
        const dash = loadDashboard(dashStore, id);
        return dash ? serializeDashboard(dash) : null;
      },
      // Run the REAL import pipeline (parse → prepare fresh id + dedup title →
      // save) over a JSON string and return the new dashboard id, or null on a
      // malformed/oversized file. Never overwrites an existing dashboard.
      importDashboardJson(raw: string): string | null {
        const parsed = parseImportedDashboard(raw);
        if (!parsed) return null;
        return importParsedDashboard(parsed);
      },
      // Build the share URL for the staged turn without touching the clipboard,
      // so a headless harness can capture it deterministically.
      async shareUrl() {
        if (!dbg.tb) return null;
        const built = await buildShareUrl(dbg.tb);
        return built ? built.url : null;
      },
      // Stage a trace through the REAL renderTrace path — same DOM, same
      // receipt/nesting/provenance rendering — from a supplied TraceEvent[]
      // (and optional VFS snapshot for inline-expandable write_file rows). No
      // LLM call: the harness hands over a realistic event sequence (e.g. an
      // execute_js step with nested llm() child receipts) and this drives the
      // app's own renderer over it.
      stageTrace(
        question: string,
        events: any[],
        files?: Record<string, string>,
        citations?: Citation[],
        answer?: { finding?: string; verification?: AgentOutput['verification'] }
      ) {
        const tb = createTurnBlock();
        allTurns.push(tb);
        consoleEl.style.display = 'none';
        tb.panel.style.display = 'block';
        (tb.panel as HTMLDetailsElement).open = true;
        renderQuestion(tb, question);
        if (files) renderFiles(tb, files);
        renderTrace(tb, events as TraceEvent[]);
        // Citations render OUTSIDE the trace, in the evidence section — drive
        // them through the SAME renderCitations path the live run uses (real
        // .ch-meta / .ch-cite containers, no floating DOM), so an offline
        // screenshot exercises the actual references renderer.
        if (citations && citations.length) {
          tb.metaSection.style.display = 'block';
          renderCitations(tb, citations);
        }
        // The answer-level verification cue lives in the answer section, not the
        // trace — drive it through the REAL renderFinding + renderVerification so
        // an offline screenshot exercises the actual honest-state treatment.
        if (answer) {
          tb.answerSection.style.display = 'block';
          renderFinding(tb, answer.finding ?? 'Staged finding.');
          renderVerification(tb, answer.verification ?? null);
        }
        dbg.tb = tb;
        return tb.root;
      },
      // Run the REAL chart-click activation path (matchPointToRow → highlight)
      // for a given point. Used by the offline harness because headless
      // Chromium's synthetic canvas events don't resolve a zrender series-click
      // target, even though hover does — so the ECharts event is stubbed but
      // every line of the app's own linking code still runs.
      activatePoint(seriesIndex: number, dataIndex: number) {
        if (dbg.tb) activateChartPoint(dbg.tb, seriesIndex, dataIndex);
      },
      // Pixel position of a data point, so the harness can issue a real mouse
      // click on the canvas that flows through the actual ECharts listeners.
      pointPixel(seriesIndex: number, dataIndex: number, value: number) {
        const p = dbg.chart?.convertToPixel({ seriesIndex }, [dataIndex, value]);
        const rect = dbg.chart?.getDom()?.getBoundingClientRect();
        return p && rect ? { x: rect.left + p[0], y: rect.top + p[1] } : null;
      },
      // Stop-control harness: drive the REAL submit handler with a stubbed
      // session so the actual running/stopped DOM is exercised with no network.
      // The injected session's ask() streams a couple of receipts, then waits;
      // when the user clicks the (real) stop button, the (real) AbortSignal
      // fires and ask() resolves with an honest aborted output — the same path
      // a live stop takes. Egress stays untouched; this is stubbing, not a run.
      setKey(k: string) {
        keyIn.value = k;
      },
      injectStopSession(over?: { rows?: DataRow[]; citations?: Citation[]; finding?: string }) {
        const rows = over?.rows ?? [];
        const citations = over?.citations ?? [];
        const fake = {
          ask(_q: string, cb: any, sig?: AbortSignal) {
            // Stream a realistic, resolved trace so "N receipts completed" is
            // non-zero and the collapsed panel reads like a real partial run.
            const now = Date.now();
            cb.onTrace([
              { tool: 'find_series', argSummary: 'child mortality', status: 'ok', ts: now, detail: '3 hits' },
              { tool: 'fetch_series', argSummary: 'SP.DYN.IMRT.IN', status: 'ok', ts: now + 1, detail: `${rows.length} rows` },
              { tool: 'execute_js', argSummary: 'rank countries', status: 'running', ts: now + 2 },
            ]);
            cb.onStatus('Working…', 'loading');
            return new Promise((resolve) => {
              const finish = () =>
                resolve({
                  finding: over?.finding ?? '',
                  chartSpec: null,
                  rows,
                  csv: rowsToCSV(rows),
                  indicators: [],
                  citations,
                  confidence: 'low',
                  verifierReport: '',
                  verification: null,
                  cost: 0,
                  retried: false,
                  kind: 'chart',
                  aborted: true,
                });
              if (sig?.aborted) finish();
              else sig?.addEventListener('abort', finish, { once: true });
            });
          },
        };
        // Same closure as `session` — inject directly and lock the picker, as a
        // real first ask() would, so the "+ new question" unlock is exercised.
        run.session = fake as unknown as ChittiSession;
        lockSources();
      },
    };
    (window as any).__chittiDebug = dbg;
    document.documentElement.setAttribute('data-chitti-debug-ready', '1');
  }
}
