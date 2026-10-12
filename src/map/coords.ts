import L from "leaflet";

// The map uses L.CRS.Simple with one map unit per image pixel. Leaflet's lat
// grows upwards, image y grows downwards, so image (x, y) <-> LatLng(-y, x).

export const toLatLng = (x: number, y: number): L.LatLngTuple => [-y, x];

export const fromLatLng = (ll: L.LatLng): { x: number; y: number } => ({
  x: Math.round(ll.lng * 10) / 10,
  y: Math.round(-ll.lat * 10) / 10,
});

export const imageBounds = (width: number, height: number): L.LatLngBoundsLiteral => [
  [-height, 0],
  [0, width],
];
