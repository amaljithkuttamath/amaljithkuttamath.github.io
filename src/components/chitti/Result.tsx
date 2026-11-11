import { createContext, useContext, useMemo, useState } from "react";
import type { ShareStateV1 } from "../../lib/chitti/share";
import { prepareChart } from "../../lib/chitti/chart-contract";
import { findingHtml } from "./ui/figures";
import { ChartCard, ResultInteraction, InlineComposer } from "./ui/ChartCard";
import { SourceLines } from "./ui/Evidence";
import { Button } from "./ui/controls";

export { ResultInteraction, InlineComposer };
/** An inherited chart (unchanged from the turn before) starts collapsed. */
export const CollapseChart = createContext(false);

/**
 * A Chitti answer: the finding (model-authored text, through the reviewed
 * mdToHtml renderer, which escapes before it formats; see ui/figures.ts), the chart card, and the
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
  // Series names in the finding are underlined in their chart colour. Only
  // when the series ARE the things named: a line or grouped chart with several
  // series. A single-series bar's categories all share one colour.
  const chart = useMemo(() => (result.spec ? prepareChart(result.spec) : null), [result.spec]);
  const figureSeries = chart && chart.series.length > 1 ? chart.series : [];
  const hasCard = !!result.spec || result.rows.length > 0 || result.citations.length > 0;
  return (
    <div className="cx-result cx-reply">
      {result.answer && <div className="cx-finding" dangerouslySetInnerHTML={{ __html: findingHtml(result.answer, figureSeries) }} />}
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
