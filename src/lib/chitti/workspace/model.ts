import { cleanShareState, type ShareStateV1 } from "../share";
import type { TraceEvent } from "../receipts";
import type { ProviderConfig } from "../providers";
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
