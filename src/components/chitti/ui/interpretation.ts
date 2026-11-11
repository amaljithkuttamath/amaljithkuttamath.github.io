// Pure helpers behind the chart card: what is being shown (the token row),
// where it came from (the provenance line), per-series stats for the panel,
// and the follow-up chips. Everything is derived from the result itself (spec,
// rows, citations) or the direct plan that produced it — never invented.
import type { ShareStateV1 } from "../../../lib/chitti/share";
import type { Citation } from "../../../lib/chitti/core";
import type { Analysis } from "../../../lib/chitti/workspace/model";
import { safeLink } from "../../../lib/chitti/workspace/model";
import { prepareChart, seriesIdentity, chartUnit } from "../../../lib/chitti/chart-contract";
import { chartTypes, recentStart } from "../../../lib/chitti/workspace/steering";
import { highlightChanges, chartValue, explainChange, changeKey } from "../../../lib/chitti/chart-insights";

/** The palette slot a series renders in, as a CSS colour. */
export const seriesColor = (colorIndex = 0) => `var(--chart-${(colorIndex % 8) + 1})`;

const yearOf = (x: unknown) => {
  const n = Number(x);
  return Number.isInteger(n) && n >= 1800 && n <= 2200 ? n : null;
};

export interface Interpretation {
  indicator?: { name: string; id: string };
  series: { name: string; id: string; iso3?: string; color: string }[];
  years?: { start: number; end: number };
  /** True when the tokens can re-run the direct lookup (a direct answer). */
  live: boolean;
}

/** Years plotted on a time chart, or undefined for a non-time chart. */
export function plottedYears(spec: ShareStateV1["spec"]): { start: number; end: number } | undefined {
  if (!spec || !chartTypes(spec).includes("line")) return undefined;
  const years = spec.series.flatMap((s) => s.data.map(([x]) => yearOf(x))).filter((y): y is number => y !== null);
  return years.length ? { start: Math.min(...years), end: Math.max(...years) } : undefined;
}

export function interpret(result: ShareStateV1, direct?: Analysis["direct"]): Interpretation {
  const spec = result.spec ? prepareChart(result.spec) : null;
  const ids = [...new Set(result.citations.map((c) => c.indicatorId))];
  const cited = ids.length === 1 ? result.citations.find((c) => c.indicatorId === ids[0]) : undefined;
  const indicator = direct
    ? { name: direct.series.name, id: direct.series.id }
    : cited
      ? { name: cited.indicatorName || cited.indicatorId, id: cited.indicatorId }
      : undefined;
  // One token per plotted series on a time chart (each is a country on the
  // direct path); a ranking or scatter has no per-country series to edit.
  const series =
    spec && spec.type === "line"
      ? spec.series.map((s, i) => ({
          name: s.name,
          id: seriesIdentity(s),
          iso3: direct ? direct.plan.countries[direct.plan.countryNames.indexOf(s.name)] ?? direct.plan.countries[i] : s.evidence?.iso3,
          color: seriesColor(s.colorIndex),
        }))
      : [];
  return { indicator, series, years: plottedYears(spec), live: !!direct && spec?.type === "line" };
}

const shortDate = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

// The unit to print: an explicit one, else the trailing "(…)" of the series
// name ("Life expectancy at birth, total (years)" → "years"). Never the whole
// axis label, which on the direct path is the series name itself.
const trailingParen = (s?: string) => s?.match(/\(([^()]+)\)\s*$/)?.[1];
function unitOf(spec: ShareStateV1["spec"], c: Citation): string | undefined {
  const explicit = spec?.unit || spec?.series.find((s) => s.unit)?.unit;
  if (explicit) return explicit;
  const named = trailingParen(c.indicatorName) || trailingParen(spec?.y_axis);
  if (named) return named;
  const axis = spec ? chartUnit(spec) : "";
  return axis && axis.length <= 24 ? axis : undefined;
}

export interface Provenance {
  source: string;
  id: string;
  unit?: string;
  coverage?: string;
  latest?: number;
  /** "retrieved <date>" for a live fetch, "snapshot <date>" for the
   * same-origin capture. The distinction is a disclosure; keep it exact. */
  when: string;
  url?: string;
  more: number;
}

/** The provenance printed along the chart card's bottom edge. */
export function provenance(result: ShareStateV1): Provenance | null {
  const c: Citation | undefined = result.citations[0];
  if (!c) return null;
  const spec = result.spec;
  const rowYears = result.rows.filter((r) => r.value !== null && (!r.indicator || r.indicator === c.indicatorId)).map((r) => r.year);
  const specYears = spec ? spec.series.flatMap((s) => s.data.map(([x]) => yearOf(x))).filter((y): y is number => y !== null) : [];
  const years = rowYears.length ? rowYears : specYears;
  const start = c.yearRange?.start ?? (years.length ? Math.min(...years) : undefined);
  const end = c.yearRange?.end ?? (years.length ? Math.max(...years) : undefined);
  return {
    source: c.sourceLabel,
    id: c.indicatorId,
    unit: unitOf(spec, c),
    coverage: start !== undefined && end !== undefined ? `${start}–${end}` : undefined,
    latest: years.length ? Math.max(...years) : undefined,
    when: c.mirroredAt ? `snapshot ${shortDate(c.mirroredAt)}` : `retrieved ${shortDate(c.fetchedAt)}`,
    url: safeLink(c.url),
    more: new Set(result.citations.map((x) => x.indicatorId)).size - 1,
  };
}

export interface SeriesStat {
  name: string;
  color: string;
  last: { year: number | string; value: number };
  first: { year: number | string; value: number };
  change: number;
  digits: number;
}

/** Last value and change since the first plotted point, per series. */
export function seriesStats(spec: ShareStateV1["spec"]): SeriesStat[] {
  if (!spec || spec.type !== "line") return [];
  const prepared = prepareChart(spec);
  return prepared.series.flatMap((s) => {
    const pts = s.data.filter(([, y]) => Number.isFinite(y));
    if (!pts.length) return [];
    const digits = Math.min(2, Math.max(0, ...pts.map(([, y]) => (String(y).split(".")[1] || "").length)));
    const [fx, fy] = pts[0];
    const [lx, ly] = pts[pts.length - 1];
    return [{ name: s.name, color: seriesColor(s.colorIndex), first: { year: fx, value: fy }, last: { year: lx, value: ly }, change: ly - fy, digits }];
  });
}

export const signed = (n: number, digits = 1) =>
  `${n > 0 ? "+" : n < 0 ? "−" : "±"}${chartValue(Math.abs(n), digits)}`;

export interface FollowUp {
  label: string;
  action: { name: string; value: string };
  /** Runs through a language model (and so needs one connected). */
  needsModel: boolean;
}

/**
 * Follow-up chips for a completed answer. Deterministic ones are view edits
 * the app can make with no model; model ones are questions about the plotted
 * values. Nothing here proposes data the answer does not already contain (no
 * "add a neighbour": there is no honest way to choose one without a model).
 */
export function followUps(result: ShareStateV1 | null): FollowUp[] {
  const spec = result?.spec;
  if (!result || !spec) return [];
  const out: FollowUp[] = [];
  const types = chartTypes(prepareChart(spec));
  if (recentStart(result) !== null) out.push({ label: "Last 10 years", action: { name: "recent", value: "" }, needsModel: false });
  if (spec.type === "line" && types.includes("bar")) out.push({ label: "Show as bars", action: { name: "chart-type", value: "bar" }, needsModel: false });
  if (spec.type !== "line" && types.includes("line")) out.push({ label: "Show as a line", action: { name: "chart-type", value: "line" }, needsModel: false });
  const change = highlightChanges(spec)[0];
  if (change)
    out.push({ label: explainChange(change), action: { name: "explain-change", value: changeKey(change) }, needsModel: true });
  out.push({
    label: "What changed in this view?",
    action: {
      name: "ask-view",
      value: "What changed in this view? Quantify the changes and distinguish what the sources show from what they cannot explain.",
    },
    needsModel: true,
  });
  return out;
}
