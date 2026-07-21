// Answer-share + clipboard actions: build a #share= permalink for a turn and
// copy it (async clipboard with a select-all fallback). Extracted verbatim.
// Pure of shared mutable state; encodeShareState comes from share.ts.
import type { TurnBlock } from './state';
import { encodeShareState } from '../share';

// ── Share permalink (backlog #15) ────────────────────────────────────────
// Encode this turn's answer state into a #share= fragment, build an absolute
// URL, and copy it to the clipboard (with a select-all fallback). All strings
// in the payload come from the turn's own captured state; keys/trace/VFS are
// never included (the whitelist encoder in share.ts guarantees it).
export function announceShare(tb: TurnBlock, msg: string, isError = false) {
  tb.shareStatus.textContent = msg;
  tb.shareStatus.classList.toggle('ch-share-status-error', isError);
  if (msg && !isError) {
    window.setTimeout(() => {
      if (tb.shareStatus.textContent === msg) tb.shareStatus.textContent = '';
    }, 2600);
  }
}

// Build the shareable URL for a turn's captured state, or null if the answer
// is too large even after dropping rows. Returned to the click handler (which
// copies it) and to the offline harness (which reads it without a clipboard).
export async function buildShareUrl(tb: TurnBlock): Promise<{ url: string; lossy: boolean } | null> {
  const enc = await encodeShareState({
    question: tb.question,
    answer: tb.lastFinding,
    spec: tb.lastSpec,
    rows: tb.lastRows,
    citations: tb.lastCitations,
    verification: tb.lastVerification,
    ts: new Date().toISOString(),
  });
  if (!enc.ok) return null;
  return { url: location.origin + location.pathname + '#share=' + enc.payload, lossy: enc.lossy };
}

export async function shareTurn(tb: TurnBlock) {
  const built = await buildShareUrl(tb);
  if (!built) {
    announceShare(tb, 'answer too large to share as a link — use CSV export', true);
    return;
  }
  const note = built.lossy ? ' (chart only; rows omitted for size)' : '';
  await copyToClipboard(tb, built.url, 'Link copied' + note);
}

// The async-clipboard write, feature-guarded. true on success; false when the
// API is unavailable/refused (headless, insecure context) so the caller can
// fall back to a selectable input. Never throws.
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the manual-copy fallback */
  }
  return false;
}

// Drop a selectable, read-only input holding `text` into `wrap` and try
// execCommand('copy'); announce success or a manual-copy hint via `announce`.
// Shared fallback for both the answer-share and dashboard-share copy paths.
export function clipboardFallback(wrap: HTMLElement, text: string, okMsg: string, announce: (m: string) => void) {
  wrap.textContent = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.readOnly = true;
  input.value = text;
  input.className = 'ch-share-fallback';
  input.setAttribute('aria-label', 'Shareable link — copy this');
  wrap.appendChild(input);
  input.focus();
  input.select();
  try {
    document.execCommand('copy');
    announce(okMsg);
  } catch {
    announce('copy the link above');
  }
}

export async function copyToClipboard(tb: TurnBlock, text: string, okMsg: string) {
  if (await writeClipboard(text)) {
    announceShare(tb, okMsg);
    return;
  }
  clipboardFallback(tb.shareStatus, text, okMsg, (m) => announceShare(tb, m));
}
