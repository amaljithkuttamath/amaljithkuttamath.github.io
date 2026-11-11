import { useState } from "react";
import type { ChartSpec } from "../../lib/chitti/core";
import { chartTypes } from "../../lib/chitti/workspace/steering";
import { Button } from "./ui/controls";

/** Two native number inputs and an Apply button: a view-only year filter. */
export default function YearRange({
  spec,
  onApply,
  isDisabled = false,
  applyLabel = "Apply years",
}: {
  spec: ChartSpec;
  onApply: (value: string) => void;
  isDisabled?: boolean;
  applyLabel?: string;
}) {
  const years = spec.series.flatMap((s) => s.data.map(([x]) => Number(x)));
  const min = Math.min(...years),
    max = Math.max(...years);
  const [start, setStart] = useState(String(min));
  const [end, setEnd] = useState(String(max));
  if (!years.length || !chartTypes(spec).includes("line")) return null;
  const a = Number(start),
    b = Number(end);
  const valid = Number.isInteger(a) && Number.isInteger(b) && a <= b && a >= min && b <= max;
  return (
    <div className="cx-year-range" role="group" aria-label="Year range">
      <input className="cx-input" type="number" aria-label="Start year" min={min} max={max} step={1} value={start} disabled={isDisabled} onChange={(e) => setStart(e.target.value)} />
      <span aria-hidden="true">–</span>
      <input className="cx-input" type="number" aria-label="End year" min={min} max={max} step={1} value={end} disabled={isDisabled} onChange={(e) => setEnd(e.target.value)} />
      <Button size="sm" label={applyLabel} disabled={isDisabled || !valid} onClick={() => valid && onApply(JSON.stringify({ start: a, end: b }))} />
    </div>
  );
}
