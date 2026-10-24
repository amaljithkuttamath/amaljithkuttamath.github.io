import { dateLabel, escapeHTML as esc } from "./data";
interface Paper {
  title: string;
  url: string;
  date: string;
}
export interface Connection {
  id: string;
  earlier: Paper;
  later: Paper;
  kind: "Builds on" | "Challenges design";
  reason: string;
  evidence: { url: string; section: string; quote: string; context: string };
  checked: string;
}
/** Editorial records checked against the linked full text. Topic similarity is never an edge. */
export const CONNECTIONS: readonly Connection[] = [
  {
    id: "flashvsr-hybrid",
    earlier: {
      title: "FlashVSR",
      url: "https://arxiv.org/abs/2510.12747",
      date: "2025-10-14",
    },
    later: {
      title: "FlashVSR+",
      url: "https://arxiv.org/abs/2610.17552v1",
      date: "2026-10-13",
    },
    kind: "Builds on",
    reason:
      "Keeps the three-stage training pipeline; adds hybrid attention and reward-weighted distillation.",
    evidence: {
      url: "https://arxiv.org/html/2610.17552v1",
      section: "§3.1 Overview",
      quote: "Following FlashVSR",
      context:
        "The authors explicitly retain FlashVSR’s training stages, replace the student attention architecture, and add reward feedback to distillation.",
    },
    checked: "2026-10-24",
  },
  {
    id: "agents-orchestration",
    earlier: {
      title: "Agents-A1",
      url: "https://arxiv.org/abs/2606.30616v1",
      date: "2026-06-29",
    },
    later: {
      title: "Sage-A1.5",
      url: "https://arxiv.org/abs/2610.28578v1",
      date: "2026-10-20",
    },
    kind: "Builds on",
    reason:
      "Adds learned task delegation and evidence checks to the same 35B agent lineage.",
    evidence: {
      url: "https://arxiv.org/html/2610.28578v1",
      section: "§1 Introduction",
      quote: "a 35B MoE agent model built on Agents-A1",
      context:
        "The paper names Agents-A1 as its base and introduces agentic orchestration and verification as the new capabilities.",
    },
    checked: "2026-10-24",
  },
  {
    id: "future-prediction-design",
    earlier: {
      title: "Next Forcing",
      url: "https://arxiv.org/abs/2606.11187",
      date: "2026-06-09",
    },
    later: {
      title: "Looking Ahead",
      url: "https://arxiv.org/abs/2610.29989v1",
      date: "2026-10-21",
    },
    kind: "Challenges design",
    reason:
      "Uses parallel future predictors; argues chained prediction can leak future information.",
    evidence: {
      url: "https://arxiv.org/html/2610.29989v1",
      section: "Appendix C.1, Parallel versus Chained Prediction",
      quote:
        "Chaining may therefore pass information from an intermediate future chunk to later predictors",
      context:
        "An explicit design critique by the Looking Ahead authors. They describe the work as independent and concurrent with Next Forcing; this is not a replication or a claim of direct lineage.",
    },
    checked: "2026-10-24",
  },
];
export function connectionsAt(
  date: string,
  records: readonly Connection[] = CONNECTIONS,
) {
  return records
    .filter((c) => c.earlier.date <= date && c.later.date <= date)
    .sort((a, b) => b.later.date.localeCompare(a.later.date));
}
export function renderConnections(
  host: HTMLElement,
  dates: string[],
  selected: string,
  onDate: (date: string) => void,
  onTracking: () => void,
) {
  const focusDate =
    host.contains(document.activeElement) &&
    (document.activeElement as HTMLElement)?.hasAttribute(
      "data-connection-date",
    );
  const focusedConnection = host.contains(document.activeElement)
    ? (document.activeElement as HTMLElement)?.getAttribute("data-connection")
    : null;
  const records = connectionsAt(selected);
  const chosen =
    records.find((c) => c.id === host.dataset.connection) || records[0];
  const index = Math.max(0, dates.indexOf(selected)),
    start = Math.max(0, Math.min(index - 3, dates.length - 7));
  const visible = dates.slice(start, start + 7).reverse();
  const node = (p: Paper) =>
    `<span class="connection-paper"><strong>${esc(p.title)}</strong><time datetime="${p.date}">${esc(dateLabel(p.date))}</time></span>`;
  host.innerHTML = `<div class="connection-toolbar"><span>Source-checked connections</span><button type="button" data-show-tracking>Edition activity</button></div><div class="signal-layout connection-layout"><div class="connection-map">${records.map((c) => `<button type="button" class="connection-row" data-connection="${c.id}" aria-pressed="${c.id === chosen?.id}" aria-label="${esc(c.later.title)} ${c.kind.toLowerCase()} ${esc(c.earlier.title)}. ${esc(c.reason)}"><span class="connection-nodes">${node(c.earlier)}<span class="connection-edge" data-kind="${c.kind}"><span>${c.kind}</span><i aria-hidden="true"></i></span>${node(c.later)}</span><span class="connection-reason">${esc(c.reason)}</span></button>`).join("") || '<p class="evolution-empty">No source-checked connections available by this date.</p>'}</div><aside class="connection-evidence" aria-label="Connection evidence" aria-live="polite">${chosen ? `<span>Why this connection</span><h3>${esc(chosen.later.title)} → ${esc(chosen.earlier.title)}</h3><blockquote>“${esc(chosen.evidence.quote)}”</blockquote><p>${esc(chosen.evidence.context)}</p><a href="${chosen.evidence.url}" target="_blank" rel="noopener noreferrer">Read ${esc(chosen.evidence.section)} ↗</a><div class="connection-sources"><a href="${chosen.earlier.url}" target="_blank" rel="noopener noreferrer">Earlier paper ↗</a><a href="${chosen.later.url}" target="_blank" rel="noopener noreferrer">Later paper ↗</a></div><small>Source checked ${esc(dateLabel(chosen.checked))}</small>` : "<p>Use Edition activity for the recorded mentions and traction changes.</p>"}</aside></div><nav class="connection-dates" aria-label="Connection timeline"><button type="button" data-connection-date="${dates[index + 1] || ""}" ${index >= dates.length - 1 ? "disabled" : ""} aria-label="Previous connection edition">←</button>${visible.map((date) => `<button type="button" data-connection-date="${date}" ${date === selected ? 'aria-current="date"' : ""} aria-label="Connections available by ${dateLabel(date)}">${date.slice(5).replace("-", "/")}</button>`).join("")}<button type="button" data-connection-date="${dates[index - 1] || ""}" ${index === 0 ? "disabled" : ""} aria-label="Next connection edition">→</button><span>Published by ${esc(dateLabel(selected))}</span></nav><div class="signal-footer evolution-footer"><p>Selected links from explicit source passages. Missing links mean unreviewed, not unrelated.</p><a href="#briefing/${selected}">Read this edition ↓</a></div>`;
  host
    .querySelector("[data-show-tracking]")
    ?.addEventListener("click", onTracking);
  host
    .querySelectorAll<HTMLButtonElement>("[data-connection]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        host.dataset.connection = button.dataset.connection;
        renderConnections(host, dates, selected, onDate, onTracking);
        host
          .querySelector<HTMLButtonElement>(
            '[data-connection][aria-pressed="true"]',
          )
          ?.focus();
      }),
    );
  host
    .querySelectorAll<HTMLButtonElement>("[data-connection-date]")
    .forEach((button) => {
      button.addEventListener("click", () =>
        onDate(button.dataset.connectionDate!),
      );
      button.addEventListener("keydown", (event) => {
        const step =
          event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next =
          dates[dates.indexOf(button.dataset.connectionDate!) + step];
        if (next) onDate(next);
      });
    });
  if (focusedConnection)
    [...host.querySelectorAll<HTMLButtonElement>("[data-connection]")]
      .find((button) => button.dataset.connection === focusedConnection)
      ?.focus();
  if (focusDate)
    host
      .querySelector<HTMLButtonElement>("[data-connection-date][aria-current]")
      ?.focus();
}
