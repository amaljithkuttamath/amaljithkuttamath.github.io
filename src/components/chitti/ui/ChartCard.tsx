import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ShareStateV1 } from "../../../lib/chitti/share";
import type { ChartSpec } from "../../../lib/chitti/core";
import { COUNTRIES } from "../../../lib/chitti/core";
import type { FastPathPlan, SeriesCandidate } from "../../../lib/chitti/fastpath";
import type { Analysis } from "../../../lib/chitti/workspace/model";
import { prepareChart, seriesIdentity } from "../../../lib/chitti/chart-contract";
import { chartTypes, recentStart } from "../../../lib/chitti/workspace/steering";
import { changeKey, lineDomain } from "../../../lib/chitti/chart-insights";
import Chart from "../Chart";
import YearRange from "../YearRange";
import ExamplePlot from "../ExamplePlot";
import { Button, IconButton, Segmented, Select, Tabs, TextField, Token } from "./controls";
import { SourceCard } from "./Evidence";
import { interpret, provenance } from "./interpretation";
import { ExpandIcon, SendIcon, SparkIcon } from "./icons";

/** Whether controls in a rendered result may act (false while a run is busy). */
export const ResultInteraction = createContext(true);
/** The workspace has one docked composer, so the card hides its own ask box. */
export const InlineComposer = createContext(false);

/**
 * What the workspace knows about the turn a card belongs to and lets the card
 * do: re-run a direct lookup with an edited plan, open the chart in the panel.
 */
export interface CardContextValue {
  turnId?: string;
  direct?: Analysis["direct"];
  onDirect?: (plan: FastPathPlan, series: SeriesCandidate, question: string) => void;
  onExpand?: (opener: HTMLElement) => void;
  openInPanel?: boolean;
}
export const CardContext = createContext<CardContextValue>({});

const PAGE = 50;
const ALL = "__all";
const number = new Intl.NumberFormat("en", { maximumFractionDigits: 6 });
const typeLabel = (type: string) => (type === "grouped-bar" ? "Grouped" : type === "bar" ? "Bars" : type[0].toUpperCase() + type.slice(1));
type Tab = "Chart" | "Data" | "Sources";

/** "+ country": a small search over the country list, offline. */
function AddCountry({ exclude, onAdd, disabled }: { exclude: string[]; onAdd: (code: string, name: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const root = useRef<HTMLSpanElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    return COUNTRIES.filter((c) => c.region !== "Aggregates" && !exclude.includes(c.id) && c.name.toLowerCase().split(/[\s,]+/).some((w) => w.startsWith(t)))
      .slice(0, 6);
  }, [q, exclude]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const close = () => {
    setOpen(false);
    setQ("");
    opener.current?.focus();
  };
  return (
    <span className="cx-anchor" ref={root}>
      <button ref={opener} type="button" className="cx-token-add" aria-expanded={open} aria-disabled={disabled || undefined} onClick={() => !disabled && setOpen(!open)}>
        + country
      </button>
      {open && (
        <div className="cx-pop" role="group" aria-label="Add a country" onKeyDown={(e) => e.key === "Escape" && close()}>
          <TextField label="Country" value={q} onChange={setQ} placeholder="Type a country" autoFocus autoComplete="off" />
          <ul className="cx-pop-list">
            {matches.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => { onAdd(c.id, c.name); close(); }}>
                  {c.name} <span className="cx-code">{c.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

/** The Years token on a direct answer: re-runs the lookup for a new range. */
function YearsToken({ start, end, onApply, disabled }: { start: number; end: number; onApply: (a: number, b: number) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState(String(start));
  const [b, setB] = useState(String(end));
  const opener = useRef<HTMLButtonElement>(null);
  const thisYear = new Date().getFullYear();
  const valid = Number.isInteger(+a) && Number.isInteger(+b) && +a >= 1800 && +b <= thisYear && +a < +b;
  return (
    <span className="cx-anchor">
      <button ref={opener} type="button" className="cx-token" aria-expanded={open} aria-label={`Years ${start} to ${end}, change`} aria-disabled={disabled || undefined} onClick={() => !disabled && setOpen(!open)}>
        <span className="cx-token-key">Years</span>
        <span className="cx-token-value">{start} – {end}</span>
      </button>
      {open && (
        <form
          className="cx-pop"
          aria-label="Change years"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              opener.current?.focus();
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            setOpen(false);
            onApply(+a, +b);
          }}
        >
          <div className="cx-year-range">
            <input className="cx-input" type="number" aria-label="From year" value={a} min={1800} max={thisYear} onChange={(e) => setA(e.target.value)} autoFocus />
            <span aria-hidden="true">–</span>
            <input className="cx-input" type="number" aria-label="To year" value={b} min={1800} max={thisYear} onChange={(e) => setB(e.target.value)} />
          </div>
          <Button type="submit" size="sm" variant="primary" label="Look up these years" disabled={!valid} />
        </form>
      )}
    </span>
  );
}

/** The interpretation row: what is shown, as tokens. Live on a direct answer. */
export function TokenRow({ result }: { result: ShareStateV1 }) {
  const ctx = useContext(CardContext);
  const enabled = useContext(ResultInteraction);
  const view = interpret(result, ctx.direct);
  const live = view.live && !!ctx.onDirect && !!ctx.direct;
  const direct = ctx.direct;
  const rerun = (plan: FastPathPlan, question: string) => direct && ctx.onDirect?.(plan, direct.series, question);
  if (!view.indicator && !view.series.length && !view.years) return null;
  return (
    <div className="cx-interp" role="group" aria-label={live ? "What is shown (editable)" : "What is shown"}>
      {view.indicator && (
        <Token k="Showing" code={view.indicator.id}>
          {view.indicator.name}
        </Token>
      )}
      {view.series.map((s) => (
        <Token
          key={s.id}
          color={s.color}
          disabled={!enabled}
          onRemove={
            live && view.series.length > 1 && s.iso3
              ? () => {
                  const i = direct!.plan.countries.indexOf(s.iso3!);
                  rerun(
                    { ...direct!.plan, countries: direct!.plan.countries.filter((_, k) => k !== i), countryNames: direct!.plan.countryNames.filter((_, k) => k !== i) },
                    `Remove ${s.name}`,
                  );
                }
              : undefined
          }
          removeLabel={`Remove ${s.name} and look it up again`}
        >
          {s.name}
        </Token>
      ))}
      {live && direct!.plan.countries.length < 6 && (
        <AddCountry
          exclude={direct!.plan.countries}
          disabled={!enabled}
          onAdd={(code, name) =>
            rerun({ ...direct!.plan, countries: [...direct!.plan.countries, code], countryNames: [...direct!.plan.countryNames, name] }, `Add ${name}`)
          }
        />
      )}
      {view.years &&
        (live ? (
          <YearsToken
            start={view.years.start}
            end={view.years.end}
            disabled={!enabled}
            onApply={(a, b) => rerun({ ...direct!.plan, yearStart: a, yearEnd: b, chartType: "line" }, `Years ${a}–${b}`)}
          />
        ) : (
          <Token k="Years">
            {view.years.start} – {view.years.end}
          </Token>
        ))}
    </div>
  );
}

/** "Showing X. Switch to: …" — the other series the phrase fits. */
export function SwitchRow() {
  const ctx = useContext(CardContext);
  const enabled = useContext(ResultInteraction);
  const direct = ctx.direct;
  if (!direct?.alternatives.length || !ctx.onDirect) return null;
  return (
    <div className="cx-switch" role="group" aria-label="Other series this phrase fits">
      <span>
        Showing <strong>{direct.series.name}</strong>. Switch to:
      </span>
      {direct.alternatives.map((alt) => (
        <button
          key={alt.id}
          type="button"
          className="cx-chip"
          aria-disabled={!enabled || undefined}
          onClick={() => enabled && ctx.onDirect!(direct.plan, alt, `Switch to ${alt.name}`)}
        >
          {alt.name}
        </button>
      ))}
    </div>
  );
}

/** Provenance along the card's bottom edge, so it survives a screenshot. */
export function ProvenanceLine({ result }: { result: ShareStateV1 }) {
  const p = provenance(result);
  if (!p) return null;
  const parts = [p.id, p.unit, p.coverage, p.latest !== undefined ? `latest data ${p.latest}` : undefined, p.when].filter(Boolean);
  return (
    <p className="cx-prov">
      <b>{p.source}</b>
      {parts.map((part, i) => (
        <span key={i}>
          <i aria-hidden="true">· </i>
          {part}
        </span>
      ))}
      {p.more > 0 && (
        <span>
          <i aria-hidden="true">· </i>+{p.more} more {p.more === 1 ? "series" : "series"}
        </span>
      )}
      {p.url && (
        <a href={p.url} target="_blank" rel="noopener noreferrer">
          Exact series ↗
        </a>
      )}
    </p>
  );
}

function DataTab({ result }: { result: ShareStateV1 }) {
  const [query, setQuery] = useState("");
  const [pageWanted, setPage] = useState(0);
  const filtered = useMemo(
    () => result.rows.filter((r) => `${r.country} ${r.year} ${r.indicator || ""}`.toLowerCase().includes(query.toLowerCase())),
    [result.rows, query],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  // Clamped at render: a surface update can replace the rows with a shorter
  // set (draft → final) while a later page is open.
  const page = Math.min(pageWanted, pages - 1);
  return (
    <div className="cx-data">
      <div className="cx-data-bar">
        <TextField type="search" label="Filter rows" hideLabel value={query} onChange={(v) => { setQuery(v); setPage(0); }} placeholder="Filter by country, year or indicator" />
        <span className="cx-micro">
          {filtered.length} rows{result.lossy ? " · full rows omitted from this share" : ""}
        </span>
      </div>
      <div className="cx-table-scroll">
        <table className="cx-table">
          <thead>
            <tr>
              <th scope="col">Country</th>
              <th scope="col" className="cx-num">Year</th>
              <th scope="col" className="cx-num">Value</th>
              <th scope="col">Indicator</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(page * PAGE, (page + 1) * PAGE).map((r, i) => (
              <tr key={i}>
                <td>{r.country}</td>
                <td className="cx-num">{r.year}</td>
                <td className="cx-num">{r.value === null ? <span className="cx-missing">Missing</span> : number.format(r.value)}</td>
                <td className="cx-indicator">{r.indicator}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!filtered.length && <p className="cx-empty">No matching rows.</p>}
      {filtered.length > 0 && (
        <nav className="cx-pager" aria-label="Data pages">
          <Button size="sm" variant="ghost" label="Previous" aria-label="Go to previous page" disabled={page === 0} onClick={() => setPage(page - 1)} />
          <span>
            Page {page + 1} of {pages}
          </span>
          <Button size="sm" variant="ghost" label="Next" aria-label="Go to next page" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} />
        </nav>
      )}
    </div>
  );
}

function SourcesTab({ result, spec }: { result: ShareStateV1; spec: ChartSpec | null }) {
  return (
    <div className="cx-sources">
      {spec?.series.some((s) => s.evidence) && (
        <section className="cx-methods" aria-label="Chart methods">
          <span className="cx-micro">Chart methods</span>
          {spec.series
            .filter((s) => s.evidence)
            .map((s) => (
              <p key={seriesIdentity(s)}>
                <strong>{s.name}</strong>
                {s.unit || spec.unit ? ` · ${s.unit || spec.unit}` : ""}:{" "}
                {s.evidence!.mode === "derived" ? s.evidence!.method || "Method not supplied" : "Observed source values"}
                {` · ${s.evidence!.citationIds.map((id) => result.citations.find((c) => c.id === id)?.indicatorName || id).join("; ")}`}
              </p>
            ))}
        </section>
      )}
      {result.citations.map((c) => (
        <SourceCard key={c.id} citation={c} />
      ))}
      {!result.citations.length && <p className="cx-empty">No source records accompany this result.</p>}
    </div>
  );
}

/** View controls that change only the displayed chart (no model, no fetch). */
function ViewTools({ result, onSteer, live }: { result: ShareStateV1; onSteer: (name: string, value: string) => void; live: boolean }) {
  const enabled = useContext(ResultInteraction);
  const inlineComposer = useContext(InlineComposer);
  const [steer, setSteer] = useState("");
  const chart = result.spec ? prepareChart(result.spec) : null;
  const choices =
    result.spec && result.spec.series.length > 1
      ? result.spec.series.map((s) => s.name)
      : result.spec && ["bar", "grouped-bar"].includes(result.spec.type)
        ? [...new Set(result.spec.series.flatMap((s) => s.data.map(([x]) => String(x))))]
        : [];
  return (
    <fieldset className="cx-viewbar" disabled={!enabled}>
      <legend className="cx-sr-only">Work with this view</legend>
      {chart && chart.series.length > 1 && (
        <Select
          label="Highlight series"
          hideLabel
          disabled={!enabled}
          value={chart.highlight?.[0] || ALL}
          onChange={(value) => onSteer("highlight", value === ALL ? "" : value)}
          options={[{ value: ALL, label: "Highlight: none" }, ...chart.series.map((s) => ({ value: seriesIdentity(s), label: `Highlight: ${s.name}` }))]}
        />
      )}
      {choices.length > 1 && (
        <Select
          label="Focus chart"
          hideLabel
          disabled={!enabled}
          placeholder="Focus on…"
          value=""
          onChange={(value) => value && onSteer("focus", value)}
          options={choices.map((name) => ({ value: name, label: name }))}
        />
      )}
      {chart && !live && (
        <YearRange key={JSON.stringify(chart.series.map((s) => s.data.map(([x]) => x)))} spec={chart} isDisabled={!enabled} onApply={(value) => onSteer("years", value)} />
      )}
      <span className="cx-viewbar-end">
        {recentStart(result) !== null && <Button label="Last 10 years" size="sm" variant="ghost" disabled={!enabled} onClick={() => onSteer("recent", "")} />}
        <Button
          label="Explain changes"
          size="sm"
          variant="ghost"
          icon={<SparkIcon />}
          disabled={!enabled}
          onClick={() => onSteer("ask-view", "What changed in this view? Quantify the changes and distinguish what the sources show from what they cannot explain.")}
        />
      </span>
      {!inlineComposer && (
        <form
          className="cx-view-ask"
          onSubmit={(e) => {
            e.preventDefault();
            if (steer.trim()) {
              onSteer("ask-view", steer.trim());
              setSteer("");
            }
          }}
        >
          <TextField className="cx-grow" label="Ask about this view" hideLabel value={steer} onChange={(v) => setSteer(v.slice(0, 2000))} placeholder="Ask about this view or change it…" />
          <IconButton type="submit" size="sm" label="Update this view" icon={<SendIcon />} disabled={!enabled || !steer.trim()} />
        </form>
      )}
    </fieldset>
  );
}

/** The small card left in the thread while its chart is open in the panel. */
function ReferenceCard({ result }: { result: ShareStateV1 }) {
  const ctx = useContext(CardContext);
  const spec = result.spec!;
  const view = interpret(result, ctx.direct);
  const detail = [
    view.series.length ? `${view.series.length} ${view.series.length === 1 ? "series" : "series"}` : "",
    view.years ? `${view.years.start}–${view.years.end}` : "",
    result.citations[0]?.sourceLabel || "",
  ].filter(Boolean).join(" · ");
  return (
    <button type="button" className="cx-ref" data-expand-turn={ctx.turnId} onClick={(e) => ctx.onExpand?.(e.currentTarget)} aria-label={`${spec.title}: open in the chart panel`}>
      <ExamplePlot spec={spec} />
      <span>
        {spec.title}
        <small>{detail}</small>
      </span>
      <span className="cx-ref-open">Open</span>
    </button>
  );
}

/**
 * The chart card: tokens for what is shown, the switch row, tabs (Chart / Data
 * / Sources), the chart with its view tools, and the provenance line. Used in
 * the thread (inline) and in the expanded panel (panel), from the same pieces.
 */
export function ChartCard({
  result,
  onSteer,
  variant = "inline",
  specOverride,
  belowChart,
}: {
  result: ShareStateV1;
  onSteer?: (name: string, value: string) => void;
  variant?: "inline" | "panel";
  specOverride?: ChartSpec | null;
  belowChart?: ReactNode;
}) {
  const ctx = useContext(CardContext);
  const enabled = useContext(ResultInteraction);
  const tabId = useId();
  const spec = specOverride ?? result.spec;
  const chart = spec ? prepareChart(spec) : null;
  const [tab, setTab] = useState<Tab>(chart ? "Chart" : "Data");
  const [fit, setFit] = useState(true);
  const domain = chart ? lineDomain(chart) : null;
  if (variant === "inline" && ctx.openInPanel && result.spec) return <ReferenceCard result={result} />;
  const tabs = [
    ...(chart ? [{ value: "Chart" as Tab, label: "Chart" }] : []),
    { value: "Data" as Tab, label: "Data", count: result.rows.length },
    { value: "Sources" as Tab, label: "Sources", count: result.citations.length },
  ];
  const current = tabs.some((t) => t.value === tab) ? tab : tabs[0].value;
  const types = chart ? chartTypes(chart) : [];
  const live = !!ctx.direct && !!ctx.onDirect && chart?.type === "line";
  return (
    <section className="cx-card" data-variant={variant} aria-label={chart ? `Chart: ${chart.title}` : "Result data"}>
      {variant === "inline" && <TokenRow result={result} />}
      {variant === "inline" && <SwitchRow />}
      <div className="cx-cardbar">
        <Tabs label="Result views" idBase={tabId} tabs={tabs} value={current} onChange={setTab} />
        <div className="cx-cardbar-end">
          {chart && onSteer && types.length > 1 && current === "Chart" && (
            <Segmented
              label="Chart type"
              value={chart.type}
              disabled={!enabled}
              onChange={(value) => onSteer("chart-type", value)}
              options={types.map((t) => ({ value: t, label: typeLabel(t) }))}
            />
          )}
          {domain && current === "Chart" && (
            <Segmented
              label="Line chart scale"
              value={fit ? "fit" : "zero"}
              onChange={(value) => setFit(value === "fit")}
              options={[
                { value: "fit", label: "Fit" },
                { value: "zero", label: "From zero" },
              ]}
            />
          )}
          {chart && variant === "inline" && ctx.onExpand && (
            <IconButton size="sm" variant="ghost" label="Expand chart" data-expand-turn={ctx.turnId} icon={<ExpandIcon />} onClick={(e) => ctx.onExpand!(e.currentTarget)} />
          )}
        </div>
      </div>
      <div role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-tab-${current}`} tabIndex={0} className="cx-tabpanel">
        {current === "Chart" && chart && (
          <>
            <Chart
              spec={spec!}
              showTitle={variant === "inline" && !interpret(result, ctx.direct).indicator}
              showChanges={variant === "inline"}
              zoom={variant === "inline"}
              fit={fit}
              onFitChange={setFit}
              onAsk={enabled && onSteer ? (_question, change) => onSteer("explain-change", changeKey(change)) : undefined}
              onSelect={enabled && onSteer ? (name) => onSteer("focus", name) : undefined}
            />
            {belowChart}
          </>
        )}
        {current === "Data" && <DataTab result={result} />}
        {current === "Sources" && <SourcesTab result={result} spec={chart} />}
      </div>
      {onSteer && variant === "inline" && (
        <div className="cx-card-tools">
          <ViewTools result={result} onSteer={onSteer} live={live} />
        </div>
      )}
      <ProvenanceLine result={result} />
    </section>
  );
}
