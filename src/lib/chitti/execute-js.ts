// execute-js.ts — the execute_js sandbox and its recursive-LM primitive type.
//
// execute_js: the model writes real JS to rank/diff/filter/aggregate the
// fetched rows, instead of doing that arithmetic by reasoning through
// numbers in natural language turns (observed directly: manually comparing
// ~190 countries' reduction values in reasoning text is slow, expensive, and
// error-prone). No fixed menu of operations — the model expresses whatever
// computation the question actually needs as code.
//
// Sandboxing note: this uses `new Function`, not a real VM (no
// quickjs-emscripten/WASM) — deliberately, to avoid a ~1.3MB dependency in a
// browser-only static site. The executed code's only argument is `rows`; it
// has no reference to anything else in this module's scope (Function bodies
// close over nothing but their own global scope, not the enclosing
// function's locals), so it cannot reach the VFS, the API key, or other
// module state. It CAN reach `window`/`fetch`/etc. like any other page
// script, so this is not a security boundary against malicious code — it's
// proportionate here because the executed code is written by the same
// model the user is already trusting to answer their question, operating on
// public World Bank data it just fetched, in the user's own tab. There is
// no execution timeout: a synchronous `new Function` call cannot be
// interrupted from the same thread. An infinite loop would hang this run
// the same way a broken tool-calling loop already could; a hard timeout
// would require moving execution to a Worker, which is more machinery than
// this risk currently justifies.
//
// RLM primitive: the code may also `await llm(prompt, data?)` — a bounded
// recursive language-model call over a slice of the data (the Recursive
// Language Model pattern: the context lives as data in this REPL and the
// model's own code makes small, depth-1 LM calls over pieces of it, keeping
// the raw data out of the main context). Because of `llm`, the sandboxed
// function is an AsyncFunction, so the code may use `await`; a plain
// synchronous `return` still works exactly as before. The caps, receipts,
// and provenance live in the injected `llm` (see agent.ts); executeJs only
// wires it in and awaits the result. When execute_js is run WITHOUT a
// session-provided llm (RLM off, or a direct unit test), the default is a
// function that throws on call — withholding, not a silent undefined.

import type { DataRow } from './tools';

export interface ExecuteJsResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

// The recursive LM primitive handed to sandboxed code. Returns text only —
// no tool access — so it is depth-1 by construction.
export type LlmFn = (prompt: string, data?: unknown) => Promise<string>;

// The AsyncFunction constructor is not a global binding; reach it off an async
// function's prototype. Lets the sandboxed body use `await llm(...)`.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as {
  new (...args: string[]): (...a: unknown[]) => Promise<unknown>;
};

// Default `llm` when execute_js is run without a session-provided one — RLM
// off (the model was never told llm() exists) or a direct unit test. Calling
// it is a clear, catchable error rather than a silent undefined: withholding
// by refusal-on-call, so the sandbox never sees an undefined identifier.
const llmUnavailable: LlmFn = async () => {
  throw new Error('llm() is not available in this context');
};

export async function executeJs(
  code: string,
  rows: DataRow[],
  llm: LlmFn = llmUnavailable
): Promise<ExecuteJsResult> {
  try {
    const fn = new AsyncFunction('rows', 'llm', code);
    const result = await fn(rows, llm);
    // Force through JSON so the result is always plain, serializable data —
    // matches every other tool's result shape and guards against the code
    // accidentally returning something (a DOM node, a class instance) that
    // can't be shown back to the model as a string.
    return { ok: true, result: JSON.parse(JSON.stringify(result ?? null)) };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
