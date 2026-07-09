# Chitti Multi-turn Agent Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `agent.ts`'s one-shot `runAgent()` into a persistent `createSession()` object that supports follow-up questions reusing already-fetched data, without breaking the existing single-turn pipeline.

**Architecture:** `createSession(cfg)` returns `{ ask(question, cb) }`. Internally it keeps a `messages` array and `state` (rows/chartSpec/indicators) that persist across `ask()` calls instead of being reconstructed per call. A new `finish_explanation` tool lets the model end a turn with prose only; the verifier is skipped for those turns (fixing a verified bug where a prose-only turn would otherwise be coerced into rendering an unwanted chart). Re-plotting from existing data is only ever done via a fresh `execute_js` call against `state.rows` — never from the lossy `summarizeRows()` preview. Old `tool`-role messages are trimmed after each turn completes, keeping `state.rows` (plain JS memory) as the durable source of truth instead of `messages` history.

**Tech Stack:** TypeScript, vitest (new dev dependency, no test runner exists in this repo today), no DOM/browser involved in this plan.

## Global Constraints

- Design source: `docs/superpowers/specs/2026-07-09-chitti-multiturn-design.md` — read it if anything below is ambiguous.
- Never use em dashes in code comments or commit messages (site-wide writing rule).
- No Co-Authored-By lines in commits.
- `npm run build` must still pass after every task (this repo's only existing verification gate) — vitest is additive, it does not replace the build check.
- `MAX_TOOL_CALLS` applies per-turn, not cumulatively across a session.
- Verification (`runVerify`) is skipped entirely for explanation turns (turns ending in `finish_explanation`), never adapted into a "prose-aware verifier" — this is a scope branch, not a new verifier mode.
- A re-plot from existing data MUST go through a fresh `execute_js` call against `state.rows` before `render_chart` — a chart may never be built directly from `summarizeRows()`'s output, since that only carries first year, last year, and row count per country.
- `state.rows` (plain JS memory inside the session) is the durable cross-turn source of truth. `messages` history may be trimmed after a turn completes without losing any capability, because nothing depends on re-reading old raw tool-result JSON back out of history.

---

## File Structure

- Modify: `src/lib/chitti/agent.ts` — the only production file this plan touches. Adds `createSession()`, the `finish_explanation` tool wiring, the explanation/chart turn branch, and the post-turn message-trimming step. `runAgent()` is removed; nothing else in the repo calls it yet (the UI still calls the old one-shot shape until Plan 2 lands), so this plan leaves a temporary compatibility shim — see Task 6.
- Modify: `src/lib/chitti/tools.ts` — add the `finish_explanation` entry to `TOOL_SCHEMAS`.
- Create: `src/lib/chitti/agent.test.ts` — vitest unit tests for the session, using `vi.mock('./providers')` to fake `complete()` (no real network calls).
- Modify: `package.json` — add `vitest` as a dev dependency and a `test` script.
- Create: `vitest.config.ts` — minimal vitest config at repo root (Astro projects need `test.environment: 'node'` since this plan's tests are pure logic, no DOM).

---

## Task 1: Add vitest to the project

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: `npm test` runs vitest once (CI-style, not watch mode) — later tasks assume this command exists.

- [ ] **Step 1: Install vitest as a dev dependency**

Run: `npm install -D vitest`

- [ ] **Step 2: Add the test script to package.json**

Modify `package.json`'s `"scripts"` block (currently `dev`, `build`, `preview`) to add:

```json
"test": "vitest run"
```

Full scripts block after this change:

```json
"scripts": {
  "dev": "astro dev",
  "build": "astro build",
  "preview": "astro preview",
  "test": "vitest run"
}
```

- [ ] **Step 3: Create vitest.config.ts**

Create `vitest.config.ts` at the repo root:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 4: Verify vitest runs with zero tests**

Run: `npm test`
Expected: vitest reports "No test files found" (or exits 0 with zero suites) — this confirms the runner is wired up correctly before any real test exists. It is NOT expected to fail.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "Add vitest for agent.ts unit tests"
```

---

## Task 2: Add the finish_explanation tool schema

**Files:**
- Modify: `src/lib/chitti/tools.ts:441-453` (the existing `finish` schema entry, in `TOOL_SCHEMAS`)
- Test: `src/lib/chitti/agent.test.ts` (created in this task, first test in the file)

**Interfaces:**
- Consumes: `TOOL_SCHEMAS: ToolSchema[]` (existing export, `tools.ts:288`)
- Produces: `TOOL_SCHEMAS` now includes a `finish_explanation` entry with parameter `explanation: string`. Task 3 (agent.ts dispatch) relies on this exact tool name and parameter name.

- [ ] **Step 1: Write the failing test**

Create `src/lib/chitti/agent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TOOL_SCHEMAS } from './tools';

describe('finish_explanation tool schema', () => {
  it('is registered with an explanation string parameter', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.name === 'finish_explanation');
    expect(schema).toBeDefined();
    expect(schema!.parameters.required).toContain('explanation');
    expect(schema!.parameters.properties.explanation).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `schema` is `undefined` because `finish_explanation` does not exist yet in `TOOL_SCHEMAS`.

- [ ] **Step 3: Add the schema to tools.ts**

In `src/lib/chitti/tools.ts`, immediately after the existing `finish` entry (ends at line 453, just before the closing `];` of `TOOL_SCHEMAS` at line 454), add:

```ts
  {
    name: 'finish_explanation',
    description:
      'End this turn with a prose explanation only, no chart. Use this when the user asked you ' +
      'to explain, describe, interpret, or summarize data you already have in words, rather than ' +
      'asking for a new or different chart. Do not call render_chart in a turn that ends with ' +
      'this tool.',
    parameters: {
      type: 'object',
      properties: {
        explanation: { type: 'string', description: 'The prose answer to the user\'s question.' },
      },
      required: ['explanation'],
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Verify the build still passes**

Run: `npm run build`
Expected: build completes with no errors (this task only added a schema object, no behavior change to any consumer yet).

- [ ] **Step 6: Commit**

```bash
git add src/lib/chitti/tools.ts src/lib/chitti/agent.test.ts
git commit -m "Add finish_explanation tool schema"
```

---

## Task 3: Session object skeleton — createSession() with persistent messages and state

**Files:**
- Modify: `src/lib/chitti/agent.ts` (the whole file is restructured around a session; see steps for exact boundaries)
- Test: `src/lib/chitti/agent.test.ts`

**Interfaces:**
- Consumes: `ChatMessage`, `ProviderConfig`, `ToolCall`, `complete`, `estimateCost` from `./providers` (unchanged imports); `TOOL_SCHEMAS` and the rest of `./tools` (unchanged imports).
- Produces:
  ```ts
  export interface ChittiSession {
    ask(question: string, cb: AgentCallbacks): Promise<AgentOutput>;
  }
  export function createSession(cfg: ProviderConfig): ChittiSession;
  ```
  `AgentOutput` gains one new field (this task only adds the field with a default; Task 4 gives it real meaning):
  ```ts
  export interface AgentOutput {
    // ...all existing fields, unchanged...
    kind: 'chart' | 'explanation';
  }
  ```
  This is the primary export Plan 2 (chitti.astro) will consume.

This task does NOT yet implement the explanation-turn branch (Task 4) or message trimming (Task 5) — it only makes `messages`/`state` persist across two `ask()` calls on the same session, keeping today's single-turn behavior (chart pipeline, verify, retry-once) otherwise identical per call.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/chitti/agent.test.ts`:

```ts
import { vi } from 'vitest';

vi.mock('./providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./providers')>();
  return {
    ...actual,
    complete: vi.fn(),
  };
});

import { complete } from './providers';
import { createSession } from './agent';

describe('createSession', () => {
  it('persists conversation history across two ask() calls', async () => {
    const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
    // Turn 1: model immediately finishes with a finding, no tool calls beyond finish.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 't1', name: 'finish', arguments: { one_line_finding: 'First finding.' } }],
      usage: { input: 10, output: 5 },
    });
    // Verifier call for turn 1 (pass, since chartSpec is null the pass condition needs
    // literal PASS text from the mock — see agent.ts's verify()).
    mockComplete.mockResolvedValueOnce({
      text: 'PASS: chart rendered.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' });
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    await session.ask('First question', cb);

    // Second ask() call should see the FIRST question's messages still present.
    // We can't inspect `messages` directly (private to the closure), so assert
    // indirectly: the second complete() call's messages argument includes the
    // first turn's user message.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 't2', name: 'finish', arguments: { one_line_finding: 'Second finding.' } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: 'PASS: chart rendered.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });
    await session.ask('Second question', cb);

    const secondCallArgs = mockComplete.mock.calls[2]; // 0,1 = turn1 pass+verify; 2 = turn2 pass
    const messagesArg = secondCallArgs[1] as { role: string; content: string }[];
    const hasFirstQuestion = messagesArg.some(
      (m) => m.role === 'user' && m.content === 'First question'
    );
    expect(hasFirstQuestion).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `createSession` is not exported from `agent.ts` yet.

- [ ] **Step 3: Restructure agent.ts around createSession()**

In `src/lib/chitti/agent.ts`, replace the `runAgent` function (lines 104-377 in the current file) with a session factory. Keep every helper function below it (`indicatorName`, `extractOneSentence`, `pipelineStatus`, `verify`, `summarizeArgs`, `normalizeSpec`, `summarizeRows`) exactly as-is — they are called from inside the new `createSession` body the same way they were called from `runAgent`.

Replace the top-level export (was `export async function runAgent(cfg, question, cb)`) with:

```ts
export interface ChittiSession {
  ask(question: string, cb: AgentCallbacks): Promise<AgentOutput>;
}

export function createSession(cfg: ProviderConfig): ChittiSession {
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  const vfsFiles: Record<string, string> = {};
  const state: {
    rows: DataRow[];
    chartSpec: ChartSpec | null;
    indicators: Map<string, string>;
    finding: string;
  } = { rows: [], chartSpec: null, indicators: new Map(), finding: '' };

  let turnCount = 0;

  async function ask(question: string, cb: AgentCallbacks): Promise<AgentOutput> {
    turnCount++;
    const trace: TraceEvent[] = [];
    const vfs = new VFS((files) => {
      Object.assign(vfsFiles, files);
      cb.onFiles({ ...vfsFiles });
    });
    let totalCost = 0;
    state.finding = ''; // reset per turn; state.rows/chartSpec/indicators persist

    function pushTrace(e: Omit<TraceEvent, 'ts'>): TraceEvent {
      const withTs: TraceEvent = { ...e, ts: Date.now() };
      trace.push(withTs);
      cb.onTrace([...trace]);
      return withTs;
    }
    function updateTrace() {
      cb.onTrace([...trace]);
    }

    async function dispatch(tc: ToolCall, tokens?: number): Promise<string> {
      const a = tc.arguments;
      const ev = pushTrace({ tool: tc.name, argSummary: summarizeArgs(tc.name, a), status: 'running', tokens });
      try {
        let result = '';
        switch (tc.name) {
          case 'search_indicators': {
            const hits = await searchIndicators(String(a.query ?? ''), a.topic ? String(a.topic) : undefined);
            result = JSON.stringify(hits.map((h) => ({ id: h.id, name: h.name })));
            break;
          }
          case 'list_countries': {
            const list = listCountries(a.filter ? String(a.filter) : 'all');
            result = JSON.stringify(list.map((c) => ({ id: c.id, name: c.name, region: c.region })));
            break;
          }
          case 'fetch_worldbank': {
            const ids = Array.isArray(a.country_ids) ? (a.country_ids as string[]) : [];
            const { rows, truncatedFrom } = await fetchWorldbank(
              String(a.indicator_id),
              ids,
              Number(a.year_start),
              Number(a.year_end)
            );
            state.rows = state.rows.concat(rows);
            state.indicators.set(String(a.indicator_id), String(a.indicator_id));
            result = summarizeRows(rows);
            if (truncatedFrom) {
              result +=
                `\n\nNOTE: you requested ${truncatedFrom} countries but only the first 60 were ` +
                `fetched (per-call limit). Call fetch_worldbank again with the remaining ` +
                `country_ids and merge results if you need full coverage.`;
            }
            ev.detail = `${rows.length} rows` + (truncatedFrom ? ` (truncated from ${truncatedFrom})` : '');
            break;
          }
          case 'fetch_worldbank_all': {
            const { rows, countryCount, batchCount } = await fetchWorldbankAll(
              String(a.indicator_id),
              Number(a.year_start),
              Number(a.year_end)
            );
            state.rows = state.rows.concat(rows);
            state.indicators.set(String(a.indicator_id), String(a.indicator_id));
            result = summarizeRows(rows);
            ev.detail = `${rows.length} rows · ${countryCount} countries · ${batchCount} batch${batchCount === 1 ? '' : 'es'}`;
            break;
          }
          case 'execute_js': {
            const { ok, result: value, error } = executeJs(String(a.code ?? ''), state.rows);
            result = ok ? JSON.stringify(value) : 'ERROR: ' + error;
            ev.detail = ok ? 'ok' : 'error: ' + error;
            break;
          }
          case 'write_file': {
            vfs.write(String(a.path), String(a.content ?? ''));
            result = 'written';
            break;
          }
          case 'read_file': {
            result = vfs.read(String(a.path)) || '(empty)';
            break;
          }
          case 'render_chart': {
            const spec = normalizeSpec(a as unknown as ChartSpec);
            state.chartSpec = spec;
            cb.onChart(spec);
            result = 'rendered';
            break;
          }
          case 'finish': {
            state.finding = String(a.one_line_finding ?? '').trim();
            result = 'done';
            break;
          }
          default:
            result = 'unknown tool';
        }
        ev.status = 'ok';
        updateTrace();
        return result;
      } catch (err: any) {
        ev.status = 'error';
        ev.detail = err?.message ?? String(err);
        updateTrace();
        return 'ERROR: ' + (err?.message ?? String(err));
      }
    }

    async function agentPass(critique?: string): Promise<void> {
      messages.push({ role: 'user', content: question + (critique ? '' : '') });
      if (critique) {
        messages.push({
          role: 'user',
          content: 'A previous attempt was judged insufficient. Fix this: ' + critique,
        });
      }

      let calls = 0;
      let noopTurns = 0;
      while (calls < MAX_TOOL_CALLS) {
        const status = pipelineStatus(state, calls);
        cb.onStatus(status, 'loading');

        const res = await complete(cfg, messages, TOOL_SCHEMAS);
        totalCost += estimateCost(cfg.model, res.usage);

        if (res.reasoning) {
          pushTrace({ tool: 'reasoning', argSummary: '', status: 'ok', detail: res.reasoning });
        }

        if (!res.toolCalls.length) {
          noopTurns++;
          const fallbackText = res.text.trim() || res.reasoning?.trim() || '';
          if (state.chartSpec && state.rows.length && fallbackText) {
            state.finding = extractOneSentence(fallbackText);
            return;
          }
          if (noopTurns >= 2) return;
          messages.push({ role: 'assistant', content: res.text });
          messages.push({
            role: 'user',
            content:
              'Continue by calling a tool. ' +
              (state.chartSpec
                ? 'The chart is already rendered — call finish now with a one-line finding.'
                : 'Pick the next tool in the pipeline.'),
          });
          calls++;
          continue;
        }

        messages.push({ role: 'assistant', content: res.text, tool_calls: res.toolCalls });

        let finished = false;
        const turnTokens = res.usage.input + res.usage.output;
        for (const [idx, tc] of res.toolCalls.entries()) {
          calls++;
          const out = await dispatch(tc, idx === 0 ? turnTokens : undefined);
          messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: out });
          if (tc.name === 'finish') finished = true;
          if (calls >= MAX_TOOL_CALLS) break;
        }
        if (finished) return;

        if (state.chartSpec && state.rows.length && calls >= 6) return;
      }

      if (!state.finding) {
        cb.onStatus('Budget reached — summarizing…', 'loading');
        const res = await complete(
          cfg,
          [
            { role: 'system', content: 'Summarize the analysis so far in ONE sentence with a concrete finding. No caveats.' },
            { role: 'user', content: question + '\n\nData summary:\n' + summarizeRows(state.rows) },
          ],
          []
        );
        totalCost += estimateCost(cfg.model, res.usage);
        state.finding = res.text.trim() || 'Analysis incomplete within the tool-call budget.';
      }
    }

    async function runVerify(critique?: string): Promise<{ pass: boolean; report: string }> {
      const ev = pushTrace({ tool: 'verify', argSummary: critique ? 'retry' : '', status: 'running' });
      const result = await verify(cfg, question, state.chartSpec, state.finding, (c) => (totalCost += c));
      ev.status = result.pass ? 'ok' : 'error';
      ev.pass = result.pass;
      ev.detail = result.report;
      ev.tokens = result.tokens;
      updateTrace();
      return result;
    }

    cb.onStatus('Planning…', 'loading');
    await agentPass();

    cb.onStatus('Verifying…', 'loading');
    const verifierReport = await runVerify();
    vfs.write('verifier_report.md', verifierReport.report);

    let retried = false;
    let confidence: 'ok' | 'low' = 'ok';

    if (!verifierReport.pass) {
      retried = true;
      cb.onStatus('Verifier flagged gaps — retrying once…', 'loading');
      await agentPass(verifierReport.report);
      const second = await runVerify(verifierReport.report);
      vfs.write('verifier_report.md', verifierReport.report + '\n\n---\nRetry verdict:\n' + second.report);
      if (!second.pass) confidence = 'low';
    }

    cb.onStatus('Done', 'ok');

    const indicators = [...state.indicators.keys()].map((id) => ({ id, name: indicatorName(id) }));

    return {
      finding: state.finding,
      chartSpec: state.chartSpec,
      rows: state.rows,
      csv: rowsToCSV(state.rows),
      indicators,
      confidence,
      verifierReport: verifierReport.report,
      cost: totalCost,
      retried,
      kind: 'chart',
    };
  }

  return { ask };
}
```

Also update the `AgentOutput` interface (currently lines 55-65) to add the new field:

```ts
export interface AgentOutput {
  finding: string;
  chartSpec: ChartSpec | null;
  rows: DataRow[];
  csv: string;
  indicators: { id: string; name: string }[];
  confidence: 'ok' | 'low';
  verifierReport: string;
  cost: number;
  retried: boolean;
  kind: 'chart' | 'explanation';
}
```

Note: this task's `agentPass()` pushes the new question directly as a `user` message onto the shared `messages` array (that's the persistence this task is testing), but does NOT yet add the turn-2+ addendum from the design doc (System prompt section) — that is Task 4, together with the `finish_explanation` branch, since they're the same conditional and splitting them would leave an awkward half-state.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Verify the build still passes**

Run: `npm run build`
Expected: build completes. Note `chitti.astro` still imports `runAgent` at this point (Task 6 addresses this) — if the build fails on a missing `runAgent` export, that is Task 6's job to fix, not this task's. If it fails here, stop and re-read Task 6 before proceeding; do not silently patch chitti.astro out of order.

- [ ] **Step 6: Commit**

```bash
git add src/lib/chitti/agent.ts src/lib/chitti/agent.test.ts
git commit -m "Restructure agent.ts around a persistent createSession()"
```

---

## Task 4: Turn 2+ addendum, finish_explanation dispatch, and the chart/explanation branch

**Files:**
- Modify: `src/lib/chitti/agent.ts`
- Test: `src/lib/chitti/agent.test.ts`

**Interfaces:**
- Consumes: `state.rows`, `state.chartSpec`, `turnCount` (from Task 3's closure).
- Produces: `AgentOutput.kind` now genuinely varies (`'explanation'` when the turn ends via `finish_explanation`, `'chart'` otherwise) instead of always being hardcoded `'chart'`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/chitti/agent.test.ts`:

```ts
describe('explanation turns', () => {
  it('skips verification and returns kind "explanation" when the model calls finish_explanation', async () => {
    const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
    mockComplete.mockReset();

    // Turn 1: a normal chart turn, so state.rows/chartSpec are non-empty going into turn 2.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'r1', name: 'render_chart', arguments: { type: 'line', title: 'T', series: [{ name: 'A', data: [[2000, 1]] }] } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'f1', name: 'finish', arguments: { one_line_finding: 'First finding.' } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: 'PASS: chart rendered.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' });
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    const first = await session.ask('Chart this data', cb);
    expect(first.kind).toBe('chart');

    // Turn 2: model calls finish_explanation instead of any chart tool.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'e1', name: 'finish_explanation', arguments: { explanation: 'Here is what the data shows.' } }],
      usage: { input: 8, output: 4 },
    });
    // NOTE: no verifier-call mock is queued for turn 2 — if the implementation
    // calls the verifier anyway, this test fails with "no more mocked values",
    // proving the skip actually happened rather than merely asserting the field.

    const second = await session.ask('Explain this data', cb);
    expect(second.kind).toBe('explanation');
    expect(second.finding).toBe('Here is what the data shows.');
    expect(second.chartSpec).not.toBeNull(); // carries forward turn 1's chart, unchanged
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — either `finish_explanation` is dispatched as `'unknown tool'` (no `case` for it yet), or the verifier still runs and the mock queue underflows.

- [ ] **Step 3: Implement the addendum, the new dispatch case, and the branch**

In `agent.ts`'s `dispatch()` switch (inside `createSession`, from Task 3), add a case alongside `finish`:

```ts
          case 'finish_explanation': {
            state.finding = String(a.explanation ?? '').trim();
            result = 'done';
            break;
          }
```

Add a module-level flag the `ask()` function can read after `agentPass()` returns, tracking which terminal tool ended the turn. The simplest correct place is a `let lastFinishKind: 'chart' | 'explanation' | null` reset at the top of each `ask()` call (alongside the existing `state.finding = ''` reset in Task 3), set inside `dispatch()`'s `finish` and `finish_explanation` cases:

```ts
    // (at the top of ask(), alongside `state.finding = '';`)
    let turnKind: 'chart' | 'explanation' = 'chart';
```

Update the two dispatch cases to set it:

```ts
          case 'finish': {
            state.finding = String(a.one_line_finding ?? '').trim();
            turnKind = 'chart';
            result = 'done';
            break;
          }
          case 'finish_explanation': {
            state.finding = String(a.explanation ?? '').trim();
            turnKind = 'explanation';
            result = 'done';
            break;
          }
```

Now add the turn-2+ system addendum. In `agentPass()`, right before pushing the new user message, build the addendum from current state and push it as a separate `user` message ahead of the question (keeps the addendum visible in history for debugging, and avoids mutating the original system message):

```ts
    async function agentPass(critique?: string): Promise<void> {
      if (turnCount > 1) {
        const chartSummary = state.chartSpec
          ? `${state.chartSpec.type} chart "${state.chartSpec.title}" with series: ${state.chartSpec.series.map((s) => s.name).join(', ')}`
          : 'none';
        messages.push({
          role: 'user',
          content:
            `You already have data from earlier in this conversation:\n${summarizeRows(state.rows)}\n\n` +
            `Current chart: ${chartSummary}.\n\n` +
            'Do NOT call search_indicators or fetch tools again unless this question needs data ' +
            "you don't have (a new country, indicator, or year range not already fetched).\n" +
            'If this question needs a different chart from the SAME data (a new chart type, a ' +
            're-ranked/filtered/re-aggregated view), you MUST call execute_js again against the ' +
            'existing rows to (re-)derive the exact values before calling render_chart — the ' +
            'summary above is a compressed preview (first year, last year, count) for your own ' +
            'orientation only, never a source of chart data. Never call render_chart from the ' +
            'summary directly.\n' +
            'If this question just asks you to explain, describe, or interpret the data in words, ' +
            'call finish_explanation with your answer — do not call render_chart at all.',
        });
      }
      messages.push({ role: 'user', content: question });
      if (critique) {
        messages.push({
          role: 'user',
          content: 'A previous attempt was judged insufficient. Fix this: ' + critique,
        });
      }
      // ...rest of agentPass unchanged from Task 3...
```

Finally, branch the post-`agentPass()` flow in `ask()` on `turnKind`, skipping verification for explanation turns:

```ts
    cb.onStatus('Planning…', 'loading');
    await agentPass();

    let verifierReport = { pass: true, report: '' };
    let retried = false;
    let confidence: 'ok' | 'low' = 'ok';

    if (turnKind === 'chart') {
      cb.onStatus('Verifying…', 'loading');
      verifierReport = await runVerify();
      vfs.write('verifier_report.md', verifierReport.report);

      if (!verifierReport.pass) {
        retried = true;
        cb.onStatus('Verifier flagged gaps — retrying once…', 'loading');
        await agentPass(verifierReport.report);
        const second = await runVerify(verifierReport.report);
        vfs.write('verifier_report.md', verifierReport.report + '\n\n---\nRetry verdict:\n' + second.report);
        if (!second.pass) confidence = 'low';
      }
    }

    cb.onStatus('Done', 'ok');

    const indicators = [...state.indicators.keys()].map((id) => ({ id, name: indicatorName(id) }));

    return {
      finding: state.finding,
      chartSpec: state.chartSpec,
      rows: state.rows,
      csv: rowsToCSV(state.rows),
      indicators,
      confidence,
      verifierReport: verifierReport.report,
      cost: totalCost,
      retried,
      kind: turnKind,
    };
```

This replaces the equivalent block written in Task 3 (which always ran `runVerify()` and hardcoded `kind: 'chart'`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — both the Task 3 test and this task's new test.

- [ ] **Step 5: Add tools.ts's finish_explanation import isn't needed check**

`agent.ts` dispatches on `tc.name` string matching, not a typed import from `tools.ts` — no import change needed here since `TOOL_SCHEMAS` (already imported) is what's sent to the model, and Task 2 already added the schema there. Run: `npm run build` to confirm no type errors.
Expected: build completes (aside from the pre-existing `chitti.astro` import issue tracked in Task 6).

- [ ] **Step 6: Commit**

```bash
git add src/lib/chitti/agent.ts src/lib/chitti/agent.test.ts
git commit -m "Add finish_explanation branch: skip verification on explanation turns"
```

---

## Task 5: Trim old tool-result messages after each turn

**Files:**
- Modify: `src/lib/chitti/agent.ts`
- Test: `src/lib/chitti/agent.test.ts`

**Interfaces:**
- Consumes: `messages` array (module-internal to `createSession`'s closure).
- Produces: no new exports — this task changes internal behavior only, verified by asserting on the `complete()` mock's captured arguments (same technique as Task 3's test).

- [ ] **Step 1: Write the failing test**

Add to `src/lib/chitti/agent.test.ts`:

```ts
describe('message trimming', () => {
  it('replaces a completed turn\'s tool-result messages with a short marker', async () => {
    const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
    mockComplete.mockReset();

    const bigRowJson = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ iso3: 'ABC', year: 2000 + i, value: i })));

    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'fw1', name: 'fetch_worldbank', arguments: { indicator_id: 'X', country_ids: ['ABC'], year_start: 2000, year_end: 2010 } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'f1', name: 'finish', arguments: { one_line_finding: 'Done.' } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: 'PASS: chart rendered.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' });
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    await session.ask('Fetch data', cb);

    // Second turn, to inspect what turn 1's tool messages look like by the time
    // they're sent again.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'f2', name: 'finish_explanation', arguments: { explanation: 'ok' } }],
      usage: { input: 10, output: 5 },
    });
    await session.ask('Explain', cb);

    const secondCallArgs = mockComplete.mock.calls[3]; // index 3 = the finish_explanation-producing call
    const messagesArg = secondCallArgs[1] as { role: string; content?: string }[];
    const toolMessages = messagesArg.filter((m) => m.role === 'tool');
    const anyMessageHasFullRowDump = messagesArg.some(
      (m) => typeof m.content === 'string' && m.content.length > 500
    );
    expect(anyMessageHasFullRowDump).toBe(false);
    expect(toolMessages.length).toBeGreaterThan(0); // trimmed, not deleted — a short marker remains
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — turn 1's `fetch_worldbank` tool-result message (the full `summarizeRows()` text, which itself is already compact, so use the `bigRowJson`-scale reasoning from the design doc, not this specific summary) is still present at full length by the time turn 2 sends `messages`. Note: since `summarizeRows()` is already compact (one line per country), this test's real trigger is any tool message from a completed turn — the assertion is about the trimming mechanism existing at all, not about a specific byte threshold; adjust the `500` threshold only if `summarizeRows` output for a single test country is naturally short enough to pass without trimming (in which case, add a second `fetch_worldbank_all`-style call in the mock with more countries to force a longer summary before concluding the test itself is wrong).

- [ ] **Step 3: Implement trimming**

In `createSession`'s `ask()` function (from Task 3/4), add a marker at the very top of `ask()`, alongside the existing `turnKind`/`state.finding` resets from Task 3/4:

```ts
    const turnStartIndex = messages.length;
```

Then, after the turn's terminal `cb.onStatus('Done', 'ok')` call and before the final `return { ... }`, add:

```ts
    // Trim this turn's tool-result messages down to a short marker. state.rows
    // (plain JS memory, not `messages`) remains the durable source of truth for
    // chart data across turns — see the design doc's context retention policy.
    // Only messages pushed during THIS turn are in range; earlier turns were
    // already trimmed when they completed.
    for (let i = turnStartIndex; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'tool' && m.content.length > 200) {
        messages[i] = { ...m, content: `(trimmed — ${m.content.length} chars, see current data summary next turn)` };
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS. If the test's `bigRowJson` variable is unused after this implementation (since `summarizeRows` output is what actually lands in the tool message, not raw JSON), remove the unused variable from the test to avoid a lint/TS-unused warning — check with `npm run build`.

- [ ] **Step 5: Verify the full test suite and build**

Run: `npm test && npm run build`
Expected: both pass. All prior tasks' tests must still pass (Tasks 2, 3, 4).

- [ ] **Step 6: Commit**

```bash
git add src/lib/chitti/agent.ts src/lib/chitti/agent.test.ts
git commit -m "Trim completed turns' tool-result messages to keep session context bounded"
```

---

## Task 6: Temporary compatibility export for chitti.astro (removed in Plan 2)

**Files:**
- Modify: `src/lib/chitti/agent.ts`

**Interfaces:**
- Produces: `export async function runAgent(cfg, question, cb): Promise<AgentOutput>` — a thin wrapper (`createSession(cfg).ask(question, cb)`) so the existing `chitti.astro` (which still calls `runAgent` directly, unchanged until Plan 2) keeps building and working exactly as it does today, with zero behavior change to the single-turn flow.

This task exists only to keep the site buildable and deployable between Plan 1 and Plan 2 — Plan 2's first task removes this shim once `chitti.astro` is updated to call `createSession()` directly.

- [ ] **Step 1: Add the compatibility export**

At the bottom of `src/lib/chitti/agent.ts`, after `createSession`, add:

```ts
// Temporary one-shot compatibility wrapper for chitti.astro, which still calls
// this directly. Removed once chitti.astro is updated to call createSession()
// and manage its own session across turns (see the multi-turn UI plan).
export async function runAgent(
  cfg: ProviderConfig,
  question: string,
  cb: AgentCallbacks
): Promise<AgentOutput> {
  return createSession(cfg).ask(question, cb);
}
```

- [ ] **Step 2: Verify the build passes with the existing UI untouched**

Run: `npm run build`
Expected: build completes with no errors — `chitti.astro`'s existing `import { runAgent } from '../../lib/chitti/agent'` and its call site keep working exactly as before, since a fresh session is created per call, matching today's one-shot behavior exactly (single-turn UI, single-turn session, same result).

- [ ] **Step 3: Manually smoke-test the live page still works**

Run: `npm run dev`, open `http://localhost:4321/apps/chitti` in a browser, ask one of the preset questions with a real (or free OpenRouter) API key, confirm a chart renders and the answer appears exactly as it did before this plan started. This is the same page Plan 2 will restructure next, so confirming it's unbroken now is the checkpoint before that work begins.

- [ ] **Step 4: Commit**

```bash
git add src/lib/chitti/agent.ts
git commit -m "Add temporary runAgent compatibility wrapper for chitti.astro"
```

---

## Plan Complete

At this point:
- `agent.ts` exports `createSession(cfg): ChittiSession` as its primary multi-turn API.
- A temporary `runAgent()` wrapper keeps `chitti.astro` building and working unchanged (single question in, single answer out) until Plan 2.
- Explanation turns (`finish_explanation`) skip verification and never produce the zero-result/error UI state (once Plan 2 wires up `kind`-based rendering).
- Re-plotting always re-derives via `execute_js` against `state.rows`, per the addendum injected on turn 2+.
- Old tool-result messages are trimmed after each turn, keeping session context bounded.
- All logic is covered by vitest unit tests with no real network calls.

Plan 2 (`chitti.astro` thread UI) builds directly on `createSession()` and removes the Task 6 shim as its first step.
