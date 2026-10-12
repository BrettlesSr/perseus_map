/**
 * Pull the GMs' Google Sheet and write public/data/game.json.
 *
 *   SHEET_ID=<id> npm run sync-sheet           # read tabs by name (gviz CSV)
 *   SHEET_ID=<id> SHEET_GIDS="Systems=0,Nations=123,Presence=456" npm run sync-sheet
 *                                              # exact CSV export per tab (avoids gviz type-guessing)
 *   npm run sync-sheet -- --csv path/to/dir    # offline: Systems.csv, Nations.csv, Presence.csv
 *
 * The sheet must be shared as "Anyone with the link can view". Exits non-zero (and
 * writes nothing) if any row is invalid or references an unknown system/nation.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Papa from "papaparse";
import { z } from "zod";
import {
  GameDataSchema,
  GameSystemSchema,
  MapDataSchema,
  NationSchema,
  PresenceSchema,
  checkGame,
  type GameData,
} from "../src/data/schema.ts";

const ROOT = resolve(import.meta.dirname, "..");
const GAME_PATH = resolve(ROOT, "public/data/game.json");
const MAP_PATH = resolve(ROOT, "public/data/map.json");
const TABS = ["Systems", "Nations", "Presence"] as const;
type Tab = (typeof TABS)[number];
type Row = Record<string, string>;

const inCI = !!process.env.GITHUB_ACTIONS;
const warn = (msg: string) => console.warn(inCI ? `::warning::${msg}` : `warning: ${msg}`);
const fail = (msg: string) => console.error(inCI ? `::error::${msg}` : `error: ${msg}`);

async function readTab(tab: Tab): Promise<string> {
  const csvIdx = process.argv.indexOf("--csv");
  if (csvIdx !== -1) return readFile(resolve(process.argv[csvIdx + 1], `${tab}.csv`), "utf8");

  const id = process.env.SHEET_ID;
  if (!id) throw new Error("Set SHEET_ID (or pass --csv <dir>)");
  const gids = Object.fromEntries(
    (process.env.SHEET_GIDS ?? "")
      .split(",")
      .filter(Boolean)
      .map((kv) => kv.split("=").map((s) => s.trim())),
  );
  const url = gids[tab]
    ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gids[tab]}`
    : `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(tab)}`;
  const res = await fetch(url, { redirect: "follow" });
  const text = await res.text();
  if (!res.ok || text.trimStart().startsWith("<"))
    throw new Error(`Could not read tab "${tab}" (HTTP ${res.status}). Is the sheet shared as "anyone with the link"?`);
  return text;
}

function parseCsv(text: string): Row[] {
  // papaparse picks one newline style from the first line; hand-edited files can mix them
  const { data } = Papa.parse<Row>(text.replace(/\r\n?/g, "\n"), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
    transform: (v) => v.trim(),
  });
  return data;
}

const errors: string[] = [];
/** ids of rows that failed validation, so references to them aren't reported again */
const rejected = new Set<string>();

/** Validate each row, reporting problems with the sheet row number GMs will see. */
function rows<T>(tab: Tab, raw: Row[], idCol: string, schema: z.ZodType<T>, map: (r: Row) => unknown): T[] {
  const out: T[] = [];
  raw.forEach((r, i) => {
    if (!r[idCol]) return; // blank / note rows
    const parsed = schema.safeParse(map(r));
    if (parsed.success) out.push(parsed.data);
    else {
      rejected.add(r[idCol]);
      for (const issue of parsed.error.issues)
        errors.push(`${tab} row ${i + 2} (${r[idCol]}): ${issue.path.join(".") || "row"} ${issue.message}`);
    }
  });
  return out;
}

const normalizeColor = (c: string) => (c && !c.startsWith("#") ? `#${c}` : c) || undefined;
const normalizeSystemId = (id: string) => {
  // accept "42" or "sys-42" in the sheet; store as sys-0042
  const m = /^(?:sys-)?(\d+)$/i.exec(id);
  return m ? `sys-${m[1].padStart(4, "0")}` : id;
};

async function main() {
  const [systemsCsv, nationsCsv, presenceCsv] = await Promise.all(TABS.map(readTab));

  const game: GameData = {
    generatedAt: new Date().toISOString(),
    systems: rows("Systems", parseCsv(systemsCsv), "system_id", GameSystemSchema, (r) => ({
      id: normalizeSystemId(r.system_id),
      name: r.name,
      description: r.description ?? "",
    })),
    nations: rows("Nations", parseCsv(nationsCsv), "nation_id", NationSchema, (r) => ({
      id: r.nation_id,
      name: r.name,
      player: r.player || undefined,
      color: normalizeColor(r.color ?? ""),
      flagUrl: r.flag_url || undefined,
      description: r.description || undefined,
      forumUrl: r.forum_url || undefined,
    })),
    presence: rows("Presence", parseCsv(presenceCsv), "system_id", PresenceSchema, (r) => ({
      systemId: normalizeSystemId(r.system_id),
      nationId: r.nation_id,
      role: (r.role || "colony").toLowerCase(),
    })),
  };

  const map = MapDataSchema.parse(JSON.parse(await readFile(MAP_PATH, "utf8")));
  const check = checkGame(GameDataSchema.parse(game), map);
  errors.push(...check.errors.filter((e) => ![...rejected].some((id) => e.endsWith(` ${id}`))));
  check.warnings.forEach(warn);

  if (errors.length) {
    errors.forEach(fail);
    console.error(`\n${errors.length} problem(s) in the sheet; game.json not updated.`);
    process.exit(1);
  }

  // keep generatedAt stable when nothing changed, so scheduled runs don't create empty commits
  const strip = ({ generatedAt: _, ...rest }: GameData) => JSON.stringify(rest);
  try {
    const prev = GameDataSchema.parse(JSON.parse(await readFile(GAME_PATH, "utf8")));
    if (strip(prev) === strip(game)) {
      console.log("game.json is already up to date.");
      return;
    }
  } catch {
    // no previous file / unreadable: just write
  }
  await writeFile(GAME_PATH, JSON.stringify(game, null, 2) + "\n");
  console.log(
    `Wrote game.json: ${game.systems.length} systems, ${game.nations.length} nations, ${game.presence.length} presence rows.`,
  );
}

main().catch((e: Error) => {
  fail(e.message);
  process.exit(1);
});
