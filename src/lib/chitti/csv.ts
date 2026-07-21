// csv.ts — CSV read/write helpers shared across the data layer.
//   parseCsvLine  — a minimal quoted-cell parser (used by the OWID fetcher to
//                   read grapher CSV, whose entity names contain commas).
//   rowsToCSV     — build the download-button CSV from fetched DataRows.

import type { DataRow } from './tools';

// Minimal CSV parser: handles quoted cells (OWID entity names contain
// commas, e.g. "Korea, Rep."). Good enough for machine-generated CSV.
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Build CSV from data rows for the download button.
export function rowsToCSV(rows: DataRow[]): string {
  const multi = new Set(rows.map((r) => r.indicator ?? '')).size > 1;
  const header = multi ? 'indicator,country,iso3,year,value' : 'country,iso3,year,value';
  const body = rows
    .map((r) =>
      (multi ? `${csvCell(r.indicator ?? '')},` : '') +
      `${csvCell(r.country)},${r.iso3},${r.year},${r.value ?? ''}`
    )
    .join('\n');
  return header + '\n' + body;
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
