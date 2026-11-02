import { cleanShareState, type ShareStateV1 } from "../share";
import { prepareChart, seriesIdentity } from "../chart-contract";
import type { ChartSpec } from "../core";

export type ViewEdit = { kind: "series"; name: string } | { kind: "recent" }
  | { kind: "type"; type: ChartSpec["type"] }
  | { kind: "highlight"; id: string }
  | { kind: "years"; start: number; end: number };

export function chartTypes(spec: ChartSpec): ChartSpec["type"][] {
  if (spec.type === "scatter") return ["scatter"];
  const time = /year/i.test(spec.x_axis || "") && spec.series.every(s => s.data.every(([x]) => typeof x === "number" && Number.isInteger(x) && x >= 1800 && x <= 2200));
  return time ? ["line", "bar", "grouped-bar"] : ["bar", "grouped-bar"];
}

export function recentStart(result: ShareStateV1): number | null {
  const spec = result.spec;
  if (!spec || spec.type !== "line" || !/year/i.test(spec.x_axis || ""))
    return null;
  const years = spec.series.flatMap((s) => s.data.map(([x]) => Number(x)));
  if (
    !years.length ||
    years.some((y) => !Number.isInteger(y) || y < 1800 || y > 2200)
  )
    return null;
  const end = Math.max(...years);
  return Math.min(...years) < end - 9 ? end - 9 : null;
}

/** Change only the displayed chart. Keep the original source ledger/rows, and
 * drop conclusions and verification that describe a different view. */
export function editView(
  source: ShareStateV1,
  edit: ViewEdit,
): ShareStateV1 | null {
  const result = cleanShareState(source);
  if (!result?.spec) return null;
  result.spec = prepareChart(result.spec);
  if (edit.kind === "type") {
    if (!chartTypes(result.spec).includes(edit.type)) return null;
    result.spec.type = edit.type;
    result.answer = `Showing a ${edit.type.replace('-', ' ')} chart. Source values unchanged.`;
  } else if (edit.kind === "highlight") {
    if (edit.id && !result.spec.series.some(s => seriesIdentity(s) === edit.id)) return null;
    result.spec.highlight = edit.id ? [edit.id] : [];
    result.answer = edit.id ? `Highlighted ${result.spec.series.find(s => seriesIdentity(s) === edit.id)!.name}. Other series remain visible.` : 'Showing all series equally.';
  } else if (edit.kind === "series") {
    const series = result.spec.series.filter((s) => s.name === edit.name);
    if (series.length) result.spec.series = series;
    else if (result.spec.type === "bar" || result.spec.type === "grouped-bar") {
      const filtered = result.spec.series
        .map((s) => ({
          ...s,
          data: s.data.filter(([x]) => String(x) === edit.name),
        }))
        .filter((s) => s.data.length);
      if (!filtered.length) return null;
      result.spec.series = filtered;
    } else return null;
    result.spec.title += ` · ${edit.name}`;
    result.answer = `Showing ${edit.name}. Original source rows retained in Data.`;
  } else {
    const start = edit.kind === "years" ? edit.start : recentStart(result);
    const limit = edit.kind === "years" ? edit.end : Infinity;
    if (start === null || !chartTypes(result.spec).includes("line") ||
        !Number.isInteger(start) || (edit.kind === "years" && (!Number.isInteger(limit) || start > limit))) return null;
    result.spec.series = result.spec.series.map((s) => ({
      ...s,
      data: s.data.filter(([x]) => Number(x) >= start && Number(x) <= limit),
    }));
    if (!result.spec.series.some(s => s.data.length)) return null;
    const end = Math.max(
      ...result.spec.series.flatMap((s) => s.data.map(([x]) => Number(x))),
    );
    result.spec.title = `${result.spec.y_axis || "Recorded values"} · ${start}–${end}`;
    result.answer = `Showing ${start}–${end}. Original source rows retained in Data.`;
  }
  const ids = result.spec.series.map(seriesIdentity);
  if (result.spec.highlight) result.spec.highlight = result.spec.highlight.filter(id => ids.includes(id));
  if (result.spec.annotations) result.spec.annotations = result.spec.annotations.filter(a => result.spec!.series.some(s => seriesIdentity(s) === a.seriesId && s.data.some(([x]) => x === a.x)));
  result.verification = null;
  // Keep the original recorded date: changing a view is not a fresh fetch.
  return result;
}
