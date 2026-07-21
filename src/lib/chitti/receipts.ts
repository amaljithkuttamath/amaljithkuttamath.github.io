// receipts.ts — the TraceEvent type: one streamed line-item in the agent's
// live receipt/timeline (a tool call, a reasoning step, a verify verdict, a
// plan card, a recursive llm() child). The bottom of the trace layer.
import type { SearchReceipt } from './tools';
import type { InsightBrief } from './planner';

export interface TraceEvent {
  tool: string;
  argSummary: string;
  status: 'running' | 'ok' | 'error';
  detail?: string;
  // Wall-clock time the event was pushed (epoch ms). Drives the receipt's
  // per-line timestamp. Captured once, at push time, not re-derived later.
  ts: number;
  // Tokens consumed by the LLM turn that produced this tool call, when this
  // step is directly attributable to one. Pure data-fetch/file steps that
  // aren't the result of a turn we're attributing usage to stay undefined;
  // the UI omits the token figure rather than showing a fake zero.
  tokens?: number;
  // Set only on the synthetic 'verify' trace event, once the verifier call
  // has returned a verdict. Drives the ink-stamped VERIFIED badge. The UI
  // must only stamp a step where this is true.
  pass?: boolean;
  // The three honest verification outcomes, set only on a 'verify' event:
  //   'verified'    — the verifier ran and passed (pass===true; amber stamp).
  //   'unverified'  — the verifier ran and did NOT confirm the answer, or its
  //                   output was unparseable (could-not-verify). pass===false.
  //   'unavailable' — the verify call itself failed (network/provider error).
  //                   NEVER implies the answer was verified.
  //   'skipped'     — the run produced no result (no answer, chart, or rows), so
  //                   verify() was never called; renders a muted "nothing to
  //                   verify" line, never a VERIFIED stamp.
  // The UI keys its answer/receipt treatments off this, never off a
  // defaulted-true pass.
  verifyStatus?: 'verified' | 'unverified' | 'unavailable' | 'skipped';
  // The verifier's self-reported confidence in ITS verdict (not the finding's).
  // 'none' when the verifier couldn't run (unavailable). Rendered on the verify
  // receipt beside the verdict.
  confidence?: 'high' | 'medium' | 'low' | 'none';
  // The concrete problems the verifier flagged on a non-pass — each a short
  // sentence naming WHAT was doubted (claim vs source, missing citation, number
  // not found). Empty on a pass. Never fabricated: a malformed/unparseable
  // verdict yields [] (could-not-verify), not invented issues.
  issues?: string[];
  // Set only on a 'find_series' step: structured search metadata (databases
  // searched, candidate count, top match + which terms/synonyms fired) that
  // the UI renders as a dedicated search-receipt card. UI-only.
  receipt?: SearchReceipt;
  // Set on a recursive 'llm' step (an llm() call made from inside execute_js):
  // renders as an indented child line-item under its execute_js parent, so the
  // recursion is visible in the trace. The parent execute_js step immediately
  // precedes this step's run in the event list.
  nested?: boolean;
  // Actual measured wall-clock duration (ms) for a step, when known at push
  // time (the llm() receipts set this). The UI prefers it over its own
  // render-time timer so a staged/offline render still shows a real duration.
  durationMs?: number;
  // Serialized-data size (bytes) attached to an llm() call — the size of the
  // data slice the recursive call reasoned over. UI shows it on the receipt.
  dataBytes?: number;
  // Set true on a write_file step whose content is model-derived (produced via
  // llm(), not fetched). Drives the subtle "model-derived" provenance label.
  derived?: boolean;
  // Set only on the synthetic 'plan' event (backlog #10): the parsed insight
  // brief for a gated planning turn. Renders as a plan card at the TOP of the
  // turn's trace — the insight line + a mono step checklist that the UI checks
  // off against later tool events (matchStepToEvent). Present only when a plan
  // was gated in AND the model returned a well-formed brief; a malformed brief
  // yields no 'plan' event at all (never a faked one). UI-only.
  plan?: InsightBrief;
}
