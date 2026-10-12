# Perseus Map

An interactive star map for the Perseus forum game. Pan and zoom the map, click a system to see
what kind of system it is, its region and the nations there, or click a region's name to see
the region. Search covers systems, regions and nations, and any of them can be linked to
(`?system=sys-0042`, `?region=reg-03`, `?nation=vey`).

The data comes from two sources, joined by id (`sys-0042`, `reg-03`):

| What | Lives in | Maintained by |
|---|---|---|
| Where stars, lanes and regions are, and each star's kind | `public/data/map.json` | detected from the map image, fixed up in the editor |
| Names, descriptions, nations, who holds what | Google Sheet → `public/data/game.json` | GMs, in the sheet |

A star's **kind** comes from its colour on the map: white = empty, blue = player,
green = NPC, red = hostile NPC.

## Day-to-day

### GMs: editing nations and systems
Edit the Google Sheet. An hourly job pulls it into the site and redeploys. To publish straight
away, open **Actions → Sync Google Sheet → Run workflow**.

If a row is invalid (a bad colour, an unknown system id, a typo'd nation id), the sync fails,
GitHub emails the repo owner, and the site keeps the last good data. The failed run lists each
problem with its tab and row number.

### Artist: publishing a new version of the map
1. On GitHub, open `public/map/` → **Add file → Upload files**, and upload the new image. Use the
   same filename to replace it, or a new one.
2. Choose **Create a new branch … and start a pull request**.
3. Within a couple of minutes a bot commits the updated `map.json` to the PR. It also comments a
   report (new, moved and removed systems, lane changes) with an overlay picture:
   - white circles: stars that kept their id
   - green: new stars
   - orange: stars that moved
   - red ✕: stars that disappeared
   It also lists systems that changed colour (kind), e.g. an empty node a player has claimed.
4. Check the overlay. If it's right, merge. The new image and its star data go live together.
5. Add the new systems (listed in the report) to the **Systems** tab of the sheet.

Region outlines (magenta in the overlay) are carried over from the previous map: they move and
scale with the stars, but they are not re-traced. If the artist redraws a region border, adjust
the outline in the editor (below), or re-detect them all with `--propose-regions` and review.

Existing systems keep their ids even if the canvas grows or the whole map shifts, so the sheet
never needs renumbering. Ids of removed systems are never reused.

### Fixing detection mistakes (editor)
Run the app locally (see [Development](#development)) and open <http://localhost:5173/?edit=1>:

| Tool | Key | Action |
|---|---|---|
| Move | 1 | drag a star |
| Add | 2 | click empty space |
| Lanes | 3 | click two stars to add or remove a lane; keep clicking to chain; Esc stops |
| Delete | 4 | click a star |
| Regions | 5 | pick a region, then drag its corners; click a midpoint to add a corner; right-click a corner to remove it; click the map to add a corner at the end (how an outline is drawn from scratch) |

- **Ctrl+Z** undoes.
- **Save** writes `public/data/map.json`.
- **Load proposal…** shows a detection result (`detect-out/map.proposed.json`, or one from a PR's
  run artifacts) against the current map, and can accept it.
- Orange stars have no row in the sheet yet.
- A system belongs to the region whose outline contains it, so moving an outline changes which
  systems the region lists. The editor shows the count as you go.

Commit the result to the PR branch. On the live site, `?edit=1` works too, but Save becomes a
download.

## Setup (once)

1. **Sheet.** Create a Google Sheet with these tabs. [`scripts/sheet-seed/`](scripts/sheet-seed/)
   has CSVs to import: every system on the current map with the names printed on the map filled
   in, the 9 regions with their names, and empty Nations and Presence tabs with the right headers.
   - **Systems**: `system_id`, `name` (may be blank for unnamed waypoints), `description`
   - **Nations**: `nation_id`, `name`, `player`, `color` (`#rrggbb`), `flag_url`,
     `description`, `forum_url`
   - **Presence**: `system_id`, `nation_id`, `role` (one row per nation per system; `role` is
     `capital`, `colony`, `outpost` or `claim`)
   - **Regions** (optional): `region_id`, `name`, `description`. Which systems are in a region
     comes from its outline on the map, not from the sheet.

   Header names matter, column order doesn't. System ids may be written as `42` or `sys-0042`,
   region ids as `3` or `reg-03`.
   Share the sheet as **Anyone with the link → Viewer**.
2. **Repo variables** (Settings → Secrets and variables → Actions → Variables):
   - `SHEET_ID`: the long id in the sheet's URL.
   - `SHEET_GIDS` (recommended): `Systems=0,Nations=123,Presence=456,Regions=789`, using each tab's
     `gid=` from its URL. Without it, tabs are read by name through Google's `gviz` endpoint. That
     endpoint guesses column types and can blank out cells in a column that mixes numbers and
     text, such as player names.
3. **Pages.** Settings → Pages → Source: **GitHub Actions**.
4. **Workflow permissions.** Settings → Actions → General → Workflow permissions:
   **Read and write**, and allow GitHub Actions to create pull requests. The detect job pushes
   to PR branches and to a `detect-previews` branch that holds the overlay images.

## Development

Requirements: Node 20.19+ and Python 3.10+.

```sh
npm install
npm run dev                      # http://localhost:5173 (?edit=1 for the editor)
npm run build                    # typecheck + production build
npm run validate-data            # check map.json and game.json agree (--strict: fail on mismatches)
SHEET_ID=… npm run sync-sheet    # pull the sheet into game.json
npm run sync-sheet -- --csv scripts/sheet-seed     # …or from local CSVs

python -m venv .venv && .venv/Scripts/pip install -r scripts/detect/requirements.txt  # (bin/ on macOS/Linux)
python scripts/detect/detect_map.py --debug        # detect on the map image -> detect-out/
python scripts/detect/detect_map.py --propose-regions  # ...and re-detect region names and outlines
python scripts/detect/test_detect.py               # end-to-end detection test on synthetic maps
python scripts/detect/make_sample_map.py           # synthetic map + data for experiments -> detect-out/sample/
```

### Tuning detection
[`scripts/detect/config.yaml`](scripts/detect/config.yaml) is tuned for the current map: a clean
diagram with circles filled white, navy, green or dark red, and black lanes. Its colour ranges are
named by kind (`empty`, `player`, `npc`, `hostile`). Sizes are `auto`, scaled from the median
star size, so a resized map needs no retuning: the 1280px and 1920px versions of the map both
detect exactly with the same config. If the artist changes the style (new star colours, thicker
lines, a different background), retune it:

1. Run `detect_map.py --debug`.
2. Compare `detect-out/mask-stars.png` and `mask-lanes.png` with the image. Adjust the HSV
   colour ranges in [`scripts/detect/config.yaml`](scripts/detect/config.yaml) until the masks
   contain only star dots and lane ink.

Tips:
- Each star colour needs its own range, under the kind it means. A new colour on the map means
  a new range (and a new kind in `src/data/schema.ts`), otherwise those stars go undetected and
  the report lists them as removed.
- Constrain hue as well as brightness, so glow or pale washes around stars aren't merged into
  the dots.
- `open_px` and `min_radius` can be set to numbers instead of `auto` if labels stick to stars
  or small stars disappear. The red stars are the smallest.

**Regions.** `--propose-regions` finds the big region names, erases stars and lanes, follows
the dashed borders (bridging gaps where a label or lane crosses them) and pairs each name with
the area it encloses. It got 8 of 9 regions right on the current map. Deep Extremadura's border
is too broken to close, so its outline was drawn by hand. Treat its output as a proposal to check
in the overlay and fix in the editor. Day to day, outlines are carried over, not re-detected.

Then check `overlay.png`, and use the editor for anything left over. The end-to-end test
(`test_detect.py`) runs on synthetic maps with its own `test-config.yaml`.

### Layout
```
public/map/             the map image(s)
public/data/            map.json (geometry), game.json (generated from the sheet)
src/data/schema.ts      zod schemas + cross-checks shared by the app and scripts
src/map/                Leaflet map (CRS.Simple: 1 map unit = 1 image pixel)
src/panel/              system and region panels, search
src/editor/             ?edit=1 editor
scripts/fetch-sheet.ts  sheet -> game.json
scripts/detect/         OpenCV star/lane/region detection, id matching, synthetic test maps
.github/workflows/      deploy, hourly sheet sync, map-detection PR bot, CI
```
