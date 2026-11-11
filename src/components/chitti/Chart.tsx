import { useEffect, useRef, useState, useMemo, useContext } from "react";
import { chartUnit } from "../../lib/chitti/chart-contract";
import type { ChartSpec } from "../../lib/chitti/tools";
import { buildOption, barLayout } from "../../lib/chitti/ui/chart-option";
import {
  lineDomain,
  chartValue,
  highlightChanges,
  chartChanges,
  deltaLabel,
  explainChange,
  changeDigits,
  changeKey,
  type ChartChange,
} from "../../lib/chitti/chart-insights";
import { ChangeExplanation, ExplanationContext } from "./ChangeExplanation";
import { chartAriaLabel } from "../../lib/chitti/a11y";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { MicroLabel, Stat } from "./ui/primitives";
export default function Chart({
  spec,
  onSelect,
  onAsk,
}: {
  spec: ChartSpec;
  onSelect?: (name: string) => void;
  onAsk?: (question: string, change: ChartChange) => void;
}) {
  const unit = chartUnit(spec);
  const explanation = useContext(ExplanationContext);
  const selected = explanation?.change;
  const [fit, setFit] = useState(true);
  const domain = useMemo(() => lineDomain(spec), [spec]);
  const highlights = useMemo(() => highlightChanges(spec), [spec]);
  const height = useMemo(() => barLayout(spec).height, [spec]);
  const ask = useRef(onAsk);
  ask.current = onAsk;
  const select = useRef(onSelect);
  select.current = onSelect;
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false,
      chart: import("echarts/core").EChartsType | undefined;
    const resize = new ResizeObserver(() => chart?.resize());
    const theme = new MutationObserver(() =>
      chart?.setOption(buildOption(spec, fit, selected), true),
    );
    setFailed(false);
    void import("./chart-runtime")
      .then(({ init }) => {
        if (disposed || !host.current) return;
        chart = init(host.current);
        chart.setOption(buildOption(spec, fit, selected));
        chart.on("click", (params) => {
          const data = params.data as { changeYear?: number } | undefined;
          const year =
            params.componentType === "markPoint"
              ? data?.changeYear
              : Number(params.name);
          // A marker is the explicit "why?" target. A plain point on a
          // multi-series chart focuses its series instead: almost every point
          // ends some step, so treating each one as a question turned an
          // ordinary click into a model run.
          const focuses =
            params.componentType === "series" &&
            spec.series.length > 1 &&
            typeof params.seriesName === "string";
          const change = focuses
            ? undefined
            : chartChanges(spec).find(
                (c) => c.series === params.seriesName && c.to[0] === year,
              );
          if (change && ask.current) {
            ask.current(explainChange(change), change);
            return;
          }
          if (params.componentType !== "series") return;
          if (focuses) select.current?.(params.seriesName as string);
          else if (
            ["bar", "grouped-bar"].includes(spec.type) &&
            typeof params.name === "string"
          )
            select.current?.(params.name);
        });
        resize.observe(host.current);
        theme.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme", "class"],
        });
      })
      .catch(() => {
        if (!disposed) setFailed(true);
      });
    return () => {
      disposed = true;
      resize.disconnect();
      theme.disconnect();
      chart?.dispose();
    };
  }, [spec, fit, selected]);
  return (
    <figure className="cx-chart">
      <figcaption className="cx-chart-head">
        <span className="cx-chart-title">{spec.title}</span>
        {unit && <MicroLabel>{unit}</MicroLabel>}
      </figcaption>
      {domain && (
        <div className="cx-scale">
          <MicroLabel>
            {fit
              ? `Axis ${chartValue(domain.min, domain.digits)}–${chartValue(domain.max, domain.digits)}`
              : "Axis includes zero"}
          </MicroLabel>
          <SegmentedControl
            label="Line chart scale"
            size="sm"
            value={fit ? "fit" : "zero"}
            onChange={(value) => setFit(value === "fit")}
          >
            <SegmentedControlItem value="fit" label="Fit values" />
            <SegmentedControlItem value="zero" label="From zero" />
          </SegmentedControl>
        </div>
      )}
      {highlights.length > 0 && (
        <div className="cx-changes" aria-label="Plotted changes" role="group">
          <MicroLabel as="p" className="cx-changes-caption">Largest plotted step per series</MicroLabel>
          <div className="cx-changes-list">
            {highlights.map((c) => (
              <button
                type="button"
                className="cx-change-card"
                key={`${c.series}-${c.to[0]}`}
                disabled={!onAsk}
                onClick={() => onAsk?.(explainChange(c), c)}
                aria-controls={
                  selected && changeKey(selected) === changeKey(c)
                    ? "cw-change-explanation"
                    : undefined
                }
                aria-expanded={!!selected && changeKey(selected) === changeKey(c)}
                aria-label={`Ask why: ${c.series}, ${deltaLabel(c, unit)}, ${c.from[0]} to ${c.to[0]}`}
              >
                <Stat
                  label={c.series}
                  value={deltaLabel(c, unit)}
                  tone={c.to[1] >= c.from[1] ? "up" : "down"}
                  detail={`${c.from[0]}–${c.to[0]} · ${chartValue(c.from[1], changeDigits(c))} → ${chartValue(c.to[1], changeDigits(c))}`}
                />
                <span className="cx-change-why" aria-hidden="true">Why?</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <ChangeExplanation unit={unit} />
      {failed ? (
        <p role="status" className="cx-empty">
          Chart unavailable. The values are still available in Data.
        </p>
      ) : (
        <div
          ref={host}
          className="cx-chart-canvas"
          style={height ? { height } : undefined}
          role="img"
          aria-label={`${chartAriaLabel(spec)}${selected ? ` Highlighted ${selected.series}, ${selected.from[0]} to ${selected.to[0]}, ${chartValue(selected.from[1])} to ${chartValue(selected.to[1])}.` : ""}${domain && fit ? ` Fitted axis ${chartValue(domain.min, domain.digits)} to ${chartValue(domain.max, domain.digits)}.` : ""}`}
        />
      )}
    </figure>
  );
}
