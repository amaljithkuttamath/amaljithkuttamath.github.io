import { escapeHTML as esc, type Row } from "./data";
import {
  researchField,
  nearestPoint,
  directionalPoint,
  FIELD_WIDTH,
  FIELD_HEIGHT,
  type FieldMode,
  type FieldPoint,
} from "./field";
const cleanups = new WeakMap<HTMLElement, () => void>();
export function mountSignals(
  rows: Row[],
  onExplore: (group: string, minimum: number) => void,
) {
  const host = document.getElementById("signal-workspace");
  if (!host) return;
  cleanups.get(host)?.();
  document.getElementById("signal-total")!.textContent =
    `Current feed / ${rows.length} observations`;
  if (!rows.length) {
    host.innerHTML =
      '<p class="signal-wait">No observations yet. The briefing and archive remain available below.</p>';
    return;
  }
  let mode: FieldMode = "source",
    field = researchField(rows, mode),
    selected = field.points[0].row.id,
    movingUntil = 0;
  const ids = new Map(rows.map((row, i) => [row.id, `signal-dot-${i}`]));
  host.innerHTML = `<div class="signal-layout"><div class="signal-canvas"><div class="signal-modes" role="group" aria-label="Arrange observations"><button type="button" data-arrangement="source" aria-pressed="true">By source</button><button type="button" data-arrangement="score" aria-pressed="false">By score</button><span>Size = evidence score</span></div><svg class="signal-field" viewBox="0 0 ${FIELD_WIDTH} ${FIELD_HEIGHT}" role="listbox" tabindex="0" aria-label="Research observations. Use arrow keys to select a mark, Home or End for the first or last item."><g class="field-groups" aria-hidden="true"></g><g class="field-points">${rows.map((row) => `<circle id="${ids.get(row.id)}" data-observation="${esc(row.id)}" role="option" aria-label="${esc(row.title)}, ${esc(row.group)}, evidence score ${row.score} out of 5" aria-selected="false" cx="0" cy="0" r="${1.65 + row.score * 0.32}"></circle>`).join("")}</g><circle class="field-selection" r="7" fill="none" aria-hidden="true" pointer-events="none"/><circle class="field-preview" r="7" fill="none" aria-hidden="true" pointer-events="none"/></svg></div><div class="signal-inspector"><div class="signal-inspector-head"><p id="signal-selection"></p><span id="signal-position"></span><div class="field-navigation"><button type="button" id="signal-prev" aria-label="Previous observation">←</button><button type="button" id="signal-next" aria-label="Next observation">→</button></div></div><div class="signal-item" id="signal-item"></div><a id="signal-source" class="signal-source" target="_blank" rel="noopener noreferrer">Open original source ↗</a><span class="sr-only" id="signal-announcement" role="status"></span></div></div><div class="signal-footer"><p>Hover to preview. Select a mark to keep it open. Arrow keys move between items.</p><button type="button" id="signal-explore"></button></div>`;
  const svg = host.querySelector<SVGSVGElement>("svg")!,
    inspector = document.getElementById("signal-item")!,
    preview = host.querySelector<SVGCircleElement>(".field-preview")!;
  const paint = (point: FieldPoint, announce = false) => {
    const row = point.row,
      [name, ...description] =
        row.group === "Code" ? row.title.split(" — ") : [row.title];
    document.getElementById("signal-selection")!.textContent = row.group;
    document.getElementById("signal-position")!.textContent =
      `${row.score}/5 evidence`;
    inspector.innerHTML = `<h3>${esc(name)}</h3>${description.length ? `<p class="signal-description">${esc(description.join(" — "))}</p>` : ""}<dl><div><dt>First observed</dt><dd>${esc(row.firstSeen || "Unavailable")}</dd></div><div><dt>Last observed</dt><dd>${esc(row.lastSeen || "Unavailable")}</dd></div></dl><p class="signal-note">${esc(new URL(row.url).hostname)}</p>`;
    (document.getElementById("signal-source") as HTMLAnchorElement).href =
      row.url;
    inspector.scrollTop = 0;
    if (announce)
      document.getElementById("signal-announcement")!.textContent =
        `${row.title}. ${row.group}. Evidence score ${row.score} out of 5.`;
  };
  const select = (point: FieldPoint, announce = true) => {
    selected = point.row.id;
    const index = field.points.indexOf(point);
    (document.getElementById("signal-prev") as HTMLButtonElement).disabled =
      index === 0;
    (document.getElementById("signal-next") as HTMLButtonElement).disabled =
      index === field.points.length - 1;
    svg
      .querySelectorAll<SVGCircleElement>("[data-observation]")
      .forEach((dot) =>
        dot.setAttribute(
          "aria-selected",
          String(dot.dataset.observation === selected),
        ),
      );
    svg.setAttribute("aria-activedescendant", ids.get(selected)!);
    const ring = host.querySelector<SVGCircleElement>(".field-selection")!;
    ring.style.transform = `translate(${point.x}px,${point.y}px)`;
    preview.style.opacity = "0";
    document.getElementById("signal-explore")!.textContent =
      `List ${point.row.group.toLowerCase()} →`;
    paint(point, announce);
  };
  const layout = () => {
    const width = Math.max(
      260,
      Math.min(FIELD_WIDTH, svg.clientWidth || FIELD_WIDTH),
    );
    const height = width < 400 ? 190 : FIELD_HEIGHT;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    field = researchField(rows, mode, width, height);
    svg.querySelector(".field-groups")!.innerHTML = field.groups
      .map(
        (g) =>
          `<circle cx="${g.x}" cy="${g.y}" r="${Math.max(1, g.radius - (width < 400 ? 19 : 12))}"/><text x="${g.x}" y="${g.y + g.radius - (width < 400 ? 12 : 1)}" text-anchor="middle">${esc(g.label)}${width < 400 ? `<tspan x="${g.x}" dy="11">${g.count}</tspan>` : ` · ${g.count}`}</text>`,
      )
      .join("");
    field.points.forEach((p) => {
      document
        .getElementById(ids.get(p.row.id)!)!
        .setAttribute("r", String(p.radius));
      document.getElementById(ids.get(p.row.id)!)!.style.transform =
        `translate(${p.x}px,${p.y}px)`;
    });
    select(
      field.points.find((p) => p.row.id === selected) || field.points[0],
      false,
    );
    if (!svg.dataset.ready) {
      svg.getBoundingClientRect();
      svg.dataset.ready = "true";
    }
  };
  const hit = (event: PointerEvent | MouseEvent) => {
    const target = event.target as SVGElement;
    const direct = target.dataset?.observation;
    if (direct) return field.points.find((p) => p.row.id === direct);
    if (performance.now() < movingUntil) return;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const p = svg.createSVGPoint();
    p.x = event.clientX;
    p.y = event.clientY;
    const at = p.matrixTransform(matrix.inverse()),
      point = nearestPoint(field.points, at.x, at.y);
    return point && Math.hypot(point.x - at.x, point.y - at.y) < 16
      ? point
      : undefined;
  };
  let hovered = "";
  svg.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const point = hit(event);
    if (point && hovered !== point.row.id) {
      hovered = point.row.id;
      preview.style.transform = `translate(${point.x}px,${point.y}px)`;
      preview.style.opacity = "1";
      paint(point);
    } else if (!point && hovered) {
      hovered = "";
      preview.style.opacity = "0";
      paint(field.points.find((p) => p.row.id === selected)!);
    }
  });
  svg.addEventListener("pointerleave", () => {
    hovered = "";
    preview.style.opacity = "0";
    paint(field.points.find((p) => p.row.id === selected)!);
  });
  svg.addEventListener("click", (event) => {
    const point = hit(event);
    if (point) {
      select(point);
      svg.focus();
    }
  });
  svg.addEventListener("keydown", (event) => {
    const current = field.points.find((p) => p.row.id === selected)!;
    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      select(directionalPoint(field.points, current, event.key));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      select(field.points[event.key === "Home" ? 0 : field.points.length - 1]);
    } else if (event.key === "Escape") {
      preview.style.opacity = "0";
      paint(current);
    }
  });
  host.querySelectorAll<HTMLButtonElement>("[data-arrangement]").forEach((b) =>
    b.addEventListener("click", () => {
      mode = b.dataset.arrangement as FieldMode;
      host
        .querySelectorAll("[data-arrangement]")
        .forEach((button) =>
          button.setAttribute("aria-pressed", String(button === b)),
        );
      movingUntil = performance.now() + 420;
      layout();
    }),
  );
  document
    .getElementById("signal-explore")!
    .addEventListener("click", () =>
      onExplore(field.points.find((p) => p.row.id === selected)!.row.group, 0),
    );
  for (const [id, delta] of [
    ["signal-prev", -1],
    ["signal-next", 1],
  ] as const) {
    document.getElementById(id)!.addEventListener("click", () => {
      const index =
        field.points.findIndex((p) => p.row.id === selected) + delta;
      if (field.points[index]) select(field.points[index]);
    });
  }
  layout();
  if (typeof ResizeObserver !== "undefined") {
    let previousWidth = svg.clientWidth;
    const observer = new ResizeObserver(() => {
      if (Math.abs(svg.clientWidth - previousWidth) > 1) {
        previousWidth = svg.clientWidth;
        layout();
      }
    });
    observer.observe(svg);
    cleanups.set(host, () => observer.disconnect());
  }
}
