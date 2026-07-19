// rlm.ts: the bounded recursive `llm(prompt, data)` that execute_js code can
// call. It exists so the model can apply *judgment* to fetched rows — classify
// a country list, extract a label, bucket a category — as one step inside a
// computation, instead of hauling every row back through a full tool-calling
// turn to reason about it in prose.
//
// Every property that makes this safe to expose is enforced here, in one
// place, rather than trusted to the model-written code that calls it:
//
//   - depth-1 by construction: the nested completion is given an EMPTY tool
//     array, so the inner model has no execute_js to call and no way to
//     recurse. There is no depth counter to get wrong; the recursion simply
//     has no edge to follow.
//   - a per-run call cap (default 4) and a per-turn cap (default 8), so a
//     loop in the model's code cannot turn one execute_js into a hundred
//     billed completions.
//   - a serialized-size cap on `data` (~20KB), so a run cannot shove every
//     fetched row into a nested prompt.
//   - a receipt per call (prompt summary, data size, duration, tokens),
//     nested under the execute_js step in the trace.
//
// PROVENANCE (identity-critical). Anything that comes out of llm() is a model
// judgment, not a fetched number. It is tagged `model_derived: true` at this
// boundary and the tag rides along in the envelope the calling code receives.
// Chitti's whole identity is "show your work": a model-derived value must
// never be presented as though a source returned it. The mechanical half of
// that guarantee lives outside this file (execute_js results are never merged
// into the session's fetched rows, so they cannot reach the CSV or the chart's
// data path); this file supplies the tag and the visible receipt that make the
// distinction legible everywhere else.

export const MAX_LLM_CALLS_PER_RUN = 4;
export const MAX_LLM_CALLS_PER_TURN = 8;
export const MAX_LLM_DATA_BYTES = 20 * 1024;

// What the nested call needs from the outside world: a text-only completion.
// Deliberately narrower than providers.complete — no tools parameter exists in
// this type, so no caller can widen the nested call into a tool-calling one.
export interface RlmCaller {
  (prompt: string): Promise<{ text: string; usage: { input: number; output: number } }>;
}

// The nested receipt for one llm() call. Mirrors the trace-event vocabulary so
// the UI can render these underneath the execute_js step that produced them.
export interface RlmReceipt {
  promptSummary: string;
  dataBytes: number;
  durationMs: number;
  tokens: number;
  // Always 1. Recorded rather than assumed so the receipt states the bound it
  // was produced under instead of the reader having to trust the code.
  depth: 1;
  ok: boolean;
  error?: string;
}

// The value model-written code actually receives back from `await llm(...)`.
// The tag is on the envelope, not buried in a sibling field, so code that
// forwards the whole object forwards the provenance with it.
export interface RlmResult {
  model_derived: true;
  text: string;
  provenance: string;
}

const PROVENANCE_NOTE =
  'model judgment, not fetched data — never cite this as a source value';

export interface RlmBudget {
  // Calls already spent this turn, shared across every execute_js run in it.
  used: number;
  readonly max: number;
}

export function createTurnBudget(max: number = MAX_LLM_CALLS_PER_TURN): RlmBudget {
  return { used: 0, max };
}

export interface RlmRun {
  // The function handed to the sandboxed code as `llm`.
  llm: (prompt: unknown, data?: unknown) => Promise<RlmResult>;
  // Receipts for every call attempted in this run, in order.
  receipts: RlmReceipt[];
  // Calls spent in this run (successful or refused-after-the-fact; a call
  // refused BY a bound is not spent, it is rejected).
  used: number;
}

// Build the bounded `llm` for a single execute_js run. The run-level counter
// lives in the returned closure, which is why the caller must reuse ONE
// RlmRun across the retry-wrapped second attempt of the same execute_js call:
// otherwise a code path that runs twice would get a fresh budget each time.
export function createRlmRun(
  caller: RlmCaller,
  turnBudget: RlmBudget,
  opts?: { maxPerRun?: number; maxDataBytes?: number }
): RlmRun {
  const maxPerRun = opts?.maxPerRun ?? MAX_LLM_CALLS_PER_RUN;
  const maxDataBytes = opts?.maxDataBytes ?? MAX_LLM_DATA_BYTES;
  const receipts: RlmReceipt[] = [];
  let used = 0;

  async function llm(prompt: unknown, data?: unknown): Promise<RlmResult> {
    const text = typeof prompt === 'string' ? prompt : String(prompt ?? '');
    if (!text.trim()) {
      throw new Error('llm(prompt, data): prompt must be a non-empty string.');
    }
    if (used >= maxPerRun) {
      throw new Error(
        `llm() limit reached: ${maxPerRun} calls per execute_js run. ` +
          'Batch the rows you need judged into one call instead of looping.'
      );
    }
    if (turnBudget.used >= turnBudget.max) {
      throw new Error(
        `llm() limit reached: ${turnBudget.max} calls per turn. ` +
          'Work with what you already have.'
      );
    }

    const serialized = data === undefined ? '' : safeSerialize(data);
    const dataBytes = byteLength(serialized);
    if (dataBytes > maxDataBytes) {
      throw new Error(
        `llm() data too large: ${dataBytes} bytes (limit ${maxDataBytes}). ` +
          'Filter or aggregate the rows before asking for a judgment.'
      );
    }

    // Spend the budget only once every bound has passed, so a rejected call
    // does not consume budget the model could have used correctly.
    used++;
    turnBudget.used++;

    const started = now();
    try {
      const res = await caller(buildPrompt(text, serialized));
      const out = String(res?.text ?? '');
      receipts.push({
        promptSummary: summarize(text),
        dataBytes,
        durationMs: Math.round(now() - started),
        tokens: (res?.usage?.input ?? 0) + (res?.usage?.output ?? 0),
        depth: 1,
        ok: true,
      });
      return { model_derived: true, text: out, provenance: PROVENANCE_NOTE };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      receipts.push({
        promptSummary: summarize(text),
        dataBytes,
        durationMs: Math.round(now() - started),
        tokens: 0,
        depth: 1,
        ok: false,
        error: message,
      });
      throw new Error('llm() failed: ' + message);
    }
  }

  return {
    llm,
    receipts,
    get used(): number {
      return used;
    },
  };
}

// The nested system framing. Kept terse: this call is one judgment step inside
// a larger computation, and its answer is consumed by code, not by a person.
export function buildPrompt(prompt: string, serialized: string): string {
  const head =
    'You are a judgment step inside a data analysis computation. Answer the ' +
    'instruction using only the data given. Be terse and literal: return just ' +
    'the answer, no preamble, no explanation, no markdown fences. If the ' +
    'instruction asks for structured output, return raw JSON.';
  const body = serialized ? `\n\nDATA:\n${serialized}` : '';
  return `${head}\n\nINSTRUCTION:\n${prompt}${body}`;
}

// Marker prepended to the execute_js tool result whenever llm() was used in
// that run, so the provenance is stated in the model's own context and not
// only in the UI.
export function provenanceNotice(callCount: number): string {
  return (
    `NOTE: this result used ${callCount} llm() judgment call${callCount === 1 ? '' : 's'}. ` +
    'Any value derived from llm() is MODEL-DERIVED, not fetched data. Do not ' +
    'present it as a number a source returned, do not chart it as source data, ' +
    'and say it is your own classification if you mention it.'
  );
}

function safeSerialize(data: unknown): string {
  try {
    const s = JSON.stringify(data);
    return s === undefined ? String(data) : s;
  } catch {
    // Cyclic or otherwise unserializable: refuse rather than silently sending
    // a mangled "[object Object]" as the nested prompt's data.
    throw new Error('llm() data must be JSON-serializable (no cycles, no functions).');
  }
}

function byteLength(s: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return s.length;
}

function summarize(prompt: string): string {
  const flat = prompt.trim().replace(/\s+/g, ' ');
  return flat.length > 120 ? flat.slice(0, 117) + '…' : flat;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
