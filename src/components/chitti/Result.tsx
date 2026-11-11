import { createContext, useContext, useState } from "react";
import type { ShareStateV1 } from "../../lib/chitti/share";
import { mdToHtml } from "../../lib/chitti/ui/dom";
import { ChartCard, ResultInteraction, InlineComposer } from "./ui/ChartCard";
import { SourceLines } from "./ui/Evidence";
import { Button } from "./ui/controls";

export { ResultInteraction, InlineComposer };
/** An inherited chart (unchanged from the turn before) starts collapsed. */
export const CollapseChart = createContext(false);

/**
 * A Chitti answer: the finding (model-authored text, through the reviewed
 * mdToHtml renderer, which escapes before it formats), the chart card, and the
 * numbered sources. Rendered by the A2UI catalog and for earlier turns.
 */
export function Result({
  result,
  onSteer,
}: {
  result: ShareStateV1;
  onSteer?: (name: string, value: string) => void;
}) {
  const collapse = useContext(CollapseChart);
  const [expanded, setExpanded] = useState(!collapse);
  const hasCard = !!result.spec || result.rows.length > 0 || result.citations.length > 0;
  return (
    <div className="cx-result cx-reply">
      {result.answer && <div className="cx-finding" dangerouslySetInnerHTML={{ __html: mdToHtml(result.answer) }} />}
      {hasCard && collapse && (
        <Button
          variant="quiet"
          size="sm"
          className="cx-evidence-toggle"
          aria-expanded={expanded}
          label={expanded ? "Hide chart and evidence" : "View chart and evidence"}
          onClick={() => setExpanded(!expanded)}
        />
      )}
      {hasCard && (!collapse || expanded) && <ChartCard result={result} onSteer={onSteer} />}
      <SourceLines citations={result.citations} />
      {result.lossy && <p className="cx-change">This shared result omits the full evidence rows.</p>}
    </div>
  );
}
