import { useState } from "react";
import { Pane, Polygon, Rectangle, Tooltip } from "react-leaflet";
import type { World } from "../data/load";
import { toLatLng } from "./coords";

interface Props {
  world: World;
  selectedId?: string;
  onSelect: (id: string) => void;
}

/** Click targets over the printed region names, and the outline of the hovered/selected region. */
export function RegionLayer({ world, selectedId, onSelect }: Props) {
  const [hoverId, setHoverId] = useState<string>();
  const regions = [...world.regions.values()];

  return (
    <>
      <Pane name="region-outline" style={{ zIndex: 405 }}>
        {regions
          .filter((r) => (r.geo.id === selectedId || r.geo.id === hoverId) && r.geo.polygon.length >= 3)
          .map((r) => (
            <Polygon
              key={r.geo.id}
              positions={r.geo.polygon.map(([x, y]) => toLatLng(x, y))}
              interactive={false}
              pathOptions={{
                color: "#b06ad9",
                weight: r.geo.id === selectedId ? 3 : 2,
                dashArray: "8 6",
                fillColor: "#b06ad9",
                fillOpacity: r.geo.id === selectedId ? 0.12 : 0.06,
              }}
            />
          ))}
      </Pane>
      <Pane name="region-labels" style={{ zIndex: 415 }}>
        {regions.map((r) => {
          const { x, y, w, h } = r.geo.label;
          const pad = 4;
          return (
            <Rectangle
              key={r.geo.id}
              bounds={[toLatLng(x - pad, y + h + pad), toLatLng(x + w + pad, y - pad)]}
              className="region-label"
              bubblingMouseEvents={false}
              pathOptions={{
                color: "#b06ad9",
                weight: r.geo.id === selectedId || r.geo.id === hoverId ? 1.5 : 0,
                fillColor: "#b06ad9",
                fillOpacity: r.geo.id === selectedId ? 0.12 : 0.01,
              }}
              eventHandlers={{
                click: () => onSelect(r.geo.id),
                mouseover: () => setHoverId(r.geo.id),
                mouseout: () => setHoverId((cur) => (cur === r.geo.id ? undefined : cur)),
              }}
            >
              <Tooltip direction="bottom" opacity={1} className="star-tooltip">
                {r.name} · {r.systems.length} systems
              </Tooltip>
            </Rectangle>
          );
        })}
      </Pane>
    </>
  );
}
