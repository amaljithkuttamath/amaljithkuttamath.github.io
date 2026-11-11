import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import type { Citation } from "../../../lib/chitti/core";
import type { ShareStateV1 } from "../../../lib/chitti/share";
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

/**
 * Verification status as a badge whose detail (confidence, issues) expands
 * beneath it. Collapsed by default: the badge is the claim, the detail is the
 * receipt.
 */
export function VerificationBadge({ verification }: { verification: Verification }) {
  const label = `${verificationLabel(verification.status)}${verification.engine === "jev" ? " · Jev" : ""}`;
  return (
    <Collapsible
      className="cx-verdict"
      defaultIsOpen={false}
      trigger={
        <Badge
          variant={
            verification.status === "verified"
              ? "success"
              : verification.status === "unavailable"
                ? "neutral"
                : "warning"
          }
          label={label}
        />
      }
    >
      <div className="cx-verdict-detail">
        <Text as="p" type="supporting">
          Verifier confidence: {verification.confidence}. This is the verifier’s assessment.
        </Text>
        {verification.issues.map((issue, i) => (
          <Text as="p" type="supporting" key={i}>
            {issue}
          </Text>
        ))}
      </div>
    </Collapsible>
  );
}

const date = (value?: string) => {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

/**
 * One citation. "Snapshot" and "Fetched" stay distinct labels: a snapshot was
 * captured earlier and served from this site, a fetch was a live call.
 */
export function SourceCard({ citation: c }: { citation: Citation }) {
  return (
    <Card className="cx-source" padding={4}>
      <div className="cx-source-head">
        <Text type="supporting" className="cx-micro">
          {c.sourceLabel}
        </Text>
        <h3 className="cx-source-title">
          <a href={safeLink(c.url)} target="_blank" rel="noopener noreferrer">
            {c.indicatorName || c.indicatorId} ↗
          </a>
        </h3>
      </div>
      <MetadataList columns={2} className="cx-source-meta">
        <MetadataListItem label="Rows">{c.rowCount}</MetadataListItem>
        <MetadataListItem label="Coverage">
          {c.countries.join(", ") || "All countries"} · {c.yearRange?.start || "…"}–
          {c.yearRange?.end || "…"}
        </MetadataListItem>
        <MetadataListItem label={c.mirroredAt ? "Snapshot" : "Fetched"}>
          <time dateTime={c.mirroredAt || c.fetchedAt} title={c.mirroredAt || c.fetchedAt}>
            {date(c.mirroredAt || c.fetchedAt)}
          </time>
        </MetadataListItem>
        {c.sourceUpdated && (
          <MetadataListItem label="Source updated">{c.sourceUpdated}</MetadataListItem>
        )}
      </MetadataList>
      {c.requestUrl && (
        <a
          className="cx-source-request"
          href={safeLink(c.requestUrl)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Exact data request ↗
        </a>
      )}
    </Card>
  );
}
