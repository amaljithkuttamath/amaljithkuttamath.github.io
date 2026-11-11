// buildOption: pure ChartSpec -> ECharts option builder, extracted verbatim
// from the chitti UI monolith. No shared state; reads only CSS custom
// properties (theme) via cssVar and formats via chart-format helpers.
import {
  lineDomain,
  chartValue,
  highlightChanges,
  deltaLabel,
  changeDigits,
  type ChartChange,
} from "../chart-insights";
import type { ChartSpec, ChartSeries } from "../core";
import { prepareChart, seriesIdentity, chartUnit } from "../chart-contract";
import {
  formatAxisValue,
  needsDataZoom,
  legendMode,
  titleSlug,
} from "../chart-format";
import { cssVar, escapeHtml, prefersReducedMotion } from "./dom";

// A ranking bar — one series over named categories — reads better on its
// side once there are more than a handful of bars: rotated country names under
// a vertical bar eat most of the canvas ("Korea, Dem. People's Rep." left ten
// bars about 60px of plot), while a horizontal bar gives every name a full
// line. Time bars (numeric x) and grouped bars stay vertical. Returns the
// category list, whether to lay it out sideways, and the canvas height that
// keeps each bar a readable thickness. Pure — exported for its unit table.
export const HORIZONTAL_BAR_MIN = 7;
export function barLayout(spec: ChartSpec): {
  categories: (string | number)[];
  horizontal: boolean;
  height?: number;
} {
  const categories: (string | number)[] = [];
  if (spec.type !== "bar" && spec.type !== "grouped-bar")
    return { categories, horizontal: false };
  for (const s of spec.series)
    for (const [x] of s.data) if (!categories.includes(x)) categories.push(x);
  const named = categories.every(
    (c) => typeof c === "string" && !Number.isFinite(Number(c)),
  );
  const horizontal =
    spec.type === "bar" &&
    spec.series.length === 1 &&
    named &&
    categories.length >= HORIZONTAL_BAR_MIN;
  return horizontal
    ? { categories, horizontal, height: Math.max(250, 60 + categories.length * 24) }
    : { categories, horizontal };
}

// Dark-theme chart palette, used only when the CSS variables are missing.
export const CHART_FALLBACK = ["#ff6b93", "#4fd8fb", "#ffcf4a", "#b9a2ff", "#7fe08f", "#ff9a5c", "#f59ee8", "#d6d0be"];

// A line chart labels each series at its right end (name + last value) instead
// of a legend while there are few enough series for the labels to stay legible.
// Pure — exported for its unit table.
export const END_LABEL_MAX = 6;
export function usesEndLabels(spec: ChartSpec): boolean {
  return spec.type === "line" && spec.series.length > 0 && spec.series.length <= END_LABEL_MAX;
}

export function buildOption(
  spec: ChartSpec,
  fitLine = true,
  selected?: ChartChange,
) {
  spec = prepareChart(spec);
  const signal = cssVar("--signal") || "#d9a13b";
  const muted = cssVar("--fg-muted") || "#79817c";
  const fg = cssVar("--fg") || "#e6e9e7";
  const faint = cssVar("--fg-faint") || "rgba(255,255,255,0.08)";
  const bg = cssVar("--bg") || "#0b0d0c";

  // The page defines --chart-1…8 for both themes (components/chitti/ui/
  // chitti.css); the fallback is the dark set, for a render with no stylesheet.
  const palette = CHART_FALLBACK.map((fallback, i) => cssVar(`--chart-${i + 1}`) || fallback);
  const colorOf = (s: ChartSeries) => palette[s.colorIndex! % palette.length];
  const opacityOf = (s: ChartSeries) =>
    selected ? (selected.series === s.name ? 1 : 0.35) :
    spec.highlight?.length && !spec.highlight.includes(seriesIdentity(s)) ? 0.35 : 1;
  const { categories: cats, horizontal: sideways } = barLayout(spec);
  const annotations = (s: ChartSeries, categories?: (string | number)[]) =>
    (spec.annotations || []).filter(a => a.seriesId === seriesIdentity(s)).flatMap(a => {
      const point = s.data.find(([x]) => x === a.x);
      if (!point) return [];
      const at = categories ? categories.indexOf(a.x) : a.x;
      return [{ name: a.label, coord: sideways ? [point[1], at] : [at, point[1]],
        symbol: "pin", symbolSize: 20,
        label: { show: true, formatter: a.label, color: fg, fontSize: 11, position: sideways ? "right" : "top" },
        itemStyle: { color: colorOf(s) } }];
    });

  const baseText = {
    color: muted,
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 11,
  };
  // No y-axis `name` inside the canvas at all: long unit strings ("deaths
  // per 1,000 live births") clipped against the container edges no matter
  // where ECharts anchored them. The unit renders in the chart card's
  // header instead (see renderChart / .ch-chart-unit).
  // containLabel keeps rotated category labels and axis ticks inside the
  // grid instead of spilling past the right/bottom edges.
  // A long line series gets a bottom dataZoom slider; reserve room for it so
  // it never overlaps the x-axis tick labels.
  const hasZoom = needsDataZoom(spec);
  const grid = {
    left: 12,
    right: 18,
    top: 40,
    bottom: hasZoom ? 34 : 8,
    containLabel: true,
  };
  const axisLine = { lineStyle: { color: faint } };
  const splitLine = { lineStyle: { color: faint, type: "dashed" as const } };

  // The unit lives in spec.y_axis (also shown in the card header). Only the
  // axis tick and tooltip number formatting consult it — via formatAxisValue,
  // which appends % for percent units and otherwise just compacts magnitudes.
  const unit = chartUnit(spec);
  const reduce = prefersReducedMotion();

  // A themed legend. type:'scroll' with paged arrows only when there are
  // enough series to warrant it (legendMode); otherwise a plain legend that
  // still wraps. Show/hide (legend click) behavior is ECharts' default in
  // both modes, so chart-link's "row with a hidden series does nothing"
  // contract is unchanged.
  const legend = {
    textStyle: {
      color: muted,
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 10,
    },
    top: 0,
    left: 0,
    type: legendMode(spec),
    icon: "roundRect",
    // Themed pager arrows: muted when active, faint when there's no more to
    // page. Amber is reserved for the dataZoom handle, so the arrows stay
    // monochrome with the rest of the axis furniture.
    pageIconColor: muted,
    pageIconInactiveColor: faint,
    pageTextStyle: baseText,
  };

  // Value-axis tick labels: compact, unit-aware. Safe on single-point /
  // all-equal series — formatAxisValue never divides by a data range.
  const valueAxisLabel = {
    ...baseText,
    formatter: (v: number) => formatAxisValue(v, unit),
  };

  // Shared-axis tooltip: monospace, values formatted like the axis, the unit
  // shown once in the header, series ordered by value descending at that x.
  // Rows whose series has no point here (null) are dropped, so a hidden or
  // absent series contributes nothing — never a blank "null" line.
  function axisTooltipFormatter(params: any): string {
    const arr = Array.isArray(params) ? params : [params];
    if (!arr.length) return "";
    const rows = arr
      .map((p: any) => {
        const raw = Array.isArray(p?.value) ? p.value[1] : p?.value;
        const num = raw == null ? null : Number(raw);
        return { name: p?.seriesName ?? "", marker: p?.marker ?? "", num };
      })
      .filter((r: any) => r.num != null && Number.isFinite(r.num))
      .sort((a: any, b: any) => b.num - a.num);
    if (!rows.length) return "";
    const head = arr[0]?.axisValueLabel ?? arr[0]?.axisValue ?? "";
    const unitTag = unit ? ` · ${escapeHtml(unit)}` : "";
    const headHtml = `<div style="opacity:.7;margin-bottom:2px">${escapeHtml(String(head))}${unitTag}</div>`;
    const body = rows
      .map(
        (r: any) =>
          `<div style="display:flex;justify-content:space-between;gap:14px">` +
          `<span>${r.marker}${escapeHtml(r.name)}</span>` +
          `<span>${escapeHtml(formatAxisValue(r.num, unit))}</span></div>`,
      )
      .join("");
    return headHtml + body;
  }

  const tooltip = {
    trigger: "axis" as const,
    backgroundColor: bg,
    borderColor: faint,
    textStyle: {
      color: fg,
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 11,
    },
    formatter: axisTooltipFormatter,
  };

  // Minimal toolbox: save-as-image only, dark background baked in, filename
  // from the title slug. No zoom/restore/dataView clutter.
  const toolbox = {
    show: true,
    right: 8,
    top: 0,
    itemSize: 13,
    feature: {
      saveAsImage: {
        title: "Save",
        name: titleSlug(spec.title),
        backgroundColor: bg || "#0b0d0c",
        pixelRatio: 2,
        iconStyle: { borderColor: muted },
        emphasis: { iconStyle: { borderColor: fg } },
      },
    },
  };

  // A themed dataZoom pair for long line series: inside (wheel/pinch) + a
  // slim slider with an amber handle. Empty [] for short charts. Zoom
  // animation is disabled under prefers-reduced-motion.
  const dataZoom = hasZoom
    ? [
        {
          type: "inside" as const,
          zoomLock: false,
          zoomOnMouseWheel: true,
          moveOnMouseWheel: false,
        },
        {
          type: "slider" as const,
          height: 16,
          bottom: 4,
          borderColor: "transparent",
          backgroundColor: "transparent",
          fillerColor: faint,
          moveHandleSize: 0,
          dataBackground: {
            lineStyle: { color: faint },
            areaStyle: { color: faint },
          },
          selectedDataBackground: {
            lineStyle: { color: muted },
            areaStyle: { color: faint },
          },
          handleStyle: { color: signal, borderColor: signal },
          moveHandleStyle: { color: muted },
          textStyle: {
            color: muted,
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 9,
          },
          labelFormatter: "",
        },
      ]
    : [];

  if (spec.type === "scatter") {
    return {
      animation: !reduce,
      color: palette,
      textStyle: baseText,
      grid,
      legend,
      toolbox,
      // Scatter is per-point (item trigger), not a shared axis — its value is
      // a coordinate pair, so it keeps a dedicated single-point formatter.
      tooltip: {
        ...tooltip,
        trigger: "item" as const,
        formatter: (p: any) =>
          `${p?.marker ?? ""}${escapeHtml(p?.seriesName ?? "")}<br/>` +
          `${escapeHtml(String(p?.value?.[0] ?? ""))}, ${escapeHtml(formatAxisValue(Number(p?.value?.[1]), unit))}`,
      },
      xAxis: {
        type: "value",
        name: spec.x_axis,
        nameLocation: "middle" as const,
        nameGap: 28,
        nameTextStyle: baseText,
        axisLine,
        splitLine,
        axisLabel: baseText,
      },
      yAxis: { type: "value", axisLine, splitLine, axisLabel: valueAxisLabel },
      series: spec.series.map((s) => ({
        name: s.name,
        type: "scatter",
        symbolSize: 8,
        itemStyle: { color: colorOf(s), opacity: opacityOf(s) },
        markPoint: { data: annotations(s) },
        data: s.data,
      })),
    };
  }

  if (spec.type === "bar" || spec.type === "grouped-bar") {
    // Name column: wide enough for "Korea, Dem. People's Rep." on a desktop,
    // capped on a phone so the bars keep most of the row.
    const narrow = typeof window !== "undefined" && window.innerWidth < 620;
    const categoryAxis = {
      type: "category" as const,
      data: cats,
      // No axis `name` for category bars — the categories are
      // self-describing and the trailing name label was clipping at the
      // container's right edge.
      axisLine,
      axisLabel: sideways
        ? { ...baseText, interval: 0, width: narrow ? 112 : 200, overflow: "truncate" as const }
        : { ...baseText, interval: 0, rotate: cats.length > 8 ? 40 : 0 },
      // First category on top, so a ranking reads downward in its own order.
      inverse: sideways,
    };
    // Sideways, the value ticks share one line: fewer of them, and never two
    // overlapping ("-80%60%40%" on a phone).
    const valueAxis = sideways
      ? { type: "value" as const, axisLine, splitLine, splitNumber: narrow ? 3 : 5, axisLabel: { ...valueAxisLabel, hideOverlap: true } }
      : { type: "value" as const, axisLine, splitLine, axisLabel: valueAxisLabel };
    return {
      animation: !reduce,
      color: palette,
      textStyle: baseText,
      // No legend on a single series, so the band reserved for it is released.
      grid: sideways ? { ...grid, top: 26, right: 28 } : grid,
      legend: spec.series.length > 1 ? legend : { show: false },
      toolbox,
      tooltip,
      xAxis: sideways ? valueAxis : categoryAxis,
      yAxis: sideways ? categoryAxis : valueAxis,
      series: spec.series.map((s) => {
        const map = new Map(s.data.map(([x, y]) => [x, y]));
        return {
          name: s.name,
          type: "bar",
          barMaxWidth: 28,
          data: cats.map((c) => map.get(c) ?? null),
          itemStyle: { color: colorOf(s), opacity: opacityOf(s) },
          markPoint: { data: annotations(s, cats) },
        };
      }),
    };
  }

  // Default: line time-series.
  // x-axis is category-type (a fixed list of year labels), so series data
  // must be plain y-values indexed positionally against that category
  // list — NOT [x, y] coordinate pairs. Passing raw pairs here (the
  // previous bug) makes ECharts read each pair as [categoryIndex, value],
  // which almost never matches the literal year number, so every line
  // silently renders with zero points and no error. Same fix already
  // applied correctly in the bar/grouped-bar branch above: build the
  // shared category list once, then map each series onto it by year.
  const lineCats: (string | number)[] = [];
  for (const s of spec.series)
    for (const [x] of s.data) if (!lineCats.includes(x)) lineCats.push(x);
  lineCats.sort((a, b) => Number(a) - Number(b));
  const domain = fitLine ? lineDomain(spec) : null;
  const linePalette = palette;
  const highlights = highlightChanges(spec);
  const endLabels = usesEndLabels(spec);
  return {
    animation: !reduce,
    color: linePalette,
    textStyle: baseText,
    // The end labels replace the legend, so the band it reserved is released.
    grid: { ...grid, top: endLabels ? 16 : grid.top, right: endLabels ? 112 : 18 },
    legend: spec.series.length > 1 && !endLabels ? legend : { show: false },
    toolbox,
    tooltip,
    dataZoom,
    xAxis: {
      type: "category",
      boundaryGap: false,
      axisLine,
      axisLabel: baseText,
      data: lineCats,
    },
    yAxis: {
      type: "value",
      ...(domain ? { min: domain.min, max: domain.max } : {}),
      axisLine,
      splitLine,
      axisLabel: domain
        ? {
            ...baseText,
            formatter: (v: number) => chartValue(v, domain.digits),
          }
        : valueAxisLabel,
    },
    series: spec.series.map((s, i) => {
      const map = new Map(s.data.map(([x, y]) => [x, y]));
      return {
        name: s.name,
        type: "line",
        smooth: false,
        showSymbol: lineCats.length <= 20,
        symbolSize: 4,
        // Name in the series colour, last value in ink: the label is the
        // legend, so it must carry the colour that identifies the line.
        endLabel: {
          show: endLabels,
          formatter: (p: any) =>
            `{n|${s.name}} {v|${chartValue(Number(Array.isArray(p.value) ? p.value[1] : p.value), Math.max(1, domain?.digits || 0))}}`,
          rich: {
            n: { color: colorOf(s), fontSize: 11, fontFamily: "Inter, sans-serif", fontWeight: 500 },
            v: { color: fg, fontSize: 11, fontFamily: "JetBrains Mono, monospace" },
          },
          distance: 6,
          width: 104,
          overflow: "truncate",
        },
        labelLayout: { moveOverlap: "shiftY" },
        markPoint: {
          symbol: "circle",
          symbolSize: 11,
          label: { show: false },
          tooltip: {
            formatter: (p: any) => escapeHtml(String(p.data?.name || "")),
          },
          data: (selected
            ? selected.series === s.name
              ? [selected]
              : []
            : highlights.filter((c) => c.series === s.name)
          ).flatMap((c) =>
            (selected ? [c.from, c.to] : [c.to]).map((point) => ({
              name: `${c.series}: ${deltaLabel(c, unit)}, ${c.from[0]}–${c.to[0]}`,
              coord: [
                lineCats.findIndex((x) => Number(x) === point[0]),
                point[1],
              ],
              changeYear: c.to[0],
              symbolSize: selected ? 12 : 11,
              itemStyle: selected ? { borderWidth: 2, borderColor: fg } : {},
              label: selected
                ? {
                    show: true,
                    formatter: chartValue(point[1], changeDigits(c)),
                    position: point === c.from ? "top" : "bottom",
                    color: fg,
                    fontSize: 10,
                  }
                : { show: false },
            })),
          ).concat(annotations(s, lineCats) as any),
        },
        markLine:
          selected?.series === s.name
            ? {
                silent: true,
                symbol: ["none", "none"],
                label: { show: false },
                lineStyle: {
                  width: 4,
                  type: "solid",
                  color: colorOf(s),
                },
                data: [
                  [
                    {
                      coord: [
                        lineCats.findIndex(
                          (x) => Number(x) === selected.from[0],
                        ),
                        selected.from[1],
                      ],
                    },
                    {
                      coord: [
                        lineCats.findIndex((x) => Number(x) === selected.to[0]),
                        selected.to[1],
                      ],
                    },
                  ],
                ],
              }
            : undefined,
        lineStyle: {
          width: spec.highlight?.includes(seriesIdentity(s)) ? 3 : 2,
          color: colorOf(s),
          // With end labels naming every line, the dash cycle (the non-colour
          // cue for a legend) is not needed; past that it identifies lines.
          type: endLabels ? "solid" : (["solid", "dashed", "dotted"] as const)[s.colorIndex! % 3],
          opacity: opacityOf(s),
        },
        itemStyle: {
          color: colorOf(s),
          opacity: opacityOf(s),
        },
        data: lineCats.map((c) => map.get(c) ?? null),
      };
    }),
  };
}
