// figures.ts — tie the figures in a finding to their lines on the chart.
//
// In the finding sentence, each series' name (and, when one follows directly,
// its "from 67.86 to 83.68 (+23.3%)" figures) is underlined in that series'
// chart colour, so the eye can go from a number in the text to its line
// without a legend. Colour is never the only carrier: the name is in the text.
//
// The finding is untrusted (model- or source-authored) and is rendered by
// `mdToHtml`, which escapes before it formats. This module does not weaken
// that: it never builds HTML from the text. It brackets the matches with
// private-use sentinel characters BEFORE escaping, lets `mdToHtml` do its work,
// and only then swaps the sentinels for a fixed <span>. Any sentinel already
// present in the input is removed first, and if the brackets do not come out
// balanced the text is rendered with no underlines at all.
import { mdToHtml } from "../../../lib/chitti/ui/dom";

const OPEN = "\uE000";
const MID = "\uE001";
const CLOSE = "\uE002";
const SENTINELS = /[\uE000-\uE002]/g;
// How many palette slots exist (`--chart-1` … `--chart-8`).
const SLOTS = 8;

export interface FigureSeries {
  name: string;
  colorIndex?: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The figures that may directly follow a name: "from 1 to 2 (+3%)", optionally
// led by the verb the direct summary uses. Deliberately narrow — digits,
// separators and a short fixed vocabulary — so a match can never swallow prose
// or cross markdown (`*`, backtick, brackets are all excluded).
const TAIL =
  /^(?: (?:rose|fell))? from [\d.,]+(?: in \d{4})? to [\d.,]+(?: in \d{4})?(?: \([+−-][\d.,]+(?:%| percentage points?)\))?/;

// Bracket every whole-word occurrence of a series name. Longest names first, so
// "Guinea" does not claim part of "Papua New Guinea"; overlapping matches lose.
// Text inside a markdown link target is left alone so URLs stay intact. Pure —
// exported for its unit table.
export function markFigures(text: string, series: FigureSeries[]): string {
  const clean = String(text ?? "").replace(SENTINELS, "");
  const named = series
    .map((s, i) => ({ name: (s.name || "").trim(), slot: ((s.colorIndex ?? i) % SLOTS + SLOTS) % SLOTS }))
    .filter((s) => s.name.length >= 2)
    .sort((a, b) => b.name.length - a.name.length);
  if (!named.length) return clean;
  // Split out link targets `](https://…)`; odd parts are targets and are kept verbatim.
  return clean
    .split(/(\]\(https?:\/\/[^\s)]+\))/)
    .map((part, k) => {
      if (k % 2) return part;
      const taken: [number, number, number][] = [];
      for (const s of named) {
        const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s.name)}(?![\\p{L}\\p{N}])`, "gu");
        for (let m = re.exec(part); m; m = re.exec(part)) {
          const start = m.index;
          let end = start + s.name.length;
          const tail = part.slice(end).match(TAIL);
          if (tail) end += tail[0].length;
          if (taken.some(([a, b]) => start < b && end > a)) continue;
          taken.push([start, end, s.slot]);
        }
      }
      taken.sort((a, b) => a[0] - b[0]);
      let out = "";
      let at = 0;
      for (const [a, b, slot] of taken) {
        out += part.slice(at, a) + OPEN + slot + MID + part.slice(a, b) + CLOSE;
        at = b;
      }
      return out + part.slice(at);
    })
    .join("");
}

// Render a finding to HTML with its figures underlined in series colours.
export function findingHtml(text: string, series: FigureSeries[] = []): string {
  const html = mdToHtml(markFigures(text, series));
  const opens = html.match(/\uE000\d\uE001/g)?.length ?? 0;
  const closes = html.match(/\uE002/g)?.length ?? 0;
  const stray = html.replace(/\uE000\d\uE001/g, "").replace(/\uE002/g, "").match(SENTINELS);
  if (opens !== closes || stray) return html.replace(/\uE000\d?\uE001?/g, "").replace(SENTINELS, "");
  return html
    .replace(/\uE000(\d)\uE001/g, (_, d) => `<span class="cx-fig" style="--c:var(--chart-${Number(d) + 1})">`)
    .replace(/\uE002/g, "</span>");
}
