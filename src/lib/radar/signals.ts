import { escapeHTML as esc, filterRows, type Row } from "./data";
export const thresholds = [0, 3, 4] as const;
export function signalCells(rows: Row[]) {
  return [...new Set(rows.map((r) => r.group))].sort().flatMap((group) =>
    thresholds.map((minimum) => ({
      group,
      minimum,
      rows: filterRows(rows, "", group).filter((r) => r.score >= minimum),
    })),
  );
}
export function mountSignals(
  rows: Row[],
  onExplore: (group: string, minimum: number) => void,
) {
  const host = document.getElementById("signal-workspace");
  if (!host) return;
  const total = document.getElementById("signal-total")!;
  total.textContent = `Current feed / ${rows.length} observations`;
  const cells = signalCells(rows);
  if (!rows.length) {
    host.innerHTML =
      '<p class="signal-wait">No observations yet. The briefing and archive remain available below.</p>';
    return;
  }
  let selected = cells.findIndex((c) => c.minimum === 4 && c.rows.length > 0);
  if (selected < 0) selected = 0;
  let cursor = 0;
  const groups = [...new Set(cells.map((c) => c.group))];
  const max = Math.max(...cells.map((c) => c.rows.length), 1);
  host.innerHTML = `<div class="signal-layout"><div><table class="signal-map"><thead><tr><th scope="col">Source</th><th scope="col">All</th><th scope="col">3+</th><th scope="col">4+</th></tr></thead><tbody>${groups
    .map(
      (group) =>
        `<tr><th scope="row">${esc(group)}</th>${cells
          .filter((c) => c.group === group)
          .map(
            (c) =>
              `<td><button type="button" data-cell="${cells.indexOf(c)}" aria-label="${esc(c.group)}, ${c.minimum ? `score ${c.minimum} or higher` : "all scores"}, ${c.rows.length} items" aria-pressed="false" style="--density:${8 + (20 * c.rows.length) / max}%" ${c.rows.length ? "" : "disabled"}>${c.rows.length}</button></td>`,
          )
          .join("")}</tr>`,
    )
    .join(
      "",
    )}</tbody></table></div><div class="signal-inspector"><div class="signal-inspector-head"><p id="signal-selection"></p><div class="signal-stepper"><button type="button" id="signal-prev" aria-label="Previous observation">←</button><span id="signal-position"></span><button type="button" id="signal-next" aria-label="Next observation">→</button></div></div><div class="signal-item" id="signal-item" aria-live="polite"></div></div></div><div class="signal-footer"><p>Counts are cumulative. 3+ and 4+ narrow the same source. Scores come from the pipeline’s evidence criteria, not a quality verdict.</p><button type="button" id="signal-explore">Explore this selection</button></div>`;
  const render = () => {
    const cell = cells[selected],
      row = cell.rows[cursor];
    host
      .querySelectorAll<HTMLButtonElement>("[data-cell]")
      .forEach((b) =>
        b.setAttribute(
          "aria-pressed",
          String(Number(b.dataset.cell) === selected),
        ),
      );
    document.getElementById("signal-selection")!.textContent =
      `${cell.group} / ${cell.minimum ? `score ${cell.minimum}+` : "all scores"}`;
    document.getElementById("signal-position")!.textContent =
      `${cursor + 1} / ${cell.rows.length}`;
    (document.getElementById("signal-prev") as HTMLButtonElement).disabled =
      cursor === 0;
    (document.getElementById("signal-next") as HTMLButtonElement).disabled =
      cursor === cell.rows.length - 1;
    const [name, ...description] =
      row.group === "Code" ? row.title.split(" — ") : [row.title];
    document.getElementById("signal-item")!.innerHTML =
      `<h3>${esc(name)}</h3>${description.length ? `<p class="signal-description">${esc(description.join(" — "))}</p>` : ""}<dl><div><dt>Evidence score</dt><dd>${row.score}/5</dd></div><div><dt>First observed</dt><dd>${esc(row.firstSeen || "Unavailable")}</dd></div></dl><a href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">Open original source ↗</a><p class="signal-note">Observed ${esc(row.lastSeen || "date unavailable")} · ${esc(new URL(row.url).hostname)}</p>`;
  };
  host.querySelectorAll<HTMLButtonElement>("[data-cell]").forEach((b) =>
    b.addEventListener("click", () => {
      selected = Number(b.dataset.cell);
      cursor = 0;
      render();
    }),
  );
  document.getElementById("signal-prev")!.addEventListener("click", () => {
    if (cursor > 0) {
      cursor--;
      render();
    }
  });
  document.getElementById("signal-next")!.addEventListener("click", () => {
    if (cursor < cells[selected].rows.length - 1) {
      cursor++;
      render();
    }
  });
  document
    .getElementById("signal-explore")!
    .addEventListener("click", () =>
      onExplore(cells[selected].group, cells[selected].minimum),
    );
  render();
}
