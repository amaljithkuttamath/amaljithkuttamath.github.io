// buildOption: pure ChartSpec -> ECharts option builder, extracted verbatim
// from the chitti UI monolith. No shared state; reads only CSS custom
// properties (theme) via cssVar and formats via chart-format helpers.
import type { ChartSpec } from '../tools';
import { formatAxisValue, needsDataZoom, legendMode, titleSlug } from '../chart-format';
import { cssVar, escapeHtml, prefersReducedMotion } from './dom';

export function buildOption(spec: ChartSpec) {
  const signal = cssVar('--signal') || '#d9a13b';
  const muted = cssVar('--fg-muted') || '#79817c';
  const fg = cssVar('--fg') || '#e6e9e7';
  const faint = cssVar('--fg-faint') || 'rgba(255,255,255,0.08)';
  const bg = cssVar('--bg') || '#0b0d0c';

  // Palette: primary in signal amber, the rest in muted-derived tones.
  const palette = [signal, muted, fg, '#6b8ab8', '#5fa97c', '#c0605a', '#9a7cc0', '#b8946b'];

  const baseText = { color: muted, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 };
  // No y-axis `name` inside the canvas at all: long unit strings ("deaths
  // per 1,000 live births") clipped against the container edges no matter
  // where ECharts anchored them. The unit renders in the chart card's
  // header instead (see renderChart / .ch-chart-unit).
  // containLabel keeps rotated category labels and axis ticks inside the
  // grid instead of spilling past the right/bottom edges.
  // A long line series gets a bottom dataZoom slider; reserve room for it so
  // it never overlaps the x-axis tick labels.
  const hasZoom = needsDataZoom(spec);
  const grid = { left: 12, right: 18, top: 40, bottom: hasZoom ? 34 : 8, containLabel: true };
  const axisLine = { lineStyle: { color: faint } };
  const splitLine = { lineStyle: { color: faint, type: 'dashed' as const } };

  // The unit lives in spec.y_axis (also shown in the card header). Only the
  // axis tick and tooltip number formatting consult it — via formatAxisValue,
  // which appends % for percent units and otherwise just compacts magnitudes.
  const unit = spec.y_axis || '';
  const reduce = prefersReducedMotion();

  // A themed legend. type:'scroll' with paged arrows only when there are
  // enough series to warrant it (legendMode); otherwise a plain legend that
  // still wraps. Show/hide (legend click) behavior is ECharts' default in
  // both modes, so chart-link's "row with a hidden series does nothing"
  // contract is unchanged.
  const legend = {
    textStyle: { color: muted, fontFamily: 'JetBrains Mono, monospace', fontSize: 10 },
    top: 0,
    left: 0,
    type: legendMode(spec),
    icon: 'roundRect',
    // Themed pager arrows: muted when active, faint when there's no more to
    // page. Amber is reserved for the dataZoom handle, so the arrows stay
    // monochrome with the rest of the axis furniture.
    pageIconColor: muted,
    pageIconInactiveColor: faint,
    pageTextStyle: baseText,
  };

  // Value-axis tick labels: compact, unit-aware. Safe on single-point /
  // all-equal series — formatAxisValue never divides by a data range.
  const valueAxisLabel = { ...baseText, formatter: (v: number) => formatAxisValue(v, unit) };

  // Shared-axis tooltip: monospace, values formatted like the axis, the unit
  // shown once in the header, series ordered by value descending at that x.
  // Rows whose series has no point here (null) are dropped, so a hidden or
  // absent series contributes nothing — never a blank "null" line.
  function axisTooltipFormatter(params: any): string {
    const arr = Array.isArray(params) ? params : [params];
    if (!arr.length) return '';
    const rows = arr
      .map((p: any) => {
        const raw = Array.isArray(p?.value) ? p.value[1] : p?.value;
        const num = raw == null ? null : Number(raw);
        return { name: p?.seriesName ?? '', marker: p?.marker ?? '', num };
      })
      .filter((r: any) => r.num != null && Number.isFinite(r.num))
      .sort((a: any, b: any) => b.num - a.num);
    if (!rows.length) return '';
    const head = arr[0]?.axisValueLabel ?? arr[0]?.axisValue ?? '';
    const unitTag = unit ? ` · ${escapeHtml(unit)}` : '';
    const headHtml = `<div style="opacity:.7;margin-bottom:2px">${escapeHtml(String(head))}${unitTag}</div>`;
    const body = rows
      .map(
        (r: any) =>
          `<div style="display:flex;justify-content:space-between;gap:14px">` +
          `<span>${r.marker}${escapeHtml(r.name)}</span>` +
          `<span>${escapeHtml(formatAxisValue(r.num, unit))}</span></div>`
      )
      .join('');
    return headHtml + body;
  }

  const tooltip = {
    trigger: 'axis' as const,
    backgroundColor: bg,
    borderColor: faint,
    textStyle: { color: fg, fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
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
        title: 'Save',
        name: titleSlug(spec.title),
        backgroundColor: bg || '#0b0d0c',
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
        { type: 'inside' as const, zoomLock: false, zoomOnMouseWheel: true, moveOnMouseWheel: false },
        {
          type: 'slider' as const,
          height: 16,
          bottom: 4,
          borderColor: faint,
          backgroundColor: 'transparent',
          fillerColor: 'rgba(217,161,59,0.10)',
          dataBackground: { lineStyle: { color: faint }, areaStyle: { color: faint } },
          selectedDataBackground: { lineStyle: { color: signal }, areaStyle: { color: 'rgba(217,161,59,0.15)' } },
          handleStyle: { color: signal, borderColor: signal },
          moveHandleStyle: { color: muted },
          textStyle: { color: muted, fontFamily: 'JetBrains Mono, monospace', fontSize: 9 },
          labelFormatter: '',
        },
      ]
    : [];

  if (spec.type === 'scatter') {
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
        trigger: 'item' as const,
        formatter: (p: any) =>
          `${p?.marker ?? ''}${escapeHtml(p?.seriesName ?? '')}<br/>` +
          `${escapeHtml(String(p?.value?.[0] ?? ''))}, ${escapeHtml(formatAxisValue(Number(p?.value?.[1]), unit))}`,
      },
      xAxis: { type: 'value', name: spec.x_axis, nameLocation: 'middle' as const, nameGap: 28, nameTextStyle: baseText, axisLine, splitLine, axisLabel: baseText },
      yAxis: { type: 'value', axisLine, splitLine, axisLabel: valueAxisLabel },
      series: spec.series.map((s) => ({
        name: s.name,
        type: 'scatter',
        symbolSize: 8,
        data: s.data,
      })),
    };
  }

  if (spec.type === 'bar' || spec.type === 'grouped-bar') {
    // Categories come from the union of x values across series.
    const cats: (string | number)[] = [];
    for (const s of spec.series) for (const [x] of s.data) if (!cats.includes(x)) cats.push(x);
    return {
      animation: !reduce,
      color: palette,
      textStyle: baseText,
      grid,
      legend: spec.series.length > 1 ? legend : { show: false },
      toolbox,
      tooltip,
      xAxis: {
        type: 'category',
        data: cats,
        // No axis `name` for category bars — the categories are
        // self-describing and the trailing name label was clipping at the
        // container's right edge.
        axisLine,
        axisLabel: { ...baseText, interval: 0, rotate: cats.length > 8 ? 40 : 0 },
      },
      yAxis: { type: 'value', axisLine, splitLine, axisLabel: valueAxisLabel },
      series: spec.series.map((s) => {
        const map = new Map(s.data.map(([x, y]) => [x, y]));
        return {
          name: s.name,
          type: 'bar',
          barMaxWidth: 28,
          data: cats.map((c) => map.get(c) ?? null),
          itemStyle: spec.series.length === 1 ? { color: signal } : {},
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
  for (const s of spec.series) for (const [x] of s.data) if (!lineCats.includes(x)) lineCats.push(x);
  lineCats.sort((a, b) => Number(a) - Number(b));
  return {
    animation: !reduce,
    color: palette,
    textStyle: baseText,
    grid,
    legend: spec.series.length > 1 ? legend : { show: false },
    toolbox,
    tooltip,
    dataZoom,
    xAxis: {
      type: 'category',
      boundaryGap: false,
      axisLine,
      axisLabel: baseText,
      data: lineCats,
    },
    yAxis: { type: 'value', axisLine, splitLine, axisLabel: valueAxisLabel },
    series: spec.series.map((s, i) => {
      const map = new Map(s.data.map(([x, y]) => [x, y]));
      return {
        name: s.name,
        type: 'line',
        smooth: false,
        showSymbol: false,
        lineStyle: { width: i === 0 ? 2 : 1.4 },
        data: lineCats.map((c) => map.get(c) ?? null),
      };
    }),
  };
}
