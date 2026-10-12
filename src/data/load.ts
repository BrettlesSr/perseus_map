import {
  GameDataSchema,
  MapDataSchema,
  checkMap,
  type GameData,
  type GameRegion,
  type GameSystem,
  type MapData,
  type MapRegion,
  type MapSystem,
  type Nation,
  type PresenceRole,
  type SystemKind,
} from "./schema";

export const kindLabel: Record<SystemKind, string> = {
  empty: "Empty",
  major: "Major power",
  npc: "NPC",
  hostile: "Hostile NPC",
};

export const asset = (path: string) => `${import.meta.env.BASE_URL}${path}`;

async function fetchJson(path: string): Promise<unknown> {
  // cache-bust so a fresh deploy is picked up without a hard refresh
  const res = await fetch(`${asset(path)}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

export async function loadMap(path = "data/map.json"): Promise<MapData> {
  const map = MapDataSchema.parse(await fetchJson(path));
  const { errors, warnings } = checkMap(map);
  warnings.forEach((w) => console.warn(w));
  if (errors.length) throw new Error(errors.join("\n"));
  return map;
}

export async function loadGame(): Promise<GameData> {
  return GameDataSchema.parse(await fetchJson("data/game.json"));
}

export interface NationPresence {
  nation: Nation;
  role: PresenceRole;
}

export interface SystemView {
  geo: MapSystem;
  /** undefined until the GMs add the system to the Systems tab */
  info?: GameSystem;
  name: string;
  presence: NationPresence[];
  /** colour of the capital/colony holder, for tinting the marker */
  ownerColor?: string;
  neighbors: string[];
  kind?: SystemKind;
  region?: string;
}

export interface RegionView {
  geo: MapRegion;
  /** undefined until the GMs add the region to the Regions tab */
  info?: GameRegion;
  name: string;
  /** system ids inside the outline */
  systems: string[];
}

export interface World {
  systems: Map<string, SystemView>;
  regions: Map<string, RegionView>;
  nations: Map<string, Nation>;
  /** nation id -> system ids it is present in */
  nationSystems: Map<string, string[]>;
}

const roleOrder: Record<PresenceRole, number> = { capital: 0, colony: 1, member: 2, client: 3, outpost: 4, claim: 5 };

/** Even-odd ray casting; polygon in image pixels. */
export function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function buildWorld(map: MapData, game: GameData): World {
  const nations = new Map(game.nations.map((n) => [n.id, n]));
  const info = new Map(game.systems.map((s) => [s.id, s]));
  const neighbors = new Map<string, string[]>();
  for (const [a, b] of map.lanes) {
    neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
    neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
  }

  const presenceBySystem = new Map<string, NationPresence[]>();
  const nationSystems = new Map<string, string[]>();
  for (const p of game.presence) {
    const nation = nations.get(p.nationId);
    if (!nation) continue;
    presenceBySystem.set(p.systemId, [...(presenceBySystem.get(p.systemId) ?? []), { nation, role: p.role }]);
    nationSystems.set(p.nationId, [...(nationSystems.get(p.nationId) ?? []), p.systemId]);
  }

  const systems = new Map<string, SystemView>();
  for (const geo of map.systems) {
    const presence = (presenceBySystem.get(geo.id) ?? []).sort((a, b) => roleOrder[a.role] - roleOrder[b.role]);
    const holder = presence.find((p) => p.role !== "outpost" && p.role !== "claim");
    systems.set(geo.id, {
      geo,
      info: info.get(geo.id),
      name: info.get(geo.id)?.name || "Unnamed system",
      presence,
      ownerColor: holder?.nation.color,
      neighbors: neighbors.get(geo.id) ?? [],
      kind: geo.kind,
      region: map.regions.find((r) => r.polygon.length >= 3 && pointInPolygon(geo.x, geo.y, r.polygon))?.id,
    });
  }

  const regionInfo = new Map(game.regions.map((r) => [r.id, r]));
  const regions = new Map<string, RegionView>();
  for (const geo of map.regions) {
    regions.set(geo.id, {
      geo,
      info: regionInfo.get(geo.id),
      name: regionInfo.get(geo.id)?.name || "Unnamed region",
      systems: [...systems.values()].filter((s) => s.region === geo.id).map((s) => s.geo.id),
    });
  }
  return { systems, regions, nations, nationSystems };
}
