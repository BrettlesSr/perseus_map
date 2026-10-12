/**
 * CI gate: map.json and game.json parse and agree with each other.
 *
 * Structural problems (bad JSON, duplicate ids, lanes to missing stars) fail.
 * Sheet/map disagreements are warnings by default, so a merged map update that
 * removes a star the sheet still mentions doesn't block deploys; --strict fails on them.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { GameDataSchema, MapDataSchema, checkGame, checkMap } from "../src/data/schema.ts";

const root = resolve(import.meta.dirname, "..");
const read = async (p: string) => JSON.parse(await readFile(resolve(root, p), "utf8"));
const strict = process.argv.includes("--strict");

const map = MapDataSchema.parse(await read("public/data/map.json"));
const game = GameDataSchema.parse(await read("public/data/game.json"));
const mapCheck = checkMap(map);
const gameCheck = checkGame(game, map);
const errors = [...mapCheck.errors, ...(strict ? gameCheck.errors : [])];
const warnings = [...mapCheck.warnings, ...gameCheck.warnings, ...(strict ? [] : gameCheck.errors)];

const ci = !!process.env.GITHUB_ACTIONS;
warnings.forEach((w) => console.warn(ci ? `::warning::${w}` : `warning: ${w}`));
errors.forEach((e) => console.error(ci ? `::error::${e}` : `error: ${e}`));
console.log(
  `${map.systems.length} systems, ${map.lanes.length} lanes, ${game.nations.length} nations — ${errors.length} error(s), ${warnings.length} warning(s)`,
);
process.exit(errors.length ? 1 : 0);
