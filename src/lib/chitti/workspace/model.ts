import { cleanShareState, type ShareStateV1 } from "../share";
import type { TraceEvent } from "../receipts";
import type { ProviderConfig, ProviderId } from "../providers";
import type { FastPathPlan, SeriesCandidate } from "../fastpath";
import type { SessionOptions } from "../session";
export type Phase =
  | "idle"
  | "running"
  | "waiting"
  | "done"
  | "stopped"
  | "error"
  | "needs-key";
export interface Analysis {
  id: string;
  question: string;
  phase: Phase;
  status: string;
  origin: "direct" | "agent" | "example" | "shared" | "view";
  result: ShareStateV1 | null;
  trace: TraceEvent[];
  files: Record<string, string>;
  cost?: number;
  model?: string;
  // Which provider ran the model steps (never the key). Set only on agent turns.
  provider?: ProviderId;
  // Wall-clock bounds of the run, stamped by the adapter. `endedAt` is set on
  // the first terminal snapshot; absent while running. Never estimated.
  startedAt?: number;
  endedAt?: number;
  // A direct (no-model) answer: the parsed plan and the series it used, so the
  // chart's tokens can re-run the same lookup with an edited plan, plus the
  // other series the phrase fits (offered as "switch to", never charted).
  direct?: { plan: FastPathPlan; series: SeriesCandidate; alternatives: SeriesCandidate[] };
  // An ambiguous direct lookup: nothing was charted; these are the choices.
  choice?: { phrase: string; plan: FastPathPlan; candidates: SeriesCandidate[] };
}
export interface Question {
  id: string;
  question: string;
  options: string[];
}
export interface WorkspaceState {
  analysis: Analysis | null;
  question: Question | null;
}
export interface Settings extends ProviderConfig {
  directOnly?: boolean;
  sources: string[];
  rlm: boolean;
  jev?: SessionOptions["jev"];
}
export const CATALOG_ID =
  "https://amaljithkuttamath.github.io/apps/chitti/catalog.json";
export function resultSurface(result: ShareStateV1) {
  const clean = cleanShareState(result);
  if (!clean) throw new Error("Invalid analysis result");
  return [
    {
      version: "v0.9",
      createSurface: { surfaceId: "result", catalogId: CATALOG_ID },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "result",
        components: [
          {
            id: "root",
            component: "AnalysisResult",
            resultJSON: JSON.stringify(clean),
          },
        ],
      },
    },
  ];
}
export function questionSurface(question: Question) {
  return [
    {
      version: "v0.9",
      createSurface: { surfaceId: "question", catalogId: CATALOG_ID },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "question",
        components: [
          {
            id: "root",
            component: "Clarification",
            question: question.question,
            options: question.options,
            requestId: question.id,
          },
        ],
      },
    },
  ];
}
export function fromShared(
  result: ShareStateV1,
  origin: "example" | "shared",
  id: string,
): Analysis {
  return {
    id,
    question: result.q,
    result,
    origin,
    phase: "done",
    status: origin === "example" ? "Recorded example" : "Shared snapshot",
    trace: [],
    files: {},
  };
}
export function safeLink(value: string) {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) ? u.href : undefined;
  } catch {
    return undefined;
  }
}
