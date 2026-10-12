import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { MapDataSchema, checkMap } from "../src/data/schema.ts";

const MAP_PATH = resolve(import.meta.dirname, "../public/data/map.json");

/** Dev-server-only endpoint that lets the editor (?edit=1) write public/data/map.json. */
export function savePlugin(): Plugin {
  return {
    name: "perseus-editor-save",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__editor/save-map", async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end("POST only");
        }
        try {
          let body = "";
          for await (const chunk of req) body += chunk;
          const map = MapDataSchema.parse(JSON.parse(body));
          const { errors } = checkMap(map);
          if (errors.length) throw new Error(errors.join("\n"));
          await writeFile(MAP_PATH, JSON.stringify(map, null, 2) + "\n");
          res.end("ok");
        } catch (err) {
          res.statusCode = 400;
          res.end((err as Error).message);
        }
      });
    },
  };
}
