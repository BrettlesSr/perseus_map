import { z } from "zod";

// ---- Geometry: owned by the map image (detection + editor) -> public/data/map.json

export const SystemIdSchema = z.string().regex(/^sys-\d{4,}$/, "system ids look like sys-0042");

export const MapSystemSchema = z.object({
  id: SystemIdSchema,
  x: z.number(),
  y: z.number(),
  /** painted star radius in image pixels; used for the hit target */
  r: z.number().positive().default(8),
});

export const MapDataSchema = z.object({
  version: z.literal(1),
  image: z.object({
    src: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  /** next numeric id to hand out; ids of removed systems are never reused */
  nextId: z.number().int().positive(),
  systems: z.array(MapSystemSchema),
  lanes: z.array(z.tuple([SystemIdSchema, SystemIdSchema])),
});

export type MapSystem = z.infer<typeof MapSystemSchema>;
export type MapData = z.infer<typeof MapDataSchema>;

// ---- Lore: owned by the GMs' Google Sheet -> public/data/game.json

export const PresenceRoles = ["capital", "colony", "outpost", "claim"] as const;

export const GameSystemSchema = z.object({
  id: SystemIdSchema,
  /** blank for unnamed waypoint systems */
  name: z.string().default(""),
  description: z.string().default(""),
});

export const NationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  player: z.string().default(""),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "colour must be #rrggbb").default("#cccccc"),
  flagUrl: z.string().default(""),
  description: z.string().default(""),
  forumUrl: z.string().default(""),
});

export const PresenceSchema = z.object({
  systemId: SystemIdSchema,
  nationId: z.string().min(1),
  role: z.enum(PresenceRoles),
});

export const GameDataSchema = z.object({
  generatedAt: z.string(),
  systems: z.array(GameSystemSchema),
  nations: z.array(NationSchema),
  presence: z.array(PresenceSchema),
});

export type GameSystem = z.infer<typeof GameSystemSchema>;
export type Nation = z.infer<typeof NationSchema>;
export type Presence = z.infer<typeof PresenceSchema>;
export type PresenceRole = (typeof PresenceRoles)[number];
export type GameData = z.infer<typeof GameDataSchema>;

// ---- Cross-file checks shared by the app, sync script and CI

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) (seen.has(id) ? dupes : seen).add(id);
  return [...dupes];
}

export function checkMap(map: MapData): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set(map.systems.map((s) => s.id));
  for (const d of duplicates(map.systems.map((s) => s.id))) errors.push(`map: duplicate system id ${d}`);
  for (const [a, b] of map.lanes) {
    if (!ids.has(a) || !ids.has(b)) errors.push(`map: lane ${a}-${b} references a missing system`);
    if (a === b) errors.push(`map: lane ${a}-${b} connects a system to itself`);
  }
  for (const s of map.systems) {
    const n = Number(s.id.slice(4));
    if (n >= map.nextId) errors.push(`map: ${s.id} is >= nextId (${map.nextId})`);
    if (s.x < 0 || s.y < 0 || s.x > map.image.width || s.y > map.image.height)
      warnings.push(`map: ${s.id} lies outside the image`);
  }
  return { errors, warnings };
}

export function checkGame(game: GameData, map: MapData): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mapIds = new Set(map.systems.map((s) => s.id));
  const sheetSystemIds = new Set(game.systems.map((s) => s.id));
  const nationIds = new Set(game.nations.map((n) => n.id));

  for (const d of duplicates(game.systems.map((s) => s.id))) errors.push(`Systems: duplicate system_id ${d}`);
  for (const d of duplicates(game.nations.map((n) => n.id))) errors.push(`Nations: duplicate nation_id ${d}`);

  for (const p of game.presence) {
    if (!mapIds.has(p.systemId)) errors.push(`Presence: ${p.systemId} is not on the map`);
    if (!nationIds.has(p.nationId)) errors.push(`Presence: unknown nation_id ${p.nationId}`);
  }
  for (const d of duplicates(game.presence.map((p) => `${p.systemId}/${p.nationId}`)))
    errors.push(`Presence: duplicate row ${d}`);

  for (const s of game.systems)
    if (!mapIds.has(s.id)) warnings.push(`Systems: ${s.id} (${s.name}) has no position on the map`);
  for (const id of mapIds) if (!sheetSystemIds.has(id)) warnings.push(`map: ${id} has no row in the Systems tab yet`);

  return { errors, warnings };
}
