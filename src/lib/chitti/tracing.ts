// tracing.ts — optional LangSmith tracing for a completed turn.
//
// Chitti already streams a per-turn `TraceEvent` timeline to the user; this maps
// that same stream into a LangSmith **run tree** (one root "chain" run per turn,
// one child run per tool/LLM step) and POSTs it to LangSmith's batch-ingest API.
//
// PRIVACY / SECURITY (why this is shaped the way it is):
//   Chitti is a zero-backend static site. A LangSmith API key must NEVER reach
//   the browser — inlining it into the public build would expose it, and
//   LangSmith's ingest isn't browser-CORS-open anyway. So the exporter POSTs to
//   a same-origin RELAY path (default `/langsmith/...`); the relay holds the key
//   server-side and forwards to LangSmith. In dev that relay is the Vite
//   dev-server proxy (astro.config.mjs) reading LANGSMITH_API_KEY from a local,
//   gitignored .env. Tracing is OFF unless `PUBLIC_LANGSMITH_TRACING === '1'` at
//   build time, so the shipped site sends nothing by default.
//
// The run-tree builder (`buildTurnRuns`) is pure and unit-tested; the exporter
// (`exportTurnTrace`) is a fire-and-forget wrapper that never throws into a turn.
import type { TraceEvent } from './receipts';

// A minimal LangSmith run (batch-ingest `post` entry). Only the fields LangSmith
// needs to nest + display a run tree; extra keys are ignored by the API.
export interface LangsmithRun {
  id: string;
  trace_id: string;
  name: string;
  run_type: 'chain' | 'llm' | 'tool' | 'parser' | 'retriever' | 'prompt';
  start_time: string; // ISO-8601
  end_time: string; // ISO-8601
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  parent_run_id?: string;
  dotted_order: string;
  session_name: string; // the LangSmith project
  extra?: { metadata?: Record<string, unknown> };
  tags?: string[];
  error?: string;
}

export interface TurnTraceInput {
  question: string;
  trace: TraceEvent[];
  model: string;
  provider: string;
  finding?: string;
  verification?: { status?: string; confidence?: string; issues?: string[] } | null;
  cost?: number;
  aborted?: boolean;
  error?: string;
  startedAt: number; // epoch ms — turn start
  endedAt: number; // epoch ms — turn end
}

export interface BuildOpts {
  project: string;
  // Injected so tests are deterministic; the real caller passes crypto.randomUUID.
  idFor: (seed: string) => string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

// A dotted_order segment: `<YYYYMMDDTHHMMSS><6-digit seq>Z<id>`. LangSmith orders
// and nests runs by dotted_order (lexical); a child's is the parent's + '.' +
// its own segment. We drive the microsecond field off a monotonic `seq` (not the
// real sub-second, which we only have to ms) so sibling order is always exact —
// real timing still rides on start_time/end_time.
function seg(ms: number, sequence: number, id: string): string {
  const d = new Date(ms);
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const stamp =
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${stamp}${String(sequence).padStart(6, '0')}Z${id}`;
}

// Map a Chitti receipt tool name to a LangSmith run_type. Model-facing steps are
// 'llm'; everything else the agent *does* is a 'tool'.
function runTypeFor(tool: string): LangsmithRun['run_type'] {
  if (tool === 'reasoning' || tool === 'verify') return 'llm';
  if (tool === 'plan') return 'chain';
  return 'tool';
}

// Build the LangSmith batch payload (`{ post: [...] }`) for one completed turn:
// a root chain run + one child run per trace event. Pure + deterministic given
// its input and `idFor`. Empty trace still yields the root run.
export function buildTurnRuns(input: TurnTraceInput, opts: BuildOpts): { post: LangsmithRun[] } {
  const rootId = opts.idFor('root');
  const rootDotted = seg(input.startedAt, 0, rootId);

  const root: LangsmithRun = {
    id: rootId,
    trace_id: rootId,
    name: 'chitti.turn',
    run_type: 'chain',
    start_time: iso(input.startedAt),
    end_time: iso(input.endedAt),
    inputs: { question: input.question },
    outputs: {
      ...(input.finding ? { finding: input.finding } : {}),
      ...(input.verification ? { verification: input.verification } : {}),
      aborted: !!input.aborted,
    },
    dotted_order: rootDotted,
    session_name: opts.project,
    extra: {
      metadata: {
        model: input.model,
        provider: input.provider,
        ...(input.cost !== undefined ? { cost_usd: input.cost } : {}),
        steps: input.trace.length,
      },
    },
    tags: ['chitti', input.provider],
    ...(input.error ? { error: input.error } : {}),
  };

  const children: LangsmithRun[] = input.trace.map((ev, i) => {
    const id = opts.idFor('ev' + i);
    const start = ev.ts;
    // Prefer a measured duration; else run to the next event; else the turn end.
    const end = ev.durationMs ? ev.ts + ev.durationMs : input.trace[i + 1]?.ts ?? input.endedAt;
    const metadata: Record<string, unknown> = { status: ev.status };
    if (ev.tokens !== undefined) metadata.tokens = ev.tokens;
    if (ev.verifyStatus) metadata.verify_status = ev.verifyStatus;
    if (ev.confidence) metadata.confidence = ev.confidence;
    if (ev.issues && ev.issues.length) metadata.issues = ev.issues;
    if (ev.receipt?.topMatch) metadata.top_match = ev.receipt.topMatch.name;
    return {
      id,
      trace_id: rootId,
      name: ev.tool,
      run_type: runTypeFor(ev.tool),
      start_time: iso(start),
      end_time: iso(Math.max(start, end)),
      inputs: ev.argSummary ? { args: ev.argSummary } : {},
      outputs: ev.detail ? { detail: ev.detail } : {},
      parent_run_id: rootId,
      dotted_order: rootDotted + '.' + seg(start, i + 1, id),
      session_name: opts.project,
      extra: { metadata },
      ...(ev.status === 'error' ? { error: ev.detail || 'error' } : {}),
    };
  });

  return { post: [root, ...children] };
}

// ── Config + exporter (browser side; a no-op unless explicitly enabled) ──────

export interface TracingConfig {
  enabled: boolean;
  ingestUrl: string; // same-origin relay by default; the relay holds the key
  project: string;
}

// Read tracing config from build-time PUBLIC_ env (safe to inline — no secret).
// The KEY is never here: it lives only in the relay (dev proxy / serverless fn).
export function tracingConfig(env: Record<string, unknown> = import.meta.env as Record<string, unknown>): TracingConfig {
  return {
    enabled: env.PUBLIC_LANGSMITH_TRACING === '1' || env.PUBLIC_LANGSMITH_TRACING === true,
    ingestUrl: typeof env.PUBLIC_LANGSMITH_INGEST_URL === 'string' && env.PUBLIC_LANGSMITH_INGEST_URL
      ? (env.PUBLIC_LANGSMITH_INGEST_URL as string)
      : '/langsmith/runs/batch',
    project: typeof env.PUBLIC_LANGSMITH_PROJECT === 'string' && env.PUBLIC_LANGSMITH_PROJECT
      ? (env.PUBLIC_LANGSMITH_PROJECT as string)
      : 'chitti',
  };
}

// Fire-and-forget: build the run tree and POST it to the relay. Guarded on the
// enable flag and wrapped so a tracing failure can NEVER break or slow a turn.
export async function exportTurnTrace(input: TurnTraceInput): Promise<void> {
  const cfg = tracingConfig();
  if (!cfg.enabled) return;
  try {
    const idFor = () =>
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : 'run-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const payload = buildTurnRuns(input, { project: cfg.project, idFor });
    await fetch(cfg.ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true, // still sent if the tab is closing
    });
  } catch {
    /* tracing is best-effort — never surface into the turn */
  }
}
