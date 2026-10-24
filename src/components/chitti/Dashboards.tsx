import { useEffect, useRef, useState } from "react";
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
    [shared, setShared] = useState<Dashboard | null>(null),
    [confirmRemove, setConfirmRemove] = useState("");
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
  return (
    <section className="cw-dashboards">
      <header className="cw-toolbar">
        <h2>{board?.title || "Saved dashboards"}</h2>
        <button onClick={onClose}>Back to analysis</button>
      </header>
      <p role="status">{message}</p>
      {pin && (
        <p className="cw-notice">Choose a dashboard for “{pin.spec?.title}”.</p>
      )}
      {!board ? (
        <>
          <form
            className="cw-inline"
            onSubmit={(e) => {
              e.preventDefault();
              if (!title.trim()) return;
              const b = createDashboard(title.trim());
              if (pin) pinTo(b);
              else if (save(b)) setActive(b.id);
              setTitle("");
            }}
          >
            <input
              aria-label="New dashboard title"
              placeholder="New dashboard title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button disabled={!title.trim()}>
              Create{pin ? " & pin" : ""}
            </button>
          </form>
          <label className="cw-import">
            Import dashboard
            <input
              type="file"
              accept="application/json,.json"
              onChange={async (e) => {
                const file = e.target.files?.[0];
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
                save(
                  prepareImportedDashboard(
                    parsed,
                    boards.map((b) => b.title),
                  ),
                );
              }}
            />
          </label>
          <div className="cw-board-list">
            {boards.map((b) => (
              <button
                key={b.id}
                onClick={() => (pin ? pinTo(b) : setActive(b.id))}
              >
                <strong>{b.title}</strong>
                <span>
                  {b.tiles.length} charts ·{" "}
                  {new Date(b.updated).toLocaleDateString()}
                </span>
              </button>
            ))}
            {!boards.length && (
              <p>
                No saved dashboards yet. Pin a result or import an existing
                dashboard.
              </p>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="cw-actions">
            <button
              onClick={() => {
                setActive(null);
                setShared(null);
              }}
            >
              All dashboards
            </button>
            <button onClick={() => void share()}>Share</button>
            <button
              onClick={() =>
                download(
                  "chitti-dashboard.json",
                  serializeDashboard(board),
                  "application/json",
                )
              }
            >
              Export JSON
            </button>
            {shared ? (
              <button
                onClick={() => {
                  const imported = prepareImportedDashboard(
                    shared,
                    boards.map((b) => b.title),
                  );
                  if (save(imported)) {
                    setShared(null);
                    setActive(imported.id);
                  }
                }}
              >
                Save a copy
              </button>
            ) : (
              <>
                <button disabled={busy} onClick={() => void refresh()}>
                  Refresh data
                </button>
                {busy && (
                  <button onClick={() => controller.current?.abort()}>
                    Stop refresh
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() => {
                    if (confirmRemove === board.id) {
                      const store = storage();
                      if (store) {
                        try {
                          deleteDashboard(store, board.id);
                          reload();
                          setActive(null);
                          setConfirmRemove("");
                        } catch {
                          setMessage("Could not delete this dashboard.");
                        }
                      }
                    } else setConfirmRemove(board.id);
                  }}
                >
                  {confirmRemove === board.id
                    ? "Confirm delete dashboard"
                    : "Delete dashboard"}
                </button>
                <details>
                  <summary>Rename</summary>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = new FormData(e.currentTarget)
                        .get("name")
                        ?.toString()
                        .trim();
                      if (name) save(renameDashboard(board, name));
                    }}
                  >
                    <input
                      name="name"
                      aria-label="Dashboard name"
                      defaultValue={board.title}
                    />
                    <button disabled={busy}>Save name</button>
                  </form>
                </details>
              </>
            )}
          </div>
          {shared && (
            <p className="cw-notice">
              Shared snapshot. Save a copy to edit or refresh.
            </p>
          )}
          {board.tiles.map((tile, i) => (
            <article className="cw-tile" key={tile.id}>
              {tile.stale && (
                <p role="status">
                  Refresh failed: {tile.stale.reason}. Showing previous data.
                </p>
              )}
              <Chart spec={{ ...tile.spec, title: tile.title }} />
              <p>{tile.sourceNote}</p>
              <details>
                <summary>Sources & data</summary>
                <p>{tile.rows.length} evidence rows</p>
                {tile.citations.map((c) => (
                  <p key={c.id}>
                    {c.sourceLabel}: {c.indicatorName},{" "}
                    {c.mirroredAt
                      ? `snapshot ${c.mirroredAt}`
                      : `fetched ${c.fetchedAt}`}
                  </p>
                ))}
              </details>
              {!shared && (
                <div className="cw-actions">
                  <button
                    disabled={busy || i === 0}
                    onClick={() => save(moveTile(board, tile.id, "up"))}
                  >
                    Move up
                  </button>
                  <button
                    disabled={busy || i === board.tiles.length - 1}
                    onClick={() => save(moveTile(board, tile.id, "down"))}
                  >
                    Move down
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      if (confirmRemove === tile.id) {
                        save(removeTile(board, tile.id));
                        setConfirmRemove("");
                      } else setConfirmRemove(tile.id);
                    }}
                  >
                    {confirmRemove === tile.id
                      ? "Confirm remove"
                      : "Remove chart"}
                  </button>
                  <details>
                    <summary>Rename chart</summary>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const value = new FormData(e.currentTarget)
                          .get("title")
                          ?.toString()
                          .trim();
                        if (value) save(renameTile(board, tile.id, value));
                      }}
                    >
                      <input
                        name="title"
                        defaultValue={tile.title}
                        aria-label="Chart title"
                      />
                      <button disabled={busy}>Save</button>
                    </form>
                  </details>
                </div>
              )}
            </article>
          ))}
        </>
      )}
    </section>
  );
}
