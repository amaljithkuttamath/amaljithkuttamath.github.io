import type { ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { ChatToolCalls, type ChatToolCallItem } from "@astryxdesign/core/Chat";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import type { TraceEvent } from "../../../lib/chitti/receipts";
import type { Phase } from "../../../lib/chitti/workspace/model";

/** Trace events as Astryx tool-call rows (the steps list and the live view). */
export function traceCalls(trace: TraceEvent[]): ChatToolCallItem[] {
  return trace.map((step, i) => ({
    key: `${step.ts}-${i}`,
    name: step.tool.replaceAll("_", " "),
    target: step.argSummary || undefined,
    status:
      step.status === "ok" ? "complete" : step.status === "error" ? "error" : "running",
    errorMessage: step.status === "error" ? step.detail || "Step failed" : undefined,
    resultDetail: step.detail ? <pre className="cx-pre">{step.detail}</pre> : undefined,
  }));
}

/** Live list of the agent's steps; collapses to a summary once there are several. */
export function StepList({
  trace,
  label,
  defaultIsExpanded = false,
}: {
  trace: TraceEvent[];
  label?: string;
  defaultIsExpanded?: boolean;
}) {
  if (!trace.length) return null;
  return (
    <ChatToolCalls
      className="cx-steps"
      calls={traceCalls(trace)}
      label={label}
      defaultIsExpanded={defaultIsExpanded}
    />
  );
}

const BANNER: Partial<Record<Phase, { status: "info" | "warning" | "error"; hint: string }>> = {
  "needs-key": {
    status: "warning",
    hint: "Questions about a single indicator, countries and years can be answered directly from source data without a model.",
  },
  error: { status: "error", hint: "Retry, or rephrase the question." },
  stopped: { status: "info", hint: "Retry, or ask something else." },
};

/**
 * The state of one run. Running and waiting show a live indicator, the
 * agent's own status string verbatim (`role="status"`) and its live steps;
 * needs-key, error and stopped become a banner carrying the relevant actions.
 * Other phases render nothing.
 */
export function RunStatus({
  phase,
  status,
  trace = [],
  actions,
  pendingText,
  hint,
  children,
}: {
  phase: Phase;
  status: string;
  trace?: TraceEvent[];
  actions?: ReactNode;
  /** Shown instead of `status` while running, for callers with their own wording. */
  pendingText?: string;
  /** Replaces the banner's explanatory line; `null` shows none. */
  hint?: string | null;
  children?: ReactNode;
}) {
  if (phase === "running" || phase === "waiting") {
    return (
      <div className="cx-run" data-phase={phase}>
        <div className="cx-run-line">
          {phase === "running" ? (
            <Spinner size="sm" aria-label="Working" />
          ) : (
            <StatusDot variant="warning" label="Waiting for your answer" />
          )}
          <p role="status" className="cx-run-status">
            {pendingText || status}
          </p>
          {actions && <div className="cx-run-actions">{actions}</div>}
        </div>
        <StepList trace={trace} label={`${trace.length} steps so far`} defaultIsExpanded />
        {children}
      </div>
    );
  }
  const banner = BANNER[phase];
  if (!banner) return children ? <>{children}</> : null;
  return (
    <div className="cx-run" data-phase={phase}>
      <Banner
        status={banner.status}
        title={<span role="status">{status}</span>}
        description={hint === undefined ? banner.hint : hint || undefined}
        endContent={actions}
        collapsible={false}
      />
      {children}
    </div>
  );
}
