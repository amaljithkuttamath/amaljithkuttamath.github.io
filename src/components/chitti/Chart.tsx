import { useEffect, useRef, useState, useMemo } from "react";
import type { ChartSpec } from "../../lib/chitti/tools";
import { buildOption } from "../../lib/chitti/ui/chart-option";
import {
  lineDomain,
  chartValue,
  highlightChanges,
  chartChanges,
  deltaLabel,
  explainChange,
  changeDigits,
} from "../../lib/chitti/chart-insights";
import { chartAriaLabel } from "../../lib/chitti/a11y";
export default function Chart({
  spec,
  onSelect,
  onAsk,
}: {
  spec: ChartSpec;
  onSelect?: (name: string) => void;
  onAsk?: (question: string) => void;
}) {
  const [fit, setFit] = useState(true);
  const domain = useMemo(() => lineDomain(spec), [spec]);
  const highlights = useMemo(() => highlightChanges(spec), [spec]);
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
      chart?.setOption(buildOption(spec, fit), true),
    );
    setFailed(false);
    void import("./chart-runtime")
      .then(({ init }) => {
        if (disposed || !host.current) return;
        chart = init(host.current);
        chart.setOption(buildOption(spec, fit));
        chart.on("click", (params) => {
          const data = params.data as { changeYear?: number } | undefined;
          const year =
            params.componentType === "markPoint"
              ? data?.changeYear
              : Number(params.name);
          const change = chartChanges(spec).find(
            (c) => c.series === params.seriesName && c.to[0] === year,
          );
          if (change && ask.current) {
            ask.current(explainChange(change));
            return;
          }
          if (params.componentType !== "series") return;
          if (spec.series.length > 1 && typeof params.seriesName === "string")
            select.current?.(params.seriesName);
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
  }, [spec, fit]);
  return (
    <figure className="cw-chart">
      <figcaption>
        {spec.title}
        <span>{spec.y_axis}</span>
      </figcaption>
      {domain && (
        <div className="cw-scale">
          <span>
            {fit
              ? `Axis ${chartValue(domain.min, domain.digits)}–${chartValue(domain.max, domain.digits)}`
              : "Axis includes zero"}
          </span>
          <div role="group" aria-label="Line chart scale">
            <button aria-pressed={fit} onClick={() => setFit(true)}>
              Fit values
            </button>
            <button aria-pressed={!fit} onClick={() => setFit(false)}>
              From zero
            </button>
          </div>
        </div>
      )}
      {highlights.length > 0 && (
        <p className="cw-change-caption">Largest plotted step per series</p>
      )}
      {highlights.length > 0 && (
        <div className="cw-chart-changes" aria-label="Plotted changes">
          {highlights.map((c) => (
            <button
              key={`${c.series}-${c.to[0]}`}
              disabled={!onAsk}
              onClick={() => onAsk?.(explainChange(c))}
              aria-label={`Ask why: ${c.series}, ${deltaLabel(c, spec.y_axis)}, ${c.from[0]} to ${c.to[0]}`}
            >
              <strong>
                {c.series} <b>{deltaLabel(c, spec.y_axis)}</b>
              </strong>
              <span>
                {c.from[0]}–{c.to[0]} · {chartValue(c.from[1], changeDigits(c))}{" "}
                → {chartValue(c.to[1], changeDigits(c))}
                <i>Why?</i>
              </span>
            </button>
          ))}
        </div>
      )}
      {failed ? (
        <p role="status">
          Chart unavailable. The values are still available in Data.
        </p>
      ) : (
        <div
          ref={host}
          className="cw-chart-canvas"
          role="img"
          aria-label={`${chartAriaLabel(spec)}${domain && fit ? ` Fitted axis ${chartValue(domain.min, domain.digits)} to ${chartValue(domain.max, domain.digits)}.` : ""}`}
        />
      )}
    </figure>
  );
}
