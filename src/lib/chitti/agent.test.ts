import { describe, it, expect, vi } from 'vitest';
import { TOOL_SCHEMAS } from './tools';

describe('finish_explanation tool schema', () => {
  it('is registered with an explanation string parameter', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.name === 'finish_explanation');
    expect(schema).toBeDefined();
    expect(schema!.parameters.required).toContain('explanation');
    expect(schema!.parameters.properties.explanation).toBeDefined();
  });
});

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
    // literal PASS text from the mock. See agent.ts's verify()).
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
    // NOTE: no verifier-call mock is queued for turn 2. If the implementation
    // calls the verifier anyway, this test fails with "no more mocked values",
    // proving the skip actually happened rather than merely asserting the field.

    const second = await session.ask('Explain this data', cb);
    expect(second.kind).toBe('explanation');
    expect(second.finding).toBe('Here is what the data shows.');
    // chartSpec is per-turn: a turn that renders no chart returns null, so
    // the UI never re-displays the previous turn's chart on a follow-up.
    expect(second.chartSpec).toBeNull();
  });
});

describe('verifier-fail retry', () => {
  it('appends only the critique on retry, not a duplicate of the question', async () => {
    const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
    mockComplete.mockReset();

    // First pass: render a chart, then finish.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'r1', name: 'render_chart', arguments: { type: 'line', title: 'T', series: [{ name: 'A', data: [[2000, 1]] }] } }],
      usage: { input: 10, output: 5 },
    });
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'f1', name: 'finish', arguments: { one_line_finding: 'First attempt.' } }],
      usage: { input: 10, output: 5 },
    });
    // Verify #1 FAILs, which triggers agentPass(critique) a second time.
    mockComplete.mockResolvedValueOnce({
      text: 'FAIL: chart type mismatched to the question.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });
    // Retry pass: model finishes again.
    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'f2', name: 'finish', arguments: { one_line_finding: 'Second attempt.' } }],
      usage: { input: 10, output: 5 },
    });
    // Verify #2 passes.
    mockComplete.mockResolvedValueOnce({
      text: 'PASS: fixed.',
      toolCalls: [],
      usage: { input: 5, output: 2 },
    });

    const session = createSession({ provider: 'openrouter', model: 'test-model', apiKey: 'x' });
    const cb = { onTrace: () => {}, onFiles: () => {}, onChart: () => {}, onStatus: () => {} };
    await session.ask('Only question', cb);

    // The retry model call is mock index 3 (0=render, 1=finish, 2=verify-fail, 3=retry).
    const retryCallArgs = mockComplete.mock.calls[3];
    const messagesArg = retryCallArgs[1] as { role: string; content: string }[];
    const questionCopies = messagesArg.filter(
      (m) => m.role === 'user' && m.content === 'Only question'
    ).length;
    // Before the dedup fix, the retry pass re-pushed the question, so it appeared twice.
    expect(questionCopies).toBe(1);
    // The critique from the failed verifier IS appended on retry.
    const hasCritique = messagesArg.some(
      (m) => m.role === 'user' && m.content.startsWith('A previous attempt was judged insufficient.')
    );
    expect(hasCritique).toBe(true);
  });
});

describe('message trimming', () => {
  it('replaces a completed turn\'s tool-result messages with a short marker', async () => {
    const mockComplete = complete as unknown as ReturnType<typeof vi.fn>;
    mockComplete.mockReset();

    // execute_js's result is JSON.stringify'd verbatim into the tool message
    // (unlike fetch_worldbank, which goes through the compact summarizeRows()),
    // so it's the faithful way to force a genuinely large tool-result payload
    // in this test. A live fetch_worldbank_all call would also work but would
    // need network mocking and is flakier than the deterministic code path here.
    const bigRowJson = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ iso3: 'ABC', year: 2000 + i, value: i })));

    mockComplete.mockResolvedValueOnce({
      text: '',
      toolCalls: [{ id: 'e0', name: 'execute_js', arguments: { code: `return ${bigRowJson};` } }],
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
    // Scoped to tool messages specifically. The system prompt and the
    // turn-2 "you already have data" reminder are legitimately long and are
    // not the trimming target; only completed turns' tool-result payloads are.
    const anyToolMessageHasFullRowDump = toolMessages.some(
      (m) => typeof m.content === 'string' && m.content.length > 500
    );
    expect(anyToolMessageHasFullRowDump).toBe(false);
    expect(toolMessages.length).toBeGreaterThan(0); // trimmed, not deleted. A short marker remains
    expect(toolMessages.some((m) => m.content?.includes('trimmed'))).toBe(true);
  });
});
