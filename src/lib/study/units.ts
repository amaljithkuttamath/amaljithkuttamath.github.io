export interface Unit {
  label: string;
  id: number;
  bits: string;
  group: number;
}
export function byteUnits(text: string): Unit[] {
  const encoder = new TextEncoder();
  return Array.from(text).flatMap((character, group) =>
    [...encoder.encode(character)].map((id) => ({
      label: character === " " ? "·" : character === "\n" ? "↵" : character,
      id,
      bits: id.toString(2).padStart(8, "0"),
      group,
    })),
  );
}
export function tokenUnits(
  ids: number[],
  decode: (id: number) => string,
): Unit[] {
  return ids.map((id, group) => ({
    id,
    group,
    label: decode(id)
      .replace(/ /g, "·")
      .replace(/\n/g, "↵")
      .replace(/\uFFFD/g, "[byte]"),
    bits: id.toString(2).padStart(18, "0"),
  }));
}
