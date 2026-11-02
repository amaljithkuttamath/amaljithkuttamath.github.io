/** Follow parent links, keeping branch history out of the active transcript. */
export function conversationPath(id: string, parents: Record<string, string>): string[] {
  const path: string[] = [], seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id); path.unshift(id); id = parents[id] || '';
  }
  return path;
}
export function conversationHeads(ids: string[], parents: Record<string, string>): string[] {
  const ancestors = new Set(ids.flatMap(id => conversationPath(id, parents).slice(0, -1)));
  return ids.filter(id => !ancestors.has(id)).reverse();
}
