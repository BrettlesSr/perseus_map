import { useMemo, useState } from "react";
import { Circle, CircleMarker, Pane, Polyline, Tooltip } from "react-leaflet";
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
  const [hoverId, setHoverId] = useState<string>();

  // Detection measures each node's painted edge (ro). Without it, estimate: the fill radius r
  // plus an outline of about half the typical fill radius (4px around an 8px fill).
  const outline = useMemo(() => {
    const rs = map.systems.map((s) => s.r).sort((a, b) => a - b);
    return rs.length ? 0.5 * rs[Math.floor(rs.length / 2)] : 4;
  }, [map.systems]);

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
      <Pane name="star-rings" style={{ zIndex: 420 }}>
        {[...world.systems.values()].map((s) => {
          const isSelected = s.geo.id === selectedId;
          const isHover = s.geo.id === hoverId;
          const isNeighbor = selected?.neighbors.includes(s.geo.id) ?? false;
          const isHighlighted = highlighted?.has(s.geo.id) ?? false;
          // thinner strokes when zoomed out, so the ring never swamps a star a few px across
          const thin = Math.min(1, Math.max(0.4, scale));
          const weight = (isSelected || isHighlighted ? 3 : isHover || s.ownerColor ? 2 : 1) * thin;
          const visible = isSelected || isHover || isHighlighted || isNeighbor || !!s.ownerColor;
          if (!visible) return null;
          // A Circle's radius is in map units (image px), so Leaflet rescales it in its own
          // redraw on every zoom, with no lag waiting for React. Only the half-stroke offset,
          // which keeps the ring's inner edge on the painted edge, is in screen px.
          const radius = (s.geo.ro ?? s.geo.r + outline) + weight / 2 / scale;
          return (
            <Circle
              key={s.geo.id}
              center={toLatLng(s.geo.x, s.geo.y)}
              radius={radius}
              interactive={false}
              className={isSelected ? "star-ring--selected" : undefined}
              pathOptions={{
                color: isSelected || isHover ? "#ffe9a8" : (s.ownerColor ?? "#ffffff"),
                weight,
                opacity: isSelected || isHover || isHighlighted ? 1 : s.ownerColor ? 0.8 : 0.6,
                fill: isHighlighted,
                fillColor: s.ownerColor ?? "#ffffff",
                fillOpacity: 0.3,
              }}
            />
          );
        })}
      </Pane>
      <Pane name="star-hits" style={{ zIndex: 425 }}>
        {[...world.systems.values()].map((s) => {
          const painted = (s.geo.ro ?? s.geo.r + outline) * scale;
          // invisible click target: never smaller than a comfortable tap size
          const radius = Math.max(10, painted + 2);
          return (
            <CircleMarker
              key={s.geo.id}
              center={toLatLng(s.geo.x, s.geo.y)}
              radius={radius}
              bubblingMouseEvents={false}
              className="star"
              eventHandlers={{
                click: () => onSelect(s.geo.id),
                mouseover: () => setHoverId(s.geo.id),
                mouseout: () => setHoverId((cur) => (cur === s.geo.id ? undefined : cur)),
              }}
              pathOptions={{ stroke: false, fillColor: "#ffffff", fillOpacity: 0.01 }}
            >
              <Tooltip direction="top" offset={[0, -painted - 4]} opacity={1} className="star-tooltip">
                {s.name}
              </Tooltip>
            </CircleMarker>
          );
        })}
      </Pane>
    </>
  );
}
