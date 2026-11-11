import { useEffect, useMemo, useRef, useState } from "react";
import {
  listDashboards,
  deleteDashboard,
  saveDashboard,
  createDashboard,
  addTile,
  makeTile,
  removeTile,
  renameDashboard,
  renameTile,
  moveTile,
  serializeDashboard,
  type Dashboard,
} from "../../lib/chitti/dashboard";
import {
  decodeDashShare,
  materializeSharedDashboard,
  parseImportedDashboard,
  prepareImportedDashboard,
  encodeDashShare,
} from "../../lib/chitti/dashboard-share";
import { refreshDashboard } from "../../lib/chitti/dashboards-agent";
import type { ShareStateV1 } from "../../lib/chitti/share";
import Chart from "./Chart";
import { Button, Confirm, Menu, Notice, TextField } from "./ui/controls";
import { MicroLabel, PanelHeader } from "./ui/primitives";
import { BackIcon, DashboardIcon, DownloadIcon, MoreIcon, PinIcon, PlusIcon, RefreshIcon, ShareIcon } from "./ui/icons";
import type { ChartSpec } from "../../lib/chitti/core";
// Chart re-initialises ECharts whenever its `spec` identity changes, so the
// titled spec is memoised per tile: an inline `{...tile.spec, title}` rebuilt
// every chart on every render, and a refresh re-renders once per tile.
function TileChart({ spec, title }: { spec: ChartSpec; title: string }) {
  const titled = useMemo(() => ({ ...spec, title }), [spec, title]);
  return <Chart spec={titled} />;
}
export function download(name: string, body: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function storage() {
  try {
    localStorage.getItem("chitti:probe");
    return localStorage;
  } catch {
    return null;
  }
}
export default function Dashboards({
  pin,
  onPinned,
  onClose,
}: {
  pin: ShareStateV1 | null;
  onPinned: () => void;
  onClose: () => void;
}) {
  const [boards, setBoards] = useState<Dashboard[]>(() => {
      const s = storage();
      return s ? listDashboards(s) : [];
    }),
    [active, setActive] = useState<string | null>(null),
    [title, setTitle] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [shared, setShared] = useState<Dashboard | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    let disposed = false;
    if (location.hash.startsWith("#dash="))
      void decodeDashShare(location.hash.slice(6)).then((result) => {
        if (disposed) return;
        if (result) setShared(materializeSharedDashboard(result));
        else setMessage("This shared dashboard could not be decoded.");
      });
    return () => {
      disposed = true;
      controller.current?.abort();
    };
  }, []);
  const board = shared || boards.find((b) => b.id === active);
  const reload = () => {
    const s = storage();
    if (s) setBoards(listDashboards(s));
  };
  const save = (b: Dashboard) => {
    const s = storage();
    if (!s) {
      setMessage(
        "Browser storage is unavailable. Export a JSON copy to keep this dashboard.",
      );
      return false;
    }
    const res = saveDashboard(s, b);
    if (!res.ok) {
      setMessage(res.error);
      return false;
    }
    reload();
    return true;
  };
  const pinTo = (b: Dashboard) => {
    if (!pin?.spec) return;
    try {
      if (
        save(
          addTile(
            b,
            makeTile({
              title: pin.spec.title,
              spec: pin.spec,
              rows: pin.rows,
              citations: pin.citations,
            }),
          ),
        )
      ) {
        onPinned();
        setActive(b.id);
        setMessage("Chart pinned.");
      }
    } catch (e) {
      setMessage(String(e));
    }
  };
  const refresh = async () => {
    const s = storage();
    if (!s || !board || shared || busy) return;
    const c = new AbortController();
    controller.current = c;
    setBusy(true);
    setMessage("Refreshing source data…");
    try {
      const r = await refreshDashboard(s, board.id, {
        signal: c.signal,
        onTile: () => reload(),
      });
      reload();
      setMessage(
        r.saveError ||
          (r.aborted
            ? "Refresh stopped."
            : `${r.results.length} tiles checked. Failed refreshes keep their last recorded data.`),
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
      controller.current = null;
    }
  };
  const share = async () => {
    if (!board) return;
    try {
      const r = await encodeDashShare(board);
      if (!r.ok) {
        setMessage("Too large for a link. Export JSON instead.");
        return;
      }
      await navigator.clipboard.writeText(
        `${location.origin}${location.pathname}#dash=${r.payload}`,
      );
      setMessage(
        r.lossy
          ? "Link copied; full evidence rows omitted."
          : "Dashboard link copied.",
      );
    } catch {
      setMessage("Clipboard unavailable. Export JSON instead.");
    }
  };
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<
    { kind: "board"; id: string } | { kind: "tile"; id: string; title: string } | null
  >(null);
  const importDashboard = async (file: File | null) => {
    if (!file) return;
    if (file.size > 1_000_000) {
      setMessage("Dashboard file is too large.");
      return;
    }
    const parsed = parseImportedDashboard(await file.text());
    if (!parsed) {
      setMessage("Invalid dashboard file.");
      return;
    }
    if (save(prepareImportedDashboard(parsed, boards.map((b) => b.title))))
      setMessage("Dashboard imported.");
  };
  const confirmRemoval = () => {
    if (!removing || !board) return;
    if (removing.kind === "tile") {
      save(removeTile(board, removing.id));
    } else {
      const store = storage();
      if (store) {
        try {
          deleteDashboard(store, board.id);
          reload();
          setActive(null);
        } catch {
          setMessage("Could not delete this dashboard.");
        }
      }
    }
    setRemoving(null);
  };
  return (
    <section className="cx-dashboards" aria-label="Dashboards">
      <PanelHeader
        eyebrow={board ? (shared ? "Shared dashboard" : "Dashboard") : "Saved locally in this browser"}
        title={board?.title || "Dashboards"}
        description={
          board
            ? `${board.tiles.length} ${board.tiles.length === 1 ? "chart" : "charts"} · updated ${new Date(board.updated).toLocaleDateString()}`
            : "Pinned charts keep their rows and sources, and can be refreshed from the source later."
        }
        actions={
          board ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<BackIcon />}
              label="All dashboards"
              onClick={() => {
                setActive(null);
                setShared(null);
                setRenaming(null);
              }}
            />
          ) : (
            <Button variant="ghost" size="sm" icon={<BackIcon />} label="Back to analysis" onClick={onClose} />
          )
        }
      />
      {message && (
        <p className="cx-status-text" role="status">
          {message}
        </p>
      )}
      {pin && (
        <Notice title={`Choose a dashboard for “${pin.spec?.title}”.`}>Pick an existing dashboard below, or name a new one.</Notice>
      )}
      {!board ? (
        <>
          <div className="cx-dash-create">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!title.trim()) return;
                const b = createDashboard(title.trim());
                if (pin) pinTo(b);
                else if (save(b)) setActive(b.id);
                setTitle("");
              }}
            >
              <TextField className="cx-grow" label="New dashboard title" hideLabel placeholder="New dashboard title" value={title} onChange={setTitle} />
              <Button type="submit" variant="primary" icon={<PlusIcon />} label={pin ? "Create & pin" : "Create"} disabled={!title.trim()} />
            </form>
            <label className="cx-file">
              <span className="cx-btn" data-size="sm" data-variant="quiet">
                <span className="cx-btn-icon" aria-hidden="true">
                  <DownloadIcon />
                </span>
                Import dashboard (.json)
              </span>
              <input
                className="cx-sr-only"
                type="file"
                aria-label="Import dashboard"
                accept="application/json,.json"
                onChange={(e) => void importDashboard(e.target.files?.[0] || null)}
              />
            </label>
          </div>
          {boards.length ? (
            <div className="cx-board-grid">
              {boards.map((b) => (
                <button
                  type="button"
                  key={b.id}
                  className="cx-board-card"
                  aria-label={pin ? `Pin to ${b.title}` : `Open ${b.title}`}
                  onClick={() => (pin ? pinTo(b) : setActive(b.id))}
                >
                  <span className="cx-btn-icon" aria-hidden="true">
                    <DashboardIcon />
                  </span>
                  <span className="cx-board-title">{b.title}</span>
                  <MicroLabel>
                    {b.tiles.length} {b.tiles.length === 1 ? "chart" : "charts"} · {new Date(b.updated).toLocaleDateString()}
                  </MicroLabel>
                </button>
              ))}
            </div>
          ) : (
            <div className="cx-empty-state">
              <h3>No dashboards yet</h3>
              <p>Pin a chart from any result, or import a dashboard file.</p>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="cx-row" role="toolbar" aria-label="Dashboard actions">
            <MicroLabel>{shared ? "Read-only snapshot" : "Pinned charts"}</MicroLabel>
            <span className="cx-grow" />
            {shared ? (
              <Button
                variant="primary"
                label="Save a copy"
                onClick={() => {
                  const imported = prepareImportedDashboard(shared, boards.map((b) => b.title));
                  if (save(imported)) {
                    setShared(null);
                    setActive(imported.id);
                  }
                }}
              />
            ) : busy ? (
              <Button label="Stop refresh" onClick={() => controller.current?.abort()} />
            ) : (
              <Button variant="primary" icon={<RefreshIcon />} label="Refresh data" onClick={() => void refresh()} />
            )}
            <Menu
              label="More dashboard actions"
              trigger={<MoreIcon />}
              align="end"
              items={[
                { label: "Copy share link", icon: <ShareIcon />, onSelect: () => void share() },
                {
                  label: "Export JSON",
                  icon: <DownloadIcon />,
                  onSelect: () => download("chitti-dashboard.json", serializeDashboard(board), "application/json"),
                },
                ...(shared
                  ? []
                  : [
                      { type: "divider" as const },
                      {
                        label: "Rename dashboard",
                        disabled: busy,
                        onSelect: () => {
                          setName(board.title);
                          setRenaming(board.id);
                        },
                      },
                      {
                        label: "Delete dashboard",
                        danger: true,
                        disabled: busy,
                        onSelect: () => setRemoving({ kind: "board", id: board.id }),
                      },
                    ]),
              ]}
            />
          </div>
          {busy && <div className="cx-progress" role="progressbar" aria-label="Refreshing source data" />}
          {renaming && (
            <form
              className="cx-row"
              onSubmit={(e) => {
                e.preventDefault();
                const value = name.trim();
                if (!value) return;
                const tile = board.tiles.find((t) => t.id === renaming);
                if (save(tile ? renameTile(board, tile.id, value) : renameDashboard(board, value))) setRenaming(null);
              }}
            >
              <TextField
                className="cx-grow"
                label={board.tiles.some((t) => t.id === renaming) ? "Chart title" : "Dashboard name"}
                hideLabel
                value={name}
                onChange={setName}
                autoFocus
              />
              <Button type="submit" label="Save name" disabled={busy || !name.trim()} />
              <Button variant="ghost" label="Cancel" onClick={() => setRenaming(null)} />
            </form>
          )}
          {shared && <Notice title="Shared snapshot">Save a copy to edit or refresh it.</Notice>}
          {!board.tiles.length && (
            <div className="cx-empty-state">
              <h3>No charts on this dashboard</h3>
              <p>Open a result and choose Pin to dashboard from its share menu.</p>
            </div>
          )}
          <div className="cx-tile-grid">
            {board.tiles.map((tile, i) => (
              <article className="cx-tile" key={tile.id} aria-label={tile.title}>
                <div className="cx-tile-head">
                  <MicroLabel>{tile.citations[0]?.sourceLabel || "Chart"}</MicroLabel>
                  {!shared && (
                    <Menu
                      label={`Chart actions: ${tile.title}`}
                      trigger={<MoreIcon />}
                      variant="ghost"
                      align="end"
                      disabled={busy}
                      items={[
                        { label: "Move up", disabled: i === 0, onSelect: () => save(moveTile(board, tile.id, "up")) },
                        { label: "Move down", disabled: i === board.tiles.length - 1, onSelect: () => save(moveTile(board, tile.id, "down")) },
                        {
                          label: "Rename chart",
                          onSelect: () => {
                            setName(tile.title);
                            setRenaming(tile.id);
                          },
                        },
                        { type: "divider" },
                        { label: "Remove chart", danger: true, onSelect: () => setRemoving({ kind: "tile", id: tile.id, title: tile.title }) },
                      ]}
                    />
                  )}
                </div>
                {tile.stale && (
                  <Notice tone="warn" title={`Refresh failed: ${tile.stale.reason}`}>
                    Showing the previous data.
                  </Notice>
                )}
                <TileChart spec={tile.spec} title={tile.title} />
                <p className="cx-tile-note">{tile.sourceNote}</p>
                <details className="cx-disclosure">
                  <summary>
                    <MicroLabel>Sources &amp; data · {tile.rows.length} rows</MicroLabel>
                  </summary>
                  <div className="cx-disclosure-body">
                    <ul className="cx-link-list">
                      {tile.citations.map((c) => (
                        <li key={c.id}>
                          {c.sourceLabel}: {c.indicatorName}, {c.mirroredAt ? `snapshot ${c.mirroredAt}` : `fetched ${c.fetchedAt}`}
                        </li>
                      ))}
                    </ul>
                  </div>
                </details>
              </article>
            ))}
          </div>
          {removing && (
            <Confirm
              title={removing.kind === "tile" ? "Remove this chart?" : "Delete this dashboard?"}
              description={
                removing.kind === "tile"
                  ? `“${removing.title}” and its recorded rows will be removed from this dashboard.`
                  : "The dashboard and every pinned chart on it will be deleted from this browser."
              }
              actionLabel={removing.kind === "tile" ? "Remove chart" : "Delete dashboard"}
              danger
              onCancel={() => setRemoving(null)}
              onAction={confirmRemoval}
            />
          )}
        </>
      )}
    </section>
  );
}
