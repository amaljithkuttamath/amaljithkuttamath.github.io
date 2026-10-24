import {
  RAW,
  REPO,
  escapeHTML as esc,
  ageLabel,
  dateLabel,
  validDate,
  parseState,
  parseArchive,
  filterRows,
  type Row,
} from "./data";
import { digestView } from "./digest";
import { mountSignals } from "./signals";
import { editionEvolution, renderEvolution, type Evolution } from "./evolution";
export function bootRadar() {
  const $ = (id: string) => document.getElementById(id)!;
  const input = (id: string) => $(id) as HTMLInputElement;
  let rows: Row[] = [],
    editions: ReturnType<typeof parseArchive> = [],
    group = "All",
    limit = 15,
    revision = 0,
    currentDate = "",
    publication: any = null;
  const cache = new Map<string, Promise<string>>();
  const movements = new Map<string, Evolution | null>();
  const movementLoads = new Set<string>();
  let movementRevision = 0;
  function showResearch(view: string) {
    const evolution = document.getElementById("evolution-workspace");
    if (!evolution) return;
    evolution.hidden = view !== "evolution";
    if (document.getElementById("radar-timeline"))
      $("radar-timeline").hidden = view === "evolution";
    $("signal-workspace").hidden = view === "evolution";
    $("signal-total").hidden = view === "evolution";
    $("signal-title").textContent =
      view === "evolution" ? "Research threads" : "Research observations";
    document
      .querySelectorAll<HTMLButtonElement>("[data-signal-view]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.signalView === view),
        ),
      );
  }
  function paintEvolution() {
    const host = document.getElementById("evolution-workspace");
    if (!host) return;
    const requested = location.hash.slice(1).split("/")[1];
    const selected = validDate(requested || "") ? requested : editions[0]?.date;
    if (!selected) {
      host.innerHTML =
        '<p class="signal-wait">No edition history available.</p>';
      return;
    }
    const dates = editions.map((edition) => edition.date);
    const index = Math.max(0, dates.indexOf(selected));
    const start = Math.max(0, Math.min(index - 3, dates.length - 7));
    renderEvolution(host, dates, selected, movements, (date) => {
      showResearch("evolution");
      location.hash = `briefing/${date}`;
    });
    const generation = movementRevision;
    for (const date of dates.slice(start, start + 7)) {
      if (movements.has(date) || movementLoads.has(date)) continue;
      movementLoads.add(date);
      void read(`reports/${date}-digest.md`)
        .then((md) => {
          const digest = digestView(md, document);
          if (digest.date !== date) throw new Error("Edition date mismatch");
          if (generation === movementRevision)
            movements.set(date, editionEvolution(digest.root, date));
        })
        .catch(() => {
          if (generation === movementRevision) movements.set(date, null);
        })
        .finally(() => {
          if (generation === movementRevision) {
            movementLoads.delete(date);
            paintEvolution();
          }
        });
    }
  }
  async function read(path: string) {
    if (!cache.has(path))
      cache.set(
        path,
        (async () => {
          const controller = new AbortController(),
            timer = setTimeout(() => controller.abort(), 15000);
          try {
            const r = await fetch(RAW + path, {
              cache: "no-store",
              signal: controller.signal,
            });
            if (!r.ok) throw new Error(`Source returned HTTP ${r.status}.`);
            const text = await r.text();
            if (text.length > 5_000_000)
              throw new Error("Source is unexpectedly large.");
            return text;
          } finally {
            clearTimeout(timer);
          }
        })(),
      );
    try {
      return await cache.get(path)!;
    } catch (e) {
      cache.delete(path);
      throw e;
    }
  }
  function error(host: HTMLElement, e: unknown, retry: () => unknown) {
    host.innerHTML = `<div class="radar-error" role="alert"><p>${esc(e instanceof Error ? e.message : "This source could not be loaded.")} The other views remain available.</p><button type="button">Try again</button> <a href="${REPO}/tree/main/reports" target="_blank" rel="noopener noreferrer">Read on GitHub</a></div>`;
    host.querySelector("button")!.addEventListener("click", retry);
  }
  function status(date: string, degraded: boolean) {
    $("radar-date").textContent = dateLabel(date);
    $("radar-date").setAttribute("datetime", date);
    const matching = publication?.report === `reports/${date}-digest.md`;
    const age = matching ? ageLabel(publication.published_at) : "";
    $("radar-status").textContent = degraded
      ? "Fallback edition"
      : matching
        ? `Published · ${age.toLowerCase()}`
        : "Published edition";
    $("radar-status").dataset.current = String(
      matching &&
        Number.isFinite(Date.parse(publication.published_at)) &&
        Date.now() - Date.parse(publication.published_at) >= 0 &&
        Date.now() - Date.parse(publication.published_at) < 48 * 3600000 &&
        !degraded,
    );
  }
  async function loadBrief(date = "latest") {
    const mine = ++revision,
      host = $("radar-brief");
    host.setAttribute("aria-busy", "true");
    host.innerHTML =
      '<p class="radar-loading">Opening the published briefing…</p>';
    try {
      const md = await read(
        `reports/${date === "latest" ? "latest.md" : date + "-digest.md"}`,
      );
      if (mine !== revision) return;
      const d = digestView(md, document);
      currentDate = d.date;
      status(d.date, d.degraded);
      host.innerHTML = `${date !== "latest" ? '<button class="radar-back" id="latest-edition">Back to the latest edition</button>' : ""}${d.degraded ? '<p class="radar-notice">Synthesis was unavailable for this edition. The published fallback remains visible below.</p>' : ""}<div class="brief-overview"><div><h2>Daily synthesis</h2><div class="brief-lead">${d.lead}</div></div><aside><span class="folio-label">About this edition</span><p>${d.minutes} minute full read</p><p>${d.degraded ? "Deterministic fallback" : "Machine-generated briefing"}<br/>Check claims against the linked sources.</p><a href="${REPO}/blob/main/reports/${d.date}-digest.md" target="_blank" rel="noopener noreferrer">Original Markdown ↗</a></aside></div>${d.stories.length ? `<h2 class="radar-reading-title">Selected sources</h2><div class="radar-picks">${d.stories.map((s) => `<article class="radar-pick"><h3><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></h3><p>${s.body}</p></article>`).join("")}</div>` : ""}${d.actions ? `<section class="radar-actions"><h2>Suggested actions</h2><div>${d.actions}</div></section>` : ""}<details class="radar-full"><summary>Read the full briefing <span>${d.minutes} min</span></summary><div id="full-brief"></div></details>`;
      $("full-brief").replaceWith(d.root);
      $("latest-edition")?.addEventListener("click", () => {
        location.hash = "briefing";
      });
    } catch (e) {
      if (mine === revision) error(host, e, () => loadBrief(date));
    } finally {
      if (mine === revision) host.removeAttribute("aria-busy");
    }
  }
  function renderEvidence() {
    const filtered = filterRows(
        rows,
        input("evidence-search").value,
        group,
        input("evidence-sort").value,
        false,
      ),
      minimum = Number(input("minimum-score").value),
      qualified = filtered.filter((r) => r.score >= minimum),
      shown = qualified.slice(0, limit);
    $("evidence-result").textContent =
      `${qualified.length} matching items / ${rows.length} observed`;
    $("evidence-list").innerHTML =
      shown
        .map(
          (r) =>
            `<a class="evidence-row" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer"><span class="evidence-score" aria-label="Evidence score ${r.score} out of 5">${r.score}<small>/5</small></span><div><h3>${esc(r.title)}</h3><p>${esc(r.group)}</p></div><time datetime="${esc(r.lastSeen)}">${r.lastSeen ? `Seen ${esc(r.lastSeen.slice(5))}` : "Date unavailable"}</time></a>`,
        )
        .join("") ||
      '<p class="radar-loading">No matching items. Try a broader search or another source.</p>';
    $("evidence-more").hidden = limit >= qualified.length;
  }
  async function loadEvidence() {
    try {
      const [state, latest] = await Promise.all([
        read("data/state.json"),
        read("reports/latest.md").catch(() => null),
      ]);
      rows = parseState(JSON.parse(state));
      let notes = new Map<string, string>();
      if (latest) {
        try {
          const brief = digestView(latest, document);
          if (!brief.degraded)
            notes = new Map(
              rows
                .filter((row) => row.lastSeen <= brief.date)
                .flatMap((row) => {
                  const note = brief.notes.get(row.url);
                  return note ? [[row.url, note] as [string, string]] : [];
                }),
            );
        } catch {
          /* Current observations remain usable if briefing notes are unavailable. */
        }
      }
      $("evidence-count").textContent = String(rows.length);
      const groups = ["All", ...new Set(rows.map((r) => r.group))];
      if (!groups.includes(group)) group = "All";
      $("source-filters").innerHTML = groups
        .map(
          (g) =>
            `<button type="button" data-group="${esc(g)}" aria-pressed="${g === group}">${esc(g)}</button>`,
        )
        .join("");
      $("source-filters")
        .querySelectorAll<HTMLButtonElement>("button")
        .forEach((b) =>
          b.addEventListener("click", () => {
            group = b.dataset.group!;
            limit = 15;
            $("source-filters")
              .querySelectorAll("button")
              .forEach((btn) =>
                btn.setAttribute("aria-pressed", String(btn === b)),
              );
            renderEvidence();
          }),
        );
      mountSignals(
        rows,
        (selectedGroup, minimum) => {
          group = selectedGroup;
          input("minimum-score").value = String(minimum);
          input("evidence-search").value = "";
          limit = 15;
          $("source-filters")
            .querySelectorAll<HTMLButtonElement>("button")
            .forEach((b) =>
              b.setAttribute("aria-pressed", String(b.dataset.group === group)),
            );
          renderEvidence();
          location.hash = "evidence";
          $("tab-evidence").focus();
          $("tab-evidence").scrollIntoView({
            block: "start",
            behavior: "instant",
          });
        },
        notes,
      );
      renderEvidence();
    } catch (e) {
      if (document.getElementById("signal-total"))
        $("signal-total").textContent = "Evidence unavailable";
      if (document.getElementById("signal-workspace"))
        error($("signal-workspace"), e, loadEvidence);
      error($("evidence-list"), e, loadEvidence);
    }
  }
  function renderTimeline() {
    const host = document.getElementById("radar-timeline");
    if (!host) return;
    const hadFocus = host.contains(document.activeElement);
    const requested = location.hash.slice(1).split("/")[1];
    const selected = validDate(requested || "") ? requested : editions[0]?.date;
    const index = Math.max(
      0,
      editions.findIndex((edition) => edition.date === selected),
    );
    const start = Math.max(0, Math.min(index - 3, editions.length - 7));
    const visible = editions.slice(start, start + 7).reverse();
    host.innerHTML = editions.length
      ? `<span>Timeline</span><button type="button" data-timeline-date="${editions[index + 1]?.date || ""}" aria-label="Previous edition" ${index >= editions.length - 1 ? "disabled" : ""}>←</button>${visible.map((edition) => `<a href="#briefing/${edition.date}" aria-label="Read ${dateLabel(edition.date)}" ${edition.date === selected ? 'aria-current="date"' : ""}>${edition.date.slice(5).replace("-", "/")}</a>`).join("")}<button type="button" data-timeline-date="${editions[index - 1]?.date || ""}" aria-label="Next edition" ${index === 0 ? "disabled" : ""}>→</button>`
      : '<a href="#archive">Timeline unavailable</a>';
    if (hadFocus) host.querySelector<HTMLElement>("[aria-current]")?.focus();
    host
      .querySelectorAll<HTMLButtonElement>("[data-timeline-date]")
      .forEach((button) =>
        button.addEventListener("click", () => {
          if (button.dataset.timelineDate)
            location.hash = `briefing/${button.dataset.timelineDate}`;
        }),
      );
  }
  function renderArchive() {
    const q = input("archive-search").value.toLowerCase().trim(),
      found = editions.filter((e) =>
        `${e.date} ${e.teaser}`.toLowerCase().includes(q),
      );
    document
      .querySelectorAll<HTMLButtonElement>("[data-month]")
      .forEach((b) =>
        b.setAttribute("aria-pressed", String(q === b.dataset.month)),
      );
    $("archive-result").textContent =
      `${found.length} ${found.length === 1 ? "edition" : "editions"}`;
    $("archive-list").innerHTML =
      found
        .map(
          (e) =>
            `<button class="archive-row" data-date="${e.date}"><time datetime="${e.date}">${esc(e.date)}</time><p>${esc(e.teaser || "Open this edition")}</p><span aria-hidden="true">↗</span></button>`,
        )
        .join("") ||
      '<p class="radar-loading">No matching editions. Try a date or a broader topic.</p>';
    $("archive-list")
      .querySelectorAll<HTMLButtonElement>("button")
      .forEach((b) =>
        b.addEventListener("click", () => {
          location.hash = `briefing/${b.dataset.date}`;
        }),
      );
  }
  async function loadArchive() {
    try {
      editions = parseArchive(await read("reports/README.md"));
      const months = [...new Set(editions.map((e) => e.date.slice(0, 7)))];
      const counts = months.map(
        (m) => editions.filter((e) => e.date.startsWith(m)).length,
      );
      if (document.getElementById("archive-months")) {
        $("archive-months").innerHTML = months
          .map(
            (month, i) =>
              `<button type="button" data-month="${month}" aria-pressed="false" style="--edition-width:${(100 * counts[i]) / Math.max(...counts)}%"><span>${new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(month + "-01T12:00:00Z"))}</span><span>${counts[i]} editions</span></button>`,
          )
          .join("");
        $("archive-months")
          .querySelectorAll<HTMLButtonElement>("button")
          .forEach((b) =>
            b.addEventListener("click", () => {
              input("archive-search").value =
                input("archive-search").value === b.dataset.month
                  ? ""
                  : b.dataset.month!;
              renderArchive();
            }),
          );
      }
      renderArchive();
      renderTimeline();
      paintEvolution();
    } catch (e) {
      error($("archive-list"), e, loadArchive);
      renderTimeline();
      paintEvolution();
    }
  }
  let briefKey = "";
  function route(force = false) {
    if (location.hash === "#main") return;
    renderTimeline();
    paintEvolution();
    const [part, date] = location.hash.slice(1).split("/"),
      view = ["evidence", "archive"].includes(part) ? part : "briefing";
    document
      .querySelectorAll<HTMLButtonElement>('.radar-tabs [role="tab"]')
      .forEach((b) => {
        const active = b.dataset.view === view;
        b.setAttribute("aria-selected", String(active));
        b.tabIndex = active ? 0 : -1;
        $(b.getAttribute("aria-controls")!).hidden = !active;
      });
    if (view === "briefing") {
      const key = validDate(date || "") ? date : "latest";
      if (key !== "latest") showResearch("evolution");
      if (key !== briefKey || force) {
        briefKey = key;
        void loadBrief(key);
      }
    }
  }
  document
    .querySelectorAll<HTMLButtonElement>('.radar-tabs [role="tab"]')
    .forEach((b, i, buttons) => {
      b.addEventListener("click", () => {
        location.hash = b.dataset.view!;
      });
      b.addEventListener("keydown", (e) => {
        let next = i;
        if (e.key === "ArrowRight") next = (i + 1) % buttons.length;
        else if (e.key === "ArrowLeft")
          next = (i + buttons.length - 1) % buttons.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = buttons.length - 1;
        else return;
        e.preventDefault();
        buttons[next].focus();
        buttons[next].click();
      });
    });
  for (const id of ["evidence-search", "evidence-sort", "minimum-score"])
    $(id).addEventListener("input", () => {
      limit = 15;
      renderEvidence();
    });
  $("evidence-more").addEventListener("click", () => {
    limit += 20;
    renderEvidence();
  });
  input("archive-search").addEventListener("input", renderArchive);
  async function loadPublication() {
    try {
      const p = JSON.parse(await read("data/publication.json"));
      if (p && typeof p === "object" && !Array.isArray(p)) {
        publication = p;
        if (!currentDate) {
          const date =
            typeof p.report === "string"
              ? p.report.match(/reports\/(\d{4}-\d{2}-\d{2})-digest\.md$/)?.[1]
              : "";
          if (date && validDate(date)) currentDate = date;
        }
        if (currentDate)
          status(
            currentDate,
            $("radar-brief").querySelector(".radar-notice") !== null,
          );
      }
      if (!currentDate)
        $("radar-status").textContent = "Publication time unavailable";
    } catch {
      if (!currentDate)
        $("radar-status").textContent = "Publication time unavailable";
      /* Date-only editions remain usable without a receipt. */
    }
  }
  function refresh() {
    cache.clear();
    movementRevision++;
    movements.clear();
    movementLoads.clear();
    publication = null;
    void loadPublication();
    void loadEvidence();
    void loadArchive();
    route(true);
  }
  document
    .querySelectorAll<HTMLButtonElement>("[data-signal-view]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        showResearch(button.dataset.signalView!),
      ),
    );
  $("radar-refresh").addEventListener("click", refresh);
  document.getElementById("jump-briefing")?.addEventListener("click", () => {
    $("tab-briefing").focus();
    $("tab-briefing").scrollIntoView({ block: "start", behavior: "instant" });
  });
  window.addEventListener("hashchange", () => route());
  refresh();
  // A long-lived tab must not keep the freshness signal after its receipt ages out.
  window.setInterval(() => {
    if (currentDate)
      status(
        currentDate,
        $("radar-brief").querySelector(".radar-notice") !== null,
      );
  }, 60000);
}
