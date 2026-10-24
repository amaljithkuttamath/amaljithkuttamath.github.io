import type { ChartSpec } from "./core";
import { isPercentUnit } from "./chart-format";

export interface ChartChange {
  series: string;
  from: [number, number];
  to: [number, number];
  delta: number;
}

export function lineDomain(
  spec: ChartSpec,
): { min: number; max: number; digits: number } | null {
  if (spec.type !== "line") return null;
  const values = spec.series
    .flatMap((s) => s.data.map(([, y]) => y))
    .filter((y) => typeof y === "number" && Number.isFinite(y));
  if (!values.length) return null;
  const low = Math.min(...values),
    high = Math.max(...values);
  const span = high - low || Math.max(Math.abs(high) * 0.02, 1);
  const step = 10 ** Math.floor(Math.log10(span / 5));
  const min = Math.floor((low - span * 0.08) / step) * step;
  const max = Math.ceil((high + span * 0.08) / step) * step;
  if (![min, max, step].every(Number.isFinite) || min >= max || step <= 0)
    return null;
  return {
    min,
    max,
    digits: Math.min(12, Math.max(0, -Math.floor(Math.log10(step)))),
  };
}
export function chartValue(value: number, digits = 2): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: digits }).format(
    value,
  );
}

/** Consecutive recorded points, not interpolated annual estimates. */
export function chartChanges(spec: ChartSpec): ChartChange[] {
  if (spec.type !== "line" || !/year/i.test(spec.x_axis || "")) return [];
  return spec.series.flatMap((series) => {
    const points = series.data
      .map(([x, y]) => [Number(x), y] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    if (
      points.some(([x]) => !Number.isInteger(x) || x < 1800 || x > 2200) ||
      new Set(points.map(([x]) => x)).size !== points.length
    )
      return [];
    const changes: ChartChange[] = [];
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1],
        to = points[i];
      if (
        typeof from[1] !== "number" ||
        typeof to[1] !== "number" ||
        !Number.isFinite(from[1]) ||
        !Number.isFinite(to[1]) ||
        from[1] === to[1]
      )
        continue;
      changes.push({ series: series.name, from, to, delta: to[1] - from[1] });
    }
    return changes;
  });
}
export function highlightChanges(spec: ChartSpec): ChartChange[] {
  // One largest absolute observed change per series, then at most three.
  const largest = new Map<string, ChartChange>();
  for (const c of chartChanges(spec))
    if (
      !largest.has(c.series) ||
      Math.abs(c.delta) > Math.abs(largest.get(c.series)!.delta)
    )
      largest.set(c.series, c);
  return [...largest.values()]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 3);
}
export function changeDigits(change: ChartChange): number {
  const magnitude = Math.abs(change.delta);
  return magnitude && magnitude < 0.01
    ? Math.min(12, 1 - Math.floor(Math.log10(magnitude)))
    : 2;
}
export function deltaLabel(change: ChartChange, unit?: string): string {
  const suffix = isPercentUnit(unit)
    ? " pp"
    : /\byears?\b/i.test(unit || "")
      ? " years"
      : "";
  const magnitude = Math.abs(change.delta);
  const digits = changeDigits(change);
  return `${change.delta > 0 ? "+" : "−"}${chartValue(magnitude, digits)}${suffix}`;
}
export function explainChange(change: ChartChange): string {
  return `Why did ${change.series} change from ${chartValue(change.from[1], changeDigits(change))} to ${chartValue(change.to[1], changeDigits(change))} between ${change.from[0]} and ${change.to[0]}?`;
}
