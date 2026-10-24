import { cleanShareState, type ShareStateV1 } from "../share";

export type ViewEdit = { kind: "series"; name: string } | { kind: "recent" };

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
  if (edit.kind === "series") {
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
    const start = recentStart(result);
    if (start === null) return null;
    result.spec.series = result.spec.series.map((s) => ({
      ...s,
      data: s.data.filter(([x]) => Number(x) >= start),
    }));
    const end = Math.max(
      ...result.spec.series.flatMap((s) => s.data.map(([x]) => Number(x))),
    );
    result.spec.title = `${result.spec.y_axis || "Recorded values"} · ${start}–${end}`;
    result.answer = `Showing ${start} onward. Original source rows retained in Data.`;
  }
  result.verification = null;
  // Keep the original recorded date: changing a view is not a fresh fetch.
  return result;
}
