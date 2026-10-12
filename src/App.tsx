import { useCallback, useEffect, useMemo, useState } from "react";
import { buildWorld, loadGame, loadMap } from "./data/load";
import type { GameData, MapData } from "./data/schema";
import { FlyTo, StarMap } from "./map/StarMap";
import { ViewerLayers } from "./map/ViewerLayers";
import { SystemPanel } from "./panel/SystemPanel";
import { Search } from "./panel/Search";
import { EditorLayers, EditorToolbar, useMapDraft, type Tool } from "./editor/EditorMode";

type Loaded = { map: MapData; game: GameData };

export function App() {
  const [data, setData] = useState<Loaded>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([loadMap(), loadGame()])
      .then(([map, game]) => setData({ map, game }))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error)
    return (
      <div className="fullscreen-msg">
        <h1>Couldn't load the map</h1>
        <pre>{error}</pre>
      </div>
    );
  if (!data) return <div className="fullscreen-msg">Charting the stars…</div>;
  return <MapApp {...data} />;
}

// ---- URL state: ?system=sys-0001&nation=foo&edit=1

function readParams() {
  const p = new URLSearchParams(location.search);
  return { system: p.get("system") ?? undefined, nation: p.get("nation") ?? undefined, edit: p.has("edit") };
}

function writeParams(system?: string, nation?: string) {
  const p = new URLSearchParams(location.search);
  for (const [k, v] of [["system", system], ["nation", nation]] as const) {
    if (v) p.set(k, v);
    else p.delete(k);
  }
  const qs = p.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
}

function MapApp({ map: loadedMap, game }: Loaded) {
  const initial = useMemo(readParams, []);
  const draft = useMapDraft(loadedMap);
  const map = initial.edit ? draft.draft : loadedMap;
  const world = useMemo(() => buildWorld(map, game), [map, game]);

  const [selectedId, setSelectedId] = useState(() =>
    initial.system && world.systems.has(initial.system) ? initial.system : undefined,
  );
  const [nationId, setNationId] = useState(() =>
    initial.nation && world.nations.has(initial.nation) ? initial.nation : undefined,
  );
  const [flyTarget, setFlyTarget] = useState<{ x: number; y: number; key: string }>();
  const [showLanes, setShowLanes] = useState(false); // the painted map already shows lanes

  // editor state
  const [tool, setTool] = useState<Tool>("move");
  const [laneStart, setLaneStart] = useState<string>();
  const [showLabels, setShowLabels] = useState(true);
  const [proposal, setProposal] = useState<MapData>();

  useEffect(() => writeParams(selectedId, nationId), [selectedId, nationId]);

  const flyToSystem = useCallback(
    (id: string) => {
      const s = world.systems.get(id);
      if (s) setFlyTarget({ x: s.geo.x, y: s.geo.y, key: `${id}:${Date.now()}` });
    },
    [world],
  );

  const highlighted = useMemo(
    () => (nationId ? new Set(world.nationSystems.get(nationId) ?? []) : undefined),
    [nationId, world],
  );

  const focusNation = (id: string | undefined) => {
    setNationId(id);
    if (!id) return;
    // jump to the capital (or first holding) when chosen from search
    const ids = world.nationSystems.get(id) ?? [];
    const capital = ids.find((sid) => world.systems.get(sid)?.presence.some((p) => p.nation.id === id && p.role === "capital"));
    const target = capital ?? ids[0];
    if (target && !selectedId) {
      setSelectedId(target);
      flyToSystem(target);
    }
  };

  const initialFocus = selectedId ? world.systems.get(selectedId)?.geo : undefined;
  const focusedNation = nationId ? world.nations.get(nationId) : undefined;

  return (
    <div className={`app${selectedId && !initial.edit ? " app--panel-open" : ""}`}>
      <StarMap map={map} initialFocus={initialFocus}>
        <FlyTo target={flyTarget} />
        {initial.edit ? (
          <EditorLayers
            draft={draft}
            world={world}
            tool={tool}
            laneStart={laneStart}
            setLaneStart={setLaneStart}
            showLabels={showLabels}
            proposal={proposal}
          />
        ) : (
          <ViewerLayers
            map={map}
            world={world}
            selectedId={selectedId}
            highlighted={highlighted}
            showLanes={showLanes}
            onSelect={(id) => setSelectedId((cur) => (cur === id ? undefined : id))}
          />
        )}
      </StarMap>

      {initial.edit ? (
        <EditorToolbar
          draft={draft}
          tool={tool}
          setTool={setTool}
          laneStart={laneStart}
          setLaneStart={setLaneStart}
          showLabels={showLabels}
          setShowLabels={setShowLabels}
          proposal={proposal}
          setProposal={setProposal}
        />
      ) : (
        <div className="topbar">
          <h1 className="topbar__title">Perseus</h1>
          <Search
            world={world}
            onSelectSystem={(id) => {
              setSelectedId(id);
              flyToSystem(id);
            }}
            onFocusNation={focusNation}
          />
          <label className="toggle">
            <input type="checkbox" checked={showLanes} onChange={(e) => setShowLanes(e.target.checked)} />
            Lanes
          </label>
          {focusedNation && (
            <button className="chip chip--active" style={{ borderColor: focusedNation.color }} onClick={() => setNationId(undefined)}>
              {focusedNation.name} territory ×
            </button>
          )}
        </div>
      )}

      {!initial.edit && selectedId && (
        <SystemPanel
          world={world}
          systemId={selectedId}
          focusedNationId={nationId}
          onSelectSystem={(id) => {
            setSelectedId(id);
            flyToSystem(id);
          }}
          onFocusNation={focusNation}
          onClose={() => setSelectedId(undefined)}
        />
      )}
    </div>
  );
}
