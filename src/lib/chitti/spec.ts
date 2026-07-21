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
            // Drop gap points instead of plotting a false zero. Number(null),
            // Number('') and Number(false) all === 0 and would sail past an
            // isNaN guard, so a missing y ([2021, null]) turned into a real
            // crash-to-zero in the chart. Only a genuinely numeric y survives.
            const rawY = pt[1];
            if (rawY === null || rawY === undefined || rawY === '' || typeof rawY === 'boolean') return null;
            const y = Number(rawY);
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
