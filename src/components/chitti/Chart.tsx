import { useCallback, useEffect, useRef, useState, useMemo, useContext } from "react";
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
import { Segmented } from "./ui/controls";
import { MicroLabel, Stat } from "./ui/primitives";
export default function Chart({
  spec,
  onSelect,
  onAsk,
  showTitle = true,
  showChanges = true,
  fit: fitProp,
  onFitChange,
  zoom = true,
}: {
  spec: ChartSpec;
  showTitle?: boolean;
  /** The "largest plotted step" cards (the markers stay on the chart). */
  showChanges?: boolean;
  /** Controlled scale: when given, the caller renders the Fit/From zero control. */
  fit?: boolean;
  onFitChange?: (fit: boolean) => void;
  /** ECharts' own zoom slider; off where the caller supplies a year range. */
  zoom?: boolean;
  onSelect?: (name: string) => void;
  onAsk?: (question: string, change: ChartChange) => void;
}) {
  const unit = chartUnit(spec);
  const explanation = useContext(ExplanationContext);
  const selected = explanation?.change;
  const [ownFit, setFit] = useState(true);
  const fit = fitProp ?? ownFit;
  const domain = useMemo(() => lineDomain(spec), [spec]);
  const highlights = useMemo(() => highlightChanges(spec), [spec]);
  const height = useMemo(() => barLayout(spec).height, [spec]);
  const ask = useRef(onAsk);
  ask.current = onAsk;
  const select = useRef(onSelect);
  select.current = onSelect;
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const option = useCallback(() => {
    const o = buildOption(spec, fit, selected) as Record<string, unknown>;
    if (!zoom && Array.isArray(o.dataZoom) && o.dataZoom.length) {
      o.dataZoom = [];
      o.grid = { ...(o.grid as object), bottom: 8 };
    }
    return o;
  }, [spec, fit, selected, zoom]);
  const instance = useRef<import("echarts/core").EChartsType | null>(null);
  const current = useRef({ option, spec });
  useEffect(() => {
    current.current = { option, spec };
    instance.current?.setOption(option(), true);
  }, [option, spec]);
  useEffect(() => {
    let disposed = false,
      chart: import("echarts/core").EChartsType | undefined;
    const resize = new ResizeObserver(() => chart?.resize());
    const theme = new MutationObserver(() => chart?.setOption(current.current.option(), true));
    setFailed(false);
    void import("./chart-runtime")
      .then(({ init }) => {
        if (disposed || !host.current) return;
        chart = init(host.current);
        instance.current = chart;
        chart.setOption(current.current.option());
        chart.on("click", (params) => {
          const { spec } = current.current;
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
      instance.current = null;
    };
  }, []);
  return (
    <figure className="cx-chart">
      <figcaption className={showTitle ? "cx-chart-head" : "cx-sr-only"}>
        <span className="cx-chart-title">{spec.title}</span>
        {unit && <MicroLabel>{unit}</MicroLabel>}
      </figcaption>
      {domain && onFitChange === undefined && (
        <div className="cx-scale">
          <MicroLabel>
            {fit
              ? `Axis ${chartValue(domain.min, domain.digits)}–${chartValue(domain.max, domain.digits)}`
              : "Axis includes zero"}
          </MicroLabel>
          <Segmented
            label="Line chart scale"
            value={fit ? "fit" : "zero"}
            onChange={(value) => setFit(value === "fit")}
            options={[
              { value: "fit", label: "Fit values" },
              { value: "zero", label: "From zero" },
            ]}
          />
        </div>
      )}
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
      {showChanges && highlights.length > 0 && (
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
    </figure>
  );
}
