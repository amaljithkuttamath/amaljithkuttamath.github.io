import type { ChartSpec, ChartSeries, Citation, DataRow } from './core';

export const CHART_PALETTE_SIZE = 8;
const record = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {};
const text = (x: unknown, max = 240) => typeof x === 'string' ? x.slice(0, max) : undefined;
const coordinate = (x: unknown): x is string | number =>
  typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x));

/** Shared whitelist for model output and saved charts. No executable options. */
export function normalizeChart(raw: unknown): ChartSpec {
  const r = record(raw);
  const series = (Array.isArray(r.series) ? r.series : []).map((item): ChartSeries => {
    const s = record(item);
    const out: ChartSeries = {
      name: text(s.name) ?? 'series',
      data: (Array.isArray(s.data) ? s.data : []).flatMap((pt) => {
        if (!Array.isArray(pt) || !coordinate(pt[0]) || pt[1] == null ||
            typeof pt[1] === 'boolean' || (typeof pt[1] !== 'number' && typeof pt[1] !== 'string') ||
            (typeof pt[1] === 'string' && !pt[1].trim())) return [];
        const y = Number(pt[1]);
        if (!Number.isFinite(y)) return [];
        const x = typeof pt[0] === 'string' && pt[0].trim() && Number.isFinite(Number(pt[0])) ? Number(pt[0]) : pt[0];
        return [[x, y] as [string | number, number]];
      }),
    };
    if (text(s.id)) out.id = text(s.id);
    if (text(s.unit)) out.unit = text(s.unit);
    if (Number.isInteger(s.colorIndex) && Number(s.colorIndex) >= 0 && Number(s.colorIndex) < CHART_PALETTE_SIZE)
      out.colorIndex = Number(s.colorIndex);
    if (s.evidence != null) {
      const e = record(s.evidence);
      out.evidence = {
        mode: e.mode === 'observed' ? 'observed' : 'derived',
        citationIds: Array.isArray(e.citationIds) ? e.citationIds.filter((id): id is string => typeof id === 'string').map(id => id.slice(0, 500)) : [],
      };
      if (text(e.indicatorId)) out.evidence.indicatorId = text(e.indicatorId);
      if (text(e.iso3)) out.evidence.iso3 = text(e.iso3);
      if (Number.isInteger(e.year)) out.evidence.year = Number(e.year);
      if (text(e.method, 1000)) out.evidence.method = text(e.method, 1000);
    }
    return out;
  });
  const out: ChartSpec = {
    type: ['line', 'bar', 'scatter', 'grouped-bar'].includes(String(r.type)) ? r.type as ChartSpec['type'] : 'line',
    title: text(r.title) ?? 'Chart', series,
  };
  if (text(r.x_axis)) out.x_axis = text(r.x_axis);
  if (text(r.y_axis)) out.y_axis = text(r.y_axis);
  if (text(r.unit)) out.unit = text(r.unit);
  if (Array.isArray(r.highlight)) out.highlight = r.highlight.filter((id): id is string => typeof id === 'string').slice(0, 32);
  if (Array.isArray(r.annotations)) out.annotations = r.annotations.slice(0, 20).flatMap((value) => {
    const a = record(value);
    return text(a.seriesId) && coordinate(a.x) && text(a.label)
      ? [{ seriesId: text(a.seriesId)!, x: a.x, label: text(a.label)! }] : [];
  });
  return out;
}

export function chartUnit(spec: ChartSpec): string {
  return spec.unit || spec.series.find(s => s.unit)?.unit || spec.y_axis || '';
}

export const seriesIdentity = (s: ChartSeries) => s.id || s.name;
function hash(key: string) {
  let value = 0;
  for (const c of key) value = (Math.imul(value, 31) + c.charCodeAt(0)) >>> 0;
  return value % CHART_PALETTE_SIZE;
}

/** Resolve new slots deterministically, retaining parent IDs and palette slots. */
export function prepareChart(spec: ChartSpec, previous?: ChartSpec | null): ChartSpec {
  const before = previous ? prepareChart(previous).series : [];
  const series = spec.series.map(s => {
    const parent = before.find(p => s.id ? seriesIdentity(p) === s.id : p.name === s.name);
    return { ...s, id: s.id || parent?.id || s.name, colorIndex: parent?.colorIndex ?? s.colorIndex };
  });
  const used = new Set([...before, ...series].flatMap(s => s.colorIndex === undefined ? [] : [s.colorIndex]));
  for (const s of [...series].sort((a, b) => seriesIdentity(a).localeCompare(seriesIdentity(b)))) {
    if (s.colorIndex !== undefined) continue;
    let slot = hash(seriesIdentity(s));
    for (let i = 0; i < CHART_PALETTE_SIZE && used.has(slot); i++) slot = (slot + 1) % CHART_PALETTE_SIZE;
    s.colorIndex = slot;
    used.add(slot);
  }
  return { ...spec, series };
}

/** Check declared bindings. Legacy charts without bindings remain readable.
 * A derived method is provenance, not a claim of verified mathematics. */
export function chartIssues(spec: ChartSpec, rows: DataRow[], citations: Citation[]): string[] {
  const issues: string[] = [];
  if (!spec.series.length || !spec.series.some(s => s.data.length)) issues.push('Chart has no numeric observations.');
  const ids = spec.series.map(seriesIdentity);
  if (new Set(ids).size !== ids.length) issues.push('Series identities must be unique.');
  const units = new Set(spec.series.map(s => s.unit || spec.unit).filter(Boolean));
  if (units.size > 1) issues.push('Series with different units need separate charts.');
  if (spec.unit && [...units].some(u => u !== spec.unit)) issues.push('Series units must match the chart unit.');
  for (const s of spec.series) {
    const e = s.evidence;
    if (!e) continue;
    const sources = citations.filter(c => e.citationIds.includes(c.id));
    if (!e.citationIds.length || sources.length !== new Set(e.citationIds).size) issues.push(`${s.name}: use citation IDs from the evidence ledger.`);
    if (e.indicatorId && !sources.some(c => c.indicatorId === e.indicatorId)) issues.push(`${s.name}: indicator is not covered by its sources.`);
    if (e.mode === 'derived') {
      if (!e.method?.trim()) issues.push(`${s.name}: describe the calculation for derived values.`);
    } else {
      if (!e.indicatorId) { issues.push(`${s.name}: observed values need an indicator ID.`); continue; }
      if (s.data.some(([x]) => typeof x === 'number') && !e.iso3) issues.push(`${s.name}: time-series observations need a country ISO3 binding.`);
      if (s.data.some(([x]) => typeof x === 'string') && e.year === undefined) issues.push(`${s.name}: categorical observations need a year binding.`);
      const available = rows.filter(r => r.indicator === e.indicatorId && (!e.iso3 || r.iso3 === e.iso3) &&
        (e.year === undefined || r.year === e.year) && sources.some(c => c.indicatorId === r.indicator &&
          (!c.countries?.length || c.countries.includes(r.iso3)) &&
          (c.yearRange?.start === undefined || r.year >= c.yearRange.start) &&
          (c.yearRange?.end === undefined || r.year <= c.yearRange.end)));
      for (const [x, y] of s.data) {
        if (!available.some(r => r.value === y && (typeof x === 'number' ? r.year === x : r.country === x || r.iso3 === x))) {
          issues.push(`${s.name}: plotted observation ${String(x)} is absent from the source rows.`); break;
        }
      }
    }
  }
  for (const id of spec.highlight || []) if (!ids.includes(id)) issues.push(`Unknown highlighted series: ${id}.`);
  for (const a of spec.annotations || []) {
    const s = spec.series.find(s => seriesIdentity(s) === a.seriesId);
    if (!s?.data.some(([x]) => x === a.x)) issues.push(`Annotation must refer to an existing point: ${a.seriesId}.`);
  }
  return issues;
}
