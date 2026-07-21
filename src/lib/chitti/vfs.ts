// vfs.ts — the agent's in-memory virtual filesystem.
// An in-memory Record<string,string> the agent writes intermediate artifacts
// into. The UI mirrors this so the "deep agent" is visible as it works.

// Provenance marker for a VFS entry. Set when the file's content was produced
// by a recursive llm() call inside execute_js (semantic labelling/summarizing
// over data slices) rather than fetched from a data API. Identity-critical:
// model-derived content must be visibly labelled and must never be presented
// as fetched data (no citation, never in the evidence table).
export interface FileMeta {
  derived?: boolean; // true → content is model-derived, not fetched
  via?: string; // how it was derived, e.g. 'llm'
}

export class VFS {
  files: Record<string, string> = {};
  // Per-path provenance, parallel to `files`. Absent entry = ordinary
  // (non-derived) file. Kept separate so the string content contract of
  // `files` is unchanged for every existing reader.
  meta: Record<string, FileMeta> = {};
  private onChange?: (files: Record<string, string>) => void;

  constructor(onChange?: (files: Record<string, string>) => void) {
    this.onChange = onChange;
  }
  write(path: string, content: string, meta?: FileMeta): void {
    this.files[path] = content;
    if (meta && (meta.derived || meta.via)) this.meta[path] = { ...meta };
    else delete this.meta[path]; // a plain re-write clears any stale marker
    this.onChange?.({ ...this.files });
  }
  read(path: string): string {
    return this.files[path] ?? '';
  }
  list(): string[] {
    return Object.keys(this.files);
  }
}
