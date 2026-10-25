import type { ShareStateV1 } from "../../lib/chitti/share";
const numeric = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
// Orientation sketches use the same coordinates as the full recorded chart.
export default function ExamplePlot({ spec }: { spec: ShareStateV1["spec"] }) {
  if (!spec) return null;
  const series = spec.series.slice(0, 3);
  const values = series.flatMap((s) => s.data.map((p) => p[1])).filter(numeric);
  if (!values.length) return null;
  const bars = spec.type === "bar" || spec.type === "grouped-bar";
  const lo = Math.min(...values, ...(bars ? [0] : []));
  const hi = Math.max(...values, ...(bars ? [0] : []));
  const y = (v: number) => 42 - ((v - lo) / (hi - lo || 1)) * 36;
  const xs = series.flatMap((s) => s.data.map((p) => p[0])).filter(numeric);
  const xmin = Math.min(...xs),
    xmax = Math.max(...xs);
  const x = (v: number) => 4 + ((v - xmin) / (xmax - xmin || 1)) * 152;
  return (
    <svg className="cw-example-plot" viewBox="0 0 160 48" aria-hidden="true">
      {bars
        ? series[0].data
            .slice(0, 7)
            .filter((p) => numeric(p[1]))
            .map((p, i) => (
              <rect
                key={i}
                x={i * 21 + 4}
                y={Math.min(y(0), y(p[1]))}
                width="12"
                height={Math.abs(y(p[1]) - y(0))}
                rx="1"
              />
            ))
        : spec.type === "scatter"
          ? series.flatMap((s, k) =>
              s.data
                .filter((p) => numeric(p[0]) && numeric(p[1]))
                .slice(0, 120)
                .map((p, i) => (
                  <circle
                    key={`${k}-${i}`}
                    cx={x(Number(p[0]))}
                    cy={y(p[1])}
                    r="1.5"
                  />
                )),
            )
          : series.map((s, i) => (
              <polyline
                key={s.name}
                points={s.data
                  .filter((p) => numeric(p[0]) && numeric(p[1]))
                  .map((p) => `${x(Number(p[0]))},${y(p[1])}`)
                  .join(" ")}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                opacity={1 - i * 0.25}
              />
            ))}
    </svg>
  );
}
