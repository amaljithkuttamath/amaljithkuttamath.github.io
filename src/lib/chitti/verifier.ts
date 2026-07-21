// verifier.ts — the second-LLM verifier that judges whether the chart + finding
// answer the question, plus the defensive verdict parser. Returns one of three
// honest outcomes (VerifyStatus) and NEVER defaults to verified. parseVerifierVerdict
// and the types are exported (tests + UI); verify() is used by the session loop.
import {
  complete,
  estimateCost,
  type ChatMessage,
  type CompleteDeps,
  type ProviderConfig,
} from './providers';
import type { ChartSpec, Citation } from './tools';
import { extractJsonObject } from './parse-json';

// The honest verification outcomes. 'skipped' is the empty-run state: the turn
// produced no answer, chart, or fetched rows, so verify() was NEVER called (no
// LLM spend, no verdict retry) — distinct from 'unavailable' (the verify call
// itself failed) and never implying the answer was verified.
export type VerifyStatus = 'verified' | 'unverified' | 'unavailable' | 'skipped';

// The verifier's verdict as it leaves verify()/reaches the UI. `pass` is true
// only when status==='verified' — the two are kept in lockstep so a caller can
// never read a truthy pass out of an unavailable/unverified verdict.
export interface VerificationVerdict {
  status: VerifyStatus;
  pass: boolean;
  confidence: 'high' | 'medium' | 'low' | 'none';
  issues: string[];
  report: string;
  tokens?: number;
}

// The shape parseVerifierVerdict extracts from the verifier's raw text. `null`
// from the parser means "could not be parsed" — the caller treats that as
// could-not-verify (never verified, never fabricated issues).
export interface ParsedVerdict {
  pass: boolean;
  confidence: 'high' | 'medium' | 'low';
  issues: string[];
}

// Parse the verifier's raw text into a structured verdict, DEFENSIVELY. The
// contract, in priority order:
//   1. A JSON object {pass:bool, confidence:'high'|'medium'|'low', issues:[str]}
//      — accepted only when ALL three fields are the right shape. A present-but-
//      malformed JSON verdict returns null (could-not-verify) rather than a
//      half-guessed one: we never invent a pass or fabricate issues.
//   2. Legacy "PASS: …" / "FAIL: …" prefix (the pre-structured format, still
//      emitted by older prompts and exercised by the existing tests). PASS →
//      pass with high confidence; FAIL → not-pass, low confidence, the reason
//      text kept as the single issue.
//   3. Anything else (empty, or neither JSON nor a PASS/FAIL prefix) → null.
// A null return ALWAYS means could-not-verify; it never means verified.
export function parseVerifierVerdict(raw: string): ParsedVerdict | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  const json = extractJsonObject(text);
  if (json) {
    const pass = typeof json.pass === 'boolean' ? json.pass : null;
    const conf = json.confidence;
    const confOk = conf === 'high' || conf === 'medium' || conf === 'low';
    const issues = Array.isArray(json.issues)
      ? (json.issues as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
      : null;
    // Every field must be well-formed. A partial object is could-not-verify.
    if (pass !== null && confOk && issues !== null) {
      return { pass, confidence: conf as 'high' | 'medium' | 'low', issues };
    }
    return null;
  }

  if (/^\s*PASS\b/i.test(text)) {
    return { pass: true, confidence: 'high', issues: [] };
  }
  if (/^\s*FAIL\b/i.test(text)) {
    const reason = text.replace(/^\s*FAIL\s*:?\s*/i, '').trim();
    return { pass: false, confidence: 'low', issues: reason ? [reason] : [] };
  }
  return null;
}

// ── Verifier: a second LLM call judging whether the chart answers the question.
// It returns one of three honest outcomes (see VerifyStatus). It NEVER defaults
// to verified: a provider error is 'unavailable', an unparseable verdict is
// 'unverified' (could-not-verify), and only a genuine parsed pass is 'verified'.
export async function verify(
  cfg: ProviderConfig,
  question: string,
  spec: ChartSpec | null,
  finding: string,
  citations: Citation[],
  addCost: (c: number) => void,
  deps: CompleteDeps = {},
  insight?: string
): Promise<VerificationVerdict> {
  const specText = spec ? JSON.stringify({ type: spec.type, title: spec.title, series: spec.series.map((s) => ({ name: s.name, points: s.data.length })) }) : 'NO CHART RENDERED';
  // The ledger's own entries — truthful source, indicator, URL and vintage,
  // straight from the fetch (not reconstructed). Gives the verifier real
  // provenance to check the finding against.
  const citeText = citations.length
    ? citations
        .map((c) => `${c.sourceLabel}: ${c.indicatorName} (${c.indicatorId}) ${c.url}${c.sourceUpdated ? ` [updated ${c.sourceUpdated}]` : ''}`)
        .join('\n')
    : '(no live data fetched)';
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You are a strict verifier. Given a user question, a rendered chart spec, a one-line finding, and the ' +
        'citation ledger, judge whether the chart and finding actually answer the question and are supported by ' +
        'the cited sources.' +
        (insight
          ? ' The analysis committed up front to a specific intended insight; also judge whether the answer ' +
            'actually SHOWS what it set out to show — a chart/finding that drifts from the intended insight is a real problem.'
          : '') +
        '\n\n' +
        'Respond with ONLY a JSON object, no prose, no code fences:\n' +
        '{"pass": true|false, "confidence": "high"|"medium"|"low", "issues": ["..."]}\n\n' +
        '- pass=false ONLY for real problems: wrong indicator, no data, chart type mismatched to the question, a ' +
        'number in the finding not supported by the sources, a claim with no citation' +
        (insight ? ', or an answer that does not deliver the intended insight' : '') +
        '.\n' +
        '- confidence: how sure you are of THIS verdict.\n' +
        '- issues: one short concrete sentence per real problem, naming WHAT is doubted (claim vs source mismatch, ' +
        'missing citation, number not found in the data' +
        (insight ? ', insight not delivered' : '') +
        '). Use an empty array when pass=true.',
    },
    {
      role: 'user',
      content:
        `Question: ${question}\n\n` +
        (insight ? `Intended insight: ${insight}\n\n` : '') +
        `Chart spec: ${specText}\n\nFinding: ${finding || '(none)'}\n\nSources (citation ledger):\n${citeText}`,
    },
  ];
  try {
    const res = await complete(cfg, messages, [], deps);
    addCost(estimateCost(res.servedModel ?? cfg.model, res.usage));
    const text = res.text.trim();
    const tokens = res.usage.input + res.usage.output;
    const parsed = parseVerifierVerdict(text);
    if (!parsed) {
      // The call succeeded but its verdict is unparseable — could-not-verify.
      // Honest: not verified, and NO fabricated issues (we don't know what was
      // wrong, only that we couldn't read the verdict).
      return {
        status: 'unverified',
        pass: false,
        confidence: 'low',
        issues: [],
        report: text || 'Verifier returned an unreadable verdict — could not verify.',
        tokens,
      };
    }
    return {
      status: parsed.pass ? 'verified' : 'unverified',
      pass: parsed.pass,
      confidence: parsed.confidence,
      issues: parsed.issues,
      report: text || (parsed.pass ? 'PASS' : 'FAIL'),
      tokens,
    };
  } catch (err: any) {
    // The verify call itself failed (network/provider error). Verification is
    // UNAVAILABLE — we say so plainly and NEVER imply the answer was verified.
    return {
      status: 'unavailable',
      pass: false,
      confidence: 'none',
      issues: [],
      report: 'verification unavailable — provider error: ' + (err?.message ?? String(err)),
    };
  }
}
