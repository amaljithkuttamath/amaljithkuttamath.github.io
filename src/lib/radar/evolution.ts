import { dateLabel, escapeHTML as esc, safeURL } from "./data";
export const MOVEMENTS = ["new", "gaining", "fading"] as const;
export type Movement = (typeof MOVEMENTS)[number];
export interface Mover {
  title: string;
  url: string;
  detail: string;
}
export interface Evolution {
  date: string;
  buckets: Record<Movement, Mover[]>;
  known: Record<Movement, boolean>;
  mentions?: Mover[];
}
const labels = { new: "New", gaining: "Gaining", fading: "Fading" };
export function sourceIdentity(url: string) {
  const parsed = new URL(url);
  if (parsed.hostname === "arxiv.org")
    return `arxiv:${parsed.pathname
      .replace(/^\/(?:abs|pdf)\//, "")
      .replace(/v\d+(?:\.pdf)?$/, "")
      .replace(/\.pdf$/, "")}`;
  return parsed.origin + parsed.pathname.replace(/\/$/, "");
}
/** Read only the report's explicit change section, never infer decline from absence. */
export function editionEvolution(root: HTMLElement, date: string): Evolution {
  const buckets: Evolution["buckets"] = { new: [], gaining: [], fading: [] };
  const known: Evolution["known"] = {
    new: false,
    gaining: false,
    fading: false,
  };
  const mentions: Mover[] = [];
  const arcHeading = [...root.querySelectorAll("h2,h3")].find((h) =>
    /^story arcs?$/i.test((h.textContent || "").trim()),
  );
  let arc = arcHeading?.nextElementSibling;
  while (arc && !/^H[1-3]$/.test(arc.tagName)) {
    for (const item of arc.querySelectorAll("li")) {
      const anchor = item.querySelector<HTMLAnchorElement>("a[href]");
      const url = safeURL(anchor?.getAttribute("href"));
      if (
        !anchor ||
        !url ||
        mentions.some((m) => sourceIdentity(m.url) === sourceIdentity(url))
      )
        continue;
      const copy = item.cloneNode(true) as HTMLElement;
      copy.querySelector("a")?.remove();
      mentions.push({
        title: anchor.textContent?.trim() || "Untitled source",
        url,
        detail: (copy.textContent || "")
          .replace(/^\s*[—–:-]\s*/, "")
          .replace(/\s+/g, " ")
          .trim(),
      });
    }
    arc = arc.nextElementSibling;
  }
  const heading = [...root.querySelectorAll("h2,h3")].find((h) =>
    /^what changed\b/i.test(h.textContent || ""),
  );
  if (!heading) return { date, buckets, known, mentions };
  let group: Movement | null = null;
  let node = heading.nextElementSibling;
  while (node) {
    const text = (node.textContent || "").trim();
    if (/^no new,? climbing,? or cooled items detected/i.test(text)) {
      MOVEMENTS.forEach((key) => {
        known[key] = true;
      });
      break;
    }
    const next =
      /^(?:new(?: today| arrivals?)?|climbing|gaining(?: traction)?|cooled|fading)\s*:?$/i.exec(
        text,
      );
    if (next) {
      group = /^new/i.test(text)
        ? "new"
        : /^(climbing|gaining)/i.test(text)
          ? "gaining"
          : "fading";
      known[group] = true;
    } else if (/^H[1-3]$/.test(node.tagName) || node.tagName === "HR") break;
    else if (group) {
      const items =
        node.tagName === "LI" ? [node] : [...node.querySelectorAll("li")];
      for (const item of items) {
        const anchor = item.querySelector<HTMLAnchorElement>("a[href]");
        const url = safeURL(anchor?.getAttribute("href"));
        if (!anchor || !url) continue;
        const title = anchor.textContent?.trim() || "Untitled source";
        const copy = item.cloneNode(true) as HTMLElement;
        copy.querySelector("a")?.remove();
        const detail = (copy.textContent || "")
          .replace(/^\s*[—–:-]\s*/, "")
          .replace(/\s+/g, " ")
          .trim();
        if (
          !buckets[group].some(
            (m) => sourceIdentity(m.url) === sourceIdentity(url),
          )
        )
          buckets[group].push({ title, url, detail });
      }
    }
    node = node.nextElementSibling;
  }
  return { date, buckets, known, mentions };
}
export type ThreadEvent = Mover & { date: string; kind: Movement | "tracked" };
export interface ResearchThread {
  id: string;
  title: string;
  url: string;
  events: ThreadEvent[];
}
/** Connections mean source identity, never an inferred influence or topic relationship. */
export function researchThreads(
  dates: string[],
  editions: ReadonlyMap<string, Evolution | null>,
) {
  const threads = new Map<string, ResearchThread>();
  for (const date of [...dates].sort()) {
    const edition = editions.get(date);
    if (!edition) continue;
    const records: ThreadEvent[] = [
      ...MOVEMENTS.flatMap((kind) =>
        edition.buckets[kind].map((item) => ({ ...item, date, kind })),
      ),
      ...(edition.mentions || []).map((item) => ({
        ...item,
        date,
        kind: "tracked" as const,
      })),
    ];
    for (const event of records) {
      const id = sourceIdentity(event.url);
      let thread = threads.get(id);
      if (!thread) {
        thread = { id, title: event.title, url: event.url, events: [] };
        threads.set(id, thread);
      }
      // Prefer the run's explicit move over cumulative tracking on the same day.
      if (thread.events.some((previous) => previous.date === date)) continue;
      thread.events.push(event);
      thread.url = event.url;
      if (event.title.length > thread.title.length) thread.title = event.title;
    }
  }
  const weight = (thread: ResearchThread) => {
    const changes = thread.events.filter((event) => event.kind !== "tracked");
    return (
      new Set(changes.map((event) => event.kind)).size * 5 +
      Math.min(thread.events.length, 7) +
      (thread.events.length > 1 ? 8 : 0)
    );
  };
  return [...threads.values()].sort(
    (a, b) =>
      weight(b) - weight(a) ||
      b.events.at(-1)!.date.localeCompare(a.events.at(-1)!.date) ||
      a.title.localeCompare(b.title),
  );
}
const shortTitle = (title: string) =>
  title.split(": ")[0].replace(/ \(HF (Model|Dataset)\)$/, "");
function milestoneDetail(event: ThreadEvent) {
  if (event.kind !== "tracked") return event.detail;
  const match = event.detail.match(
    /^seen (\d+) runs?, traction ([+−–-]?\d+(?:\.\d+)?%) since first seen on (\d{4}-\d{2}-\d{2})\.?$/i,
  );
  return match
    ? `${match[1]} runs; ${match[2]} since ${match[3]}`
    : event.detail;
}
const eventName = (kind: ThreadEvent["kind"]) =>
  kind === "tracked" ? "Tracked" : labels[kind];
function eventLabel(event: ThreadEvent) {
  if (event.kind === "new") return "New";
  if (event.kind === "tracked") return "Seen";
  return (
    (event.detail.match(/score\s*([+−–-]\d+)/i)?.[1]
      ? event.detail.match(/score\s*([+−–-]\d+)/i)![1] + "pt"
      : "") ||
    event.detail.match(/traction\s*([+−–-]\d+(?:\.\d+)?%)/i)?.[1] ||
    (event.kind === "gaining" ? "Up" : "Down")
  );
}
export function renderEvolution(
  host: HTMLElement,
  dates: string[],
  selected: string,
  editions: ReadonlyMap<string, Evolution | null>,
  onDate: (date: string) => void,
) {
  const focused = host.contains(document.activeElement)
    ? (document.activeElement as HTMLElement)
    : null;
  const focusDate = focused?.hasAttribute("data-evolution-date");
  const focusReset = focused?.hasAttribute("data-reset");
  const focusTrace = focused?.getAttribute("data-trace");
  const index = Math.max(0, dates.indexOf(selected));
  const start = Math.max(0, Math.min(index - 3, dates.length - 7));
  const visible = dates.slice(start, start + 7).reverse();
  const threads = researchThreads(visible, editions);
  const rememberedURL = safeURL(host.dataset.traceUrl);
  const chosen =
    threads.find((thread) => thread.id === host.dataset.trace) ||
    (host.dataset.trace &&
    rememberedURL &&
    sourceIdentity(rememberedURL) === host.dataset.trace
      ? {
          id: host.dataset.trace,
          title: host.dataset.traceTitle || "Selected research",
          url: rememberedURL,
          events: [],
        }
      : threads[0]);
  if (chosen) {
    host.dataset.traceTitle = chosen.title;
    host.dataset.traceUrl = chosen.url;
  }
  const shown = threads.slice(0, 4);
  if (chosen && !shown.some((thread) => thread.id === chosen.id)) {
    if (shown.length === 4) shown.pop();
    shown.push(chosen);
  }
  const x = (i: number) => 184 + (i * 344) / Math.max(1, visible.length - 1);
  const rowY = (i: number) => 33 + i * 54;
  const selectedIndex = visible.indexOf(selected);
  let drawing =
    selectedIndex < 0
      ? ""
      : `<line class="evolution-cursor" x1="${x(selectedIndex)}" x2="${x(selectedIndex)}" y1="8" y2="220"/>`;
  for (const [i, thread] of shown.entries()) {
    const y = rowY(i);
    const points = thread.events
      .map((event) => ({ event, index: visible.indexOf(event.date) }))
      .filter((point) => point.index >= 0);
    drawing += `<g class="research-thread" data-active="${thread.id === chosen?.id}">`;
    points.forEach((point, n) => {
      const previous = points[n - 1];
      if (previous)
        drawing += `<line class="thread-connection ${point.index - previous.index > 1 ? "thread-gap" : ""}" data-source="${esc(thread.id)}" x1="${x(previous.index)}" x2="${x(point.index)}" y1="${y}" y2="${y}"/>`;
      const at = x(point.index),
        kind = point.event.kind;
      const shape =
        kind === "new"
          ? `<rect x="${at - 3.5}" y="${y - 3.5}" width="7" height="7"/>`
          : kind === "tracked"
            ? `<circle class="thread-tracked" cx="${at}" cy="${y}" r="3.5"/>`
            : `<path d="M${at - 4},${y + (kind === "gaining" ? 3 : -3)} L${at},${y + (kind === "gaining" ? -4 : 4)} L${at + 4},${y + (kind === "gaining" ? 3 : -3)} Z"/>`;
      drawing += `<g class="thread-event"><title>${esc(dateLabel(point.event.date))}: ${eventName(kind)}. ${esc(point.event.detail)}</title>${shape}<text x="${at}" y="${y + 18}" text-anchor="middle">${esc(eventLabel(point.event))}</text></g>`;
    });
    drawing += "</g>";
  }
  const nameButtons = shown
    .map((thread, i) => {
      const changes = thread.events
        .filter((event) => event.kind !== "tracked")
        .map((event) => event.kind)
        .filter((kind, i, array) => i === 0 || array[i - 1] !== kind);
      const progression = changes.length
        ? changes.slice(-2).map(eventName).join(" → ")
        : "Continued tracking";
      return `<button class="thread-name" style="--thread-row:${i}" type="button" data-trace="${esc(thread.id)}" aria-pressed="${chosen?.id === thread.id}" title="${esc(thread.title)}"><strong>${esc(shortTitle(thread.title))}</strong><span>${esc(progression)}</span></button>`;
    })
    .join("");
  const list = host.dataset.threadList === "true";
  let detail = "";
  if (list) {
    detail = `<div class="evolution-detail-head"><button type="button" data-reset>← Thread story</button><span>In this window</span></div><div class="evolution-history">${threads.map((thread) => `<button class="evolution-item" type="button" data-trace="${esc(thread.id)}"><strong>${esc(shortTitle(thread.title))}</strong><span>${esc(thread.events.at(-1)!.date.slice(5))}: ${eventName(thread.events.at(-1)!.kind)} · ${esc(thread.events.at(-1)!.detail)}</span></button>`).join("") || "<p>No research threads recorded.</p>"}</div>`;
  } else if (chosen) {
    const subtitle = chosen.title.includes(": ")
      ? chosen.title.slice(chosen.title.indexOf(": ") + 2)
      : "";
    detail = `<div class="evolution-detail-head"><button type="button" data-all-threads>All threads</button><a href="${esc(chosen.url)}" target="_blank" rel="noopener noreferrer">Source ↗</a></div><h3>${esc(shortTitle(chosen.title))}</h3>${subtitle ? `<p class="thread-purpose">${esc(subtitle)}</p>` : ""}<div class="evolution-history">${chosen.events.length ? chosen.events.map((event) => `<div class="thread-milestone" ${event.date === selected ? 'data-current="true"' : ""}><time>${event.date.slice(5).replace("-", "/")}</time><p><b>${eventName(event.kind)}</b> ${esc(milestoneDetail(event) || "Listed in this edition")}</p></div>`).join("") : "<p>No matching change recorded in this window.</p>"}</div>`;
  } else
    detail = `<p class="evolution-empty">${!visible.length || visible.some((date) => !editions.has(date)) ? "Reading research threads…" : "No named research history in these editions."}</p>`;
  host.innerHTML = `<div class="signal-layout evolution-layout"><div class="evolution-chart"><div class="evolution-chart-head"><span>Named work across editions</span><time>${esc(dateLabel(selected))}</time></div><div class="thread-map"><svg viewBox="0 0 560 230" preserveAspectRatio="none" role="img" aria-label="Research threads connected across recorded editions; each row is the same work.">${drawing}</svg>${nameButtons}</div><div class="evolution-dates">${visible.map((date, i) => `<button style="left:${(100 * x(i)) / 560}%" type="button" data-evolution-date="${date}" aria-label="Explore ${dateLabel(date)}" ${date === selected ? 'aria-current="date"' : ""}>${i === 0 || date.slice(0, 7) !== visible[i - 1].slice(0, 7) ? date.slice(5).replace("-", "/") : date.slice(8)}</button>`).join("")}</div></div><div class="evolution-details" aria-live="polite">${detail}</div></div><div class="signal-footer evolution-footer"><p>Same work connects. Dashed gaps = unreported. ○ = tracked.</p><a href="#briefing/${selected}">Read this edition ↓</a></div>`;
  const redraw = () => renderEvolution(host, dates, selected, editions, onDate);
  host
    .querySelectorAll<HTMLButtonElement>("[data-evolution-date]")
    .forEach((button) => {
      button.addEventListener("click", () =>
        onDate(button.dataset.evolutionDate!),
      );
      button.addEventListener("keydown", (event) => {
        const current = dates.indexOf(button.dataset.evolutionDate!);
        const next =
          event.key === "ArrowLeft"
            ? current + 1
            : event.key === "ArrowRight"
              ? current - 1
              : event.key === "Home"
                ? dates.length - 1
                : event.key === "End"
                  ? 0
                  : -1;
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          if (dates[next]) onDate(dates[next]);
        }
      });
    });
  host.querySelectorAll<HTMLButtonElement>("[data-trace]").forEach((button) =>
    button.addEventListener("click", () => {
      host.dataset.trace = button.dataset.trace;
      delete host.dataset.threadList;
      redraw();
      [...host.querySelectorAll<HTMLButtonElement>(".thread-name")]
        .find((button) => button.dataset.trace === host.dataset.trace)
        ?.focus();
    }),
  );
  host
    .querySelector<HTMLButtonElement>("[data-all-threads]")
    ?.addEventListener("click", () => {
      host.dataset.threadList = "true";
      redraw();
      host.querySelector<HTMLButtonElement>("[data-reset]")?.focus();
    });
  host
    .querySelector<HTMLButtonElement>("[data-reset]")
    ?.addEventListener("click", () => {
      delete host.dataset.threadList;
      redraw();
      host.querySelector<HTMLButtonElement>("[data-all-threads]")?.focus();
    });
  const history = host.querySelector<HTMLElement>(".evolution-history");
  const activeMilestone = host.querySelector<HTMLElement>(
    ".thread-milestone[data-current]",
  );
  if (history && activeMilestone)
    history.scrollTop = Math.max(
      0,
      activeMilestone.offsetTop -
        history.offsetTop +
        activeMilestone.offsetHeight -
        history.clientHeight,
    );
  if (focusDate)
    host
      .querySelector<HTMLButtonElement>("[data-evolution-date][aria-current]")
      ?.focus();
  if (focusReset)
    host.querySelector<HTMLButtonElement>("[data-reset]")?.focus();
  if (focusTrace)
    [...host.querySelectorAll<HTMLButtonElement>("[data-trace]")]
      .find((button) => button.dataset.trace === focusTrace)
      ?.focus();
}
