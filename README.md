# Perseus Map

An interactive star map for the Perseus forum game. Pan and zoom the hand-drawn galaxy, click a
system to see which nations are there, search for systems and nations, and share links to
any system (`?system=sys-0042`) or nation territory (`?nation=vey`).

The data comes from two sources, joined by system id (`sys-0042`):

| What | Lives in | Maintained by |
|---|---|---|
| Where stars and lanes are | `public/data/map.json` | detected from the map image, fixed up in the editor |
| Names, nations, who holds what | Google Sheet → `public/data/game.json` | GMs, in the sheet |

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
4. Check the overlay. If it's right, merge. The new image and its star data go live together.
5. Add the new systems (listed in the report) to the **Systems** tab of the sheet.

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

- **Ctrl+Z** undoes.
- **Save** writes `public/data/map.json`.
- **Load proposal…** shows a detection result (`detect-out/map.proposed.json`, or one from a PR's
  run artifacts) against the current map, and can accept it.
- Orange stars have no row in the sheet yet.

Commit the result to the PR branch. On the live site, `?edit=1` works too, but Save becomes a
download.

## Setup (once)

1. **Sheet.** Create a Google Sheet with three tabs. [`scripts/sheet-seed/`](scripts/sheet-seed/)
   has CSVs to import: every system on the current map, with the names printed on the map filled
   in, plus empty Nations and Presence tabs with the right headers.
   - **Systems**: `system_id`, `name` (may be blank for unnamed waypoints), `description`
   - **Nations**: `nation_id`, `name`, `player`, `color` (`#rrggbb`), `flag_url`,
     `description`, `forum_url`
   - **Presence**: `system_id`, `nation_id`, `role` (one row per nation per system; `role` is
     `capital`, `colony`, `outpost` or `claim`)

   Header names matter, column order doesn't. System ids may be written as `42` or `sys-0042`.
   Share the sheet as **Anyone with the link → Viewer**.
2. **Repo variables** (Settings → Secrets and variables → Actions → Variables):
   - `SHEET_ID`: the long id in the sheet's URL.
   - `SHEET_GIDS` (recommended): `Systems=0,Nations=123,Presence=456`, using each tab's `gid=`
     from its URL. Without it, tabs are read by name through Google's `gviz` endpoint. That
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
python scripts/detect/detect_map.py --debug        # detect on public/map/perseus.png -> detect-out/
python scripts/detect/test_detect.py               # end-to-end detection test on synthetic maps
python scripts/detect/make_sample_map.py           # synthetic map + data for experiments -> detect-out/sample/
```

### Tuning detection
[`scripts/detect/config.yaml`](scripts/detect/config.yaml) is tuned for the current map: a clean
diagram with circles filled white, navy, green or dark red, and black lanes. On the first run it
found all 117 stars and 137 lanes. If the artist changes the style (new star colours, thicker
lines, a different background), retune it:

1. Run `detect_map.py --debug`.
2. Compare `detect-out/mask-stars.png` and `mask-lanes.png` with the image. Adjust the HSV
   colour ranges in [`scripts/detect/config.yaml`](scripts/detect/config.yaml) until the masks
   contain only star dots and lane ink.

Tips:
- Each star colour needs its own range. A new nation colour on the map means a new range,
  otherwise those stars go undetected and the report lists them as removed.
- Constrain hue as well as brightness, so glow or pale washes around stars aren't merged into
  the dots.
- Raise `open_px` if lanes or labels stick to stars. Lower it if small stars disappear: the red
  stars here are smaller than the rest, which is why it's 3.

Then check `overlay.png`, and use the editor for anything left over. The end-to-end test
(`test_detect.py`) runs on synthetic maps with its own `test-config.yaml`.

### Layout
```
public/map/             the map image(s)
public/data/            map.json (geometry), game.json (generated from the sheet)
src/data/schema.ts      zod schemas + cross-checks shared by the app and scripts
src/map/                Leaflet map (CRS.Simple: 1 map unit = 1 image pixel)
src/panel/              system panel, search
src/editor/             ?edit=1 editor
scripts/fetch-sheet.ts  sheet -> game.json
scripts/detect/         OpenCV star/lane detection, id matching, synthetic test maps
.github/workflows/      deploy, hourly sheet sync, map-detection PR bot, CI
```
