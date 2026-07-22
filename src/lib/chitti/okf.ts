// okf.ts — export one Chitti answer as a Google Open Knowledge Format (OKF)
// v0.1 "concept": YAML front matter (a non-empty `type`, the okf_version, and
// provenance) followed by a grounded Markdown body whose data sources are
// expressed as standard Markdown links. Ported in spirit from langchain-ai/
// openwiki, adapted to Chitti's domain: the exported concept is a *finding*
// (question → answer → chart → citations → verification), not a doc page.
//
// Pure and offline-testable — no DOM, no network, no module state. The UI wraps
// this string into a clipboard copy / file download; nothing here knows how it
// is delivered. This is the one place the OKF shape is defined, so the format
// can never drift between what's tested and what's copied.
import type { ChartSpec, Citation } from './tools';
import type { VerificationVerdict } from './verifier';

export interface OkfFindingInput {
  question: string;
  finding: string;
  spec: ChartSpec | null;
  citations: Citation[];
  verification: VerificationVerdict | null;
  // ISO timestamp for the front-matter `created` field. Passed in (never
  // Date.now() here) so the output is deterministic and unit-testable.
  createdAt: string;
}

// One YAML scalar, always double-quoted and escaped, kept to a single line so a
// stray newline/quote in model text can't break the front matter.
function yamlStr(s: string): string {
  const clean = String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return `"${clean}"`;
}

// Collapse to a single trimmed line — for the H1 title and front-matter title.
function oneLine(s: string): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function fmtCountries(codes: string[]): string {
  return codes && codes.length ? codes.join(', ') : 'all countries';
}

function fmtYearRange(yr: Citation['yearRange']): string {
  if (!yr || (yr.start === undefined && yr.end === undefined)) return 'all years';
  if (yr.start !== undefined && yr.end !== undefined) return `${yr.start}–${yr.end}`;
  if (yr.start !== undefined) return `since ${yr.start}`;
  return `through ${yr.end}`;
}

// The verification line, mirroring the app's own honest states. Never claims a
// pass the verdict didn't assert.
function verificationLine(v: VerificationVerdict): string {
  const label =
    v.status === 'verified'
      ? 'Verified'
      : v.status === 'unverified'
        ? 'Not verified'
        : v.status === 'unavailable'
          ? 'Verification unavailable'
          : 'Not verified';
  const conf = v.confidence && v.confidence !== 'none' ? ` · verifier confidence: ${v.confidence}` : '';
  return label + conf;
}

// Build the OKF v0.1 Markdown concept for one finding. Deterministic given its
// input. Omits sections that have no content (no chart on an explanation turn,
// no citations on a prose answer) rather than emitting empty headers.
export function buildFindingOkf(input: OkfFindingInput): string {
  const title = oneLine(input.question) || oneLine(input.finding).slice(0, 80) || 'Chitti finding';
  const sources = [...new Set((input.citations ?? []).map((c) => c.sourceLabel).filter(Boolean))];

  // ── Front matter ──────────────────────────────────────────────────────
  const fm: string[] = ['---', 'okf_version: "0.1"', 'type: "finding"', `title: ${yamlStr(title)}`, `created: ${yamlStr(input.createdAt)}`, 'producer: "chitti"'];
  if (sources.length) {
    fm.push('sources:');
    for (const s of sources) fm.push(`  - ${yamlStr(s)}`);
  }
  if (input.verification && input.verification.status === 'verified') fm.push('verified: true');
  else if (input.verification && input.verification.status === 'unverified') fm.push('verified: false');
  fm.push('---');

  // ── Body ──────────────────────────────────────────────────────────────
  const body: string[] = [`# ${title}`, ''];
  const finding = input.finding?.trim();
  body.push(finding || '_No finding was produced for this question._', '');

  if (input.spec) {
    const seriesNames = input.spec.series.map((s) => s.name).filter(Boolean).join(', ');
    body.push('## Chart', '');
    body.push(`**${oneLine(input.spec.title) || 'Chart'}** — ${input.spec.type} chart.`);
    if (seriesNames) body.push('', `Series: ${seriesNames}.`);
    const axes = [input.spec.x_axis ? `x: ${oneLine(input.spec.x_axis)}` : '', input.spec.y_axis ? `y: ${oneLine(input.spec.y_axis)}` : '']
      .filter(Boolean)
      .join(' · ');
    if (axes) body.push('', axes + '.');
    body.push('');
  }

  if (input.citations && input.citations.length) {
    body.push('## Data sources', '');
    for (const c of input.citations) {
      const name = c.indicatorName || c.indicatorId;
      const facets = [
        c.sourceLabel,
        fmtCountries(c.countries),
        fmtYearRange(c.yearRange),
        c.sourceUpdated ? `source updated ${c.sourceUpdated}` : '',
        c.fetchedAt ? `fetched ${c.fetchedAt}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      // The link points to the human-visitable canonical page (c.url).
      body.push(`- [${name} (${c.indicatorId})](${c.url}) — ${facets}`);
    }
    body.push('');
  }

  if (input.verification) {
    body.push('## Verification', '', verificationLine(input.verification));
    const issues = (input.verification.issues ?? []).filter(Boolean);
    if (issues.length) {
      body.push('');
      for (const issue of issues) body.push(`- ${issue}`);
    }
    body.push('');
  }

  // Trailing single newline; collapse any accidental 3+ blank runs to one.
  return (fm.join('\n') + '\n\n' + body.join('\n')).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}
