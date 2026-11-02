import { useState } from 'react';
import type { ChartSpec } from '../../lib/chitti/core';
import { chartTypes } from '../../lib/chitti/workspace/steering';

export default function YearRange({ spec, onApply }: { spec: ChartSpec; onApply: (value: string) => void }) {
  const years = spec.series.flatMap(s => s.data.map(([x]) => Number(x)));
  const [start, setStart] = useState(String(Math.min(...years)));
  const [end, setEnd] = useState(String(Math.max(...years)));
  if (!years.length || !chartTypes(spec).includes('line')) return null;
  const valid = start.trim() && end.trim() && Number.isInteger(Number(start)) && Number.isInteger(Number(end)) && Number(start) <= Number(end) && Number(start) >= Math.min(...years) && Number(end) <= Math.max(...years);
  return <div className="cw-year-range">
    <label>From <input aria-label="Start year" type="number" value={start} min={Math.min(...years)} max={Math.max(...years)} onChange={e => setStart(e.target.value)} /></label>
    <label>To <input aria-label="End year" type="number" value={end} min={Math.min(...years)} max={Math.max(...years)} onChange={e => setEnd(e.target.value)} /></label>
    <button disabled={!valid} onClick={() => onApply(JSON.stringify({ start: Number(start), end: Number(end) }))}>Apply years</button>
  </div>;
}
