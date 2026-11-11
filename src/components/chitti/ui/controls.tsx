import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/**
 * Chitti's own small control set: native elements first (button, select,
 * dialog, details, input), styled from the one token block in chitti.css.
 * Every control takes a visible label or an explicit accessible name.
 */

type Variant = "default" | "primary" | "ghost" | "quiet";
type Size = "sm" | "md";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  label?: ReactNode;
  icon?: ReactNode;
  variant?: Variant;
  size?: Size;
  /** Disabled controls stay focusable (aria-disabled) so they keep their
   * place in the tab order and can still be read; clicks are ignored. */
  disabled?: boolean;
  href?: string;
  target?: string;
  rel?: string;
}

export function Button({
  label,
  icon,
  variant = "default",
  size = "md",
  disabled = false,
  className = "",
  children,
  href,
  target,
  rel,
  type = "button",
  onClick,
  ...rest
}: ButtonProps) {
  const cls = `cx-btn ${className}`.trim();
  const content = (
    <>
      {icon && <span className="cx-btn-icon" aria-hidden="true">{icon}</span>}
      {label !== undefined && <span className="cx-btn-label">{label}</span>}
      {children}
    </>
  );
  if (href)
    return (
      <a
        className={cls}
        data-variant={variant}
        data-size={size}
        href={href}
        target={target}
        rel={rel}
      >
        {content}
      </a>
    );
  return (
    <button
      {...rest}
      type={type}
      className={cls}
      data-variant={variant}
      data-size={size}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {content}
    </button>
  );
}

/** An icon-only button: the label is its accessible name and its tooltip. */
export function IconButton({
  label,
  icon,
  ...rest
}: Omit<ButtonProps, "label" | "children"> & { label: string; icon: ReactNode }) {
  return (
    <Button
      {...rest}
      className={`cx-icon-btn ${rest.className || ""}`.trim()}
      aria-label={label}
      title={label}
      icon={icon}
    />
  );
}

/** A rounded suggestion/choice chip (follow-ups, "switch to" choices). */
export function Chip({
  label,
  note,
  onClick,
  disabled,
  pressed,
}: {
  label: ReactNode;
  note?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className="cx-chip"
      aria-disabled={disabled || undefined}
      aria-pressed={pressed}
      onClick={() => !disabled && onClick()}
    >
      <span>{label}</span>
      {note && <span className="cx-chip-note">{note}</span>}
    </button>
  );
}

/**
 * A token in the chart's interpretation row: an optional key ("Showing",
 * "Years"), a value, an optional code, an optional colour dot and an optional
 * remove control. Read-only tokens render as plain spans.
 */
export function Token({
  k,
  children,
  code,
  color,
  onRemove,
  removeLabel,
  disabled,
  tone,
}: {
  k?: string;
  children: ReactNode;
  code?: string;
  color?: string;
  onRemove?: () => void;
  removeLabel?: string;
  disabled?: boolean;
  tone?: "warn";
}) {
  return (
    <span className="cx-token" data-tone={tone}>
      {color && <span className="cx-dot" style={{ background: color }} aria-hidden="true" />}
      {k && <span className="cx-token-key">{k}</span>}
      <span className="cx-token-value">{children}</span>
      {code && <span className="cx-code">{code}</span>}
      {onRemove && (
        <button
          type="button"
          className="cx-token-x"
          aria-label={removeLabel || "Remove"}
          title={removeLabel || "Remove"}
          aria-disabled={disabled || undefined}
          onClick={() => !disabled && onRemove()}
        >
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" />
          </svg>
        </button>
      )}
    </span>
  );
}

/** A segmented control: native radio inputs, so arrow keys and the radio role
 * come for free. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const name = useId();
  return (
    <div className="cx-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className="cx-seg-item">
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={disabled}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** A real tablist: roving tabindex, arrow keys, Home/End. */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  idBase,
}: {
  label: string;
  tabs: { value: T; label: string; count?: number | null }[];
  value: T;
  onChange: (value: T) => void;
  idBase: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const move = (e: KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const next =
      e.key === "ArrowRight"
        ? index === last ? 0 : index + 1
        : e.key === "ArrowLeft"
          ? index === 0 ? last : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].value);
    refs.current[tabs[next].value]?.focus();
  };
  return (
    <div className="cx-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.value}
          ref={(el) => {
            refs.current[t.value] = el;
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${t.value}`}
          aria-controls={`${idBase}-panel`}
          aria-selected={value === t.value}
          tabIndex={value === t.value ? 0 : -1}
          className="cx-tab"
          onClick={() => onChange(t.value)}
          onKeyDown={(e) => move(e, i)}
        >
          {t.label}
          {t.count !== undefined && t.count !== null && (
            <span className="cx-tab-count">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export type MenuItem =
  | {
      type?: "item";
      label: string;
      description?: string;
      icon?: ReactNode;
      checked?: boolean;
      disabled?: boolean;
      danger?: boolean;
      onSelect: () => void;
    }
  | { type: "section"; title: string; items: MenuItem[] }
  | { type: "divider" };

/**
 * A menu button: aria-haspopup="menu", a popup with role="menu" and
 * menuitems, arrow keys / Home / End, Esc and outside click close it, focus
 * returns to the trigger.
 */
export function Menu({
  label,
  trigger,
  items,
  align = "start",
  placement = "below",
  size = "sm",
  variant = "default",
  icon,
  disabled,
  className = "",
  open: controlledOpen,
  onOpenChange,
}: {
  /** Accessible name of the trigger. */
  label: string;
  /** Visible trigger content (defaults to the label). */
  trigger?: ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  placement?: "below" | "above";
  size?: Size;
  variant?: Variant;
  icon?: ReactNode;
  disabled?: boolean;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (value: boolean) => {
    setOwnOpen(value);
    onOpenChange?.(value);
  };
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const focusItem = (index: number) => {
    const nodes = list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]');
    if (!nodes?.length) return;
    const i = (index + nodes.length) % nodes.length;
    nodes[i].focus();
  };
  useEffect(() => {
    if (!open) return;
    focusItem(0);
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const nodes = [...(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') || [])];
    const at = nodes.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(at + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(nodes.length - 1); }
    else if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); close(); }
  };
  const renderItems = (entries: MenuItem[], prefix: string): ReactNode =>
    entries.map((item, i) => {
      if (item.type === "divider") return <div key={`${prefix}${i}`} role="separator" className="cx-menu-sep" />;
      if (item.type === "section")
        return (
          <div key={`${prefix}${i}`} role="group" aria-label={item.title} className="cx-menu-group">
            <div className="cx-menu-title" aria-hidden="true">{item.title}</div>
            {renderItems(item.items, `${prefix}${i}-`)}
          </div>
        );
      return (
        <button
          key={`${prefix}${i}`}
          type="button"
          role={item.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={item.checked}
          aria-disabled={item.disabled || undefined}
          tabIndex={-1}
          className="cx-menu-item"
          data-danger={item.danger || undefined}
          onClick={() => {
            if (item.disabled) return;
            close();
            item.onSelect();
          }}
        >
          {item.icon && <span className="cx-btn-icon" aria-hidden="true">{item.icon}</span>}
          <span className="cx-menu-text">
            <span className="cx-menu-label">{item.label}</span>
            {item.description && <span className="cx-menu-desc">{item.description}</span>}
          </span>
          {item.checked && (
            <svg className="cx-menu-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          )}
        </button>
      );
    });
  return (
    <div className={`cx-menu ${className}`.trim()} ref={root} data-align={align} data-placement={placement}>
      <button
        ref={button}
        type="button"
        className="cx-btn"
        data-variant={variant}
        data-size={size}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={trigger ? label : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={(e) => {
          if (!disabled && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon && <span className="cx-btn-icon" aria-hidden="true">{icon}</span>}
        <span className="cx-btn-label">{trigger ?? label}</span>
        <svg className="cx-caret" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      {open && (
        <div id={id} ref={list} role="menu" aria-label={label} className="cx-menu-pop" onKeyDown={onKey}>
          {renderItems(items, "")}
        </div>
      )}
    </div>
  );
}

/**
 * A modal dialog on the native <dialog>: showModal gives the focus trap,
 * inert background and Esc; focus returns to whatever opened it.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  footer,
  className = "",
  labelledBy,
  as = "div",
  onSubmit,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  labelledBy?: string;
  as?: "div" | "form";
  onSubmit?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    if (dialog && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    }
    const onCancel = (e: Event) => {
      e.preventDefault();
      close.current();
    };
    dialog?.addEventListener("cancel", onCancel);
    return () => {
      dialog?.removeEventListener("cancel", onCancel);
      if (dialog?.open) dialog.close();
      opener?.focus?.();
    };
  }, []);
  const Body = as;
  return (
    <dialog
      ref={ref}
      className={`cx-dialog ${className}`.trim()}
      aria-labelledby={labelledBy || titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close.current();
        }
      }}
    >
      <Body
        className="cx-dialog-body"
        {...(as === "form"
          ? {
              onSubmit: (e: React.FormEvent) => {
                e.preventDefault();
                onSubmit?.();
              },
              "aria-labelledby": titleId,
            }
          : {})}
      >
        <header className="cx-dialog-head">
          <div>
            <h2 id={titleId} className="cx-dialog-title">{title}</h2>
            {description && <p className="cx-dialog-desc">{description}</p>}
          </div>
          <IconButton
            variant="ghost"
            size="sm"
            label="Close dialog"
            icon={
              <svg viewBox="0 0 16 16" width="14" height="14">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            }
            onClick={() => close.current()}
          />
        </header>
        {children && <div className="cx-dialog-main">{children}</div>}
        {footer && <footer className="cx-dialog-foot">{footer}</footer>}
      </Body>
    </dialog>
  );
}

/** A two-button confirmation dialog. */
export function Confirm({
  title,
  description,
  cancelLabel = "Cancel",
  actionLabel,
  onCancel,
  onAction,
  danger,
}: {
  title: string;
  description: string;
  cancelLabel?: string;
  actionLabel: string;
  onCancel: () => void;
  onAction: () => void;
  danger?: boolean;
}) {
  return (
    <Dialog
      title={title}
      description={description}
      onClose={onCancel}
      className="cx-confirm"
      footer={
        <>
          <Button variant="ghost" label={cancelLabel} onClick={onCancel} />
          <Button variant={danger ? "default" : "primary"} label={actionLabel} onClick={onAction} />
        </>
      }
    />
  );
}

/** A labelled text/password/search input. */
export function TextField({
  label,
  value,
  onChange,
  type = "text",
  description,
  hideLabel,
  placeholder,
  disabled,
  autoFocus,
  list,
  autoComplete,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password" | "search";
  description?: string;
  hideLabel?: boolean;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  list?: string;
  autoComplete?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`cx-field ${className}`.trim()}>
      <label htmlFor={id} className={hideLabel ? "cx-sr-only" : "cx-field-label"}>
        {label}
      </label>
      <input
        id={id}
        className="cx-input"
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        list={list}
        autoComplete={autoComplete}
        aria-describedby={description ? `${id}-d` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {description && (
        <p id={`${id}-d`} className="cx-field-desc">
          {description}
        </p>
      )}
    </div>
  );
}

/** A labelled native <select>. */
export function Select({
  label,
  value,
  onChange,
  options,
  hideLabel,
  disabled,
  placeholder,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  hideLabel?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={`cx-field ${className}`.trim()} data-inline={hideLabel || undefined}>
      <label htmlFor={id} className={hideLabel ? "cx-sr-only" : "cx-field-label"}>
        {label}
      </label>
      <select
        id={id}
        className="cx-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {placeholder !== undefined && (
          <option value="" disabled={value !== ""}>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  description?: string;
}) {
  const id = useId();
  return (
    <div className="cx-check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? `${id}-d` : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id}>{label}</label>
      {description && (
        <p id={`${id}-d`} className="cx-field-desc">
          {description}
        </p>
      )}
    </div>
  );
}

/** A native disclosure. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details className={`cx-disclosure ${className}`.trim()} open={defaultOpen || undefined}>
      <summary>{summary}</summary>
      <div className="cx-disclosure-body">{children}</div>
    </details>
  );
}

/** A status/notice strip. `role="status"` sits on the message itself. */
export function Notice({
  tone = "info",
  title,
  children,
  actions,
  onDismiss,
}: {
  tone?: "info" | "warn" | "error";
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className="cx-notice" data-tone={tone}>
      <span className="cx-notice-dot" aria-hidden="true" />
      <div className="cx-notice-text">
        <p role="status" className="cx-notice-title">{title}</p>
        {children && <div className="cx-notice-body">{children}</div>}
      </div>
      {(actions || onDismiss) && (
        <div className="cx-notice-actions">
          {actions}
          {onDismiss && (
            <IconButton
              variant="ghost"
              size="sm"
              label="Dismiss notice"
              icon={
                <svg viewBox="0 0 16 16" width="12" height="12">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              }
              onClick={onDismiss}
            />
          )}
        </div>
      )}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return <span className="cx-spinner" role="img" aria-label={label} />;
}
