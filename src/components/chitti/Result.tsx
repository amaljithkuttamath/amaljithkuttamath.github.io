import { useMemo, useState, useId, createContext, useContext } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Pagination } from "@astryxdesign/core/Pagination";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ShareStateV1 } from "../../lib/chitti/share";
import { mdToHtml } from "../../lib/chitti/ui/dom";
import { prepareChart, seriesIdentity } from "../../lib/chitti/chart-contract";
import { chartTypes } from "../../lib/chitti/workspace/steering";
import { recentStart } from "../../lib/chitti/workspace/steering";
import { changeKey } from "../../lib/chitti/chart-insights";
import Chart from "./Chart";
import YearRange from "./YearRange";
import { SourceCard, VerificationBadge } from "./ui/Evidence";
import { MicroLabel } from "./ui/primitives";
import { SendIcon, SparkIcon } from "./ui/icons";
export const ResultInteraction = createContext(true);
export const CollapseChart = createContext(false);
export const InlineComposer = createContext(false);
const TABS = ["Chart", "Data", "Sources"] as const;
const PAGE = 50;
const ALL = "__all";
const number = new Intl.NumberFormat("en", { maximumFractionDigits: 6 });
const typeLabel = (type: string) =>
  type === "grouped-bar" ? "Grouped" : type[0].toUpperCase() + type.slice(1);

export function Result({
  result,
  onSteer,
}: {
  result: ShareStateV1;
  onSteer?: (name: string, value: string) => void;
}) {
  const enabled = useContext(ResultInteraction);
  const collapse = useContext(CollapseChart);
  const [expanded, setExpanded] = useState(!collapse);
  const tabId = useId();
  const chart = result.spec ? prepareChart(result.spec) : null;
  const inlineComposer = useContext(InlineComposer);
  const [steer, setSteer] = useState("");
  const choices =
    result.spec && result.spec.series.length > 1
      ? result.spec.series.map((s) => s.name)
      : result.spec && ["bar", "grouped-bar"].includes(result.spec.type)
        ? [
            ...new Set(
              result.spec.series.flatMap((s) => s.data.map(([x]) => String(x))),
            ),
          ]
        : [];
  const [tab, setTab] = useState<string>("Chart");
  const [query, setQuery] = useState("");
  const [pageWanted, setPage] = useState(0);
  const filtered = useMemo(
    () =>
      result.rows.filter((r) =>
        `${r.country} ${r.year} ${r.indicator || ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [result.rows, query],
  );
  // Clamped at render: a surface update can replace the rows with a shorter
  // set (draft → final) while a later page is open, which showed "Page 3 of 1".
  const page = Math.min(
    pageWanted,
    Math.max(0, Math.ceil(filtered.length / PAGE) - 1),
  );
  const types = chart ? chartTypes(chart) : [];
  const count = (t: string) =>
    t === "Data" ? result.rows.length : t === "Sources" ? result.citations.length : null;
  return (
    <div className="cx-result">
      {result.answer && (
        <div
          className="cx-finding"
          dangerouslySetInnerHTML={{ __html: mdToHtml(result.answer) }}
        />
      )}
      {result.verification && <VerificationBadge verification={result.verification} />}
      {collapse && (
        <Button
          variant="ghost"
          size="sm"
          className="cx-evidence-toggle"
          aria-expanded={expanded}
          label={expanded ? "Hide chart and evidence" : "View chart and evidence"}
          onClick={() => setExpanded(!expanded)}
        />
      )}
      <div hidden={collapse && !expanded} className="cx-evidence">
        {onSteer && (
          <fieldset className="cx-viewbar" disabled={!enabled}>
            <legend className="cx-sr-only">Work with this view</legend>
            {chart && types.length > 1 && (
              <SegmentedControl
                label="Chart type"
                size="sm"
                value={chart.type}
                isDisabled={!enabled}
                onChange={(value) => onSteer("chart-type", value)}
              >
                {types.map((type) => (
                  <SegmentedControlItem key={type} value={type} label={typeLabel(type)} />
                ))}
              </SegmentedControl>
            )}
            {chart && chart.series.length > 1 && (
              <Selector
                label="Highlight series"
                isLabelHidden
                size="sm"
                variant="secondary"
                isDisabled={!enabled}
                value={chart.highlight?.[0] || ALL}
                onChange={(value) => onSteer("highlight", value === ALL ? "" : value)}
                options={[
                  { value: ALL, label: "Highlight: none" },
                  ...chart.series.map((s) => ({
                    value: seriesIdentity(s),
                    label: `Highlight: ${s.name}`,
                  })),
                ]}
              />
            )}
            {choices.length > 1 && (
              <Selector
                label="Focus chart"
                isLabelHidden
                size="sm"
                variant="secondary"
                placeholder="Focus on…"
                isDisabled={!enabled}
                value=""
                onChange={(value) => {
                  if (value) onSteer("focus", value);
                }}
                options={choices.map((name) => ({ value: name, label: name }))}
              />
            )}
            {chart && (
              <YearRange
                key={JSON.stringify(chart.series.map((s) => s.data.map(([x]) => x)))}
                spec={chart}
                isDisabled={!enabled}
                onApply={(value) => onSteer("years", value)}
              />
            )}
            <span className="cx-viewbar-end">
              {recentStart(result) !== null && (
                <Button
                  label="Last 10 years"
                  size="sm"
                  variant="ghost"
                  isDisabled={!enabled}
                  onClick={() => onSteer("recent", "")}
                />
              )}
              <Button
                label="Explain changes"
                size="sm"
                variant="ghost"
                icon={<SparkIcon />}
                isDisabled={!enabled}
                onClick={() =>
                  onSteer(
                    "ask-view",
                    "What changed in this view? Quantify the changes and distinguish what the sources show from what they cannot explain.",
                  )
                }
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
                <TextInput
                  label="Ask about this view"
                  isLabelHidden
                  size="sm"
                  value={steer}
                  onChange={(value) => setSteer(value.slice(0, 2000))}
                  placeholder="Ask about this view or change it…"
                  width="100%"
                />
                <IconButton
                  type="submit"
                  size="sm"
                  label="Update this view"
                  icon={<SendIcon />}
                  isDisabled={!enabled || !steer.trim()}
                />
              </form>
            )}
          </fieldset>
        )}
        <div className="cx-result-panel">
          <TabList role="tablist" value={tab} onChange={setTab} size="sm" hasDivider className="cx-tabs">
            {TABS.map((t) => (
              <Tab
                key={t}
                value={t}
                label={t}
                id={`${tabId}-tab-${t}`}
                panelId={`${tabId}-panel`}
                endContent={
                  count(t) === null ? undefined : (
                    <span className="cx-tab-count">{count(t)}</span>
                  )
                }
              />
            ))}
          </TabList>
          <section
            role="tabpanel"
            id={`${tabId}-panel`}
            aria-labelledby={`${tabId}-tab-${tab}`}
            tabIndex={0}
            className="cx-tabpanel"
          >
            {tab === "Chart" &&
              (result.spec ? (
                <Chart
                  spec={result.spec}
                  onAsk={
                    enabled && onSteer
                      ? (_question, change) =>
                          onSteer("explain-change", changeKey(change))
                      : undefined
                  }
                  onSelect={
                    enabled && onSteer
                      ? (name) => onSteer("focus", name)
                      : undefined
                  }
                />
              ) : (
                <Text as="p" type="supporting" className="cx-empty">
                  No chart was produced for this answer.
                </Text>
              ))}
            {tab === "Data" && (
              <div className="cx-data">
                <div className="cx-data-bar">
                  <TextInput
                    label="Filter rows"
                    isLabelHidden
                    size="sm"
                    startIcon="search"
                    hasClear
                    value={query}
                    onChange={(value) => {
                      setQuery(value);
                      setPage(0);
                    }}
                    placeholder="Filter by country, year or indicator"
                    width="min(100%, 320px)"
                  />
                  <MicroLabel className="cx-data-count">
                    {filtered.length} rows
                    {result.lossy ? " · full rows omitted from this share" : ""}
                  </MicroLabel>
                </div>
                <div className="cx-table-scroll">
                  <Table density="compact" hasHover className="cx-table">
                    <TableHeader>
                      <TableRow>
                        <TableHeaderCell scope="col">Country</TableHeaderCell>
                        <TableHeaderCell scope="col" className="cx-num">Year</TableHeaderCell>
                        <TableHeaderCell scope="col" className="cx-num">Value</TableHeaderCell>
                        <TableHeaderCell scope="col" className="cx-indicator">Indicator</TableHeaderCell>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.slice(page * PAGE, (page + 1) * PAGE).map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.country}</TableCell>
                          <TableCell className="cx-num">{r.year}</TableCell>
                          <TableCell className="cx-num">
                            {r.value === null ? (
                              <span className="cx-missing">Missing</span>
                            ) : (
                              number.format(r.value)
                            )}
                          </TableCell>
                          <TableCell className="cx-indicator">{r.indicator}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {!filtered.length && (
                  <Text as="p" type="supporting" className="cx-empty">
                    No matching rows.
                  </Text>
                )}
                <Pagination
                  className="cx-pagination"
                  variant="compact"
                  size="sm"
                  label="Data pages"
                  page={page + 1}
                  pageSize={PAGE}
                  totalItems={filtered.length}
                  onChange={(next) => setPage(next - 1)}
                />
              </div>
            )}
            {tab === "Sources" && (
              <div className="cx-sources">
                {chart?.series.some((s) => s.evidence) && (
                  <section className="cx-methods" aria-label="Chart methods">
                    <MicroLabel as="p">Chart methods</MicroLabel>
                    {chart.series
                      .filter((s) => s.evidence)
                      .map((s) => (
                        <Text as="p" type="supporting" key={seriesIdentity(s)}>
                          <strong>{s.name}</strong>
                          {s.unit || chart.unit ? ` · ${s.unit || chart.unit}` : ""}:{" "}
                          {s.evidence!.mode === "derived"
                            ? s.evidence!.method || "Method not supplied"
                            : "Observed source values"}
                          {` · ${s.evidence!.citationIds
                            .map(
                              (id) =>
                                result.citations.find((c) => c.id === id)?.indicatorName || id,
                            )
                            .join("; ")}`}
                        </Text>
                      ))}
                  </section>
                )}
                {result.citations.map((c) => (
                  <SourceCard key={c.id} citation={c} />
                ))}
                {!result.citations.length && (
                  <Text as="p" type="supporting" className="cx-empty">
                    No source records accompany this result.
                  </Text>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
      <MicroLabel as="p" className="cx-result-date">
        Recorded{" "}
        {new Date(result.ts).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        })}
        {result.lossy
          ? ". This shared result omits the full evidence rows."
          : ""}
      </MicroLabel>
    </div>
  );
}
