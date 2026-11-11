import type { Citation } from "../../../lib/chitti/core";
import type { ShareStateV1 } from "../../../lib/chitti/share";
import type { Analysis } from "../../../lib/chitti/workspace/model";
import { safeLink } from "../../../lib/chitti/workspace/model";

type Verification = NonNullable<ShareStateV1["verification"]>;

/** The badge wording says exactly what the verifier returned and no more. */
export function verificationLabel(status: Verification["status"]) {
  return status === "verified"
    ? "Evidence check passed"
    : status === "unavailable"
      ? "Evidence check unavailable"
      : "Evidence not verified";
}

const date = (value?: string) => {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
};

/** "retrieved" for a live fetch, "snapshot" for the same-origin capture. */
export const fetchedLabel = (c: Citation) =>
  c.mirroredAt ? `snapshot ${date(c.mirroredAt)}` : `retrieved ${date(c.fetchedAt)}`;

/**
 * The check badge under an answer. It shows exactly what the verifier
 * returned (label, then confidence and issues on expand). An answer that was
 * never checked says how it was produced instead of looking checked.
 */
export function CheckBadge({
  verification,
  origin,
}: {
  verification: ShareStateV1["verification"];
  origin: Analysis["origin"];
}) {
  if (verification) {
    const tone = verification.status === "verified" ? "ok" : verification.status === "unavailable" ? undefined : "warn";
    return (
      <details className="cx-checkbadge" data-tone={tone}>
        <summary>
          {verificationLabel(verification.status)}
          {verification.engine === "jev" ? " · Jev" : ""}
        </summary>
        <div className="cx-checkbadge-detail">
          <p>Verifier confidence: {verification.confidence}. This is the verifier’s own assessment.</p>
          {verification.issues.map((issue, i) => (
            <p key={i}>{issue}</p>
          ))}
        </div>
      </details>
    );
  }
  const how =
    origin === "direct"
      ? "Matched to a known series · no language model involved"
      : origin === "view"
        ? "View changed here · no model, no new fetch"
        : origin === "example"
          ? "Recorded example · not checked by a verifier"
          : origin === "shared"
            ? "Shared snapshot · not checked by a verifier"
            : "Not checked by a verifier";
  return (
    <div className="cx-checkbadge" data-tone={origin === "direct" ? "ok" : undefined}>
      <span>{how}</span>
    </div>
  );
}

/** The numbered source list under an answer. */
export function SourceLines({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  return (
    <ol className="cx-srcs" aria-label="Sources">
      {citations.map((c, i) => (
        <li key={c.id}>
          <b aria-hidden="true">{i + 1}</b>
          <span>
            {c.sourceLabel} ·{" "}
            <a href={safeLink(c.url)} target="_blank" rel="noopener noreferrer">
              {c.indicatorName || c.indicatorId} ↗
            </a>{" "}
            · {fetchedLabel(c)}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * One citation in the Sources tab. "Snapshot" and "Fetched" stay distinct
 * labels: a snapshot was captured earlier and served from this site, a fetch
 * was a live call.
 */
export function SourceCard({ citation: c }: { citation: Citation }) {
  return (
    <article className="cx-source">
      <span className="cx-micro">{c.sourceLabel}</span>
      <h3 className="cx-source-title">
        <a href={safeLink(c.url)} target="_blank" rel="noopener noreferrer">
          {c.indicatorName || c.indicatorId} ↗
        </a>
      </h3>
      <dl className="cx-source-meta">
        <div>
          <dt>Series</dt>
          <dd className="cx-mono">{c.indicatorId}</dd>
        </div>
        <div>
          <dt>Rows</dt>
          <dd>{c.rowCount}</dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>
            {c.countries.join(", ") || "All countries"} · {c.yearRange?.start || "…"}–{c.yearRange?.end || "…"}
          </dd>
        </div>
        <div>
          <dt>{c.mirroredAt ? "Snapshot" : "Fetched"}</dt>
          <dd>
            <time dateTime={c.mirroredAt || c.fetchedAt} title={c.mirroredAt || c.fetchedAt}>
              {date(c.mirroredAt || c.fetchedAt)}
            </time>
          </dd>
        </div>
        {c.sourceUpdated && (
          <div>
            <dt>Source updated</dt>
            <dd>{c.sourceUpdated}</dd>
          </div>
        )}
      </dl>
      {c.requestUrl && (
        <a className="cx-source-request" href={safeLink(c.requestUrl)} target="_blank" rel="noopener noreferrer">
          Exact data request ↗
        </a>
      )}
    </article>
  );
}
