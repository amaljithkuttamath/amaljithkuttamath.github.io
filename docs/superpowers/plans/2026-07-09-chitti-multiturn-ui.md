# Chitti Multi-turn Thread UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `chitti.astro`'s single-run UI (one receipt + one canvas + one answer, all singleton IDs) into a stacked thread where each `ask()` call appends a new turn block, only the latest turn is live, and a sticky composer lets the user ask follow-ups.

**Architecture:** The existing per-run markup (status line, receipt rail + canvas panel, answer section) moves into an HTML `<template>` element. Each turn calls `template.content.cloneNode(true)`, appends the clone to a new `#ch-thread` container, and does all DOM lookups scoped to that clone (`clone.querySelector(...)`, never `document.getElementById`) instead of the current module-level singleton constants. `createSession()` (from the agent plan) replaces the current one-shot `runAgent()` call; the session object is created once, on the first submit, and reused for every subsequent submit on the same page load. A "new conversation" control discards the session and clears the thread.

**Tech Stack:** Astro 5 (`.astro` component, scoped `<style>`), vanilla TS in a `<script>` block, ECharts via dynamic CDN import (unchanged). No new dependencies.

## Global Constraints

- Design source: `docs/superpowers/specs/2026-07-09-chitti-multiturn-design.md`.
- Depends on Plan 1 (`docs/superpowers/plans/2026-07-09-chitti-multiturn-agent.md`) being complete: `createSession(cfg): ChittiSession` with `.ask(question, cb): Promise<AgentOutput>`, where `AgentOutput` has a `kind: 'chart' | 'explanation'` field.
- Never use em dashes in code comments or commit messages.
- No Co-Authored-By lines in commits.
- `npm run build` must pass after every task. This repo has no DOM/browser test runner — every task in this plan is verified by running `npm run dev` and driving the page manually (or via the Claude-in-Chrome browser tools if working in an agentic session with browser access), not by automated tests. State exactly what to click/type and what you should see.
- Preserve every existing visual/interaction detail not explicitly called out as changing: receipt styling, ink-stamped VERIFIED badge, torn-edge rail, confidence tinting hook, CSV download, citations, zero-result copy. This plan restructures WHERE these things live in the DOM, not how they look or behave within a single turn.
- The sticky composer docks after the last turn block (not `position: fixed`), per the design doc's own recommendation to start simple.
- BYOK config (provider/model/key) is set once on turn 1 and is not re-shown per turn; it carries forward via the session's `cfg`, which does not change mid-session in this plan (changing provider/model mid-conversation is out of scope — the config controls become read-only-in-effect once a conversation starts, enforced by the console being hidden, not by disabling the inputs).

---

## File Structure

- Modify: `src/pages/apps/chitti.astro` — the only file this plan touches. Every change is within this single file (template markup, script logic, scoped styles).

No other files change. `src/lib/chitti/agent.ts` and `tools.ts` are consumed as-is from Plan 1.

---

## Task 1: Remove the Plan 1 compatibility shim, call createSession() directly

**Files:**
- Modify: `src/pages/apps/chitti.astro:166` (import), `:918-1039` (submit handler)

**Interfaces:**
- Consumes: `createSession` from `../../lib/chitti/agent` (replaces `runAgent`).
- Produces: a module-level `let session: ChittiSession | null = null;` that the submit handler creates on first use and reuses thereafter. This is the seam every later task in this plan builds on.

This task makes the SMALLEST possible change that proves `createSession()` works from the UI: it keeps today's single-turn-looking behavior (fresh page load, one question, one answer) working exactly as before, but now goes through a session object instead of the one-shot wrapper. It does NOT yet add multi-turn DOM (that's Task 2+) — after this task, asking a second question without reloading the page will still visually clobber the first (same as today), but it will now be the SAME session underneath, so Task 2 can layer the thread DOM on top without touching the agent call site again.

- [ ] **Step 1: Change the import**

In `src/pages/apps/chitti.astro`, change:

```ts
import { runAgent } from '../../lib/chitti/agent';
```

to:

```ts
import { createSession, type ChittiSession } from '../../lib/chitti/agent';
```

- [ ] **Step 2: Add the module-level session variable**

Near the top of the `<script>` block, after the existing `const SESSION_KEY = 'chitti:key';` / `const SESSION_PROVIDER = 'chitti:provider';` lines, add:

```ts
  // The multi-turn agent session. Created on the first ask() call and reused
  // for every subsequent one on this page load, so follow-up questions share
  // conversation history and fetched data. Cleared by "new conversation".
  let session: ChittiSession | null = null;
```

- [ ] **Step 3: Replace the runAgent() call site**

In the submit handler, change:

```ts
      const out = await runAgent(cfg, question, {
        onTrace: (events) => renderTrace(events),
        onFiles: (files) => renderFiles(files),
        onChart: (spec) => { void renderChart(spec); },
        onStatus: (msg, kind) => setStatus(kind, msg),
      });
```

to:

```ts
      if (!session) session = createSession(cfg);
      const out = await session.ask(question, {
        onTrace: (events) => renderTrace(events),
        onFiles: (files) => renderFiles(files),
        onChart: (spec) => { void renderChart(spec); },
        onStatus: (msg, kind) => setStatus(kind, msg),
      });
```

- [ ] **Step 4: Verify the build passes**

Run: `npm run build`
Expected: no errors. `AgentOutput.kind` is unused by the UI at this point (added in Task 1 of Plan 1, consumed starting in this plan's Task 4) — this is fine, TypeScript does not error on unused object properties from a returned value.

- [ ] **Step 5: Manually verify a single question still works**

Run: `npm run dev`, open `http://localhost:4321/apps/chitti`, ask a preset question with a working API key. Expected: identical behavior to before this task (receipt fills in, chart renders, answer + citations appear) — this task changed the call site only, not any rendering logic.

- [ ] **Step 6: Commit**

```bash
git add src/pages/apps/chitti.astro
git commit -m "Call createSession() directly from chitti.astro, drop the one-shot wrapper"
```

---

## Task 2: Convert the per-run markup into a `<template>`

**Files:**
- Modify: `src/pages/apps/chitti.astro` (template section of the `.astro` markup, roughly lines 63-157 in the current file — the status line, `ch-panel`, and `ch-answer` section)

**Interfaces:**
- Produces: a `<template id="ch-turn-template">` containing the status line + receipt/canvas panel + answer section, with `ch-thread` as an empty container below it in the live DOM. No script changes yet in this task (that's Task 3) — this task only restructures the markup and confirms the page still builds and the (now-empty, unused) template doesn't break anything visually.

- [ ] **Step 1: Locate and wrap the per-run markup**

In the `.astro` markup, find this existing sequence (status line through the answer section's closing `</section>`):

```astro
    <!-- Status line -->
    <div class="ch-status" id="ch-status" style="display:none">
      <span class="ch-status-dot" id="ch-status-dot"></span>
      <span id="ch-status-msg">Planning…</span>
    </div>

    <!-- The agent at work: receipt-style trace rail (left) + canvas (right) -->
    <section class="ch-panel" id="ch-panel" style="display:none">
      <!-- ... rail and canvas markup, unchanged ... -->
    </section>

    <!-- Answer: finding first, then the receipts -->
    <section class="ch-answer" id="ch-chart-wrap" style="display:none">
      <!-- ... finding, confidence, data table, citations, unchanged ... -->
    </section>
```

Replace it with the SAME markup moved inside a `<template>`, immediately followed by an empty thread container:

```astro
    <template id="ch-turn-template">
      <div class="ch-turn">
        <!-- Status line -->
        <div class="ch-status" style="display:none">
          <span class="ch-status-dot"></span>
          <span class="ch-status-msg">Planning…</span>
        </div>

        <!-- The agent at work: receipt-style trace rail (left) + canvas (right) -->
        <section class="ch-panel" style="display:none">
          <!-- ... rail and canvas markup, unchanged, minus their id attributes (see Step 2) ... -->
        </section>

        <!-- Answer: finding first, then the receipts -->
        <section class="ch-answer" style="display:none">
          <!-- ... finding, confidence, data table, citations, unchanged, minus their id attributes ... -->
        </section>
      </div>
    </template>

    <div class="ch-thread" id="ch-thread"></div>
```

- [ ] **Step 2: Strip every `id` attribute inside the template, keep every `class`**

Every element that had an `id` inside the moved block (`ch-status`, `ch-status-dot`, `ch-status-msg`, `ch-panel`, `ch-rail`, `ch-rail-model`, `ch-render-flag`, `ch-trace`, `ch-rail-total`, `ch-canvas`, `ch-canvas-wait`, `ch-chart-title`, `ch-chart`, `ch-chart-wrap` — now `ch-answer`'s section itself, since `ch-chart-wrap` was that section's id — `ch-finding`, `ch-conf-legend`, `ch-conf`, `ch-data`, `ch-data-count`, `ch-csv`, `ch-table`, `ch-cite`) must have its `id="..."` attribute deleted. Do NOT delete or rename any `class="..."` attribute — Task 3's per-clone lookups use `clone.querySelector('.class-name')`, and every existing scoped `<style>` rule already targets these classes (ids were only ever used for JS `document.getElementById` lookups, confirmed by reading the file's CSS — every style rule uses the class selector, e.g. `.ch-panel { ... }`, not `#ch-panel`).

One exception: `ch-csv`'s button keeps its `type="button"` and `class="ch-csv"` — its `id="ch-csv"` is removed like the others; Task 3 rewires its click listener per-clone.

- [ ] **Step 3: Verify the build passes**

Run: `npm run build`
Expected: no errors. The template's content is inert (browsers do not render `<template>` contents), so the page currently renders with an empty area where the panel/answer used to be — this is expected and temporary; Task 3 makes it functional again.

- [ ] **Step 4: Manually verify the page loads without console errors**

Run: `npm run dev`, open `http://localhost:4321/apps/chitti`, open the browser console. Expected: page loads, header/console/chips/BYOK all look identical to before (this task didn't touch them), no red console errors. Asking a question at this point will throw (the script still references now-removed ids like `$('ch-panel')`) — that's expected and fixed in Task 3, not this task. Do not attempt to ask a question yet.

- [ ] **Step 5: Commit**

```bash
git add src/pages/apps/chitti.astro
git commit -m "Move per-run markup into a template element for per-turn cloning"
```

---

## Task 3: Turn-block manager — clone, scope lookups, wire one turn's rendering

**Files:**
- Modify: `src/pages/apps/chitti.astro` (script section: element lookups at the top, and every render function)

**Interfaces:**
- Produces:
  ```ts
  interface TurnBlock {
    root: HTMLElement;           // the cloned .ch-turn wrapper, appended to #ch-thread
    statusRow: HTMLElement;
    statusDot: HTMLElement;
    statusMsg: HTMLElement;
    panel: HTMLElement;
    railModelEl: HTMLElement;
    traceEl: HTMLElement;
    renderFlag: HTMLElement;
    railTotal: HTMLElement;
    canvasEl: HTMLElement;
    chartEl: HTMLElement;
    chartTitle: HTMLElement;
    answerSection: HTMLElement;
    findingEl: HTMLElement;
    confEl: HTMLElement;
    confLegend: HTMLElement;
    dataDetails: HTMLDetailsElement;
    dataCount: HTMLElement;
    csvBtn: HTMLButtonElement;
    tableEl: HTMLTableElement;
    citeEl: HTMLElement;
    chartInstance: any | null;   // this turn's own ECharts instance
    lastSpec: ChartSpec | null;
    lastRows: DataRow[];
    lastCSV: string;
  }
  function createTurnBlock(): TurnBlock;
  ```
  This is the shape every later task (4, 5, 6) reads and writes. `createTurnBlock()` is called once per `ask()` invocation, appends its `root` to `#ch-thread`, and returns the handle used for the rest of that turn's rendering.

This is the largest task in this plan: every render function (`renderTrace`, `renderFiles`, `renderChart`, `renderTable`, `renderFinding`, `renderRunningTotal`, `renderCitations`, `setStatus`/`hideStatus`) currently reads/writes module-level singleton constants (`traceEl`, `chartEl`, `findingEl`, etc.) and module-level mutable state (`chartInstance`, `lastSpec`, `currentTrace`, `currentFiles`, `startTimes`, `lastRows`, `lastCSV`). All of that state and all of those functions become PER-TURN, taking a `TurnBlock` as their first parameter instead of closing over module-level singletons.

- [ ] **Step 1: Remove the now-dead module-level element constants**

Delete these lines (the ones for elements that used to be singletons and are now inside the template, cloned per turn):

```ts
  const statusRow = $('ch-status');
  const statusDot = $('ch-status-dot');
  const statusMsg = $('ch-status-msg');

  const panel = $('ch-panel');
  const railModelEl = $('ch-rail-model');
  const traceEl = $('ch-trace');
  const renderFlag = $('ch-render-flag');

  const canvasEl = $('ch-canvas');
  const chartWrap = $('ch-chart-wrap');
  const chartEl = $('ch-chart');
  const chartTitle = $('ch-chart-title');
  const findingEl = $('ch-finding');
  const confEl = $('ch-conf');
  const confLegend = $('ch-conf-legend');
  const railTotal = $('ch-rail-total');

  const dataDetails = $('ch-data') as HTMLDetailsElement;
  const dataCount = $('ch-data-count');
  const csvBtn = $('ch-csv') as HTMLButtonElement;
  const tableEl = $('ch-table') as HTMLTableElement;

  const citeEl = $('ch-cite');
```

Keep everything else in the elements section (`providerSel` through `chips`, and `INDICATOR_MAP`) — those are turn-independent, config-level elements that stay module-level singletons, per this plan's Global Constraints.

Also add the new thread/template references in their place:

```ts
  const threadEl = $('ch-thread');
  const turnTemplate = $('ch-turn-template') as HTMLTemplateElement;
```

- [ ] **Step 2: Define the TurnBlock type and createTurnBlock()**

Add this near the top of the script, after the element lookups:

```ts
  interface TurnBlock {
    root: HTMLElement;
    statusRow: HTMLElement;
    statusDot: HTMLElement;
    statusMsg: HTMLElement;
    panel: HTMLElement;
    railModelEl: HTMLElement;
    traceEl: HTMLElement;
    renderFlag: HTMLElement;
    railTotal: HTMLElement;
    canvasEl: HTMLElement;
    chartEl: HTMLElement;
    chartTitle: HTMLElement;
    answerSection: HTMLElement;
    findingEl: HTMLElement;
    confEl: HTMLElement;
    confLegend: HTMLElement;
    dataDetails: HTMLDetailsElement;
    dataCount: HTMLElement;
    csvBtn: HTMLButtonElement;
    tableEl: HTMLTableElement;
    citeEl: HTMLElement;
    chartInstance: any | null;
    lastSpec: ChartSpec | null;
    lastRows: DataRow[];
    lastCSV: string;
    trace: TraceEvent[];
    files: Record<string, string>;
    startTimes: number[];
    question: string;
  }

  function q<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string): T {
    const el = root.querySelector(selector);
    if (!el) throw new Error('Turn block missing expected element: ' + selector);
    return el as T;
  }

  function createTurnBlock(): TurnBlock {
    const fragment = turnTemplate.content.cloneNode(true) as DocumentFragment;
    const root = fragment.querySelector('.ch-turn') as HTMLElement;
    threadEl.appendChild(fragment);

    return {
      root,
      statusRow: q(root, '.ch-status'),
      statusDot: q(root, '.ch-status-dot'),
      statusMsg: q(root, '.ch-status-msg'),
      panel: q(root, '.ch-panel'),
      railModelEl: q(root, '.ch-rail-model'),
      traceEl: q(root, '.ch-trace'),
      renderFlag: q(root, '.ch-render-flag'),
      railTotal: q(root, '.ch-rail-total'),
      canvasEl: q(root, '.ch-canvas'),
      chartEl: q(root, '.ch-chart'),
      chartTitle: q(root, '.ch-chart-title'),
      answerSection: q(root, '.ch-answer'),
      findingEl: q(root, '.ch-finding'),
      confEl: q(root, '.ch-conf'),
      confLegend: q(root, '.ch-conf-legend'),
      dataDetails: q<HTMLDetailsElement>(root, '.ch-data'),
      dataCount: q(root, '.ch-data-count'),
      csvBtn: q<HTMLButtonElement>(root, '.ch-csv'),
      tableEl: q<HTMLTableElement>(root, '.ch-table'),
      citeEl: q(root, '.ch-cite'),
      chartInstance: null,
      lastSpec: null,
      lastRows: [],
      lastCSV: '',
      trace: [],
      files: {},
      startTimes: [],
      question: '',
    };
  }
```

Note: `q()` throws on a missing selector rather than silently returning a nullable value — a missing element here is a template/markup bug (Task 2 must have kept every class), and failing loudly during development is far more useful than a silent `null` that surfaces as "nothing rendered" three functions later.

The ORIGINAL file also has a single module-level `csvBtn.addEventListener('click', ...)` (reading a module-level `lastCSV`) that this task's Step 1 deletion makes dangling — that listener must move to be per-turn, bound inside `createTurnBlock()` itself so it closes over THAT turn's own CSV data. Revise the `createTurnBlock()` body above to bind it just before returning:

```ts
  function createTurnBlock(): TurnBlock {
    const fragment = turnTemplate.content.cloneNode(true) as DocumentFragment;
    const root = fragment.querySelector('.ch-turn') as HTMLElement;
    threadEl.appendChild(fragment);

    const tb: TurnBlock = {
      root,
      statusRow: q(root, '.ch-status'),
      statusDot: q(root, '.ch-status-dot'),
      statusMsg: q(root, '.ch-status-msg'),
      panel: q(root, '.ch-panel'),
      railModelEl: q(root, '.ch-rail-model'),
      traceEl: q(root, '.ch-trace'),
      renderFlag: q(root, '.ch-render-flag'),
      railTotal: q(root, '.ch-rail-total'),
      canvasEl: q(root, '.ch-canvas'),
      chartEl: q(root, '.ch-chart'),
      chartTitle: q(root, '.ch-chart-title'),
      answerSection: q(root, '.ch-answer'),
      findingEl: q(root, '.ch-finding'),
      confEl: q(root, '.ch-conf'),
      confLegend: q(root, '.ch-conf-legend'),
      dataDetails: q<HTMLDetailsElement>(root, '.ch-data'),
      dataCount: q(root, '.ch-data-count'),
      csvBtn: q<HTMLButtonElement>(root, '.ch-csv'),
      tableEl: q<HTMLTableElement>(root, '.ch-table'),
      citeEl: q(root, '.ch-cite'),
      chartInstance: null,
      lastSpec: null,
      lastRows: [],
      lastCSV: '',
      trace: [],
      files: {},
      startTimes: [],
      question: '',
    };

    tb.csvBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const blob = new Blob([tb.lastCSV], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'chitti-data.csv';
      a.click();
      URL.revokeObjectURL(url);
    });

    return tb;
  }
```

This replaces the object-literal-return version shown above in its entirety — `createTurnBlock()` has exactly one implementation, this one, with the CSV listener bound before return.

Also delete the ORIGINAL module-level CSV listener (currently in the script, right after the `renderTable` function):

```ts
  csvBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const blob = new Blob([lastCSV], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chitti-data.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
```

Delete this entire block — it referenced the now-deleted module-level `csvBtn`/`lastCSV` and is fully superseded by the per-turn binding above.

- [ ] **Step 3: Verify the build passes**

Run: `npm run build`
Expected: no errors yet from this task's additions (the render functions below still reference the old deleted module-level constants, so the build WILL fail until Step 4 is also done — if working through this plan step by step rather than task by task, expect a transient red build between Step 2 and Step 4; that's fine, don't stop and debug it, continue to Step 4).

- [ ] **Step 4: Rewrite every render function to take a TurnBlock parameter**

Replace each of the following functions. Where a function used a module-level mutable variable (`currentTrace`, `currentFiles`, `startTimes`, `chartInstance`, `lastSpec`, `lastRows`, `lastCSV`), that state now lives on the `TurnBlock` passed in.

`renderTrace` (was module-level `currentTrace`/`startTimes`, now `tb.trace`/`tb.startTimes`):

```ts
  function renderTrace(tb: TurnBlock, events: TraceEvent[]) {
    tb.panel.style.display = 'grid';
    tb.trace = events;
    const stick =
      tb.traceEl.scrollHeight - tb.traceEl.scrollTop - tb.traceEl.clientHeight < 40;
    const openPaths = new Set(
      Array.from(tb.traceEl.querySelectorAll<HTMLDetailsElement>('details[open]')).map(
        (d) => d.dataset.path || ''
      )
    );
    tb.traceEl.innerHTML = '';
    events.forEach((e, i) => {
      if (tb.startTimes[i] === undefined) tb.startTimes[i] = performance.now();

      if (e.tool === 'reasoning') {
        const rrow = document.createElement('p');
        rrow.className = 'ch-trace-thinking';
        rrow.textContent = e.detail || '';
        tb.traceEl.appendChild(rrow);
        return;
      }

      const row = document.createElement('div');
      row.className = 'ch-trace-row ch-trace-' + e.status;
      const dot = document.createElement('span');
      dot.className = 'ch-trace-dot';
      const body = document.createElement('div');
      body.className = 'ch-trace-body';
      const head = document.createElement('div');
      head.className = 'ch-trace-head';
      const stamp = document.createElement('span');
      stamp.className = 'ch-trace-ts';
      stamp.textContent = formatTs(e.ts);
      head.appendChild(stamp);
      const name = document.createElement('span');
      name.className = 'ch-trace-name';
      name.textContent = e.tool;
      head.appendChild(name);
      const filePath = (e.tool === 'write_file' || e.tool === 'read_file') ? e.argSummary : '';
      const fileContent = filePath ? tb.files[filePath] : undefined;
      if (e.argSummary && fileContent === undefined) {
        const sep = document.createElement('span');
        sep.className = 'ch-trace-sep';
        sep.textContent = '·';
        head.appendChild(sep);
        const arg = document.createElement('span');
        arg.className = 'ch-trace-arg';
        arg.textContent = e.argSummary;
        head.appendChild(arg);
        body.appendChild(head);
      } else if (fileContent !== undefined) {
        const det = document.createElement('details');
        det.className = 'ch-trace-file';
        det.dataset.path = filePath;
        if (openPaths.has(filePath)) det.open = true;
        const sum = document.createElement('summary');
        sum.appendChild(head);
        const sep = document.createElement('span');
        sep.className = 'ch-trace-sep';
        sep.textContent = '·';
        head.appendChild(sep);
        const arg = document.createElement('span');
        arg.className = 'ch-trace-arg';
        arg.textContent = filePath;
        head.appendChild(arg);
        const ext = document.createElement('span');
        ext.className = 'ch-file-ext ch-file-ext-' + fileExt(filePath);
        ext.textContent = fileExt(filePath);
        sum.appendChild(ext);
        const pre = document.createElement('pre');
        pre.className = 'ch-file-body';
        pre.textContent = fileContent;
        det.appendChild(sum);
        det.appendChild(pre);
        body.appendChild(det);
      } else {
        body.appendChild(head);
      }
      if (e.detail && e.tool !== 'verify') {
        const d = document.createElement('div');
        d.className = 'ch-trace-detail';
        d.textContent = e.detail;
        body.appendChild(d);
      }
      if (e.tool === 'verify' && e.pass === true) {
        const stampEl = document.createElement('span');
        stampEl.className = 'ch-stamp';
        stampEl.textContent = 'verified';
        body.appendChild(stampEl);
      } else if (e.tool === 'verify' && e.status === 'error') {
        const note = document.createElement('div');
        note.className = 'ch-trace-detail';
        note.textContent = 'not verified — retrying';
        body.appendChild(note);
      }
      const metaCol = document.createElement('div');
      metaCol.className = 'ch-trace-meta-col';
      const meta = document.createElement('span');
      meta.className = 'ch-trace-meta';
      if (e.status === 'ok') {
        const ms = Math.round(performance.now() - tb.startTimes[i]);
        meta.textContent = ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
      } else if (e.status === 'error') {
        meta.textContent = 'error';
      } else {
        meta.textContent = '…';
      }
      metaCol.appendChild(meta);
      if (typeof e.tokens === 'number' && e.tokens > 0) {
        const tok = document.createElement('span');
        tok.className = 'ch-trace-tokens';
        tok.textContent = formatTokens(e.tokens);
        metaCol.appendChild(tok);
      }
      row.appendChild(dot);
      row.appendChild(body);
      row.appendChild(metaCol);
      tb.traceEl.appendChild(row);
    });
    if (stick) tb.traceEl.scrollTop = tb.traceEl.scrollHeight;
  }
```

`renderFiles` (was module-level `currentFiles`, now `tb.files`):

```ts
  function renderFiles(tb: TurnBlock, files: Record<string, string>) {
    tb.panel.style.display = 'grid';
    tb.files = files;
    renderTrace(tb, tb.trace);
  }
```

`renderChart` (was module-level `chartInstance`/`lastSpec`, now `tb.chartInstance`/`tb.lastSpec`):

```ts
  async function renderChart(tb: TurnBlock, spec: ChartSpec) {
    tb.lastSpec = spec;
    tb.canvasEl.classList.remove('ch-canvas-pending');
    tb.panel.classList.remove('ch-panel-pending');
    tb.renderFlag.style.display = 'inline';
    const echarts = await loadECharts();
    if (tb.chartInstance) tb.chartInstance.dispose();
    tb.chartInstance = echarts.init(tb.chartEl, null, { renderer: 'canvas' });
    tb.chartInstance.setOption(buildOption(spec));
    tb.chartTitle.textContent = spec.title;
    tb.renderFlag.style.display = 'none';
  }
```

`renderTable` (was module-level `lastRows`/`lastCSV`, now `tb.lastRows`/`tb.lastCSV`):

```ts
  function renderTable(tb: TurnBlock, rows: DataRow[], csv: string) {
    tb.lastRows = rows;
    tb.lastCSV = csv;
    if (!rows.length) { tb.dataDetails.style.display = 'none'; return; }
    tb.dataDetails.style.display = 'block';
    tb.dataCount.textContent = String(rows.length);
    const head = '<thead><tr><th>Country</th><th>ISO3</th><th>Year</th><th>Value</th></tr></thead>';
    const shown = rows.slice(0, 500);
    const body =
      '<tbody>' +
      shown
        .map(
          (r) =>
            `<tr><td>${esc(r.country)}</td><td>${esc(r.iso3)}</td><td>${r.year}</td><td>${
              r.value === null ? '—' : r.value
            }</td></tr>`
        )
        .join('') +
      (rows.length > 500 ? `<tr><td colspan="4" class="ch-table-more">… ${rows.length - 500} more rows (in CSV)</td></tr>` : '') +
      '</tbody>';
    tb.tableEl.innerHTML = head + body;
  }
```

`renderFinding` (no module-level state, just took `findingEl` implicitly — now takes `tb`):

```ts
  function renderFinding(tb: TurnBlock, text: string, logprobs?: WordLogprob[]) {
    tb.findingEl.textContent = '';
    if (!text) return;
    if (!logprobs || !logprobs.length) {
      tb.findingEl.textContent = text;
      tb.confLegend.style.display = 'none';
      return;
    }
    logprobs.forEach((wl, i) => {
      const span = document.createElement('span');
      span.textContent = wl.word + (i < logprobs.length - 1 ? ' ' : '');
      if (wl.logprob < LOW_CONFIDENCE_THRESHOLD) {
        span.className = 'ch-conf-word ch-conf-word-lo';
        span.title = `logprob ${wl.logprob.toFixed(2)}`;
      }
      tb.findingEl.appendChild(span);
    });
    tb.confLegend.style.display = 'flex';
  }
```

`renderRunningTotal`:

```ts
  function renderRunningTotal(tb: TurnBlock, trace: TraceEvent[], cost: number) {
    const totalTokens = trace.reduce((sum, e) => sum + (e.tokens ?? 0), 0);
    if (!totalTokens && !cost) { tb.railTotal.style.display = 'none'; return; }
    tb.railTotal.style.display = 'block';
    const costTxt = cost > 0 ? `$${cost.toFixed(4)}` : 'free';
    tb.railTotal.textContent = `${formatTokens(totalTokens)} · ${costTxt}`;
  }
```

`renderCitations` (only reads module-level `INDICATOR_MAP`, which stays a true singleton — the curated indicator name lookup is the same for every turn, not per-turn state; only its DOM target moves):

```ts
  function renderCitations(tb: TurnBlock, indicators: { id: string; name: string }[]) {
    if (!indicators.length) { tb.citeEl.style.display = 'none'; return; }
    tb.citeEl.style.display = 'block';
    const iso = new Date().toISOString().slice(0, 10);
    const parts = indicators.map((ind) => {
      const name = INDICATOR_MAP[ind.id] || ind.name || ind.id;
      const url = 'https://data.worldbank.org/indicator/' + encodeURIComponent(ind.id);
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${esc(ind.id)} — ${esc(name)}</a>`;
    });
    tb.citeEl.innerHTML =
      'Data from <a href="https://data.worldbank.org" target="_blank" rel="noopener noreferrer">World Bank Open Data</a> · Indicator: ' +
      parts.join(' · ') +
      ' · Retrieved ' + iso;
  }
```

`setStatus`/`hideStatus` (per-turn now):

```ts
  function setStatus(tb: TurnBlock, kind: 'loading' | 'ok' | 'error', msg: string) {
    tb.statusRow.style.display = 'flex';
    tb.statusDot.className = 'ch-status-dot ch-status-' + kind;
    tb.statusMsg.textContent = msg;
  }
```

(`hideStatus` is unused in the current file's actual flow — grep confirms no call site — so it is dropped rather than ported. If a later task turns out to need it, re-add it scoped to `tb` the same way.)

- [ ] **Step 5: Update the theme-observer and resize listener**

The current module-level `themeObserver`/`resize` listener re-renders ONE chart instance. With per-turn chart instances, this must iterate every turn that has a live chart. Replace:

```ts
  const themeObserver = new MutationObserver(() => {
    if (chartInstance && lastSpec) {
      chartInstance.dispose();
      chartInstance = echartsMod.init(chartEl, null, { renderer: 'canvas' });
      chartInstance.setOption(buildOption(lastSpec));
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('resize', () => chartInstance && chartInstance.resize());
```

with a design that tracks all turn blocks with a live (non-superseded) chart. Add a module-level array, populated by Task 4/5's turn lifecycle:

```ts
  // Turn blocks whose chart is still "live" (wired to theme/resize) — i.e.
  // not yet superseded by a later turn. Task 5 removes an entry from this
  // array when that turn's chart is frozen.
  const liveChartTurns: TurnBlock[] = [];

  const themeObserver = new MutationObserver(() => {
    for (const tb of liveChartTurns) {
      if (tb.chartInstance && tb.lastSpec) {
        tb.chartInstance.dispose();
        tb.chartInstance = echartsMod.init(tb.chartEl, null, { renderer: 'canvas' });
        tb.chartInstance.setOption(buildOption(tb.lastSpec));
      }
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('resize', () => {
    for (const tb of liveChartTurns) tb.chartInstance?.resize();
  });
```

This task does not yet populate or prune `liveChartTurns` (Task 4 adds each new turn to it; Task 5 removes superseded ones) — declaring it here just gets the listener code in place with the right shape.

- [ ] **Step 6: Verify the build passes**

Run: `npm run build`
Expected: no errors. The submit handler (Task 4) still calls the old per-turn functions without a `tb` argument at this point, so this step's build WILL still fail until Task 4 is done — same transient-red-build note as Step 3. If executing this plan strictly task-by-task (recommended), Task 4 immediately follows and resolves this.

- [ ] **Step 7: Commit**

```bash
git add src/pages/apps/chitti.astro
git commit -m "Scope all render functions to a per-turn TurnBlock instead of module singletons"
```

---

## Task 4: Wire the submit handler to create a turn block per ask()

**Files:**
- Modify: `src/pages/apps/chitti.astro` (the `askForm.addEventListener('submit', ...)` handler)

**Interfaces:**
- Consumes: `createTurnBlock()`, `renderTrace(tb, ...)`, `renderFiles(tb, ...)`, `renderChart(tb, ...)`, `renderTable(tb, ...)`, `renderFinding(tb, ...)`, `renderRunningTotal(tb, ...)`, `renderCitations(tb, ...)`, `setStatus(tb, ...)` (all from Task 3), `liveChartTurns` array (from Task 3 Step 5), `session`/`createSession` (from Task 1).
- Produces: every `ask()` call results in exactly one new `TurnBlock` appended to `#ch-thread`, fully wired end to end — this task alone (before Task 5's collapsing/Task 6's composer) already produces a WORKING, if visually repetitive, multi-turn page: asking twice appends two full turn blocks, each with its own live chart, both remaining fully expanded. Task 5 adds the "only latest is live" collapsing behavior on top of this.

- [ ] **Step 1: Rewrite the submit handler**

Replace the entire `askForm.addEventListener('submit', async (e) => { ... })` body with:

```ts
  askForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (running) return;
    const question = qIn.value.trim() || (qIn.placeholder || '').trim();
    if (!question) return;

    const apiKey = keyIn.value.trim();
    if (!apiKey) {
      byokDetails.open = true;
      byokDetails.classList.remove('ch-byok-nudge');
      void byokDetails.offsetWidth;
      byokDetails.classList.add('ch-byok-nudge');
      keyIn.focus();
      return;
    }

    const cfg: ProviderConfig = {
      provider: currentProvider(),
      model: modelSel.value,
      apiKey,
      requestReasoning: modelSel.selectedOptions[0]?.dataset.reasoning === '1',
    };

    running = true;
    askBtn.disabled = true;
    askBtn.textContent = 'Working…';
    byokDetails.open = false;
    qIn.value = '';

    const tb = createTurnBlock();
    liveChartTurns.push(tb);
    tb.canvasEl.classList.add('ch-canvas-pending');
    tb.panel.classList.add('ch-panel-pending');
    setStatus(tb, 'loading', 'Planning…');
    tb.panel.style.display = 'grid';
    consoleEl.classList.add('ch-console-compact');
    renderFiles(tb, {});

    const modelLabel = modelSel.selectedOptions[0]?.textContent?.trim() || cfg.model;
    tb.railModelEl.textContent = `${modelLabel} / ${cfg.provider}`;

    try {
      if (!session) session = createSession(cfg);
      const out = await session.ask(question, {
        onTrace: (events) => renderTrace(tb, events),
        onFiles: (files) => renderFiles(tb, files),
        onChart: (spec) => { void renderChart(tb, spec); },
        onStatus: (msg, kind) => setStatus(tb, kind, msg),
      });

      if (out.chartSpec && !tb.chartInstance) await renderChart(tb, out.chartSpec);

      tb.answerSection.style.display = 'block';

      if (out.kind === 'chart' && !out.chartSpec) {
        tb.findingEl.classList.add('ch-finding-empty');
        renderFinding(
          tb,
          out.finding || 'No chart could be built for this question — try rephrasing or narrowing it to a specific indicator.'
        );
        renderTable(tb, [], '');
        renderCitations(tb, []);
        renderRunningTotal(tb, tb.trace, out.cost);
        setStatus(tb, 'error', 'No result' + (out.retried ? ' (retried once, still nothing)' : ''));
        tb.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }

      if (out.kind === 'explanation') {
        renderFinding(tb, out.finding || 'No explanation produced.');
        renderRunningTotal(tb, tb.trace, out.cost);
        setStatus(tb, 'ok', 'Done' + (out.cost > 0 ? ` · ~$${out.cost.toFixed(4)}` : ' · free'));
        tb.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }

      renderFinding(tb, out.finding || 'No finding produced.');
      if (out.confidence === 'low') tb.confEl.style.display = 'inline-block';
      renderTable(tb, out.rows, out.csv);
      renderCitations(tb, out.indicators);
      renderRunningTotal(tb, tb.trace, out.cost);

      const costTxt = out.cost > 0 ? ` · ~$${out.cost.toFixed(4)}` : ' · free';
      setStatus(tb, 'ok', 'Done' + (out.retried ? ' (retried once)' : '') + costTxt);
      tb.root.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err: any) {
      console.error(err);
      setStatus(tb, 'error', 'Run failed: ' + (err?.message ?? String(err)));
    } finally {
      running = false;
      askBtn.disabled = false;
      askBtn.textContent = 'Ask';
    }
  });
```

Note the three-way branch replacing the old `if (!out.chartSpec) { ... }` / fall-through structure: `out.kind === 'chart' && !out.chartSpec` (the genuine zero-result error path, unchanged copy and behavior from before), `out.kind === 'explanation'` (new: a normal answer, no data table or citations since nothing new was fetched, no error status), and the implicit third case (`out.kind === 'chart' && out.chartSpec` truthy — today's normal success path, unchanged).

Note also that the no-API-key guard no longer calls `setStatus(...)`: the ORIGINAL code called it against a single module-level status row that was visible even before any run started. In the per-turn model there is no such shared row to write into, and this guard clause fires before `createTurnBlock()` runs, so there is no `tb` to write into either. `byokDetails` opening, the nudge animation, and focusing the key input already give the user clear, immediate feedback about what's wrong, so no status line is needed here.

- [ ] **Step 2: Verify the build passes**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Manually verify two sequential questions both render fully**

Run: `npm run dev`, open `http://localhost:4321/apps/chitti`. Ask a preset question, wait for it to finish (chart + finding + citations visible). Then type a second, different question (e.g. a different preset chip) and submit again WITHOUT reloading the page.

Expected:
- Two full turn blocks now appear stacked in `#ch-thread`, each with its own receipt rail, its own chart, its own finding/citations. Both are fully expanded (Task 5 has not run yet, so nothing collapses).
- The SECOND turn's question, when it references "this data" or similar, should reflect Plan 1's turn-2+ addendum behavior (verify against Plan 1's own manual smoke test, not required again here — this task is about DOM plumbing, not agent behavior).
- No console errors.
- The top console (title/badges/textarea/chips/BYOK) is still visible and usable for the second ask (Task 6 adds the sticky composer and hides the top console on turn 2+; that hasn't happened yet in this task, which is fine).

- [ ] **Step 4: Commit**

```bash
git add src/pages/apps/chitti.astro
git commit -m "Wire submit handler to append one turn block per ask() call"
```

---

## Task 5: Collapse superseded turns, freeze their charts

**Files:**
- Modify: `src/pages/apps/chitti.astro`

**Interfaces:**
- Consumes: `liveChartTurns` (Task 3), `TurnBlock` (Task 3, including its `question: string` field), the submit handler (Task 4).
- Produces: `collapseTurn(tb: TurnBlock): void` — called on every PREVIOUS turn block at the start of a new `ask()` call, before `createTurnBlock()` for the new one. Reads `tb.question` (already set by Task 4's submit handler) and `tb.findingEl.textContent` to build the collapsed summary line.

- [ ] **Step 1: Set the question text on the turn block**

`TurnBlock` already has a `question: string` field (added in Task 3, initialized to `''` there since the actual question text isn't known until the submit handler runs). Set it in the submit handler (Task 4), right after `const tb = createTurnBlock();`:

```ts
    const tb = createTurnBlock();
    tb.question = question;
```

- [ ] **Step 2: Add the collapsed-summary markup to the template**

In the `.astro` template block (Task 2's `<template id="ch-turn-template">`), add a collapsed-summary element as a sibling of the status line, hidden by default, shown only once a turn is superseded:

```astro
        <details class="ch-turn-summary" style="display:none">
          <summary>
            <span class="ch-turn-q"></span>
            <span class="ch-turn-finding"></span>
          </summary>
        </details>
```

Place it as the FIRST child of `.ch-turn`, before the status line — once a turn collapses, this is the only thing visible for it, and `<details>` defaults to closed.

- [ ] **Step 3: Query the new elements in createTurnBlock()**

Add to `createTurnBlock()`'s returned object (Task 3):

```ts
      turnSummary: q<HTMLDetailsElement>(root, '.ch-turn-summary'),
      turnSummaryQ: q(root, '.ch-turn-q'),
      turnSummaryFinding: q(root, '.ch-turn-finding'),
```

And to the `TurnBlock` interface:

```ts
    turnSummary: HTMLDetailsElement;
    turnSummaryQ: HTMLElement;
    turnSummaryFinding: HTMLElement;
```

- [ ] **Step 4: Implement collapseTurn()**

Add this function near the other render functions:

```ts
  // Called on a turn block that is no longer the latest turn. Freezes its
  // chart as a static PNG snapshot (taken via ECharts's own getDataURL()
  // BEFORE disposing — dispose()'s effect on the underlying <canvas> bitmap
  // is undocumented/unverified, so this does not rely on it leaving anything
  // visible behind) and swaps its full receipt/panel/answer display for a
  // one-line collapsed summary. state.rows/chartSpec in agent.ts is
  // unaffected by this — this is presentation only, the underlying session
  // data is untouched.
  function collapseTurn(tb: TurnBlock) {
    const idx = liveChartTurns.indexOf(tb);
    if (idx !== -1) liveChartTurns.splice(idx, 1);
    if (tb.chartInstance) {
      const dataUrl = tb.chartInstance.getDataURL({ type: 'png', backgroundColor: 'transparent' });
      const img = document.createElement('img');
      img.src = dataUrl;
      img.className = 'ch-turn-chart-snapshot';
      img.alt = tb.chartTitle.textContent || 'Chart';
      tb.turnSummary.appendChild(img);
      tb.chartInstance.dispose();
      tb.chartInstance = null;
    }
    tb.statusRow.style.display = 'none';
    tb.panel.style.display = 'none';
    tb.answerSection.style.display = 'none';
    tb.turnSummary.style.display = 'block';
    tb.turnSummaryQ.textContent = tb.question;
    tb.turnSummaryFinding.textContent = tb.findingEl.textContent || '';
  }
```

- [ ] **Step 5: Call collapseTurn() on every previous turn when a new one starts**

In the submit handler (Task 4), add a module-level array tracking every turn block created so far (separate from `liveChartTurns`, which only tracks turns with a live chart — this new array tracks ALL turns, since even an explanation-only turn with no chart still needs to collapse):

```ts
  const allTurns: TurnBlock[] = [];
```

Then, in the submit handler, right before `const tb = createTurnBlock();`, add:

```ts
    for (const prev of allTurns) collapseTurn(prev);
```

And right after `tb.question = question;`, add:

```ts
    allTurns.push(tb);
```

- [ ] **Step 6: Verify the build passes**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 7: Manually verify collapsing behavior**

Run: `npm run dev`, ask a first question, wait for it to complete. Ask a second question.

Expected:
- The moment the second question is submitted, the FIRST turn's full receipt/chart/answer disappear, replaced by a single collapsed line showing the first question's text and its finding.
- Clicking that collapsed line (a native `<details>` summary) expands it to reveal a static PNG snapshot of that turn's last-rendered chart (if it had one) — a frozen image, not a live/interactive ECharts instance. The full receipt trace does not come back, only the chart snapshot.
- The second turn shows its own full, live receipt + chart + answer.
- No visual flash of the first turn's chart resizing/re-theming after it's collapsed (confirms the `liveChartTurns` removal is working — try toggling the site's dark/light theme after both turns exist, and confirm only the SECOND turn's chart, if visible, responds).

- [ ] **Step 8: Commit**

```bash
git add src/pages/apps/chitti.astro
git commit -m "Collapse superseded turns to a one-line summary, freeze their charts"
```

---

## Task 6: Sticky composer and top-console collapse on turn 2+

**Files:**
- Modify: `src/pages/apps/chitti.astro`

**Interfaces:**
- Produces: a new `#ch-composer` element (question textarea + Ask button, reusing `ch-q`/`ch-btn` styling) that appears once `allTurns.length > 0`, docked after `#ch-thread`. The original top console (`#ch-console`) becomes fully hidden (not just `ch-console-compact`) once the composer takes over.

- [ ] **Step 1: Add the composer markup**

In the `.astro` markup, add this immediately after the `<div class="ch-thread" id="ch-thread"></div>` line (from Task 2):

```astro
    <form class="ch-composer" id="ch-composer" autocomplete="off" style="display:none">
      <textarea
        id="ch-composer-q"
        class="ch-q"
        rows="1"
        placeholder="Ask a follow-up…"
        spellcheck="false"
      ></textarea>
      <button type="submit" class="ch-btn" id="ch-composer-btn">Ask</button>
      <button type="button" class="ch-new-convo" id="ch-new-convo">+ new conversation</button>
    </form>
```

- [ ] **Step 2: Wire up element references**

Near the other module-level element lookups (after `const chips = $('ch-chips');`), add:

```ts
  const composerForm = $('ch-composer') as HTMLFormElement;
  const composerQ = $('ch-composer-q') as HTMLTextAreaElement;
  const newConvoBtn = $('ch-new-convo') as HTMLButtonElement;
```

- [ ] **Step 3: Show the composer and hide the top console once the first turn completes**

In the submit handler, at the very end of the `try` block's SUCCESS paths (both the `out.kind === 'explanation'` return and the final normal-success path — NOT the error/zero-result return, so a failed first attempt doesn't lock the user out of retrying via the same top console), add, right before each `tb.root.scrollIntoView(...)` call:

```ts
      consoleEl.style.display = 'none';
      composerForm.style.display = 'flex';
```

Concretely, this means adding those two lines in both of these spots from Task 4's submit handler:
1. Immediately before `tb.root.scrollIntoView(...)` in the `out.kind === 'explanation'` branch.
2. Immediately before `tb.root.scrollIntoView(...)` in the final normal-success path (after the `setStatus(tb, 'ok', ...)` line).

Do NOT add it to the `out.kind === 'chart' && !out.chartSpec` (zero-result) branch — a failed first attempt should let the user retry from the same top console, not switch to the composer for a conversation that hasn't produced a real answer yet.

- [ ] **Step 4: Wire the composer's submit to reuse the same ask flow**

The composer needs to trigger the exact same logic as the top console's form. Rather than duplicating the submit handler, make the composer's own submit event just delegate to it:

```ts
  composerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    qIn.value = composerQ.value;
    composerQ.value = '';
    askForm.requestSubmit();
  });
```

This reuses `qIn` (the ORIGINAL top-console textarea, still in the DOM, just hidden via `consoleEl.style.display = 'none'`) as the actual source of truth the submit handler reads from (`const question = qIn.value.trim() || ...`) — no duplication of the question-reading logic, no second code path to keep in sync.

- [ ] **Step 5: Wire "new conversation"**

```ts
  newConvoBtn.addEventListener('click', () => {
    session = null;
    threadEl.innerHTML = '';
    allTurns.length = 0;
    liveChartTurns.length = 0;
    composerForm.style.display = 'none';
    consoleEl.style.display = '';
    consoleEl.classList.remove('ch-console-compact');
    qIn.value = '';
    qIn.focus();
  });
```

- [ ] **Step 6: Verify the build passes**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 7: Manually verify the full flow end to end**

Run: `npm run dev`, open `http://localhost:4321/apps/chitti`.
1. Ask a first question via the top console/chips. Confirm it completes normally.
2. Confirm the top console disappears and a slim composer bar appears below the (now-collapsed, since a 2nd turn hasn't happened yet — actually the FIRST turn stays fully expanded until a SECOND is asked, per Task 5's collapse-on-next-ask logic; only the top console/chips/BYOK strip hide at this point, not the turn itself) thread.
3. Type a follow-up in the composer, submit. Confirm: the first turn collapses to a one-line summary, the second turn appears fully expanded, the composer is still there for a third question.
4. Click "+ new conversation". Confirm: the thread clears entirely, the top console (title/badges/textarea/chips/BYOK) reappears exactly as it looked on first page load, the composer disappears.
5. Ask a fresh question after the reset. Confirm it starts a genuinely new session (no memory of the previous conversation's data) — the fastest way to check this without reading network calls is to ask something like "explain this data" as the FIRST question after a reset and confirm the agent does not have any prior chart to explain (it should behave as a normal turn-1 question, not find `state.rows` already populated).

- [ ] **Step 8: Commit**

```bash
git add src/pages/apps/chitti.astro
git commit -m "Add sticky follow-up composer and new-conversation control"
```

---

## Task 7: Styles for the thread, collapsed summary, and composer

**Files:**
- Modify: `src/pages/apps/chitti.astro` (`<style>` block)

**Interfaces:**
- Produces: visual styling for `.ch-thread`, `.ch-turn`, `.ch-turn-summary`/`.ch-turn-q`/`.ch-turn-finding`, `.ch-composer`, `.ch-new-convo` — none of which exist in the current stylesheet (they're new elements from Tasks 2, 5, 6).

- [ ] **Step 1: Add thread and turn-block spacing**

Add near the top of the existing `<style>` block, after the `.ch { width: 100%; margin: 0 auto; }` rule:

```css
  .ch-thread { display: flex; flex-direction: column; gap: var(--space-lg); }
  .ch-turn + .ch-turn { margin-top: var(--space-lg); }
```

- [ ] **Step 2: Add collapsed-summary styling**

Add near the `.ch-status` rule:

```css
  .ch-turn-summary {
    margin-bottom: var(--space-sm);
    font-family: var(--font-mono);
    font-size: var(--text-small);
    color: var(--fg-muted);
  }
  .ch-turn-summary summary {
    display: flex;
    gap: 10px;
    align-items: baseline;
    cursor: pointer;
    list-style: none;
    padding: 6px 2px;
  }
  .ch-turn-summary summary::-webkit-details-marker { display: none; }
  .ch-turn-summary summary::before { content: '▸ '; color: var(--fg-muted); }
  .ch-turn-summary[open] summary::before { content: '▾ '; }
  .ch-turn-q {
    color: var(--fg);
    font-style: italic;
    font-family: var(--font-serif);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 55%;
  }
  .ch-turn-finding {
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
  .ch-turn-chart-snapshot {
    display: block;
    max-width: 100%;
    margin: 4px 0 8px;
    border: 1px solid var(--fg-faint);
    border-radius: var(--radius-md);
  }
```

- [ ] **Step 3: Add composer styling**

Add near the `.ch-console` rules:

```css
  .ch-composer {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    margin-top: var(--space-md);
    padding: var(--space-sm) var(--space-md);
    background: var(--bg-elevated);
    border: 1px solid var(--fg-faint);
    border-radius: var(--radius-md);
  }
  .ch-composer .ch-q {
    flex: 1;
    padding: 6px 4px;
    font-size: var(--text-body);
    min-height: 0;
  }
  .ch-new-convo {
    font-family: var(--font-mono);
    font-size: var(--text-tag);
    background: transparent;
    color: var(--fg-muted);
    border: none;
    cursor: pointer;
    text-decoration: underline;
    text-underline-offset: 2px;
    white-space: nowrap;
    padding: 0 0 10px;
  }
  .ch-new-convo:hover { color: var(--fg); }
```

- [ ] **Step 4: Verify the build passes**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 5: Manually verify visual polish**

Run: `npm run dev`, repeat the full flow from Task 6 Step 7. Confirm:
- Collapsed turn summaries read cleanly as a single truncated line (question in serif italic, finding in muted mono-adjacent sans, per the styling above) — not an awkward wrapped mess.
- The composer visually matches the site's existing surface language (`--bg-elevated`, `--fg-faint` border, `--radius-md`) rather than looking like a bolted-on chat widget.
- "+ new conversation" reads as a clearly secondary, low-emphasis action next to the primary Ask button.
- Check both light and dark mode (the site's theme toggle) for all new elements.

- [ ] **Step 6: Commit**

```bash
git add src/pages/apps/chitti.astro
git commit -m "Style the turn thread, collapsed summaries, and follow-up composer"
```

---

## Plan Complete

At this point, `/apps/chitti` supports a full multi-turn conversation:
- Turn 1 uses the original top console (title, badges, textarea, chips, BYOK).
- Every `ask()` call appends a new, fully-live turn block (own receipt, own chart, own answer) to a stacked thread.
- Once a turn completes successfully, the top console hides and a sticky composer takes over for follow-ups.
- Every previous turn collapses to a one-line question+finding summary, its chart frozen (disposed, no longer wired to theme/resize).
- "+ new conversation" discards the session and thread, restoring the original single-question entry point.
- Explanation-only turns (`kind: 'explanation'`, from Plan 1) render as a normal answer with no data table/citations, never as an error state.

This closes out both plans for `docs/superpowers/specs/2026-07-09-chitti-multiturn-design.md`.
