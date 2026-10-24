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
  const heading = [...root.querySelectorAll("h2,h3")].find((h) =>
    /^what changed\b/i.test(h.textContent || ""),
  );
  if (!heading) return { date, buckets, known };
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
  return { date, buckets, known };
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
  const restoreDateFocus = focused?.hasAttribute("data-evolution-date");
  const restoreResetFocus = focused?.hasAttribute("data-reset");
  const previousTrace = host.dataset.trace || "";
  const previousGroup = host.dataset.group as Movement | undefined;
  const index = Math.max(0, dates.indexOf(selected));
  const start = Math.max(0, Math.min(index - 3, dates.length - 7));
  const visible = dates.slice(start, start + 7).reverse();
  const current = editions.get(selected);
  const all = visible.flatMap((date) =>
    MOVEMENTS.flatMap((key) => editions.get(date)?.buckets[key] || []),
  );
  const candidates = [
    ...MOVEMENTS.flatMap((key) => current?.buckets[key] || []),
    ...all,
  ];
  const foundTrace = candidates.find(
    (item) => sourceIdentity(item.url) === previousTrace,
  );
  const rememberedURL = safeURL(host.dataset.traceUrl);
  const tracked =
    foundTrace ||
    (previousTrace &&
    rememberedURL &&
    sourceIdentity(rememberedURL) === previousTrace
      ? {
          title: host.dataset.traceTitle || "Selected research",
          url: rememberedURL,
          detail: "",
        }
      : undefined);
  if (tracked) {
    host.dataset.traceTitle = tracked.title;
    host.dataset.traceUrl = tracked.url;
  }
  const x = (i: number) => 90 + i * (442 / Math.max(1, visible.length - 1));
  const y = (key: Movement) => 40 + MOVEMENTS.indexOf(key) * 68;
  const max = Math.max(
    1,
    ...visible.flatMap((date) =>
      MOVEMENTS.map((key) => editions.get(date)?.buckets[key].length || 0),
    ),
  );
  const selectedX = x(visible.indexOf(selected));
  let lanes = "";
  for (const key of MOVEMENTS) {
    const points = visible.map((date, i) => {
      const edition = editions.get(date);
      const known = edition?.known[key];
      const items = edition?.buckets[key] || [];
      const match =
        tracked &&
        items.find(
          (item) => sourceIdentity(item.url) === sourceIdentity(tracked.url),
        );
      const count = tracked ? Number(Boolean(match)) : items.length;
      return {
        x: x(i),
        y: y(key) + 22 - (tracked ? count * 24 : (count / max) * 28),
        known,
        count,
        date,
        match,
      };
    });
    lanes += `<text class="evolution-lane-label" x="0" y="${y(key) + 10}">${labels[key]}</text><line class="evolution-baseline" x1="84" x2="540" y1="${y(key) + 22}" y2="${y(key) + 22}"/>`;
    // Unknown editions break the path. An unlisted item has no measured trend.
    points.forEach((point, i) => {
      const previous = points[i - 1];
      if (!tracked && point.known && previous?.known)
        lanes += `<line class="evolution-path" x1="${previous.x}" y1="${previous.y}" x2="${point.x}" y2="${point.y}"/>`;
      if (!point.known)
        lanes += `<text class="evolution-unknown" x="${point.x}" y="${y(key) + 24}" text-anchor="middle">?</text>`;
      else if (!tracked || point.match)
        lanes += `<circle class="evolution-dot" cx="${point.x}" cy="${point.y}" r="${point.date === selected ? 4 : 2.5}"/><text class="evolution-value" x="${point.x}" y="${point.y - 8}" text-anchor="middle">${tracked ? esc(point.match?.detail.match(/score\s*([+−–-]\d+)/i)?.[0] || point.match?.detail.match(/traction\s*([+−–-]\d+(?:\.\d+)?%)/i)?.[1] || (key === "new" ? "new" : key === "gaining" ? "↑" : "↓")) : point.count}</text>`;
    });
  }
  const short = (title: string) =>
    title.split(": ")[0].replace(/ \(HF (Model|Dataset)\)$/, "");
  const itemHTML = (item: Mover) =>
    `<button class="evolution-item" type="button" data-trace="${esc(sourceIdentity(item.url))}"><strong>${esc(short(item.title))}</strong><span>${esc(item.detail || "Newly listed in this report")}</span></button>`;
  let detail = "";
  if (tracked) {
    detail = `<div class="evolution-detail-head"><button type="button" data-reset>← All movers</button><a href="${esc(tracked.url)}" target="_blank" rel="noopener noreferrer">Source ↗</a></div><h3>${esc(short(tracked.title))}</h3><div class="evolution-history">${visible
      .map((date) => {
        const edition = editions.get(date);
        const hits = MOVEMENTS.flatMap((key) =>
          (edition?.buckets[key] || [])
            .filter(
              (item) =>
                sourceIdentity(item.url) === sourceIdentity(tracked.url),
            )
            .map((item) => ({ key, item })),
        );
        return `<div><time>${date.slice(5).replace("-", "/")}</time><p>${hits.length ? hits.map(({ key, item }) => `<b>${labels[key]}</b> ${esc(item.detail)}`).join("; ") : edition && MOVEMENTS.every((key) => edition.known[key]) ? "Not listed among movers" : "No matching change recorded"}</p></div>`;
      })
      .join("")}</div>`;
  } else if (previousGroup && MOVEMENTS.includes(previousGroup)) {
    const items = current?.buckets[previousGroup] || [];
    detail = `<div class="evolution-detail-head"><button type="button" data-reset>← All movers</button><span>${labels[previousGroup]} / ${items.length}</span></div><div class="evolution-history">${items.map(itemHTML).join("") || `<p>${current?.known[previousGroup] ? "None reported" : "Change data unavailable"}</p>`}</div>`;
  } else {
    detail = MOVEMENTS.map((key) => {
      const items = current?.buckets[key] || [];
      return `<section class="evolution-summary"><button class="evolution-category" type="button" data-category="${key}">${labels[key]} <span>${current?.known[key] ? `${items.length} reported${items.length > 1 ? " · view all" : ""}` : "Not reported"}</span></button>${items.length ? itemHTML(items[0]) : `<p class="evolution-empty">${current?.known[key] ? "None reported in this edition" : editions.has(selected) ? "Change data unavailable" : "Reading edition…"}</p>`}</section>`;
    }).join("");
  }
  host.innerHTML = `<div class="signal-layout evolution-layout"><div class="evolution-chart"><div class="evolution-chart-head"><span>${tracked ? "Recorded moves for this item" : "Named movers per edition"}</span><time>${esc(dateLabel(selected))}</time></div><svg viewBox="0 0 560 230" preserveAspectRatio="none" role="img" aria-label="${tracked ? "Recorded changes for " + esc(short(tracked.title)) : "Reported new, gaining, and fading item counts across editions"}"><line class="evolution-cursor" x1="${selectedX}" x2="${selectedX}" y1="8" y2="212"/>${lanes}</svg><div class="evolution-dates">${visible.map((date, i) => `<button style="left:${(100 * x(i)) / 560}%" type="button" data-evolution-date="${date}" aria-label="Explore ${dateLabel(date)}" ${date === selected ? 'aria-current="date"' : ""}>${date.slice(5).replace("-", "/")}</button>`).join("")}</div></div><div class="evolution-details" aria-live="polite">${detail}</div></div><div class="signal-footer evolution-footer"><p>${tracked ? "Gaps mean no recorded move, not decline." : "Select a name to trace it. ? = unreported."}</p><a href="#briefing/${selected}">Read this edition ↓</a></div>`;
  host
    .querySelectorAll<HTMLButtonElement>("[data-evolution-date]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        onDate(button.dataset.evolutionDate!),
      ),
    );
  host
    .querySelectorAll<HTMLButtonElement>("[data-evolution-date]")
    .forEach((button) =>
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
      }),
    );
  if (restoreDateFocus)
    host
      .querySelector<HTMLButtonElement>("[data-evolution-date][aria-current]")
      ?.focus();
  if (restoreResetFocus)
    host.querySelector<HTMLButtonElement>("[data-reset]")?.focus();
  host.querySelectorAll<HTMLButtonElement>("[data-trace]").forEach((button) =>
    button.addEventListener("click", () => {
      host.dataset.trace = button.dataset.trace;
      delete host.dataset.group;
      renderEvolution(host, dates, selected, editions, onDate);
      host.querySelector<HTMLButtonElement>("[data-reset]")?.focus();
    }),
  );
  host
    .querySelectorAll<HTMLButtonElement>("[data-category]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        host.dataset.group = button.dataset.category;
        renderEvolution(host, dates, selected, editions, onDate);
        host.querySelector<HTMLButtonElement>("[data-reset]")?.focus();
      }),
    );
  host
    .querySelector<HTMLButtonElement>("[data-reset]")
    ?.addEventListener("click", () => {
      delete host.dataset.trace;
      delete host.dataset.traceTitle;
      delete host.dataset.traceUrl;
      delete host.dataset.group;
      renderEvolution(host, dates, selected, editions, onDate);
      host.querySelector<HTMLButtonElement>("[data-category]")?.focus();
    });
}
