// Pure DOM/string helpers extracted verbatim from the chitti UI monolith.
// No shared mutable state: every function is a pure transform of its args
// (or a thin wrapper over document). Imported by boot.ts and the ui/ modules.
import type { Citation } from '../tools';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function q<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string): T {
  const el = root.querySelector(selector);
  if (!el) throw new Error('Turn block missing expected element: ' + selector);
  return el as T;
}

// HH:MM:SS.d, tenths precision, matching the spec's receipt timestamp style.
export function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const tenths = Math.floor(d.getMilliseconds() / 100);
  return `${hh}:${mm}:${ss}.${tenths}`;
}

// Compact token count, receipt-style: "217" -> "217 tok", "1834" -> "1.8k tok".
export function formatTokens(n: number): string {
  const val = n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  return val + ' tok';
}

// Compact byte count for the nested llm() receipts: "820 B", "4.1 KB".
export function formatBytes(n: number): string {
  return n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
}

export function fileExt(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? 'txt' : path.slice(dot + 1).toLowerCase();
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Minimal HTML escape for values interpolated into the tooltip's HTML
// string (series names, unit, axis label all originate from model/spec text).
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}

export function prefersReducedMotion(): boolean {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

export function esc(s: string): string {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

// The model's answers arrive as markdown (bold, lists, headings). A tiny
// renderer — escape first, then transform — instead of a library: the
// subset the agent actually emits is small and everything is escaped
// before any HTML is introduced, so no injection surface.
export function inlineMd(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

export function mdToHtml(text: string): string {
  const lines = esc(text).split(/\r?\n/);
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let para: string[] = [];
  const flushPara = () => { if (para.length) { out.push('<p>' + inlineMd(para.join(' ')) + '</p>'); para = []; } };
  const flushList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const ul = line.match(/^[-*]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push('<h4>' + inlineMd(h[2]) + '</h4>'); }
    else if (ul) { flushPara(); if (list !== 'ul') { flushList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inlineMd(ul[1]) + '</li>'); }
    else if (ol) { flushPara(); if (list !== 'ol') { flushList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inlineMd(ol[1]) + '</li>'); }
    else { flushList(); para.push(line); }
  }
  flushPara();
  flushList();
  return out.join('');
}

export function fmtShareDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an earlier session';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// The citation ledger (backlog #11): one structured record per distinct live
// fetch, rendered as a references section on a receipt — compact, mono,
// understated. Every field comes straight from the fetch (source, indicator,
// human URL, resolved countries, year range, fetched-at, and — when the
// source gave one — its data vintage). Model-derived (llm()) artifacts never
// reach this list: only fetched data produces a Citation.
export function fmtRange(r: Citation['yearRange']): string {
  if (!r) return 'all years';
  if (r.start !== undefined && r.end !== undefined) return r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`;
  if (r.start !== undefined) return `${r.start}–`;
  if (r.end !== undefined) return `–${r.end}`;
  return 'all years';
}

export function fmtFetchedAt(iso: string): string {
  // Compact "2026-07-19 14:03 UTC" — a receipt timestamp, not a full ISO string.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// A tiny date formatter for cards/tiles ("Jul 21, 2026").
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
