import { useEffect, useRef, useState } from "react";
import type { ChartSpec } from "../../lib/chitti/tools";
import { buildOption } from "../../lib/chitti/ui/chart-option";
import { chartAriaLabel } from "../../lib/chitti/a11y";
export default function Chart({ spec }: { spec: ChartSpec }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false,
      chart: import("echarts/core").EChartsType | undefined;
    const resize = new ResizeObserver(() => chart?.resize());
    const theme = new MutationObserver(() =>
      chart?.setOption(buildOption(spec), true),
    );
    setFailed(false);
    void import("./chart-runtime")
      .then(({ init }) => {
        if (disposed || !host.current) return;
        chart = init(host.current);
        chart.setOption(buildOption(spec));
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
  }, [spec]);
  return (
    <figure className="cw-chart">
      <figcaption>
        {spec.title}
        <span>{spec.y_axis}</span>
      </figcaption>
      {failed ? (
        <p role="status">
          Chart unavailable. The values are still available in Data.
        </p>
      ) : (
        <div
          ref={host}
          className="cw-chart-canvas"
          role="img"
          aria-label={chartAriaLabel(spec)}
        />
      )}
    </figure>
  );
}
