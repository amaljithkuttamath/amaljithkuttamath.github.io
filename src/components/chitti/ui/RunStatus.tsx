import type { ReactNode } from "react";
import type { Phase } from "../../../lib/chitti/workspace/model";
import { Notice, Spinner } from "./controls";

const NOTICE: Partial<Record<Phase, { tone: "info" | "warn" | "error"; hint: string }>> = {
  "needs-key": {
    tone: "warn",
    hint: "Questions about one indicator, some countries and years are answered directly from source data, without a model.",
  },
  error: { tone: "error", hint: "Retry, or rephrase the question." },
  stopped: { tone: "info", hint: "Retry, or ask something else." },
};

/**
 * The state of one run, with the agent's own status string verbatim in a
 * `role="status"` element. Running and waiting show a live line (the steps
 * themselves live in the thinking block); needs-key, error and stopped become
 * a notice carrying the relevant actions. Other phases render only children.
 */
export function RunStatus({
  phase,
  status,
  actions,
  pendingText,
  hint,
  children,
}: {
  phase: Phase;
  status: string;
  actions?: ReactNode;
  /** Shown instead of `status` while running, for callers with their own wording. */
  pendingText?: string;
  /** Replaces the notice's explanatory line; `null` shows none. */
  hint?: string | null;
  children?: ReactNode;
}) {
  if (phase === "running" || phase === "waiting") {
    return (
      <div className="cx-reply" data-phase={phase}>
        <div className="cx-run">
          {phase === "running" ? <Spinner label="Working" /> : <span className="cx-dot" style={{ background: "var(--cx-warn)" }} aria-label="Waiting for your answer" role="img" />}
          <p role="status" className="cx-run-status">
            {pendingText || status}
          </p>
          {actions && <div className="cx-run-actions">{actions}</div>}
        </div>
        {children}
      </div>
    );
  }
  const notice = NOTICE[phase];
  if (!notice) return children ? <>{children}</> : null;
  return (
    <div className="cx-reply" data-phase={phase}>
      <Notice tone={notice.tone} title={status} actions={actions}>
        {hint === undefined ? notice.hint : hint || undefined}
      </Notice>
      {children}
    </div>
  );
}
