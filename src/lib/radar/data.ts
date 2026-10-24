export const RAW =
  "https://raw.githubusercontent.com/amaljithkuttamath/ai-radar/main/";
export const REPO = "https://github.com/amaljithkuttamath/ai-radar";
export const escapeHTML = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function safeURL(value: unknown): string | null {
  try {
    if (typeof value !== "string") return null;
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}
export function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function dateLabel(date: string) {
  return validDate(date)
    ? new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(date + "T12:00:00Z"))
    : "Undated edition";
}
export function ageLabel(value: unknown, now = Date.now()) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  const diff = (now - time) / 3600000;
  if (!Number.isFinite(diff) || diff < 0) return "Time unavailable";
  if (diff < 1) return "Less than an hour ago";
  if (diff < 24) return `${Math.floor(diff)}h ago`;
  return `${Math.floor(diff / 24)}d ago`;
}
export function sourceGroup(id: string) {
  const prefix = id.split(":")[0];
  return (
    (
      {
        arxiv: "Papers",
        hfpaper: "Papers",
        hfmodel: "Models",
        hfdataset: "Datasets",
        ghrepo: "Code",
        blog: "Lab posts",
      } as Record<string, string>
    )[prefix] || "Other"
  );
}
export interface Row {
  id: string;
  title: string;
  url: string;
  score: number;
  firstSeen: string;
  lastSeen: string;
  group: string;
  history: number[];
}
export function parseState(value: unknown): Row[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("The evidence index has an unexpected format.");
  return Object.entries(value).flatMap(([id, s]: [string, any]) => {
    if (
      !s ||
      typeof s !== "object" ||
      typeof s.title !== "string" ||
      !safeURL(s.url)
    )
      return [];
    return [
      {
        id,
        title: s.title,
        url: safeURL(s.url)!,
        score:
          typeof s.score === "number" && Number.isFinite(s.score)
            ? Math.max(0, Math.min(5, s.score))
            : 0,
        firstSeen: validDate(s.first_seen || "") ? s.first_seen : "",
        lastSeen: validDate(s.last_seen || "") ? s.last_seen : "",
        group: sourceGroup(id),
        history: Array.isArray(s.mag_history)
          ? s.mag_history.filter(
              (v: unknown) =>
                typeof v === "number" && Number.isFinite(v) && v >= 0,
            )
          : [],
      },
    ];
  });
}
export function filterRows(
  rows: Row[],
  query = "",
  group = "All",
  sort = "score",
  highOnly = false,
) {
  return rows
    .filter(
      (r) =>
        (!highOnly || r.score >= 3) &&
        (group === "All" || r.group === group) &&
        `${r.title} ${r.id} ${r.group}`
          .toLowerCase()
          .includes(query.toLowerCase().trim()),
    )
    .sort((a, b) =>
      sort === "newest"
        ? b.firstSeen.localeCompare(a.firstSeen) || b.score - a.score
        : b.score - a.score ||
          b.lastSeen.localeCompare(a.lastSeen) ||
          a.title.localeCompare(b.title),
    );
}
export function parseArchive(md: string) {
  const rows = new Map<string, { date: string; teaser: string }>();
  for (const line of md.split("\n")) {
    const m = line.match(
      /^\|\s*\[(\d{4}-\d{2}-\d{2})\]\([^)]*\)\s*\|\s*(.*?)\s*\|\s*$/,
    );
    if (m && validDate(m[1]))
      rows.set(m[1], {
        date: m[1],
        teaser: m[2]
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/<[^>]+>/g, "")
          .replace(/[*_`]/g, "")
          .replace(/\\\|/g, "|"),
      });
  }
  return [...rows.values()].sort((a, b) => b.date.localeCompare(a.date));
}
