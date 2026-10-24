import { filterRows, type Row } from "./data";
export type FieldMode = "source" | "score";
export interface FieldPoint {
  row: Row;
  x: number;
  y: number;
  radius: number;
}
export interface FieldGroup {
  label: string;
  count: number;
  x: number;
  y: number;
  radius: number;
}
export const FIELD_WIDTH = 560,
  FIELD_HEIGHT = 240;
/** Pack real categories without implying semantic proximity or links. */
export function researchField(
  rows: Row[],
  mode: FieldMode,
  width = FIELD_WIDTH,
  height = FIELD_HEIGHT,
) {
  const buckets = new Map<string, Row[]>();
  for (const row of filterRows(rows)) {
    const key = mode === "source" ? row.group : `Score ${row.score}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(row);
  }
  const entries = [...buckets].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const anchors = [
    [136, 116],
    [352, 132],
    [457, 58],
    [455, 180],
    [295, 48],
    [272, 194],
  ];
  let packed: FieldGroup[] = [],
    packingScale = 1;
  for (let scale = 1; scale > 0.12; scale *= 0.85) {
    packed = [];
    packingScale = scale;
    for (const [index, [label, items]] of entries.entries()) {
      const radius =
        Math.min(88, Math.sqrt(items.length) * 4.1) * scale +
        (width < 400 ? 22 : 19);
      const base = anchors[index % anchors.length];
      const anchor = [
        (base[0] * width) / FIELD_WIDTH,
        (base[1] * height) / FIELD_HEIGHT,
      ];
      let best: { x: number; y: number; cost: number } | undefined;
      for (let y = radius + 4; y <= height - radius - 4; y += 5)
        for (let x = radius + 4; x <= width - radius - 4; x += 5) {
          if (
            packed.some(
              (p) => Math.hypot(x - p.x, y - p.y) < radius + p.radius + 6,
            )
          )
            continue;
          const cost = (x - anchor[0]) ** 2 + (y - anchor[1]) ** 2;
          if (!best || cost < best.cost) best = { x, y, cost };
        }
      if (!best) break;
      packed.push({ label, count: items.length, x: best.x, y: best.y, radius });
    }
    if (packed.length === entries.length) break;
  }
  // Keep every record reachable even if an unexpected number of categories arrives.
  if (packed.length !== entries.length) {
    const columns = Math.ceil(Math.sqrt((entries.length * width) / height));
    const lines = Math.ceil(entries.length / columns);
    const cellWidth = width / columns,
      cellHeight = height / lines;
    packingScale = Math.min(cellWidth, cellHeight) / 100;
    packed = entries.map(([label, items], index) => ({
      label,
      count: items.length,
      x: ((index % columns) + 0.5) * cellWidth,
      y: (Math.floor(index / columns) + 0.5) * cellHeight,
      radius: Math.max(1, Math.min(cellWidth, cellHeight) / 2 - 4),
    }));
  }
  const points: FieldPoint[] = [];
  packed.forEach((group, index) => {
    const items = entries[index][1],
      extent = Math.max(1, group.radius - (width < 400 ? 22 : 18));
    items.forEach((row, i) => {
      const angle = i * Math.PI * (3 - Math.sqrt(5)),
        distance = extent * Math.sqrt((i + 0.5) / items.length);
      points.push({
        row,
        x: group.x + Math.cos(angle) * distance,
        y: group.y + Math.sin(angle) * distance,
        radius: (1.65 + row.score * 0.32) * packingScale,
      });
    });
  });
  return { groups: packed, points };
}
export function nearestPoint(points: FieldPoint[], x: number, y: number) {
  return points.reduce<FieldPoint | undefined>(
    (best, p) =>
      !best || Math.hypot(p.x - x, p.y - y) < Math.hypot(best.x - x, best.y - y)
        ? p
        : best,
    undefined,
  );
}
export function directionalPoint(
  points: FieldPoint[],
  current: FieldPoint,
  key: string,
) {
  const direction: Record<string, [number, number]> = {
    ArrowRight: [1, 0],
    ArrowLeft: [-1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const vector = direction[key];
  if (!vector) return current;
  let best = current,
    cost = Infinity;
  for (const p of points) {
    const dx = p.x - current.x,
      dy = p.y - current.y,
      forward = dx * vector[0] + dy * vector[1];
    if (forward <= 0.1) continue;
    const side = Math.abs(dx * vector[1] - dy * vector[0]),
      candidate = Math.hypot(dx, dy) + side * 2;
    if (candidate < cost) {
      best = p;
      cost = candidate;
    }
  }
  return best;
}
