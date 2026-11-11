import { createContext, useContext, type ReactNode } from "react";
import { Button } from "./ui/controls";
import type { ChartChange } from "../../lib/chitti/chart-insights";
import {
  chartValue,
  changeDigits,
  deltaLabel,
} from "../../lib/chitti/chart-insights";
import type { Analysis } from "../../lib/chitti/workspace/model";
import { safeLink } from "../../lib/chitti/workspace/model";
import { mdToHtml } from "../../lib/chitti/ui/dom";
import { verificationLabel } from "./ui/Evidence";
import { MicroLabel, Stat } from "./ui/primitives";
import { RunStatus } from "./ui/RunStatus";

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
  const failed = ["needs-key", "error", "stopped"].includes(analysis.phase);
  const answer = analysis.result?.answer;
  const actions = (
    <>
      {analysis.phase === "needs-key" && (
        <Button size="sm" label="Connect model" onClick={detail.onConnect} />
      )}
      {failed && <Button size="sm" label="Retry explanation" onClick={detail.onRetry} />}
      {pending ? (
        <Button size="sm" variant="ghost" label="Stop explanation" onClick={detail.onStop} />
      ) : (
        <Button size="sm" variant="ghost" label="Close explanation" onClick={detail.onClose} />
      )}
    </>
  );
  return (
    <section
      id="cw-change-explanation"
      className="cx-explanation"
      aria-label={`Explanation: ${change.series}, ${change.from[0]} to ${change.to[0]}`}
      aria-busy={pending}
    >
      <div className="cx-explanation-evidence">
        <Stat
          label={change.series}
          value={deltaLabel(change, unit)}
          tone={change.to[1] >= change.from[1] ? "up" : "down"}
          detail={`${change.from[0]}–${change.to[0]} · ${chartValue(change.from[1], changeDigits(change))} → ${chartValue(change.to[1], changeDigits(change))}`}
        />
        <MicroLabel>Highlighted on chart</MicroLabel>
      </div>
      <div className="cx-explanation-body">
        <div aria-live="polite">
          {answer ? (
            <div
              className="cx-finding"
              dangerouslySetInnerHTML={{ __html: mdToHtml(answer) }}
            />
          ) : (
            <RunStatus
              phase={analysis.phase}
              status={analysis.status}
              pendingText={pending ? "Checking this change against the sources…" : undefined}
              hint={null}
            />
          )}
        </div>
        {answer && (
          <details className="cx-disclosure cx-explanation-sources">
            <summary>
              <MicroLabel>
                Sources ·{" "}
                {analysis.result?.verification
                  ? verificationLabel(analysis.result.verification.status)
                  : "Not verified"}
              </MicroLabel>
            </summary>
            <div className="cx-disclosure-body">
            <ul className="cx-link-list">
              {analysis.result?.citations.map((c) => (
                <li key={c.id}>
                  <a href={safeLink(c.url)} target="_blank" rel="noopener noreferrer">
                    {c.sourceLabel}: {c.indicatorName || c.indicatorId}
                  </a>
                </li>
              ))}
            </ul>
            {!analysis.result?.citations.length && (
              <p className="cx-empty">No source records returned.</p>
            )}
            </div>
          </details>
        )}
        {detail.clarification}
        <div className="cx-explanation-actions">{actions}</div>
      </div>
    </section>
  );
}
