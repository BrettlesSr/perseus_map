import { useMemo } from "react";
import { CircleMarker, Pane, Polyline, Tooltip } from "react-leaflet";
import type { MapData } from "../data/schema";
import type { World } from "../data/load";
import { toLatLng } from "./coords";
import { useZoom } from "./StarMap";

interface Props {
  map: MapData;
  world: World;
  selectedId?: string;
  /** systems to emphasise (e.g. everything held by a selected nation) */
  highlighted?: Set<string>;
  showLanes: boolean;
  onSelect: (id: string) => void;
}

export function ViewerLayers({ map, world, selectedId, highlighted, showLanes, onSelect }: Props) {
  const zoom = useZoom();
  const scale = 2 ** zoom; // screen px per image px
  const selected = selectedId ? world.systems.get(selectedId) : undefined;

  const lanes = useMemo(
    () =>
      map.lanes.flatMap(([a, b]) => {
        const sa = world.systems.get(a)?.geo;
        const sb = world.systems.get(b)?.geo;
        return sa && sb ? [{ key: `${a}-${b}`, a, b, pts: [toLatLng(sa.x, sa.y), toLatLng(sb.x, sb.y)] }] : [];
      }),
    [map.lanes, world],
  );

  return (
    <>
      <Pane name="lanes" style={{ zIndex: 410 }}>
        {lanes.map((l) => {
          const active = selectedId !== undefined && (l.a === selectedId || l.b === selectedId);
          if (!showLanes && !active) return null;
          return (
            <Polyline
              key={l.key}
              positions={l.pts}
              interactive={false}
              pathOptions={{
                color: active ? "#ffe9a8" : "#9fb6ff",
                weight: active ? 3 : 1.5,
                opacity: active ? 0.95 : 0.35,
              }}
            />
          );
        })}
      </Pane>
      <Pane name="stars" style={{ zIndex: 420 }}>
        {[...world.systems.values()].map((s) => {
          const isSelected = s.geo.id === selectedId;
          const isNeighbor = selected?.neighbors.includes(s.geo.id) ?? false;
          const isHighlighted = highlighted?.has(s.geo.id) ?? false;
          // a comfortable hit target that still hugs the painted star when zoomed in
          const radius = Math.max(9, s.geo.r * scale + 4);
          const ring = s.ownerColor ?? "#ffffff";
          return (
            <CircleMarker
              key={s.geo.id}
              center={toLatLng(s.geo.x, s.geo.y)}
              radius={radius}
              bubblingMouseEvents={false}
              eventHandlers={{ click: () => onSelect(s.geo.id) }}
              className={`star${isSelected ? " star--selected" : ""}`}
              pathOptions={{
                color: isSelected ? "#ffe9a8" : ring,
                weight: isSelected ? 3 : isHighlighted ? 3 : s.ownerColor ? 2 : 1,
                opacity: isSelected || isHighlighted ? 1 : s.ownerColor ? 0.75 : isNeighbor ? 0.6 : 0.0,
                fillColor: s.ownerColor ?? "#ffffff",
                fillOpacity: isHighlighted ? 0.35 : s.ownerColor ? 0.12 : 0.01,
              }}
            >
              <Tooltip direction="top" offset={[0, -radius]} opacity={1} className="star-tooltip">
                {s.name}
              </Tooltip>
            </CircleMarker>
          );
        })}
      </Pane>
    </>
  );
}
