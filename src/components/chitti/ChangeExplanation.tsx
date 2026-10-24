import { createContext, useContext, type ReactNode } from "react";
import type { ChartChange } from "../../lib/chitti/chart-insights";
import {
  chartValue,
  changeDigits,
  deltaLabel,
} from "../../lib/chitti/chart-insights";
import type { Analysis } from "../../lib/chitti/workspace/model";
import { safeLink } from "../../lib/chitti/workspace/model";
import { mdToHtml } from "../../lib/chitti/ui/dom";

export interface InlineExplanation {
  change: ChartChange;
  analysis: Analysis;
  onClose: () => void;
  onRetry: () => void;
  onConnect: () => void;
  onStop: () => void;
  clarification?: ReactNode;
}
export const ExplanationContext = createContext<InlineExplanation | null>(null);
export function ChangeExplanation({ unit }: { unit?: string }) {
  const detail = useContext(ExplanationContext);
  if (!detail) return null;
  const { change, analysis } = detail;
  const pending = ["running", "waiting"].includes(analysis.phase);
  const answer = analysis.result?.answer;
  return (
    <section
      id="cw-change-explanation"
      className="cw-change-explanation"
      aria-label={`Explanation: ${change.series}, ${change.from[0]} to ${change.to[0]}`}
      aria-busy={pending}
    >
      <div className="cw-explanation-evidence">
        <strong>
          {change.series} <span>{deltaLabel(change, unit)}</span>
        </strong>
        <span>
          {change.from[0]}–{change.to[0]} ·{" "}
          {chartValue(change.from[1], changeDigits(change))} →{" "}
          {chartValue(change.to[1], changeDigits(change))}
        </span>
        <small>Highlighted on chart</small>
      </div>
      <div className="cw-explanation-body">
        <div aria-live="polite">
          {answer ? (
            <div
              className="cw-explanation-answer"
              dangerouslySetInnerHTML={{ __html: mdToHtml(answer) }}
            />
          ) : (
            <p>
              {pending
                ? "Checking this change against the sources…"
                : analysis.status}
            </p>
          )}
        </div>
        {answer && (
          <details className="cw-explanation-sources">
            <summary>
              Sources ·{" "}
              {analysis.result?.verification?.status === "verified"
                ? "Evidence check passed"
                : "Not verified"}
            </summary>
            {analysis.result?.citations.map((c) => (
              <a
                key={c.id}
                href={safeLink(c.url)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {c.sourceLabel}: {c.indicatorName || c.indicatorId}
              </a>
            ))}
            {!analysis.result?.citations.length && (
              <p>No source records returned.</p>
            )}
          </details>
        )}
        {detail.clarification}
        <div className="cw-explanation-actions">
          {analysis.phase === "needs-key" && (
            <button onClick={detail.onConnect}>Connect model</button>
          )}
          {["needs-key", "error", "stopped"].includes(analysis.phase) && (
            <button onClick={detail.onRetry}>Retry explanation</button>
          )}
          {pending ? (
            <button onClick={detail.onStop}>Stop explanation</button>
          ) : (
            <button onClick={detail.onClose}>Close explanation</button>
          )}
        </div>
      </div>
    </section>
  );
}
