import { useMemo, useState } from "react";
import type { ShareStateV1 } from "../../lib/chitti/share";
import { safeLink } from "../../lib/chitti/workspace/model";
import { mdToHtml } from "../../lib/chitti/ui/dom";
import Chart from "./Chart";
export function Result({ result }: { result: ShareStateV1 }) {
  const [tab, setTab] = useState("Chart");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filtered = useMemo(
    () =>
      result.rows.filter((r) =>
        `${r.country} ${r.year} ${r.indicator || ""}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [result.rows, query],
  );
  return (
    <div className="cw-result">
      {result.answer && (
        <div
          className="cw-finding"
          dangerouslySetInnerHTML={{ __html: mdToHtml(result.answer) }}
        />
      )}
      {result.verification && (
        <details
          className="cw-verdict"
          data-verified={result.verification.status === "verified"}
        >
          <summary>
            {result.verification.status === "verified"
              ? "Evidence check passed"
              : result.verification.status === "unavailable"
                ? "Evidence check unavailable"
                : "Evidence not verified"}
            {result.verification.engine === "jev" ? " · Jev" : ""}
          </summary>
          <p>
            Verifier confidence: {result.verification.confidence}. This is the
            verifier’s assessment.
          </p>
          {result.verification.issues.map((issue, i) => (
            <p key={i}>{issue}</p>
          ))}
        </details>
      )}
      <div className="cw-tabs" role="tablist" aria-label="Result view">
        {["Chart", "Data", "Sources"].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            id={`result-tab-${t}`}
            aria-controls="result-panel"
            onClick={() => setTab(t)}
            onKeyDown={(e) => {
              const list = ["Chart", "Data", "Sources"];
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const next =
                  list[
                    (list.indexOf(t) + (e.key === "ArrowRight" ? 1 : 2)) % 3
                  ];
                setTab(next);
                document.getElementById(`result-tab-${next}`)?.focus();
              }
            }}
            tabIndex={tab === t ? 0 : -1}
          >
            {t}
            {t === "Data"
              ? ` (${result.rows.length})`
              : t === "Sources"
                ? ` (${result.citations.length})`
                : ""}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id="result-panel"
        aria-labelledby={`result-tab-${tab}`}
        tabIndex={0}
      >
        {tab === "Chart" &&
          (result.spec ? (
            <Chart spec={result.spec} />
          ) : (
            <p className="cw-empty">No chart was produced for this answer.</p>
          ))}
        {tab === "Data" && (
          <>
            <div className="cw-data-controls">
              <label>
                Filter rows{" "}
                <input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(0);
                  }}
                  placeholder="Country, year or indicator"
                />
              </label>
              <span>
                {filtered.length} rows
                {result.lossy ? " · full rows omitted from this share" : ""}
              </span>
            </div>
            <div className="cw-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Country</th>
                    <th>Year</th>
                    <th>Value</th>
                    <th>Indicator</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(page * 50, (page + 1) * 50).map((r, i) => (
                    <tr key={i}>
                      <td>{r.country}</td>
                      <td>{r.year}</td>
                      <td>
                        {r.value === null
                          ? "Missing"
                          : new Intl.NumberFormat("en", {
                              maximumFractionDigits: 6,
                            }).format(r.value)}
                      </td>
                      <td>{r.indicator}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!filtered.length && <p>No matching rows.</p>}
            <div className="cw-pagination">
              <button disabled={!page} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>
                Page {page + 1} of{" "}
                {Math.max(1, Math.ceil(filtered.length / 50))}
              </span>
              <button
                disabled={(page + 1) * 50 >= filtered.length}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
          </>
        )}
        {tab === "Sources" && (
          <div className="cw-sources">
            {result.citations.map((c) => (
              <article key={c.id}>
                <h3>
                  <a
                    href={safeLink(c.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {c.indicatorName || c.indicatorId} ↗
                  </a>
                </h3>
                <p>
                  {c.sourceLabel} · {c.rowCount} rows
                </p>
                <dl>
                  <dt>Coverage</dt>
                  <dd>
                    {c.countries.join(", ") || "All countries"} ·{" "}
                    {c.yearRange?.start || "…"}–{c.yearRange?.end || "…"}
                  </dd>
                  <dt>{c.mirroredAt ? "Snapshot" : "Fetched"}</dt>
                  <dd>{c.mirroredAt || c.fetchedAt}</dd>
                  {c.sourceUpdated && (
                    <>
                      <dt>Source updated</dt>
                      <dd>{c.sourceUpdated}</dd>
                    </>
                  )}
                </dl>
                {c.requestUrl && (
                  <a
                    href={safeLink(c.requestUrl)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Exact data request ↗
                  </a>
                )}
              </article>
            ))}
            {!result.citations.length && (
              <p>No source records accompany this result.</p>
            )}
          </div>
        )}
      </section>
      <p className="cw-result-date">
        Recorded{" "}
        {new Date(result.ts).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        })}
        {result.lossy
          ? ". This shared result omits the full evidence rows."
          : ""}
      </p>
    </div>
  );
}
