import {
  GameDataSchema,
  MapDataSchema,
  checkMap,
  type GameData,
  type GameSystem,
  type MapData,
  type MapSystem,
  type Nation,
  type PresenceRole,
} from "./schema";

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
}

export interface World {
  systems: Map<string, SystemView>;
  nations: Map<string, Nation>;
  /** nation id -> system ids it is present in */
  nationSystems: Map<string, string[]>;
}

const roleOrder: Record<PresenceRole, number> = { capital: 0, colony: 1, outpost: 2, claim: 3 };

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
    const holder = presence.find((p) => p.role === "capital" || p.role === "colony");
    systems.set(geo.id, {
      geo,
      info: info.get(geo.id),
      name: info.get(geo.id)?.name || "Unnamed system",
      presence,
      ownerColor: holder?.nation.color,
      neighbors: neighbors.get(geo.id) ?? [],
    });
  }
  return { systems, nations, nationSystems };
}
