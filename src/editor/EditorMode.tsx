import { useCallback, useEffect, useMemo, useState } from "react";
import L from "leaflet";
import { CircleMarker, Marker, Pane, Polygon, Polyline, useMapEvents } from "react-leaflet";
import { MapDataSchema, checkMap, type MapData, type MapSystem } from "../data/schema";
import type { World } from "../data/load";
import { fromLatLng, toLatLng } from "../map/coords";

export type Tool = "move" | "add" | "lane" | "delete" | "region";

const formatId = (n: number) => `sys-${String(n).padStart(4, "0")}`;
const laneKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Editable copy of map.json with undo. Lives in App so toolbar and layers share it. */
export function useMapDraft(initial: MapData) {
  const [history, setHistory] = useState<MapData[]>([initial]);
  const [saved, setSaved] = useState<MapData>(initial);
  const draft = history[history.length - 1];

  const commit = useCallback((next: (m: MapData) => MapData) => {
    setHistory((h) => [...h.slice(-99), next(h[h.length - 1])]);
  }, []);
  const undo = useCallback(() => setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h)), []);

  return { draft, commit, undo, canUndo: history.length > 1, dirty: draft !== saved, markSaved: () => setSaved(draft) };
}

export type MapDraft = ReturnType<typeof useMapDraft>;

// ---------------------------------------------------------------- map layers

interface LayerProps {
  draft: MapDraft;
  world: World;
  tool: Tool;
  laneStart?: string;
  setLaneStart: (id: string | undefined) => void;
  showLabels: boolean;
  proposal?: MapData;
  editRegion?: string;
}

export function EditorLayers(props: LayerProps) {
  const { draft, world, tool, laneStart, setLaneStart, showLabels, proposal, editRegion } = props;
  const map = draft.draft;
  const byId = useMemo(() => new Map(map.systems.map((s) => [s.id, s])), [map.systems]);
  const defaultR = useMemo(() => {
    const rs = map.systems.map((s) => s.r).sort((a, b) => a - b);
    return rs.length ? rs[Math.floor(rs.length / 2)] : 8;
  }, [map.systems]);

  const setRegionPolygon = (id: string, f: (poly: [number, number][]) => [number, number][]) =>
    draft.commit((m) => ({ ...m, regions: m.regions.map((r) => (r.id === id ? { ...r, polygon: f(r.polygon) } : r)) }));

  useMapEvents({
    click(e) {
      if (tool === "region" && editRegion) {
        // append a corner: how a missing outline is drawn from scratch
        const { x, y } = fromLatLng(e.latlng);
        setRegionPolygon(editRegion, (poly) => [...poly, [x, y]]);
        return;
      }
      if (tool !== "add") return;
      const { x, y } = fromLatLng(e.latlng);
      draft.commit((m) => ({
        ...m,
        nextId: m.nextId + 1,
        systems: [...m.systems, { id: formatId(m.nextId), x, y, r: defaultR }],
      }));
    },
  });

  const onStarClick = (s: MapSystem) => {
    if (tool === "delete") {
      draft.commit((m) => ({
        ...m,
        systems: m.systems.filter((o) => o.id !== s.id),
        lanes: m.lanes.filter(([a, b]) => a !== s.id && b !== s.id),
      }));
    } else if (tool === "lane") {
      if (!laneStart) return setLaneStart(s.id);
      if (laneStart === s.id) return setLaneStart(undefined);
      const key = laneKey(laneStart, s.id);
      const start = laneStart;
      draft.commit((m) => {
        const exists = m.lanes.some(([a, b]) => laneKey(a, b) === key);
        return {
          ...m,
          lanes: exists
            ? m.lanes.filter(([a, b]) => laneKey(a, b) !== key)
            : [...m.lanes, (start < s.id ? [start, s.id] : [s.id, start]) as [string, string]],
        };
      });
      setLaneStart(s.id); // chain: keep drawing from the star just reached
    }
  };

  return (
    <>
      {proposal && <ProposalLayer current={map} proposal={proposal} />}
      <RegionOutlines
        regions={map.regions}
        editing={tool === "region" ? editRegion : undefined}
        setPolygon={setRegionPolygon}
      />
      <Pane name="editor-lanes" style={{ zIndex: 430 }}>
        {map.lanes.map(([a, b]) => {
          const sa = byId.get(a);
          const sb = byId.get(b);
          if (!sa || !sb) return null;
          return (
            <Polyline
              key={laneKey(a, b)}
              positions={[toLatLng(sa.x, sa.y), toLatLng(sb.x, sb.y)]}
              interactive={false}
              pathOptions={{ color: "#5ad1ff", weight: 2, opacity: 0.85 }}
            />
          );
        })}
      </Pane>
      {map.systems.map((s) => (
        <EditorStar
          key={s.id}
          system={s}
          label={showLabels ? world.systems.get(s.id)?.info?.name || s.id : undefined}
          unnamed={!world.systems.get(s.id)?.info}
          active={s.id === laneStart}
          draggable={tool === "move"}
          interactive={tool !== "region"}
          onClick={() => onStarClick(s)}
          onMove={(x, y) =>
            draft.commit((m) => ({ ...m, systems: m.systems.map((o) => (o.id === s.id ? { ...o, x, y } : o)) }))
          }
        />
      ))}
    </>
  );
}

interface StarProps {
  system: MapSystem;
  label?: string;
  unnamed: boolean;
  active: boolean;
  draggable: boolean;
  interactive: boolean;
  onClick: () => void;
  onMove: (x: number, y: number) => void;
}

function EditorStar({ system, label, unnamed, active, draggable, interactive, onClick, onMove }: StarProps) {
  const icon = useMemo(
    () =>
      L.divIcon({
        className: "ed-star-icon",
        iconSize: [14, 14],
        html:
          `<div class="ed-star${active ? " ed-star--active" : ""}${unnamed ? " ed-star--unnamed" : ""}"></div>` +
          (label ? `<div class="ed-star__label">${escapeHtml(label)}</div>` : ""),
      }),
    [active, unnamed, label],
  );
  return (
    <Marker
      position={toLatLng(system.x, system.y)}
      icon={icon}
      draggable={draggable}
      interactive={interactive}
      bubblingMouseEvents={false}
      eventHandlers={{
        click: onClick,
        dragend: (e) => {
          const { x, y } = fromLatLng((e.target as L.Marker).getLatLng());
          onMove(x, y);
        },
      }}
    />
  );
}

/** Ghost overlay comparing a detection proposal to the current draft. */
function ProposalLayer({ current, proposal }: { current: MapData; proposal: MapData }) {
  const cur = new Map(current.systems.map((s) => [s.id, s]));
  const prop = new Map(proposal.systems.map((s) => [s.id, s]));
  return (
    <Pane name="proposal" style={{ zIndex: 425 }}>
      {proposal.systems.map((p) => {
        const c = cur.get(p.id);
        if (!c)
          return (
            <CircleMarker
              key={p.id}
              center={toLatLng(p.x, p.y)}
              radius={10}
              interactive={false}
              pathOptions={{ color: "#4ade80", weight: 2, dashArray: "3 3", fillOpacity: 0.15 }}
            />
          );
        if (Math.hypot(c.x - p.x, c.y - p.y) < 1) return null;
        return (
          <Polyline
            key={p.id}
            positions={[toLatLng(c.x, c.y), toLatLng(p.x, p.y)]}
            interactive={false}
            pathOptions={{ color: "#facc15", weight: 2, dashArray: "4 3" }}
          />
        );
      })}
      {current.systems
        .filter((c) => !prop.has(c.id))
        .map((c) => (
          <CircleMarker
            key={`gone-${c.id}`}
            center={toLatLng(c.x, c.y)}
            radius={12}
            interactive={false}
            pathOptions={{ color: "#f87171", weight: 2, dashArray: "2 4", fillOpacity: 0 }}
          />
        ))}
    </Pane>
  );
}

/** All region outlines faintly; the one being edited with draggable corner handles. */
function RegionOutlines({
  regions,
  editing,
  setPolygon,
}: {
  regions: MapData["regions"];
  editing?: string;
  setPolygon: (id: string, f: (poly: [number, number][]) => [number, number][]) => void;
}) {
  const handle = useMemo(() => L.divIcon({ className: "region-handle", iconSize: [12, 12] }), []);
  const mid = useMemo(() => L.divIcon({ className: "region-handle region-handle--mid", iconSize: [9, 9] }), []);
  const current = regions.find((r) => r.id === editing);
  return (
    <>
      <Pane name="editor-regions" style={{ zIndex: 404 }}>
        {regions
          .filter((r) => r.polygon.length >= 2)
          .map((r) => (
            <Polygon
              key={r.id}
              positions={r.polygon.map(([x, y]) => toLatLng(x, y))}
              interactive={false}
              pathOptions={{
                color: "#b06ad9",
                weight: r.id === editing ? 3 : 1.5,
                dashArray: r.id === editing ? undefined : "6 6",
                fillOpacity: r.id === editing ? 0.15 : 0.04,
              }}
            />
          ))}
      </Pane>
      {current?.polygon.map(([x, y], i) => (
        <Marker
          key={`v${i}-${x}-${y}`}
          position={toLatLng(x, y)}
          icon={handle}
          draggable
          bubblingMouseEvents={false}
          eventHandlers={{
            dragend: (e) => {
              const p = fromLatLng((e.target as L.Marker).getLatLng());
              setPolygon(current.id, (poly) => poly.map((v, j) => (j === i ? [p.x, p.y] : v)));
            },
            contextmenu: (e) => {
              L.DomEvent.preventDefault(e.originalEvent);
              setPolygon(current.id, (poly) => poly.filter((_, j) => j !== i));
            },
          }}
        />
      ))}
      {current &&
        current.polygon.length >= 2 &&
        current.polygon.map(([x, y], i) => {
          const [nx, ny] = current.polygon[(i + 1) % current.polygon.length];
          return (
            <Marker
              key={`m${i}-${x}-${y}`}
              position={toLatLng((x + nx) / 2, (y + ny) / 2)}
              icon={mid}
              bubblingMouseEvents={false}
              eventHandlers={{
                click: () =>
                  setPolygon(current.id, (poly) => [
                    ...poly.slice(0, i + 1),
                    [Math.round(((x + nx) / 2) * 10) / 10, Math.round(((y + ny) / 2) * 10) / 10],
                    ...poly.slice(i + 1),
                  ]),
              }}
            />
          );
        })}
    </>
  );
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------------------------------------------------------------- toolbar

interface ToolbarProps {
  draft: MapDraft;
  tool: Tool;
  setTool: (t: Tool) => void;
  laneStart?: string;
  setLaneStart: (id: string | undefined) => void;
  showLabels: boolean;
  setShowLabels: (v: boolean) => void;
  proposal?: MapData;
  setProposal: (p: MapData | undefined) => void;
  world: World;
  editRegion?: string;
  setEditRegion: (id: string | undefined) => void;
}

const tools: { id: Tool; label: string; hint: string }[] = [
  { id: "move", label: "Move", hint: "Drag stars to reposition them" },
  { id: "add", label: "Add", hint: "Click empty space to add a star" },
  { id: "lane", label: "Lanes", hint: "Click two stars to add/remove a lane (Esc to stop)" },
  { id: "delete", label: "Delete", hint: "Click a star to delete it and its lanes" },
  {
    id: "region",
    label: "Regions",
    hint: "Drag corners; click a midpoint to add one; right-click a corner to remove it; click the map to append",
  },
];

export function EditorToolbar(props: ToolbarProps) {
  const { draft, tool, setTool, laneStart, setLaneStart, showLabels, setShowLabels, proposal, setProposal } = props;
  const { world, editRegion, setEditRegion } = props;
  const [status, setStatus] = useState<string>();
  const problems = useMemo(() => checkMap(draft.draft), [draft.draft]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        draft.undo();
      } else if (e.key === "Escape") setLaneStart(undefined);
      else if (e.key === "1") setTool("move");
      else if (e.key === "2") setTool("add");
      else if (e.key === "3") setTool("lane");
      else if (e.key === "4") setTool("delete");
      else if (e.key === "5") setTool("region");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, setLaneStart, setTool]);

  // warn before losing unsaved work
  useEffect(() => {
    if (!draft.dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [draft.dirty]);

  const save = async () => {
    const body = JSON.stringify(draft.draft, null, 2) + "\n";
    if (import.meta.env.DEV) {
      const res = await fetch("/__editor/save-map", { method: "POST", body });
      if (!res.ok) return setStatus(`Save failed: ${await res.text()}`);
      setStatus("Saved to public/data/map.json");
    } else {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
      a.download = "map.json";
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus("Downloaded — commit it as public/data/map.json");
    }
    draft.markSaved();
  };

  const loadProposal = async (file: File) => {
    try {
      setProposal(MapDataSchema.parse(JSON.parse(await file.text())));
      setStatus(`Loaded proposal ${file.name}`);
    } catch (err) {
      setStatus(`Not a valid map.json: ${(err as Error).message.slice(0, 200)}`);
    }
  };

  const m = draft.draft;
  return (
    <div className="editor-bar" role="toolbar" aria-label="Map editor">
      <div className="editor-bar__row">
        <strong className="editor-bar__title">Editor</strong>
        <div className="seg">
          {tools.map((t, i) => (
            <button
              key={t.id}
              className={`seg__btn${tool === t.id ? " seg__btn--on" : ""}`}
              title={`${t.hint} (${i + 1})`}
              onClick={() => {
                setTool(t.id);
                setLaneStart(undefined);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button className="btn" onClick={draft.undo} disabled={!draft.canUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button className="btn btn--primary" onClick={save} disabled={problems.errors.length > 0}>
          {import.meta.env.DEV ? "Save" : "Download"}
          {draft.dirty ? " •" : ""}
        </button>
      </div>
      <div className="editor-bar__row editor-bar__row--small">
        <span>{tools.find((t) => t.id === tool)!.hint}</span>
        {laneStart && <span> · from {laneStart}</span>}
      </div>
      {tool === "region" && (
        <div className="editor-bar__row editor-bar__row--small">
          <select
            className="btn btn--small"
            value={editRegion ?? ""}
            onChange={(e) => setEditRegion(e.target.value || undefined)}
            aria-label="Region to edit"
          >
            <option value="">Choose a region…</option>
            {draft.draft.regions.map((r) => (
              <option key={r.id} value={r.id}>
                {world.regions.get(r.id)?.name ?? r.id} ({r.id}){r.polygon.length ? "" : " · no outline"}
              </option>
            ))}
          </select>
          {editRegion && (
            <button
              className="btn btn--small"
              onClick={() =>
                draft.commit((m) => ({
                  ...m,
                  regions: m.regions.map((r) => (r.id === editRegion ? { ...r, polygon: [] } : r)),
                }))
              }
            >
              Clear outline
            </button>
          )}
          {editRegion && <span>{world.regions.get(editRegion)?.systems.length ?? 0} systems inside</span>}
        </div>
      )}
      <div className="editor-bar__row editor-bar__row--small">
        <label>
          <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Labels
        </label>
        <label className="btn btn--small">
          Load proposal…
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => e.target.files?.[0] && loadProposal(e.target.files[0])}
          />
        </label>
        {proposal && (
          <>
            <button
              className="btn btn--small"
              onClick={() => {
                draft.commit(() => proposal);
                setProposal(undefined);
                setStatus("Proposal accepted — review, then save");
              }}
            >
              Accept proposal
            </button>
            <button className="btn btn--small" onClick={() => setProposal(undefined)}>
              Dismiss
            </button>
          </>
        )}
        <span className="editor-bar__stats">
          {m.systems.length} stars · {m.lanes.length} lanes · next {formatId(m.nextId)}
        </span>
      </div>
      {proposal && (
        <div className="editor-bar__row editor-bar__row--small legend">
          <span className="legend__new">new</span>
          <span className="legend__moved">moved</span>
          <span className="legend__gone">removed</span>
        </div>
      )}
      {problems.errors.map((e) => (
        <div key={e} className="editor-bar__error">
          {e}
        </div>
      ))}
      {status && <div className="editor-bar__status">{status}</div>}
    </div>
  );
}
