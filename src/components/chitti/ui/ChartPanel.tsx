import { useEffect, useMemo, useRef, useState } from "react";
import type { Analysis } from "../../../lib/chitti/workspace/model";
import type { ChartSpec } from "../../../lib/chitti/core";
import { chartValue } from "../../../lib/chitti/chart-insights";
import { chartUnit } from "../../../lib/chitti/chart-contract";
import { ChartCard, TokenRow, SwitchRow } from "./ChartCard";
import { Button, IconButton, Menu, type MenuItem } from "./controls";
import { BackIcon, CloseIcon, FullscreenIcon, PinIcon, ShareIcon } from "./icons";
import { plottedYears, seriesStats, signed } from "./interpretation";

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

/** Restrict a time chart to [start, end] for display only. Pure. */
export function clipYears(spec: ChartSpec, start: number, end: number): ChartSpec {
  return {
    ...spec,
    series: spec.series.map((s) => ({ ...s, data: s.data.filter(([x]) => Number(x) >= start && Number(x) <= end) })),
  };
}

/** A two-thumb year range made of native range inputs (arrow keys work). */
function YearSlider({ min, max, start, end, onChange }: { min: number; max: number; start: number; end: number; onChange: (a: number, b: number) => void }) {
  const pct = (v: number) => ((v - min) / (max - min || 1)) * 100;
  return (
    <div className="cx-range" role="group" aria-label="Years shown">
      <span>{start}</span>
      <div className="cx-range-track">
        <span className="cx-range-fill" style={{ left: `${pct(start)}%`, right: `${100 - pct(end)}%` }} aria-hidden="true" />
        <input type="range" aria-label="First year shown" min={min} max={max} step={1} value={start} onChange={(e) => onChange(Math.min(+e.target.value, end - 1), end)} />
        <input type="range" aria-label="Last year shown" min={min} max={max} step={1} value={end} onChange={(e) => onChange(start, Math.max(+e.target.value, start + 1))} />
      </div>
      <span>{end}</span>
    </div>
  );
}

/**
 * The expanded chart (v4): the chart of one turn in a right-hand panel beside
 * the thread, or full screen on a phone. Esc closes; the workspace returns
 * focus to the control that opened it.
 */
export function ChartPanel({
  turn,
  turnNumber,
  onClose,
  onSteer,
  shareItems,
  onPin,
}: {
  turn: Analysis;
  turnNumber: number;
  onClose: () => void;
  onSteer?: (name: string, value: string) => void;
  shareItems: MenuItem[];
  onPin?: () => void;
}) {
  const result = turn.result!;
  const spec = result.spec!;
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const years = plottedYears(spec);
  const [range, setRange] = useState(years);
  useEffect(() => setRange(years), [turn.id, years?.start, years?.end]);
  useEffect(() => {
    heading.current?.focus();
  }, [turn.id]);
  const shown = useMemo(
    () => (range && years && (range.start !== years.start || range.end !== years.end) ? clipYears(spec, range.start, range.end) : spec),
    [spec, range, years],
  );
  const stats = seriesStats(shown);
  const unit = chartUnit(spec);
  return (
    <aside
      ref={root}
      className="cx-panel"
      aria-label={`Chart panel: ${spec.title}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !(e.target as HTMLElement).closest(".cx-menu-pop, .cx-pop")) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="cx-panel-top">
        <IconButton className="cx-panel-back" variant="ghost" size="sm" label="Back to the conversation" icon={<BackIcon />} onClick={onClose} />
        <h2 ref={heading} tabIndex={-1}>
          {spec.title}
        </h2>
        <span className="cx-panel-from">from your {ordinal(turnNumber)} question</span>
        <div className="cx-panel-actions">
          {onPin && <Button size="sm" variant="quiet" icon={<PinIcon />} label="Pin to dashboard" onClick={onPin} />}
          <Menu label="Share" icon={<ShareIcon />} items={shareItems} align="end" variant="quiet" />
          {typeof document !== "undefined" && document.fullscreenEnabled && (
            <Button
              size="sm"
              variant="quiet"
              icon={<FullscreenIcon />}
              label="Full screen"
              onClick={() => (document.fullscreenElement ? document.exitFullscreen() : root.current?.requestFullscreen())}
            />
          )}
          <Button className="cx-panel-close" size="sm" variant="quiet" icon={<CloseIcon />} label="Close" onClick={onClose} />
        </div>
      </div>
      <TokenRow result={result} />
      <SwitchRow />
      <ChartCard
        result={result}
        onSteer={onSteer}
        variant="panel"
        specOverride={shown}
        belowChart={
          years && range && years.end > years.start ? (
            <YearSlider min={years.start} max={years.end} start={range.start} end={range.end} onChange={(a, b) => setRange({ start: a, end: b })} />
          ) : null
        }
      />
      {stats.length > 0 && (
        <div className="cx-stats" role="list" aria-label="Per-series summary">
          {stats.map((s) => (
            <div className="cx-st" role="listitem" key={s.name}>
              <div className="cx-st-name">
                <span className="cx-swatch" style={{ background: s.color }} aria-hidden="true" />
                {s.name}
              </div>
              <div className="cx-st-value">
                {chartValue(s.last.value, s.digits)}
                <small>
                  {unit ? `${unit}, ` : ""}
                  {s.last.year}
                </small>
              </div>
              <div className="cx-st-detail">
                {signed(s.change, s.digits)} since {s.first.year}
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
