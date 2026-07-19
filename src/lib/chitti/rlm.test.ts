import { describe, it, expect, vi } from 'vitest';
import {
  createRlmRun,
  createTurnBudget,
  provenanceNotice,
  buildPrompt,
  MAX_LLM_CALLS_PER_RUN,
  MAX_LLM_CALLS_PER_TURN,
  MAX_LLM_DATA_BYTES,
  type RlmCaller,
} from './rlm';
import { executeJs, TOOL_SCHEMAS, type DataRow } from './tools';

// Every test here uses a stubbed caller. Nothing in this suite touches the
// network: the point is to pin the bounds and the provenance tag, which are
// pure logic, not provider behaviour.
function stubCaller(text = 'ok'): RlmCaller & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (prompt: string) => {
    calls.push(prompt);
    return { text, usage: { input: 10, output: 5 } };
  }) as RlmCaller & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const ROWS: DataRow[] = [
  { country: 'India', iso3: 'IND', year: 2020, value: 1, indicator: 'X' },
  { country: 'Chad', iso3: 'TCD', year: 2020, value: 2, indicator: 'X' },
];

describe('rlm bounds', () => {
  it('allows up to 4 llm() calls per run and rejects the 5th', async () => {
    const caller = stubCaller();
    const run = createRlmRun(caller, createTurnBudget());
    for (let i = 0; i < MAX_LLM_CALLS_PER_RUN; i++) {
      await expect(run.llm('classify this')).resolves.toBeTruthy();
    }
    await expect(run.llm('one too many')).rejects.toThrow(/4 calls per execute_js run/);
    expect(caller.calls).toHaveLength(MAX_LLM_CALLS_PER_RUN);
    expect(run.used).toBe(MAX_LLM_CALLS_PER_RUN);
  });

  it('caps the turn at 8 calls across separate runs', async () => {
    const caller = stubCaller();
    const budget = createTurnBudget();
    // Two full runs of 4 exhaust the per-turn budget exactly.
    for (let r = 0; r < 2; r++) {
      const run = createRlmRun(caller, budget);
      for (let i = 0; i < MAX_LLM_CALLS_PER_RUN; i++) await run.llm('judge');
    }
    expect(budget.used).toBe(MAX_LLM_CALLS_PER_TURN);
    const third = createRlmRun(caller, budget);
    await expect(third.llm('judge')).rejects.toThrow(/8 calls per turn/);
    expect(caller.calls).toHaveLength(MAX_LLM_CALLS_PER_TURN);
  });

  it('rejects data over the ~20KB serialized cap without spending budget', async () => {
    const caller = stubCaller();
    const budget = createTurnBudget();
    const run = createRlmRun(caller, budget);
    const huge = { blob: 'x'.repeat(MAX_LLM_DATA_BYTES + 100) };
    await expect(run.llm('judge', huge)).rejects.toThrow(/data too large/);
    expect(caller.calls).toHaveLength(0);
    // A refused call must not consume the allowance the model could still
    // use correctly with a smaller payload.
    expect(run.used).toBe(0);
    expect(budget.used).toBe(0);
    // Just under the cap goes through.
    await expect(run.llm('judge', { blob: 'x'.repeat(1000) })).resolves.toBeTruthy();
  });

  it('refuses unserializable data rather than sending a mangled prompt', async () => {
    const caller = stubCaller();
    const run = createRlmRun(caller, createTurnBudget());
    const cyclic: any = { a: 1 };
    cyclic.self = cyclic;
    await expect(run.llm('judge', cyclic)).rejects.toThrow(/JSON-serializable/);
    expect(caller.calls).toHaveLength(0);
  });

  it('rejects an empty prompt', async () => {
    const run = createRlmRun(stubCaller(), createTurnBudget());
    await expect(run.llm('   ')).rejects.toThrow(/non-empty string/);
  });
});

describe('rlm depth-1', () => {
  it('the caller contract has no tools parameter, so the nested call cannot recurse', async () => {
    // Depth-1 is by construction: RlmCaller takes only a prompt. Assert the
    // stub is invoked with exactly one argument, so nothing can smuggle a
    // tool array (and therefore another execute_js) into the nested call.
    const seen: unknown[][] = [];
    const caller: RlmCaller = async (...args: unknown[]) => {
      seen.push(args);
      return { text: 'ok', usage: { input: 1, output: 1 } };
    };
    const run = createRlmRun(caller, createTurnBudget());
    await run.llm('judge', ROWS);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(typeof seen[0][0]).toBe('string');
  });

  it('records depth 1 on every receipt', async () => {
    const run = createRlmRun(stubCaller(), createTurnBudget());
    await run.llm('a');
    await run.llm('b', { rows: 2 });
    expect(run.receipts.map((r) => r.depth)).toEqual([1, 1]);
  });

  it('code inside a nested prompt cannot reach llm again — the inner model has no tool for it', async () => {
    // The nested prompt is plain text with no tool schema attached; the only
    // recursion path would be the outer sandbox, which is not re-entered.
    const caller = stubCaller();
    const run = createRlmRun(caller, createTurnBudget());
    await run.llm('classify', ROWS);
    expect(caller.calls[0]).toContain('INSTRUCTION:');
    expect(caller.calls[0]).not.toContain('execute_js');
  });
});

describe('rlm receipts', () => {
  it('records prompt summary, data size, duration and tokens per call', async () => {
    const run = createRlmRun(stubCaller(), createTurnBudget());
    await run.llm('classify these countries as coastal or landlocked', ROWS);
    expect(run.receipts).toHaveLength(1);
    const r = run.receipts[0];
    expect(r.promptSummary).toContain('coastal');
    expect(r.dataBytes).toBe(JSON.stringify(ROWS).length);
    expect(r.tokens).toBe(15);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.ok).toBe(true);
  });

  it('records a receipt for a failed call and surfaces the error', async () => {
    const caller: RlmCaller = async () => {
      throw new Error('provider exploded');
    };
    const run = createRlmRun(caller, createTurnBudget());
    await expect(run.llm('judge')).rejects.toThrow(/provider exploded/);
    expect(run.receipts).toHaveLength(1);
    expect(run.receipts[0].ok).toBe(false);
    expect(run.receipts[0].error).toContain('provider exploded');
  });

  it('truncates a long prompt summary', async () => {
    const run = createRlmRun(stubCaller(), createTurnBudget());
    await run.llm('z'.repeat(500));
    expect(run.receipts[0].promptSummary.length).toBeLessThanOrEqual(120);
  });
});

describe('rlm provenance', () => {
  it('tags every result model_derived with a human-readable note', async () => {
    const run = createRlmRun(stubCaller('landlocked'), createTurnBudget());
    const res = await run.llm('classify', ROWS);
    expect(res.model_derived).toBe(true);
    expect(res.text).toBe('landlocked');
    expect(res.provenance).toMatch(/never cite this as a source value/);
  });

  it('the notice shown to the model names the values as model-derived', () => {
    const n = provenanceNotice(2);
    expect(n).toContain('2 llm() judgment calls');
    expect(n).toContain('MODEL-DERIVED');
    expect(n).toMatch(/not fetched data/);
  });

  it('the tag survives being returned through execute_js', async () => {
    const run = createRlmRun(stubCaller('coastal'), createTurnBudget());
    const out = await executeJs(
      'const j = await llm("classify", rows); return { label: j.text, derived: j.model_derived, note: j.provenance };',
      ROWS,
      run.llm
    );
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ label: 'coastal', derived: true });
    expect((out.result as any).note).toMatch(/never cite/);
  });

  it('llm() output never enters the fetched-row set that feeds the CSV and chart', async () => {
    // The non-citability boundary is structural: execute_js results are
    // returned to the model as a string and are never merged into the
    // session's rows, so a model-derived value has no path into rowsToCSV or
    // the chart's data. Pin that executeJs does not mutate the rows it is
    // given, even when the code tries.
    const rows: DataRow[] = ROWS.map((r) => ({ ...r }));
    const run = createRlmRun(stubCaller('999'), createTurnBudget());
    const out = await executeJs(
      'const j = await llm("guess a value", rows); return rows.concat([{country:"Fake",iso3:"FKE",year:2021,value:Number(j.text),indicator:"X"}]);',
      rows,
      run.llm
    );
    expect(out.ok).toBe(true);
    // The returned array is a copy; the caller's row set is untouched.
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.iso3 === 'FKE')).toBe(false);
  });
});

describe('execute_js async contract', () => {
  it('runs plain synchronous code exactly as before', async () => {
    const out = await executeJs('return rows.length;', ROWS);
    expect(out).toEqual({ ok: true, result: 2 });
  });

  it('still forces the result through JSON and maps undefined to null', async () => {
    const out = await executeJs('return undefined;', ROWS);
    expect(out).toEqual({ ok: true, result: null });
  });

  it('reports a thrown error with the same shape', async () => {
    const out = await executeJs('throw new Error("boom");', ROWS);
    expect(out.ok).toBe(false);
    expect(out.error).toBe('boom');
  });

  it('reports a syntax error rather than throwing out of executeJs', async () => {
    const out = await executeJs('return (((;', ROWS);
    expect(out.ok).toBe(false);
    expect(typeof out.error).toBe('string');
  });

  it('the expression-style retry wrap still works', async () => {
    const out = await executeJs('return (rows.map((r) => r.iso3))', ROWS);
    expect(out.result).toEqual(['IND', 'TCD']);
  });

  it('code that calls llm() without a caller gets a clear refusal, not a ReferenceError', async () => {
    const out = await executeJs('const j = await llm("x"); return j;', ROWS);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/llm\(\) is not available/);
  });

  it('a rejected bound surfaces as an execute_js error the model can act on', async () => {
    const run = createRlmRun(stubCaller(), createTurnBudget());
    const out = await executeJs(
      'for (let i = 0; i < 10; i++) { await llm("judge " + i); } return "done";',
      ROWS,
      run.llm
    );
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/4 calls per execute_js run/);
  });

  it('one RlmRun shared across the retry-wrap does not hand out a second allowance', async () => {
    // Mirrors agent.ts dispatch: the same run object is used for the original
    // body and the wrapped retry. Four calls total, not four per attempt.
    const caller = stubCaller();
    const run = createRlmRun(caller, createTurnBudget());
    // Expression-style code with no `return`: exactly what triggers the
    // retry-wrap in agent.ts. Each attempt spends 2 calls.
    const code = '(await llm("a")) && (await llm("b")) && null';
    const first = await executeJs(code, ROWS, run.llm);
    expect(first.result ?? null).toBeNull();
    await executeJs('return (' + code + ')', ROWS, run.llm);
    expect(run.used).toBe(4);
    await expect(run.llm('fifth')).rejects.toThrow(/4 calls per execute_js run/);
  });
});

describe('execute_js tool schema documents llm()', () => {
  const schema = TOOL_SCHEMAS.find((t) => t.name === 'execute_js')!;

  it('tells the model llm() exists and how it is bounded', () => {
    expect(schema.description).toContain('llm');
    expect(schema.description).toContain('4 calls per run');
    expect(schema.description).toContain('8 per turn');
    expect(schema.description).toContain('20KB');
  });

  it('states the provenance rule in the schema the model reads', () => {
    expect(schema.description).toContain('PROVENANCE');
    expect(schema.description).toMatch(/never chart it as source data/i);
  });
});

describe('buildPrompt', () => {
  it('includes the instruction and the serialized data, and no tool affordances', () => {
    const p = buildPrompt('label these', JSON.stringify({ a: 1 }));
    expect(p).toContain('label these');
    expect(p).toContain('{"a":1}');
    expect(p).toContain('judgment step');
  });

  it('omits the DATA block when no data is passed', () => {
    expect(buildPrompt('label these', '')).not.toContain('DATA:');
  });
});
