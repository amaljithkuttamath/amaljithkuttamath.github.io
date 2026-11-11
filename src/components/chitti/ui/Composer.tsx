import { useEffect, useId, useMemo, useState, type ReactNode, type RefObject } from "react";
import { applySuggestion, preview as previewOf, suggest, type IndicatorSuggestion, type Suggestion } from "./suggest";
import { IconButton } from "./controls";
import { StopIcon, UpIcon } from "./icons";

const PREVIEW_TEXT = {
  choose: "pick a series",
  "try-direct": "tries a direct lookup first",
  model: "needs a model",
} as const;

/**
 * The one docked composer. Enter sends, Shift+Enter is a new line, Ctrl/⌘+Enter
 * also sends. As the user types, a debounced, offline type-ahead lists matching
 * indicators and countries (a combobox + listbox: arrows, Enter, Esc), and one
 * line beside the send button says what sending would do. Neither ever blocks
 * sending free text.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  placeholder,
  context,
  footer,
  sources,
  modelConnected,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  /** `pinned` is an indicator the user picked from the list, when its phrase
   * is still in the message. */
  onSend: (pinned: IndicatorSuggestion | null) => void;
  onStop: () => void;
  running: boolean;
  placeholder: string;
  context?: ReactNode;
  footer?: ReactNode;
  sources: string[];
  modelConnected: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const id = useId();
  const [debounced, setDebounced] = useState(value);
  const [open, setOpen] = useState(true);
  const [active, setActive] = useState(-1);
  const [pinned, setPinned] = useState<IndicatorSuggestion | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 120);
    return () => clearTimeout(t);
  }, [value]);
  useEffect(() => {
    if (!value) setPinned(null);
  }, [value]);
  const options = useMemo(() => (debounced ? suggest(debounced, sources) : []), [debounced, sources]);
  const preview = useMemo(() => previewOf(debounced, sources, modelConnected, pinned), [debounced, sources, modelConnected, pinned]);
  useEffect(() => setActive(-1), [options]);
  const listOpen = open && options.length > 0 && !running && debounced === value;
  const choose = (s: Suggestion) => {
    onChange(applySuggestion(value, s));
    if (s.kind === "indicator") setPinned(s);
    setOpen(false);
    inputRef.current?.focus();
  };
  const send = () => {
    if (!value.trim() || running) return;
    onSend(pinned);
    setPinned(null);
  };
  const indicators = options.map((o, i) => [o, i] as const).filter(([o]) => o.kind === "indicator");
  const countries = options.map((o, i) => [o, i] as const).filter(([o]) => o.kind === "country");
  const option = (o: Suggestion, i: number) => (
    <li
      key={`${o.kind}-${o.id}`}
      id={`${id}-opt-${i}`}
      role="option"
      aria-selected={i === active}
      className="cx-opt"
      onMouseDown={(e) => {
        e.preventDefault();
        choose(o);
      }}
      onMouseEnter={() => setActive(i)}
    >
      <span className="cx-opt-name">{o.name}</span>
      <span className="cx-code">{o.id}</span>
      {o.kind === "indicator" && o.alsoCalled && (
        <span className="cx-opt-aka">
          also called <b>{o.alsoCalled}</b>
        </span>
      )}
    </li>
  );
  return (
    <div className="cx-composer">
      {context}
      {listOpen && (
        <div className="cx-suggest">
          <ul id={`${id}-list`} role="listbox" aria-label="Suggestions">
            {indicators.length > 0 && (
              <li role="presentation" className="cx-suggest-group cx-micro">
                Indicators
              </li>
            )}
            {indicators.map(([o, i]) => option(o, i))}
            {countries.length > 0 && (
              <li role="presentation" className="cx-suggest-group cx-micro">
                Countries
              </li>
            )}
            {countries.map(([o, i]) => option(o, i))}
          </ul>
        </div>
      )}
      <textarea
        id="cw-question"
        ref={inputRef}
        className="cx-input-area"
        role="combobox"
        aria-label="Ask a data question"
        aria-autocomplete="list"
        aria-expanded={listOpen}
        aria-controls={listOpen ? `${id}-list` : undefined}
        aria-activedescendant={listOpen && active >= 0 ? `${id}-opt-${active}` : undefined}
        aria-describedby={`${id}-preview`}
        value={value}
        rows={1}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (listOpen && e.key === "ArrowDown") {
            e.preventDefault();
            setActive((active + 1) % options.length);
            return;
          }
          if (listOpen && e.key === "ArrowUp") {
            e.preventDefault();
            setActive(active <= 0 ? options.length - 1 : active - 1);
            return;
          }
          if (listOpen && e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            return;
          }
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
          e.preventDefault();
          if (listOpen && active >= 0 && !(e.metaKey || e.ctrlKey)) {
            choose(options[active]);
            return;
          }
          send();
        }}
      />
      <div className="cx-composer-row">
        {footer}
        <span id={`${id}-preview`} className="cx-preview" data-kind={preview?.kind} hidden={!preview || !value.trim()}>
          {preview?.kind === "direct"
            ? `${preview.source} · answered directly, no key needed`
            : preview
              ? PREVIEW_TEXT[preview.kind]
              : ""}
        </span>
        <span className="cx-hint" aria-hidden="true">
          Enter to send · Shift+Enter new line
        </span>
        {running ? (
          <IconButton className="cx-send" label="Stop" icon={<StopIcon />} onClick={onStop} />
        ) : (
          <IconButton className="cx-send" variant="primary" label="Send" icon={<UpIcon />} disabled={!value.trim()} onClick={send} />
        )}
      </div>
    </div>
  );
}
