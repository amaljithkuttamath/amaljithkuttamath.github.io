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
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FileInput } from "@astryxdesign/core/FileInput";
import { Icon } from "@astryxdesign/core/Icon";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { MicroLabel, PanelHeader } from "./ui/primitives";
import { DashboardIcon, DownloadIcon, PinIcon, PlusIcon, RefreshIcon, ShareIcon } from "./ui/icons";
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
  const [importFile, setImportFile] = useState<File | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<
    { kind: "board"; id: string } | { kind: "tile"; id: string; title: string } | null
  >(null);
  const importDashboard = async (file: File | null) => {
    setImportFile(file);
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
    setImportFile(null);
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
              icon={<Icon icon="chevronLeft" />}
              label="All dashboards"
              onClick={() => {
                setActive(null);
                setShared(null);
                setRenaming(null);
              }}
            />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon icon="chevronLeft" />}
              label="Back to analysis"
              onClick={onClose}
            />
          )
        }
      />
      {message && (
        <Text as="p" type="supporting" role="status" className="cx-dash-message">
          {message}
        </Text>
      )}
      {pin && (
        <Banner
          status="info"
          title={`Choose a dashboard for “${pin.spec?.title}”.`}
          description="Pick an existing dashboard below, or name a new one."
          collapsible={false}
        />
      )}
      {!board ? (
        <>
          <div className="cx-dash-create">
            <form
              className="cx-row cx-grow"
              onSubmit={(e) => {
                e.preventDefault();
                if (!title.trim()) return;
                const b = createDashboard(title.trim());
                if (pin) pinTo(b);
                else if (save(b)) setActive(b.id);
                setTitle("");
              }}
            >
              <TextInput
                label="New dashboard title"
                isLabelHidden
                placeholder="New dashboard title"
                value={title}
                onChange={setTitle}
                width="100%"
                containerClassName="cx-grow"
              />
              <Button
                type="submit"
                variant="primary"
                icon={<PlusIcon />}
                label={pin ? "Create & pin" : "Create"}
                isDisabled={!title.trim()}
              />
            </form>
            <FileInput
              label="Import dashboard"
              isLabelHidden
              placeholder="Import dashboard (.json)"
              accept="application/json,.json"
              value={importFile}
              onChange={(file) => void importDashboard(file as File | null)}
            />
          </div>
          {boards.length ? (
            <div className="cx-board-grid">
              {boards.map((b) => (
                <ClickableCard
                  key={b.id}
                  className="cx-board-card"
                  label={pin ? `Pin to ${b.title}` : `Open ${b.title}`}
                  onClick={() => (pin ? pinTo(b) : setActive(b.id))}
                  padding={4}
                >
                  <span className="cx-board-icon" aria-hidden="true">
                    <DashboardIcon />
                  </span>
                  <span className="cx-board-title">{b.title}</span>
                  <MicroLabel>
                    {b.tiles.length} {b.tiles.length === 1 ? "chart" : "charts"} ·{" "}
                    {new Date(b.updated).toLocaleDateString()}
                  </MicroLabel>
                </ClickableCard>
              ))}
            </div>
          ) : (
            <EmptyState
              className="cx-empty-state"
              icon={<DashboardIcon />}
              title="No dashboards yet"
              description="Pin a chart from any result, or import a dashboard file."
              headingLevel={3}
            />
          )}
        </>
      ) : (
        <>
          <Toolbar
            label="Dashboard actions"
            size="sm"
            className="cx-toolbar"
            startContent={<MicroLabel>{shared ? "Read-only snapshot" : "Pinned charts"}</MicroLabel>}
            endContent={
              <>
                {shared ? (
                  <Button
                    variant="primary"
                    label="Save a copy"
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
                  />
                ) : busy ? (
                  <Button label="Stop refresh" onClick={() => controller.current?.abort()} />
                ) : (
                  <Button
                    variant="primary"
                    icon={<RefreshIcon />}
                    label="Refresh data"
                    onClick={() => void refresh()}
                  />
                )}
                <MoreMenu
                  label="More dashboard actions"
                  alignment="end"
                  items={[
                    { label: "Copy share link", icon: <ShareIcon />, onClick: () => void share() },
                    {
                      label: "Export JSON",
                      icon: <DownloadIcon />,
                      onClick: () =>
                        download("chitti-dashboard.json", serializeDashboard(board), "application/json"),
                    },
                    ...(shared
                      ? []
                      : [
                          { type: "divider" as const },
                          {
                            label: "Rename dashboard",
                            isDisabled: busy,
                            onClick: () => {
                              setName(board.title);
                              setRenaming(board.id);
                            },
                          },
                          {
                            label: "Delete dashboard",
                            variant: "destructive" as const,
                            isDisabled: busy,
                            onClick: () => setRemoving({ kind: "board", id: board.id }),
                          },
                        ]),
                  ]}
                />
              </>
            }
          />
          {busy && <ProgressBar label="Refreshing source data" isLabelHidden isIndeterminate />}
          {renaming && (
            <form
              className="cx-row"
              onSubmit={(e) => {
                e.preventDefault();
                const value = name.trim();
                if (!value) return;
                const tile = board.tiles.find((t) => t.id === renaming);
                if (save(tile ? renameTile(board, tile.id, value) : renameDashboard(board, value)))
                  setRenaming(null);
              }}
            >
              <TextInput
                label={board.tiles.some((t) => t.id === renaming) ? "Chart title" : "Dashboard name"}
                isLabelHidden
                value={name}
                onChange={setName}
                hasAutoFocus
                containerClassName="cx-grow"
                width="100%"
              />
              <Button type="submit" label="Save name" isDisabled={busy || !name.trim()} />
              <Button variant="ghost" label="Cancel" onClick={() => setRenaming(null)} />
            </form>
          )}
          {shared && (
            <Banner
              status="info"
              title="Shared snapshot"
              description="Save a copy to edit or refresh it."
              collapsible={false}
            />
          )}
          {!board.tiles.length && (
            <EmptyState
              className="cx-empty-state"
              icon={<PinIcon />}
              title="No charts on this dashboard"
              description="Open a result and choose Pin to dashboard from its export menu."
              headingLevel={3}
            />
          )}
          <div className="cx-tile-grid">
            {board.tiles.map((tile, i) => (
              <Card className="cx-tile" key={tile.id} padding={4}>
                <div className="cx-tile-head">
                  <MicroLabel>{tile.citations[0]?.sourceLabel || "Chart"}</MicroLabel>
                  {!shared && (
                    <MoreMenu
                      label={`Chart actions: ${tile.title}`}
                      size="sm"
                      alignment="end"
                      isDisabled={busy}
                      items={[
                        { label: "Move up", isDisabled: i === 0, onClick: () => save(moveTile(board, tile.id, "up")) },
                        {
                          label: "Move down",
                          isDisabled: i === board.tiles.length - 1,
                          onClick: () => save(moveTile(board, tile.id, "down")),
                        },
                        {
                          label: "Rename chart",
                          onClick: () => {
                            setName(tile.title);
                            setRenaming(tile.id);
                          },
                        },
                        { type: "divider" },
                        {
                          label: "Remove chart",
                          variant: "destructive",
                          onClick: () => setRemoving({ kind: "tile", id: tile.id, title: tile.title }),
                        },
                      ]}
                    />
                  )}
                </div>
                {tile.stale && (
                  <Banner
                    status="warning"
                    title={`Refresh failed: ${tile.stale.reason}`}
                    description="Showing the previous data."
                    collapsible={false}
                  />
                )}
                <TileChart spec={tile.spec} title={tile.title} />
                <Text as="p" type="supporting">
                  {tile.sourceNote}
                </Text>
                <Collapsible
                  className="cx-tile-sources"
                  defaultIsOpen={false}
                  trigger={<MicroLabel>Sources &amp; data · {tile.rows.length} rows</MicroLabel>}
                >
                  <ul className="cx-link-list">
                    {tile.citations.map((c) => (
                      <li key={c.id}>
                        {c.sourceLabel}: {c.indicatorName},{" "}
                        {c.mirroredAt ? `snapshot ${c.mirroredAt}` : `fetched ${c.fetchedAt}`}
                      </li>
                    ))}
                  </ul>
                </Collapsible>
              </Card>
            ))}
          </div>
          <AlertDialog
            isOpen={!!removing}
            onOpenChange={(open) => {
              if (!open) setRemoving(null);
            }}
            title={removing?.kind === "tile" ? "Remove this chart?" : "Delete this dashboard?"}
            description={
              removing?.kind === "tile"
                ? `“${removing.title}” and its recorded rows will be removed from this dashboard.`
                : "The dashboard and every pinned chart on it will be deleted from this browser."
            }
            actionLabel={removing?.kind === "tile" ? "Remove chart" : "Delete dashboard"}
            onAction={confirmRemoval}
          />
        </>
      )}
    </section>
  );
}
