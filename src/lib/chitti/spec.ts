// spec.ts — normalizeSpec: guard a model-produced chart spec into a valid
// ChartSpec shape (models occasionally return strings for numbers, or malformed
// points). Pure + exported for edge-case tests.
import type { ChartSpec } from './tools';

// Guard the chart spec into a valid shape (models occasionally return strings).
// Exported for direct edge-case tests (same convention as parseVerifierVerdict).
export function normalizeSpec(raw: any): ChartSpec {
  const type = ['line', 'bar', 'scatter', 'grouped-bar'].includes(raw?.type) ? raw.type : 'line';
  const series = Array.isArray(raw?.series) ? raw.series : [];
  const cleanSeries = series.map((s: any) => ({
    name: String(s?.name ?? 'series'),
    data: Array.isArray(s?.data)
      ? s.data
          .map((pt: any) => {
            if (!Array.isArray(pt) || pt.length < 2) return null;
            const x = typeof pt[0] === 'number' ? pt[0] : isNaN(Number(pt[0])) ? pt[0] : Number(pt[0]);
            const y = Number(pt[1]);
            return isNaN(y) ? null : [x, y];
          })
          .filter((p: any) => p !== null)
      : [],
  }));
  return {
    type,
    title: String(raw?.title ?? 'Chart'),
    x_axis: raw?.x_axis ? String(raw.x_axis) : undefined,
    y_axis: raw?.y_axis ? String(raw.y_axis) : undefined,
    series: cleanSeries,
  };
}
