import type { ReactNode } from "react";

/** Mono, uppercase, tracked micro-label: metadata, eyebrows and units. */
export function MicroLabel({
  children,
  as: As = "span",
  className = "",
}: {
  children: ReactNode;
  as?: "span" | "p" | "div";
  className?: string;
}) {
  return <As className={`cx-micro ${className}`.trim()}>{children}</As>;
}

/** A header for a page-level panel: eyebrow, heading, description, actions. */
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
  level?: 2 | 3;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <header className={`cx-panel-header ${className}`.trim()}>
      <div className="cx-panel-header-text">
        {eyebrow && <MicroLabel>{eyebrow}</MicroLabel>}
        <H className="cx-panel-title">{title}</H>
        {description && <p className="cx-panel-description">{description}</p>}
      </div>
      {actions && <div className="cx-panel-actions">{actions}</div>}
    </header>
  );
}

/** A labelled number: label, tabular value, optional detail line. */
export function Stat({
  label,
  value,
  detail,
  tone = "neutral",
  color,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "neutral" | "up" | "down";
  color?: string;
}) {
  return (
    <span className="cx-stat" data-tone={tone}>
      <span className="cx-stat-label">
        {color && <span className="cx-swatch" style={{ background: color }} aria-hidden="true" />}
        {label}
      </span>
      <span className="cx-stat-value">{value}</span>
      {detail && <span className="cx-stat-detail">{detail}</span>}
    </span>
  );
}
