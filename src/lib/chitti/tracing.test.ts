import { describe, it, expect } from 'vitest';
import { buildTurnRuns, tracingConfig, type TurnTraceInput } from './tracing';
import type { TraceEvent } from './receipts';

const ev = (over: Partial<TraceEvent>): TraceEvent => ({
  tool: 'find_series',
  argSummary: '',
  status: 'ok',
  ts: 1_700_000_000_000,
  ...over,
});

// Deterministic id generator so the run tree is fully assertable.
const idFor = (seed: string) => 'id-' + seed;

const baseInput = (over: Partial<TurnTraceInput> = {}): TurnTraceInput => ({
  question: 'India GDP per capita',
  trace: [],
  model: 'nvidia/nemotron:free',
  provider: 'openrouter',
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_010_000,
  ...over,
});

describe('buildTurnRuns — TraceEvent → LangSmith run tree', () => {
  it('builds a root chain run carrying the question, model, and project', () => {
    const { post } = buildTurnRuns(baseInput({ finding: 'Rose to ~$2,480.', cost: 0 }), { project: 'chitti-dev', idFor });
    const root = post[0];
    expect(root.id).toBe('id-root');
    expect(root.trace_id).toBe('id-root'); // root is its own trace
    expect(root.run_type).toBe('chain');
    expect(root.name).toBe('chitti.turn');
    expect(root.inputs).toEqual({ question: 'India GDP per capita' });
    expect(root.outputs.finding).toBe('Rose to ~$2,480.');
    expect(root.session_name).toBe('chitti-dev');
    expect(root.extra?.metadata).toMatchObject({ model: 'nvidia/nemotron:free', provider: 'openrouter', cost_usd: 0, steps: 0 });
    expect(root.parent_run_id).toBeUndefined();
  });

  it('maps each trace event to a child run nested under the root', () => {
    const { post } = buildTurnRuns(
      baseInput({
        trace: [
          ev({ tool: 'find_series', argSummary: 'gdp per capita', detail: '3 hits', ts: 1_700_000_000_100 }),
          ev({ tool: 'fetch_series', argSummary: 'NY.GDP.PCAP.CD · IND', ts: 1_700_000_000_200, tokens: 5000 }),
          ev({ tool: 'render_chart', argSummary: 'line · GDP', ts: 1_700_000_000_300 }),
        ],
      }),
      { project: 'chitti', idFor }
    );
    expect(post).toHaveLength(4); // root + 3
    const [root, a, b] = post;
    expect(a.parent_run_id).toBe(root.id);
    expect(a.name).toBe('find_series');
    expect(a.run_type).toBe('tool');
    expect(a.inputs).toEqual({ args: 'gdp per capita' });
    expect(a.outputs).toEqual({ detail: '3 hits' });
    // Nesting: every child's dotted_order starts with the root's + '.'
    expect(a.dotted_order.startsWith(root.dotted_order + '.')).toBe(true);
    // Sibling ordering is strictly increasing (seq-driven microseconds).
    expect(a.dotted_order < b.dotted_order).toBe(true);
    expect(b.extra?.metadata).toMatchObject({ tokens: 5000 });
  });

  it('classifies reasoning/verify as llm runs and carries verify metadata', () => {
    const { post } = buildTurnRuns(
      baseInput({
        trace: [
          ev({ tool: 'reasoning', detail: 'thinking…', ts: 1_700_000_000_100 }),
          ev({ tool: 'verify', status: 'ok', verifyStatus: 'verified', confidence: 'high', issues: [], ts: 1_700_000_000_200 }),
        ],
      }),
      { project: 'chitti', idFor }
    );
    expect(post[1].run_type).toBe('llm'); // reasoning
    expect(post[2].run_type).toBe('llm'); // verify
    expect(post[2].extra?.metadata).toMatchObject({ verify_status: 'verified', confidence: 'high' });
  });

  it('surfaces an errored step and a turn-level error', () => {
    const { post } = buildTurnRuns(
      baseInput({
        error: 'Could not reach OpenRouter',
        trace: [ev({ tool: 'fetch_series', status: 'error', detail: 'API rejected id', ts: 1_700_000_000_100 })],
      }),
      { project: 'chitti', idFor }
    );
    expect(post[0].error).toBe('Could not reach OpenRouter');
    expect(post[1].error).toBe('API rejected id');
  });

  it('always emits the root run even for an empty trace', () => {
    const { post } = buildTurnRuns(baseInput(), { project: 'chitti', idFor });
    expect(post).toHaveLength(1);
    expect(post[0].run_type).toBe('chain');
  });
});

describe('tracingConfig — off by default, opt-in via PUBLIC_ env', () => {
  it('is disabled when the flag is absent', () => {
    expect(tracingConfig({}).enabled).toBe(false);
  });

  it('enables on PUBLIC_LANGSMITH_TRACING and reads project + ingest url with defaults', () => {
    const on = tracingConfig({ PUBLIC_LANGSMITH_TRACING: '1' });
    expect(on.enabled).toBe(true);
    expect(on.ingestUrl).toBe('/langsmith/runs/batch'); // same-origin relay default
    expect(on.project).toBe('chitti');
    const custom = tracingConfig({
      PUBLIC_LANGSMITH_TRACING: '1',
      PUBLIC_LANGSMITH_PROJECT: 'chitti-prod',
      PUBLIC_LANGSMITH_INGEST_URL: 'https://relay.example.com/runs/batch',
    });
    expect(custom.project).toBe('chitti-prod');
    expect(custom.ingestUrl).toBe('https://relay.example.com/runs/batch');
  });
});
