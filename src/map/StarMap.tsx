import { useEffect, useMemo, useState, type ReactNode } from "react";
import L from "leaflet";
import { ImageOverlay, MapContainer, useMap, useMapEvents, ZoomControl } from "react-leaflet";
import type { MapData } from "../data/schema";
import { asset } from "../data/load";
import { imageBounds, toLatLng } from "./coords";

interface Props {
  map: MapData;
  /** system to fly to once on first render (deep link) */
  initialFocus?: { x: number; y: number };
  children?: ReactNode;
}

/** Leaflet canvas showing the static map image in pixel coordinates. */
export function StarMap({ map, initialFocus, children }: Props) {
  const bounds = useMemo(() => L.latLngBounds(imageBounds(map.image.width, map.image.height)), [map.image]);
  // let the user drag a little past the edges so stars on the rim aren't pinned under the panel
  const padded = useMemo(() => bounds.pad(0.25), [bounds]);

  return (
    <MapContainer
      className="star-map"
      crs={L.CRS.Simple}
      bounds={bounds}
      maxBounds={padded}
      maxBoundsViscosity={0.8}
      zoomSnap={0.25}
      zoomDelta={0.5}
      wheelPxPerZoomLevel={90}
      maxZoom={2}
      minZoom={-6}
      attributionControl={false}
      zoomControl={false}
      doubleClickZoom={false}
    >
      <FitMinZoom bounds={bounds} initialFocus={initialFocus} />
      <ZoomControl position="bottomleft" />
      <ImageOverlay url={asset(map.image.src)} bounds={bounds} />
      {children}
    </MapContainer>
  );
}

/** Lock the minimum zoom to "whole map fits", recomputed on resize. */
function FitMinZoom({ bounds, initialFocus }: { bounds: L.LatLngBounds; initialFocus?: { x: number; y: number } }) {
  const map = useMap();
  useEffect(() => {
    const update = () => map.setMinZoom(map.getBoundsZoom(bounds, false) - 0.5);
    update();
    if (initialFocus) map.setView(toLatLng(initialFocus.x, initialFocus.y), Math.max(map.getZoom(), 0), { animate: false });
    map.on("resize", update);
    return () => {
      map.off("resize", update);
    };
    // initialFocus is intentionally applied only once
  }, [map, bounds]);
  return null;
}

/** Current zoom, for sizing screen-space markers relative to the painted stars. */
export function useZoom(): number {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  return zoom;
}

/** Fly the view to a system whenever `target` changes. */
export function FlyTo({ target }: { target?: { x: number; y: number; key: string } }) {
  const map = useMap();
  useEffect(() => {
    if (!target) return;
    map.flyTo(toLatLng(target.x, target.y), Math.max(map.getZoom(), -0.5), { duration: 0.6 });
  }, [target?.key]);
  return null;
}
