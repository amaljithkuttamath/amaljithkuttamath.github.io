// Pure accessibility helpers for the Chitti app UI.
//
// Kept dependency-free and DOM-free on purpose: the string/label/index logic
// that a screen reader or a focus trap depends on is the part worth testing,
// so it lives here as pure functions. The .astro file wires these thin outputs
// into the DOM (set an aria-label, move focus) and keeps that wiring minimal.

import type { ChartSpec } from './tools';
import type { VerifyStatus } from './agent';

// ── Chart aria-label ─────────────────────────────────────────────────────
// An ECharts canvas is opaque to assistive tech — there is nothing under it to
// read. So the chart's region carries a text summary instead: what kind of
// chart, what it plots (title), the y-axis unit, and how many series (named,
// capped so a twenty-line chart doesn't narrate a paragraph).
const CHART_TYPE_NAME: Record<ChartSpec['type'], string> = {
  line: 'Line chart',
  bar: 'Bar chart',
  'grouped-bar': 'Grouped bar chart',
  scatter: 'Scatter plot',
};

export function chartAriaLabel(
  spec: Pick<ChartSpec, 'type' | 'title' | 'y_axis' | 'series'>
): string {
  const typeName = CHART_TYPE_NAME[spec.type] || 'Chart';
  const parts: string[] = [];
  const title = (spec.title || '').trim();
  parts.push(title ? `${typeName}: ${title}` : typeName);

  const unit = (spec.y_axis || '').trim();
  if (unit) parts.push(unit);

  const names = (spec.series || []).map((s) => (s?.name || '').trim()).filter(Boolean);
  const n = (spec.series || []).length;
  if (n === 1) {
    parts.push(names[0] ? `1 series: ${names[0]}` : '1 series');
  } else if (n > 1) {
    const shown = names.slice(0, 6);
    const extra = names.length - shown.length;
    const list = shown.length
      ? ': ' + shown.join(', ') + (extra > 0 ? `, and ${extra} more` : '')
      : '';
    parts.push(`${n} series${list}`);
  }
  return parts.join('. ') + '.';
}

// ── Verification text equivalents ─────────────────────────────────────────
// The amber VERIFIED stamp and the muted "could not verify" tag carry meaning
// in styling a screen reader can't perceive; these give each a plain-text
// equivalent. The stamp label is spoken in place of its rubber-stamp glyph;
// the cue text is the exact string the answer-level tag renders (and the
// verifier receipt reuses for its verdict line), so the two never drift.

export function verificationStampLabel(): string {
  return 'Verified: this answer passed a second-model check.';
}

// The confidence line shown on a verify receipt. This is the VERIFIER's
// confidence in ITS OWN verdict, not the finding's — so it is labelled
// "verifier confidence" to keep it from reading as answer confidence. Pure, so
// the label is asserted without a DOM. 'none'/absent → "unknown".
export function verifierConfidenceLabel(
  confidence: 'high' | 'medium' | 'low' | 'none' | undefined
): string {
  return confidence && confidence !== 'none'
    ? 'verifier confidence: ' + confidence
    : 'verifier confidence: unknown';
}

// The three honest states, keyed off the structured verdict (never a defaulted
// pass). Returns null when there is nothing to say (verified, or no verdict) —
// the caller hides the cue entirely in that case.
export function verificationCueText(
  v: { status: VerifyStatus; issues?: string[] } | null | undefined
): string | null {
  // Nothing to say when verified, when there is no verdict, or when the run was
  // empty (skipped) — the empty-run "nothing to verify" note lives in the trace.
  if (!v || v.status === 'verified' || v.status === 'skipped') return null;
  if (v.status === 'unavailable') return 'verification unavailable — provider error';
  const reason = v.issues && v.issues.length ? v.issues[0] : 'the finding could not be confirmed';
  return 'could not verify — ' + reason;
}

// ── Focus trap ────────────────────────────────────────────────────────────
// The config sheet is a modal dialog: while it is open, Tab must cycle within
// it. This computes the next index to focus given where focus is now, the
// number of focusable elements in the sheet, and the Tab direction — returning
// null when the browser's own default Tab handling already keeps focus inside
// (i.e. not at an edge). The DOM wrapper only has to read the active index,
// call this, and preventDefault + focus when a number comes back.
export function focusTrapTarget(
  activeIndex: number,
  count: number,
  backward: boolean
): number | null {
  if (count <= 0) return null;
  if (backward) {
    // Shift+Tab off the first element (or from outside) wraps to the last.
    return activeIndex <= 0 ? count - 1 : null;
  }
  // Tab off the last element (or from outside) wraps to the first.
  return activeIndex === -1 || activeIndex >= count - 1 ? 0 : null;
}

// Elements a keyboard user can land on. Excludes tabindex="-1" (programmatic
// focus only) and disabled controls. Used by the sheet's focus trap.
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
