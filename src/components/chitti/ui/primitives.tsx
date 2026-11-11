import type { ReactNode } from "react";
import { Heading, type HeadingLevel } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";

/**
 * Small composites Chitti repeats on every screen. Each is built from Astryx
 * primitives; `chitti.css` gives them their HUD treatment through tokens.
 */

/** Mono, uppercase, tracked micro-label: metadata, eyebrows and units. */
export function MicroLabel({
  children,
  as = "span",
  className = "",
}: {
  children: ReactNode;
  as?: "span" | "p" | "div";
  className?: string;
}) {
  return (
    <Text as={as} type="supporting" className={`cx-micro ${className}`.trim()}>
      {children}
    </Text>
  );
}

/**
 * A header for any panel: optional eyebrow, a heading, optional description
 * and an actions slot that wraps under the title on narrow screens.
 */
export function PanelHeader({
  eyebrow,
  title,
  level = 2,
  description,
  actions,
  className = "",
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  level?: HeadingLevel;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`cx-panel-header ${className}`.trim()}>
      <div className="cx-panel-header-text">
        {eyebrow && <MicroLabel>{eyebrow}</MicroLabel>}
        <Heading level={level} className="cx-panel-title">
          {title}
        </Heading>
        {description && (
          <Text as="p" type="supporting" className="cx-panel-description">
            {description}
          </Text>
        )}
      </div>
      {actions && <div className="cx-panel-actions">{actions}</div>}
    </header>
  );
}

/**
 * A labelled number: micro-label, tabular value, optional detail line. Used
 * for plotted changes, the explanation's evidence and dashboard summaries.
 */
export function Stat({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "neutral" | "up" | "down";
}) {
  return (
    <span className="cx-stat" data-tone={tone}>
      <span className="cx-stat-label">{label}</span>
      <span className="cx-stat-value">{value}</span>
      {detail && <span className="cx-stat-detail">{detail}</span>}
    </span>
  );
}
