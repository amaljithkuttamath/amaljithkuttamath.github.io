import { useEffect, useId, useState } from "react";
import type { TraceEvent } from "../../../lib/chitti/receipts";
import type { Analysis } from "../../../lib/chitti/workspace/model";
import { providerMeta } from "../../../lib/chitti/providers";
import { verificationLabel } from "./Evidence";
import { Button } from "./controls";
import { DownloadIcon } from "./icons";

/** Tool names in plain words. Unknown tools fall back to their own name. */
const TOOL_WORDS: Record<string, string> = {
  find_series: "find series",
  fetch_series: "fetch",
  fetch_worldbank: "fetch",
  fetch_worldbank_all: "fetch every country",
  fetch_owid: "fetch",
  fetch_imf: "fetch",
  list_countries: "list countries",
  render_chart: "draw chart",
  execute_js: "compute",
  growth_stats: "compute growth",
  profile_series: "profile series",
  breakdown: "break down",
  correlate: "correlate",
  browse_dataset: "browse dataset",
  write_file: "write file",
  read_file: "read file",
  request_input: "ask you",
  delegate_source: "ask a source specialist",
  return_findings: "return findings",
  save_to_dashboard: "pin to dashboard",
  edit_dashboard: "edit dashboard",
  finish: "write the answer",
  finish_explanation: "write the answer",
  plan: "plan",
  verify: "evidence check",
  fallback: "switch model",
  llm: "nested model call",
  salvage: "recover tool call",
  nudge: "nudge",
  jev_route: "route dataset",
};
export const toolWords = (tool: string) => TOOL_WORDS[tool] || tool.replaceAll("_", " ");

const seconds = (ms: number) => (ms < 100 ? "<0.1s" : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

/** The one-line summary: label, step count, and the meta on the right. */
export function thinkingSummary(analysis: Analysis): { label: string; steps: number; meta: string[] } {
  const steps = analysis.trace.filter((e) => e.tool !== "reasoning").length;
  const running = analysis.phase === "running" || analysis.phase === "waiting";
  const verified = analysis.trace.some((e) => e.tool === "verify");
  const label =
    analysis.choice
      ? "Searched the catalogue"
      : analysis.origin === "direct"
      ? running ? "Looking it up directly" : "Looked it up directly"
      : analysis.origin === "view"
        ? "Changed the view"
        : running
          ? "Thinking"
          : verified
            ? "Thought and checked sources"
            : "Thought it through";
  const meta: string[] = [];
  if (analysis.startedAt && analysis.endedAt) meta.push(seconds(analysis.endedAt - analysis.startedAt));
  if (analysis.origin === "direct" || analysis.origin === "view") meta.push(analysis.origin === "view" ? "no model, no new fetch" : "no model");
  else if (analysis.origin === "agent") {
    if (analysis.model) meta.push(analysis.model);
    if (analysis.provider)
      meta.push(analysis.provider === "chatgpt" ? "your ChatGPT plan" : `your ${providerMeta(analysis.provider).label} key`);
    // Cost is shown only when the app has it; it is never set for the
    // ChatGPT subscription provider.
    if (analysis.cost !== undefined) meta.push(`$${analysis.cost.toFixed(4)}`);
  }
  return { label, steps, meta };
}

function StepIcon({ kind }: { kind: string }) {
  if (kind === "ok")
    return (
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M2.5 6.5l2.2 2.2 4.8-5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  if (kind === "error" || kind === "warn") return <span aria-hidden="true">!</span>;
  return <span aria-hidden="true">…</span>;
}

function Step({ event }: { event: TraceEvent }) {
  if (event.tool === "reasoning")
    return (
      <li className="cx-th" data-kind="thought">
        <span className="cx-th-i"><StepIcon kind="thought" /></span>
        <div>
          <span className="cx-sr-only">Model reasoning: </span>
          {/* Model-authored text: rendered as plain text (React escapes it). */}
          <p className="cx-th-thought">{event.detail}</p>
        </div>
      </li>
    );
  if (event.tool === "verify") {
    const status = event.verifyStatus;
    const kind = event.status === "running" ? "running" : status === "verified" ? "ok" : status === "skipped" || status === "unavailable" ? "neutral" : "warn";
    return (
      <li className="cx-th" data-kind={kind}>
        <span className="cx-th-i"><StepIcon kind={kind} /></span>
        <div>
          <span className="cx-th-tool">evidence check</span>
          {event.argSummary && <span className="cx-th-arg"> {event.argSummary}</span>}
          {event.durationMs !== undefined && <span className="cx-th-time">{seconds(event.durationMs)}</span>}
          <div className="cx-th-res">
            {event.status === "running"
              ? "Checking the answer against the fetched values…"
              : status === "skipped"
                ? "Nothing to verify."
                : status
                  ? `${verificationLabel(status === "verified" ? "verified" : status === "unavailable" ? "unavailable" : "unverified")}${event.confidence && event.confidence !== "none" ? ` · verifier confidence ${event.confidence}` : ""}`
                  : event.detail}
          </div>
          {!!event.issues?.length && (
            <ul className="cx-th-issues">
              {event.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      </li>
    );
  }
  const kind = event.status === "running" ? "running" : event.status === "ok" ? "ok" : "error";
  const detail = event.tool === "plan" && event.plan ? event.plan.insight : event.detail;
  return (
    <li className="cx-th" data-kind={kind}>
      <span className="cx-th-i"><StepIcon kind={kind} /></span>
      <div>
        <span className="cx-th-tool">{toolWords(event.tool)}</span>
        {event.argSummary && <span className="cx-th-arg"> {event.argSummary}</span>}
        {event.durationMs !== undefined && <span className="cx-th-time">{seconds(event.durationMs)}</span>}
        {kind === "running" && <span className="cx-sr-only"> (running)</span>}
        {kind === "error" && <span className="cx-sr-only"> (did not succeed)</span>}
        {detail && <div className="cx-th-res">{detail}</div>}
      </div>
    </li>
  );
}

/**
 * The turn's thinking: a disclosure that is collapsed by default and open
 * (and live) while the turn runs. Collapsed, it is one line: what happened,
 * how many steps, how long, and which model/key (or no model). Expanded, it is
 * the turn's own TraceEvents in order, model reasoning interleaved where the
 * provider returned any, ending with the evidence check.
 */
export function ThinkingBlock({
  analysis,
  onDownload,
}: {
  analysis: Analysis;
  onDownload?: (name: string, body: string) => void;
}) {
  const running = analysis.phase === "running" || analysis.phase === "waiting";
  const [choice, setChoice] = useState<boolean | null>(null);
  // A finished run collapses again unless the reader opened it themselves.
  useEffect(() => {
    if (running) setChoice(null);
  }, [running]);
  const open = choice ?? running;
  const id = useId();
  const files = Object.entries(analysis.files || {});
  const { label, steps, meta } = thinkingSummary(analysis);
  if (!analysis.trace.length && !running) {
    if (analysis.origin === "example" || analysis.origin === "shared")
      return (
        <div className="cx-think">
          <div className="cx-think-head" aria-disabled="true">
            <span className="cx-think-title">{analysis.origin === "example" ? "Recorded example" : "Shared snapshot"}</span>
            <span>· the original steps are not included</span>
          </div>
        </div>
      );
    return null;
  }
  return (
    <section className="cx-think" aria-label="Thinking">
      <button
        type="button"
        className="cx-think-head"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setChoice(!open)}
      >
        <svg className="cx-think-car" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
        <span>
          <span className="cx-think-title">{label}</span> · {steps} {steps === 1 ? "step" : "steps"}
        </span>
        {meta.length > 0 && <span className="cx-think-meta">{meta.join(" · ")}</span>}
      </button>
      <div id={id} className="cx-think-body" hidden={!open} aria-live={running ? "polite" : undefined}>
        <ol className="cx-steps">
          {analysis.trace.map((event, i) => (
            <Step key={`${event.ts}-${i}`} event={event} />
          ))}
        </ol>
        {running && !analysis.trace.length && <p className="cx-th-res">{analysis.status}</p>}
        {files.length > 0 && (
          <div className="cx-think-files">
            {files.map(([name, body]) => (
              <details key={name} className="cx-disclosure">
                <summary className="cx-mono">{name}</summary>
                <div className="cx-disclosure-body">
                  <pre className="cx-pre">{body}</pre>
                  {onDownload && (
                    <Button size="sm" icon={<DownloadIcon />} label="Download file" onClick={() => onDownload(name.split("/").at(-1) || "file.txt", body)} />
                  )}
                </div>
              </details>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
