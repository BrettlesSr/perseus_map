"""Generate a synthetic 'hand-drawn' star map plus matching data, for development and tests.

    python scripts/detect/make_sample_map.py                 # placeholder map + sample sheet CSVs
    python scripts/detect/make_sample_map.py --variant expanded --out detect-out/test
                                                             # same galaxy on a bigger canvas, with
                                                             # stars added/moved/removed (detection test)

The real map replaces public/map/perseus.png; this only exists so the app and the
detection pipeline have something realistic to run against.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import random
from pathlib import Path

import cv2
import numpy as np
from scipy.spatial import Delaunay

ROOT = Path(__file__).resolve().parents[2]

STAR_BGR = (205, 240, 255)  # pale yellow-white
LANE_BGR = (255, 175, 95)  # light blue
LABEL_BGR = (215, 215, 215)

SYLLABLES = "ka ri on tel vas mor eth al zan qu ir os yl dra ven ces thi lo ru nex sa por am".split()


def make_name(rng: random.Random) -> str:
    n = "".join(rng.choice(SYLLABLES) for _ in range(rng.choice([2, 2, 3])))
    return n.capitalize()


def generate_world(seed: int, width: int, height: int, count: int):
    rng = random.Random(seed)
    cx, cy = width / 2, height / 2
    pts: list[tuple[float, float]] = []
    tries = 0
    while len(pts) < count and tries < 100_000:
        tries += 1
        # elliptical galaxy-ish distribution, denser towards the middle
        a = rng.uniform(0, 2 * math.pi)
        d = math.sqrt(rng.random()) * 0.92
        x = cx + math.cos(a) * d * (width / 2 - 80)
        y = cy + math.sin(a) * d * (height / 2 - 80)
        if all(math.hypot(x - px, y - py) > 150 for px, py in pts):
            pts.append((round(x, 1), round(y, 1)))

    systems = [
        {"id": f"sys-{i + 1:04d}", "x": x, "y": y, "r": rng.choice([6, 7, 8, 8, 9, 10, 12, 14])}
        for i, (x, y) in enumerate(pts)
    ]
    lanes = delaunay_lanes(systems, rng, max_len=380)
    names = {s["id"]: make_name(rng) for s in systems}
    return systems, lanes, names


def segment_clearance(p, a, b) -> float:
    ax, ay, bx, by, px, py = a["x"], a["y"], b["x"], b["y"], p["x"], p["y"]
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def delaunay_lanes(systems, rng: random.Random, max_len: float):
    pts = np.array([[s["x"], s["y"]] for s in systems])
    tri = Delaunay(pts)
    edges = set()
    for simplex in tri.simplices:
        for i in range(3):
            a, b = sorted((int(simplex[i]), int(simplex[(i + 1) % 3])))
            edges.add((a, b))
    lanes = []
    for a, b in sorted(edges):
        sa, sb = systems[a], systems[b]
        if math.hypot(sa["x"] - sb["x"], sa["y"] - sb["y"]) > max_len or rng.random() < 0.3:
            continue
        # keep lanes from grazing other stars, which hand-drawn maps avoid anyway
        if any(segment_clearance(s, sa, sb) < s["r"] + 18 for s in systems if s is not sa and s is not sb):
            continue
        lanes.append([sa["id"], sb["id"]])
    return lanes


def wobbly_polyline(a, b, rng: random.Random, amp=1.6):
    n = max(4, int(math.hypot(b[0] - a[0], b[1] - a[1]) / 12))
    t = np.linspace(0, 1, n)
    nx, ny = -(b[1] - a[1]), b[0] - a[0]
    norm = math.hypot(nx, ny) or 1
    noise = np.convolve(np.array([rng.gauss(0, amp) for _ in range(n)]), np.ones(3) / 3, mode="same")
    noise[0] = noise[-1] = 0
    xs = a[0] + (b[0] - a[0]) * t + nx / norm * noise
    ys = a[1] + (b[1] - a[1]) * t + ny / norm * noise
    return np.stack([xs, ys], axis=1)


def render(systems, lanes, names, width, height, seed, territories=None) -> np.ndarray:
    rng = random.Random(seed + 1)
    nprng = np.random.default_rng(seed)
    img = np.zeros((height, width, 3), np.float32)
    img[:] = (28, 14, 8)  # deep navy

    # nebula: blurred multi-scale noise tinted purple/teal
    for scale, tint in ((64, (90, 30, 70)), (24, (70, 60, 20))):
        small = nprng.random((height // scale + 2, width // scale + 2)).astype(np.float32)
        neb = cv2.resize(small, (width, height), interpolation=cv2.INTER_CUBIC)[:height, :width]
        neb = np.clip(neb - 0.55, 0, None) * 2.2
        img += neb[..., None] * np.array(tint, np.float32)

    # territory washes (what a GM might paint over nation space)
    for t in territories or []:
        layer = np.zeros((height, width), np.float32)
        for sid in t["systems"]:
            s = next((s for s in systems if s["id"] == sid), None)
            if s:
                cv2.circle(layer, (int(s["x"]), int(s["y"])), 110, 1.0, -1, cv2.LINE_AA)
        layer = cv2.GaussianBlur(layer, (0, 0), 25)
        img += layer[..., None] * np.array(t["bgr"], np.float32) * 0.35

    # dust: tiny dim specks that detection must ignore
    for _ in range(width * height // 1500):
        x, y = rng.randrange(width), rng.randrange(height)
        v = rng.randint(60, 255)
        img[y, x] = (v, v, v)

    by_id = {s["id"]: s for s in systems}
    lane_layer = np.zeros_like(img)
    for a, b in lanes:
        sa, sb = by_id[a], by_id[b]
        line = wobbly_polyline((sa["x"], sa["y"]), (sb["x"], sb["y"]), rng)
        cv2.polylines(lane_layer, [np.round(line * 4).astype(np.int32)], False, LANE_BGR, 2, cv2.LINE_AA, shift=2)
    img = np.where(lane_layer.sum(axis=2, keepdims=True) > 0, lane_layer * 0.85 + img * 0.15, img)

    glow = np.zeros_like(img)
    for s in systems:
        cv2.circle(glow, (int(s["x"]), int(s["y"])), int(s["r"] * 2.2), (120, 140, 150), -1, cv2.LINE_AA)
    img += cv2.GaussianBlur(glow, (0, 0), 6) * 0.6
    for s in systems:
        # slightly irregular, hand-inked star blobs
        jitter = [(s["x"] + rng.uniform(-0.8, 0.8), s["y"] + rng.uniform(-0.8, 0.8)) for _ in range(3)]
        for jx, jy in jitter:
            cv2.circle(img, (round(jx * 4), round(jy * 4)), round(s["r"] * 4 * rng.uniform(0.92, 1.0)), STAR_BGR, -1, cv2.LINE_AA, shift=2)

    out = np.clip(img, 0, 255).astype(np.uint8)
    for s in systems:
        org = (int(s["x"] + s["r"] + 6), int(s["y"] + s["r"] + 14))
        cv2.putText(out, names[s["id"]], org, cv2.FONT_HERSHEY_SIMPLEX, 0.55, LABEL_BGR, 1, cv2.LINE_AA)
    return out


NATIONS = [
    ("aurelian", "Aurelian Concord", "stellarfox", "#e0b341", (65, 180, 225)),
    ("vey", "Vey Collective", "mossbank", "#43c59e", (160, 200, 70)),
    ("drast", "Drast Hegemony", "IronQuill", "#d9534f", (80, 80, 220)),
    ("lumen", "Lumen Pact", "kestrel", "#7aa2ff", (255, 160, 120)),
    ("orrin", "Free Orrin Worlds", "tallow", "#c77dff", (255, 125, 200)),
]


def make_nations(systems, lanes, seed):
    """Grow each nation outward from a capital along lanes."""
    rng = random.Random(seed + 2)
    adj: dict[str, list[str]] = {s["id"]: [] for s in systems}
    for a, b in lanes:
        adj[a].append(b)
        adj[b].append(a)
    taken: dict[str, str] = {}
    presence = []
    caps = rng.sample([s["id"] for s in systems if len(adj[s["id"]]) >= 3], len(NATIONS))
    territories = []
    for (nid, _, _, _, bgr), cap in zip(NATIONS, caps):
        owned = [cap]
        taken[cap] = nid
        frontier = list(adj[cap])
        while len(owned) < rng.randint(4, 7) and frontier:
            sid = frontier.pop(rng.randrange(len(frontier)))
            if sid in taken:
                continue
            taken[sid] = nid
            owned.append(sid)
            frontier += adj[sid]
        presence.append((cap, nid, "capital"))
        presence += [(sid, nid, rng.choice(["colony", "colony", "outpost"])) for sid in owned[1:]]
        # claims on unowned neighbours
        for sid in {n for o in owned for n in adj[o]} - set(taken):
            if rng.random() < 0.3:
                presence.append((sid, nid, "claim"))
        territories.append({"systems": owned, "bgr": bgr})
    return presence, territories


def write_sheet_csvs(out: Path, systems, names, presence):
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(7)
    flavour = ["A dusty trade hub.", "Rich in rare crystals.", "Site of an ancient battle.", "Gas giant refineries.", "", ""]
    with open(out / "Systems.csv", "w", newline="", encoding="utf8") as f:
        w = csv.writer(f)
        w.writerow(["system_id", "name", "description"])
        for s in systems:
            w.writerow([s["id"], names[s["id"]], rng.choice(flavour)])
    with open(out / "Nations.csv", "w", newline="", encoding="utf8") as f:
        w = csv.writer(f)
        w.writerow(["nation_id", "name", "player", "color", "flag_url", "description", "forum_url"])
        for nid, name, player, color, _ in NATIONS:
            w.writerow([nid, name, player, color, "", f"The {name} is a sample nation.", ""])
    with open(out / "Presence.csv", "w", newline="", encoding="utf8") as f:
        w = csv.writer(f)
        w.writerow(["system_id", "nation_id", "role"])
        w.writerows(presence)


def expanded_variant(systems, lanes, names, seed, width, height):
    """Simulate the artist's next revision: bigger canvas, new stars, a few edits."""
    rng = random.Random(seed + 3)
    ox, oy = 420, 260
    new_w, new_h = width + ox + 200, height + oy
    moved = {systems[3]["id"], systems[10]["id"]}
    removed = systems[20]["id"]
    out = []
    for s in systems:
        if s["id"] == removed:
            continue
        dx, dy = (rng.uniform(18, 30) * rng.choice([-1, 1]), rng.uniform(18, 30) * rng.choice([-1, 1])) if s["id"] in moved else (0, 0)
        out.append({**s, "x": round(s["x"] + ox + dx, 1), "y": round(s["y"] + oy + dy, 1)})
    next_n = len(systems) + 1
    added = []
    while len(added) < 6:
        x, y = rng.uniform(60, ox - 60), rng.uniform(80, new_h - 80)
        if all(math.hypot(x - o["x"], y - o["y"]) > 150 for o in out):
            s = {"id": f"sys-{next_n:04d}", "x": round(x, 1), "y": round(y, 1), "r": 9}
            out.append(s)
            added.append(s["id"])
            names[s["id"]] = make_name(rng)
            next_n += 1
    kept_lanes = [l for l in lanes if removed not in l]
    # connect each new star to its nearest neighbour, if the segment is clear
    for sid in added:
        s = next(o for o in out if o["id"] == sid)
        near = sorted((o for o in out if o["id"] != sid), key=lambda o: math.hypot(o["x"] - s["x"], o["y"] - s["y"]))[0]
        if all(segment_clearance(o, s, near) > o["r"] + 18 for o in out if o["id"] not in (sid, near["id"])):
            kept_lanes.append(sorted([sid, near["id"]]))
    truth = {"moved": sorted(moved), "removed": [removed], "added": added, "offset": [ox, oy]}
    return out, kept_lanes, new_w, new_h, truth


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--width", type=int, default=3200)
    ap.add_argument("--height", type=int, default=2200)
    ap.add_argument("--count", type=int, default=72)
    ap.add_argument("--variant", choices=["base", "expanded"], default="base")
    ap.add_argument("--out", type=Path, help="output dir for the expanded variant")
    ap.add_argument("--out-root", type=Path, default=ROOT / "detect-out/sample",
                    help="where to write the base variant (public/..., scripts/sample-sheet/...); pass . to target the repo")
    args = ap.parse_args()

    systems, lanes, names = generate_world(args.seed, args.width, args.height, args.count)
    presence, territories = make_nations(systems, lanes, args.seed)

    if args.variant == "base":
        img = render(systems, lanes, names, args.width, args.height, args.seed, territories)
        root = args.out_root
        (root / "public/map").mkdir(parents=True, exist_ok=True)
        (root / "public/data").mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(root / "public/map/perseus.png"), img)
        map_json = {
            "version": 1,
            "image": {"src": "map/perseus.png", "width": args.width, "height": args.height},
            "nextId": len(systems) + 1,
            "systems": systems,
            "lanes": lanes,
        }
        (root / "public/data/map.json").write_text(json.dumps(map_json, indent=2) + "\n", encoding="utf8")
        write_sheet_csvs(root / "scripts/sample-sheet", systems, names, presence)
        print(f"Wrote sample map: {len(systems)} systems, {len(lanes)} lanes")
    else:
        out_dir = args.out or ROOT / "detect-out/test"
        out_dir.mkdir(parents=True, exist_ok=True)
        systems2, lanes2, w2, h2, truth = expanded_variant(systems, lanes, names, args.seed, args.width, args.height)
        img = render(systems2, lanes2, names, w2, h2, args.seed, territories)  # washes follow systems by id
        cv2.imwrite(str(out_dir / "expanded.png"), img)
        truth["systems"] = systems2
        truth["lanes"] = lanes2
        (out_dir / "expanded.truth.json").write_text(json.dumps(truth, indent=2) + "\n", encoding="utf8")
        print(f"Wrote expanded variant to {out_dir}: +{len(truth['added'])} added, {truth['moved']} moved, {truth['removed']} removed")


if __name__ == "__main__":
    main()
