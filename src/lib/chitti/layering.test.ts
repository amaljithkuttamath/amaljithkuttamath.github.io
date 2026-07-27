// The module layering, asserted rather than described.
//
// WHY THIS EXISTS. ARCHITECTURE.md and AGENTS.md both say the layers are kept
// acyclic, and both were wrong: `sources/<adapter> -> tools -> sources/index ->
// sources/<adapter>` had been there for a while. Nothing caught it because a
// runtime import cycle is not a compile error and not a test failure — it only
// shows up as a half-initialised module, and ONLY when the loop is entered
// through the wrong file.
//
// That conditional is what made it expensive. The app enters through tools.ts,
// where the order happens to work, so the site and the whole suite were green
// while `sources/index`'s SOURCES array held `undefined` for anyone who imported
// an adapter file first. The snapshot generator does exactly that, and the bug
// surfaced as a failed workflow run on a CI runner — the slowest, most opaque
// place to learn about a broken import.
//
// A prose convention cannot prevent that; this can. It walks the real import
// graph and fails on any cycle, in CI, on every push.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    // Tests are excluded: a test may legitimately import anything, and a cycle
    // through one cannot break the shipped app.
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // package or data import
  const base = resolve(dirname(from), spec);
  for (const candidate of [base + '.ts', join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

// Only RUNTIME edges. `import type` / `export type` are erased by the compiler
// and so cannot contribute to an initialisation-order failure — counting them
// would flag the type-only dependencies that are the correct way to reference a
// shape across layers.
function runtimeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^;]*?from\s+'([^']+)'/gm)) {
    const t = resolveSpec(file, m[1]);
    if (t && t !== file) found.add(t);
  }
  for (const m of src.matchAll(/^\s*import\s+'([^']+)'/gm)) {
    const t = resolveSpec(file, m[1]);
    if (t && t !== file) found.add(t);
  }
  return [...found];
}

function findCycles(files: string[]): string[][] {
  const graph = new Map(files.map((f) => [f, runtimeImports(f)]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (n: string) => {
    state.set(n, 1);
    stack.push(n);
    for (const m of graph.get(n) ?? []) {
      if (state.get(m) === 1) cycles.push([...stack.slice(stack.indexOf(m)), m]);
      else if (!state.get(m)) visit(m);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const f of files) if (!state.get(f)) visit(f);
  return cycles;
}

describe('module layering', () => {
  const files = sourceFiles(ROOT);
  const short = (p: string) => relative(ROOT, p);

  it('has no runtime import cycles', () => {
    const cycles = findCycles(files);
    expect(
      cycles.length,
      cycles.length
        ? 'runtime import cycle(s):\n' + cycles.map((c) => '  ' + c.map(short).join(' → ')).join('\n')
        : ''
    ).toBe(0);
  });

  it('keeps the source adapters off the tools facade', () => {
    // The specific shape of the cycle that reached production. tools.ts
    // re-exports ./sources, so any runtime import from an adapter back into it
    // closes the loop. Shared tables and types belong in ./core, which imports
    // nothing from the app. Stated separately from the general check so the
    // failure names the fix.
    const toolsPath = join(ROOT, 'tools.ts');
    const offenders = files
      .filter((f) => f.startsWith(join(ROOT, 'sources')))
      .filter((f) => runtimeImports(f).includes(toolsPath))
      .map(short);
    expect(offenders, `these must import from ../core, not ../tools: ${offenders.join(', ')}`)
      .toEqual([]);
  });

  it('found the real graph, not an empty one', () => {
    // A guard on the guard: if the walker or the import regex ever silently
    // stops matching, both checks above would pass vacuously.
    expect(files.length).toBeGreaterThan(40);
    expect(files.filter((f) => runtimeImports(f).length > 0).length).toBeGreaterThan(20);
  });
});
