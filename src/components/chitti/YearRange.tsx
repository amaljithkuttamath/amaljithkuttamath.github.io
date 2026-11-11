import { useState } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { NumberInput } from '@astryxdesign/core/NumberInput';
import type { ChartSpec } from '../../lib/chitti/core';
import { chartTypes } from '../../lib/chitti/workspace/steering';

export default function YearRange({ spec, onApply, isDisabled = false }: { spec: ChartSpec; onApply: (value: string) => void; isDisabled?: boolean }) {
  const years = spec.series.flatMap(s => s.data.map(([x]) => Number(x)));
  const min = Math.min(...years), max = Math.max(...years);
  const [start, setStart] = useState<number | null>(min);
  const [end, setEnd] = useState<number | null>(max);
  if (!years.length || !chartTypes(spec).includes('line')) return null;
  const valid = start !== null && end !== null && Number.isInteger(start) && Number.isInteger(end) && start <= end && start >= min && end <= max;
  return <div className="cx-year-range" role="group" aria-label="Year range">
    <NumberInput label="Start year" isLabelHidden size="sm" width={84} value={start} min={min} max={max} isIntegerOnly isWheelEnabled={false} isDisabled={isDisabled} onChange={setStart} formatValue={String} />
    <span className="cx-year-dash" aria-hidden="true">–</span>
    <NumberInput label="End year" isLabelHidden size="sm" width={84} value={end} min={min} max={max} isIntegerOnly isWheelEnabled={false} isDisabled={isDisabled} onChange={setEnd} formatValue={String} />
    <Button label="Apply years" size="sm" isDisabled={isDisabled || !valid} onClick={() => valid && onApply(JSON.stringify({ start, end }))} />
  </div>;
}
