import type { ShareStateV1 } from "../share";

function period(result: ShareStateV1): string | null {
  if (result.spec?.type !== "line" || !/year/i.test(result.spec.x_axis || ""))
    return null;
  const years = result.spec.series.flatMap((s) =>
    s.data.map(([x]) => Number(x)),
  );
  if (
    !years.length ||
    years.some((y) => !Number.isInteger(y) || y < 1800 || y > 2200)
  )
    return null;
  return `${Math.min(...years)}–${Math.max(...years)}`;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const rows = (result: ShareStateV1) =>
  result.rows
    .map((row) =>
      JSON.stringify([row.iso3, row.indicator, row.year, row.value]),
    )
    .sort();

/** Describe observed result differences, never an inferred scientific finding. */
export function describeChange(
  before: ShareStateV1 | null,
  after: ShareStateV1,
): string {
  if (!before)
    return after.spec
      ? `Loaded ${after.rows.length} source rows; charted ${after.spec.series.length} series.`
      : after.answer
        ? "Added an answer."
        : `Loaded ${after.rows.length} source rows.`;
  const changes: string[] = [];
  const oldPeriod = period(before),
    newPeriod = period(after);
  if (oldPeriod && newPeriod && oldPeriod !== newPeriod)
    changes.push(`Period ${oldPeriod} → ${newPeriod}`);
  const oldNames = before.spec?.series.map((s) => s.name) || [];
  const newNames = after.spec?.series.map((s) => s.name) || [];
  if (!same(oldNames, newNames)) {
    changes.push(
      newNames.length === 1 && oldNames.includes(newNames[0])
        ? `Focused ${newNames[0]}; ${oldNames.length - 1} series hidden`
        : `Series now ${newNames.slice(0, 2).join(", ") || "none"}${newNames.length > 2 ? ", …" : ""}`,
    );
  } else if (after.spec && ["bar", "grouped-bar"].includes(after.spec.type)) {
    const oldCategories = [
      ...new Set(
        before.spec?.series.flatMap((s) => s.data.map(([x]) => String(x))) ||
          [],
      ),
    ];
    const categories = [
      ...new Set(
        after.spec.series.flatMap((s) => s.data.map(([x]) => String(x))),
      ),
    ];
    if (!same(oldCategories, categories))
      changes.push(
        categories.length === 1 && oldCategories.includes(categories[0])
          ? `Focused ${categories[0]}; ${oldCategories.length - 1} categories hidden`
          : `Categories now ${categories.slice(0, 2).join(", ") || "none"}${categories.length > 2 ? ", …" : ""}`,
      );
  }
  if (!same(rows(before), rows(after)))
    changes.push(
      before.rows.length === after.rows.length
        ? "Updated source values"
        : `Source rows ${before.rows.length} → ${after.rows.length}`,
    );
  if (!changes.length && !same(before.spec, after.spec))
    changes.push("Updated chart");
  if (!changes.length && before.answer !== after.answer)
    changes.push("Updated answer; chart unchanged");
  if (!same(before.citations, after.citations))
    changes.push("Updated source records");
  if (!changes.length && !same(before.verification, after.verification))
    changes.push("Updated evidence check");
  return changes.length
    ? `${changes.slice(0, 2).join(". ")}.`
    : "No change to the result.";
}
