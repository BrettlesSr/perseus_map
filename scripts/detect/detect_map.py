"""Detect stars and hyperlanes in the hand-drawn map and reconcile them with map.json.

    python scripts/detect/detect_map.py                       # proposal -> detect-out/
    python scripts/detect/detect_map.py --image new.png --write  # also overwrite public/data/map.json
    python scripts/detect/detect_map.py --debug               # also dump the colour masks for tuning

Existing system ids are preserved: the old star layout is aligned to the new one
(handles the canvas growing or the map being rescaled), then stars are paired up with
an optimal assignment. Unmatched detections get fresh ids; ids are never reused.

Outputs (in --out): map.proposed.json, detect-report.md, overlay.png [, mask-*.png]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
import yaml
from scipy.optimize import linear_sum_assignment
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "public"


# ---------------------------------------------------------------- detection


def color_mask(hsv: np.ndarray, ranges) -> np.ndarray:
    mask = np.zeros(hsv.shape[:2], np.uint8)
    for lower, upper in ranges:
        mask |= cv2.inRange(hsv, np.array(lower, np.uint8), np.array(upper, np.uint8))
    return mask


@dataclass
class Star:
    x: float
    y: float
    r: float


def detect_stars(hsv: np.ndarray, cfg) -> tuple[list[Star], np.ndarray]:
    mask = color_mask(hsv, cfg["colors"])
    # Opening erases anything thinner than the kernel: text strokes, dust, and the
    # glow-bleached ends of lanes that otherwise stick out of stars as spikes.
    k = cfg["open_px"]
    if k > 1:
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    stars = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < math.pi * cfg["min_radius"] ** 2 * 0.5:
            continue
        # Judge the blob by its solid core: the largest inscribed circle. Leftover
        # spikes barely change it, unlike the bounding box or the centroid.
        comp = labels[y : y + h, x : x + w] == i
        d = np.where(comp, dist[y : y + h, x : x + w], 0)
        r_in = float(d.max())
        if not cfg["min_radius"] <= r_in <= cfg["max_radius"]:
            continue
        if max(w, h) / max(1, min(w, h)) > cfg["max_aspect"]:
            continue
        # area within 1.5 core radii should be mostly filled for a round dot
        core = d >= r_in * 0.5
        if core.sum() / (math.pi * (r_in * 0.5 + 0.5) ** 2) < cfg["min_fill"]:
            continue
        # sub-pixel centre from the deepest part of the core only, so lobes merged
        # onto the star (glow, lane junctions) can't pull it off-centre
        ys, xs = np.nonzero(d >= r_in * 0.85)
        wts = d[ys, xs]
        cx, cy = x + float((xs * wts).sum() / wts.sum()), y + float((ys * wts).sum() / wts.sum())
        stars.append(Star(round(cx, 1), round(cy, 1), round(r_in, 1)))
    return stars, mask


def point_segment_dist(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Distance from each point in p (N,2) to segment ab."""
    ab = b - a
    t = np.clip(((p - a) @ ab) / max(ab @ ab, 1e-9), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)


def detect_lanes(hsv: np.ndarray, stars: list[Star], cfg) -> tuple[list[tuple[int, int]], np.ndarray]:
    mask = color_mask(hsv, cfg["colors"])
    d = cfg["dilate_px"]
    if d > 0:
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * d + 1, 2 * d + 1)))
    if not stars:
        return [], mask
    pts = np.array([[s.x, s.y] for s in stars])
    radii = np.array([s.r for s in stars])
    h, w = mask.shape
    lanes = []
    for i, j in sorted(cKDTree(pts).query_pairs(cfg["max_length"])):
        a, b = pts[i], pts[j]
        length = float(np.linalg.norm(b - a))
        start, end = radii[i] + cfg["star_margin"], length - radii[j] - cfg["star_margin"]
        if end - start < 4:
            continue
        # another star in the way means this is A-B-C, not a direct A-C lane
        others = np.ones(len(stars), bool)
        others[[i, j]] = False
        if np.any(point_segment_dist(pts[others], a, b) < radii[others] + cfg["clearance"]):
            continue
        unit = (b - a) / length
        ts = np.linspace(start, end, max(8, int((end - start) / 2)))
        xs = np.clip(np.round(a[0] + unit[0] * ts).astype(int), 0, w - 1)
        ys = np.clip(np.round(a[1] + unit[1] * ts).astype(int), 0, h - 1)
        if (mask[ys, xs] > 0).mean() >= cfg["min_coverage"]:
            lanes.append((i, j))
    return lanes, mask


# ---------------------------------------------------------------- matching


@dataclass
class Alignment:
    scale: float = 1.0
    tx: float = 0.0
    ty: float = 0.0
    inliers: int = 0

    def apply(self, p: np.ndarray) -> np.ndarray:
        return p * self.scale + np.array([self.tx, self.ty])


def estimate_alignment(old: np.ndarray, new: np.ndarray, scales: list[float], tol: float) -> Alignment:
    """Find the scale+translation that lines up the most old stars with new ones.

    Every (old, new) pair votes for a translation; the most popular bin wins and is
    refined on its inliers. Robust to added/removed stars and a few moved ones.
    """
    best = Alignment()
    if len(old) == 0 or len(new) == 0:
        return best
    tree = cKDTree(new)
    for s in scales:
        diffs = (new[None, :, :] - s * old[:, None, :]).reshape(-1, 2)
        bins, counts = np.unique(np.round(diffs / (tol / 2)), axis=0, return_counts=True)
        for b in bins[np.argsort(-counts)[:5]]:
            t = b * (tol / 2)
            for _ in range(3):  # refine on the inliers
                moved = s * old + t
                dist, idx = tree.query(moved, distance_upper_bound=tol)
                ok = np.isfinite(dist)
                if not ok.any():
                    break
                t = np.median(new[idx[ok]] - s * old[ok], axis=0)
            inliers = int(ok.sum())
            if inliers > best.inliers:
                best = Alignment(s, float(t[0]), float(t[1]), inliers)
    return best


@dataclass
class Reconciled:
    systems: list[dict]
    lanes: list[list[str]]
    next_id: int
    alignment: Alignment
    added: list[str] = field(default_factory=list)
    removed: list[dict] = field(default_factory=list)
    moved: list[tuple[str, float]] = field(default_factory=list)
    lanes_added: list[list[str]] = field(default_factory=list)
    lanes_removed: list[list[str]] = field(default_factory=list)


def match_tolerance(old: np.ndarray, cfg) -> float:
    """'auto' = a fraction of the typical gap between neighbouring stars."""
    if cfg["tolerance"] != "auto":
        return float(cfg["tolerance"])
    if len(old) < 2:
        return 30.0
    dist, _ = cKDTree(old).query(old, k=2)
    return float(np.median(dist[:, 1]) * cfg.get("auto_fraction", 0.35))


def reconcile(current: dict | None, stars: list[Star], lanes: list[tuple[int, int]], img_size, cfg) -> Reconciled:
    old_systems = current["systems"] if current else []
    next_id = current["nextId"] if current else 1
    old = np.array([[s["x"], s["y"]] for s in old_systems]).reshape(-1, 2)
    new = np.array([[s.x, s.y] for s in stars]).reshape(-1, 2)
    tol = match_tolerance(old, cfg)

    scales = [1.0]
    if current and cfg["allow_scale"]:
        ow, oh = current["image"]["width"], current["image"]["height"]
        for s in (img_size[0] / ow, img_size[1] / oh):
            if abs(s - 1) > 0.01 and all(abs(s - o) > 0.01 for o in scales):
                scales.append(s)
    align = estimate_alignment(old, new, scales, tol)

    ids: list[str | None] = [None] * len(stars)
    moved = []
    if len(old) and len(new):
        projected = align.apply(old)
        cost = np.linalg.norm(projected[:, None, :] - new[None, :, :], axis=2)
        rows, cols = linear_sum_assignment(np.minimum(cost, tol * 4))
        for r, c in zip(rows, cols):
            if cost[r, c] <= tol:
                ids[c] = old_systems[r]["id"]
                if cost[r, c] > cfg["moved_threshold"]:
                    moved.append((old_systems[r]["id"], round(float(cost[r, c]), 1)))

    added = []
    # number new stars left-to-right, top-to-bottom so ids are stable across reruns
    for c in sorted(range(len(stars)), key=lambda c: (round(stars[c].y / 50), stars[c].x)):
        if ids[c] is None:
            ids[c] = f"sys-{next_id:04d}"
            added.append(ids[c])
            next_id += 1

    kept = set(ids)
    removed = [s for s in old_systems if s["id"] not in kept]
    systems = sorted(
        ({"id": ids[c], "x": s.x, "y": s.y, "r": s.r} for c, s in enumerate(stars)), key=lambda s: s["id"]
    )
    new_lanes = sorted(sorted([ids[i], ids[j]]) for i, j in lanes)
    old_lanes = {tuple(sorted(l)) for l in (current["lanes"] if current else [])}
    new_set = {tuple(l) for l in new_lanes}
    return Reconciled(
        systems=systems,
        lanes=new_lanes,
        next_id=next_id,
        alignment=align,
        added=added,
        removed=removed,
        moved=sorted(moved),
        lanes_added=sorted(list(l) for l in new_set - old_lanes),
        lanes_removed=sorted(list(l) for l in old_lanes - new_set),
    )


# ---------------------------------------------------------------- outputs


def draw_overlay(img: np.ndarray, rec: Reconciled, out_dir: Path):
    out = (img * 0.55).astype(np.uint8)  # dim the art so annotations stand out
    by_id = {s["id"]: s for s in rec.systems}
    added, moved = set(rec.added), {m[0] for m in rec.moved}
    p = lambda s: (int(round(s["x"])), int(round(s["y"])))
    for a, b in rec.lanes:
        cv2.line(out, p(by_id[a]), p(by_id[b]), (255, 220, 90), 2, cv2.LINE_AA)
    for a, b in rec.lanes_removed:
        if a in by_id and b in by_id:
            cv2.line(out, p(by_id[a]), p(by_id[b]), (60, 60, 255), 2, cv2.LINE_AA)
    for s in rec.systems:
        color = (80, 230, 80) if s["id"] in added else (40, 210, 255) if s["id"] in moved else (255, 255, 255)
        cv2.circle(out, p(s), int(s["r"]) + 5, color, 2, cv2.LINE_AA)
        cv2.putText(out, s["id"], (p(s)[0] + int(s["r"]) + 6, p(s)[1] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
    for s in rec.removed:
        x, y = rec.alignment.apply(np.array([s["x"], s["y"]]))
        c = (60, 60, 255)
        cv2.drawMarker(out, (int(x), int(y)), c, cv2.MARKER_TILTED_CROSS, 26, 3, cv2.LINE_AA)
        cv2.putText(out, s["id"], (int(x) + 14, int(y) - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.5, c, 1, cv2.LINE_AA)
    cv2.imwrite(str(out_dir / "overlay.png"), out)
    # smaller copy for embedding in the PR comment
    scale = min(1.0, 2400 / out.shape[1])
    small = cv2.resize(out, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else out
    cv2.imwrite(str(out_dir / "overlay.jpg"), small, [cv2.IMWRITE_JPEG_QUALITY, 85])


def write_report(rec: Reconciled, current: dict | None, game: dict | None, path: Path, image_rel: str, size):
    a = rec.alignment
    old_n = len(current["systems"]) if current else 0
    lines = [
        "## Map detection report",
        "",
        f"Image `{image_rel}` ({size[0]}×{size[1]} px)",
        "",
        "| | count |",
        "|---|---|",
        f"| systems detected | {len(rec.systems)} (was {old_n}) |",
        f"| lanes detected | {len(rec.lanes)} (was {len(current['lanes']) if current else 0}) |",
        f"| matched to existing ids | {len(rec.systems) - len(rec.added)} |",
        f"| new systems | {len(rec.added)} |",
        f"| removed systems | {len(rec.removed)} |",
        f"| moved > threshold | {len(rec.moved)} |",
        f"| lanes added / removed | {len(rec.lanes_added)} / {len(rec.lanes_removed)} |",
        "",
    ]
    if current:
        lines += [
            f"Old layout aligned to new with scale **{a.scale:.3f}**, offset **({a.tx:+.1f}, {a.ty:+.1f})** px "
            f"({a.inliers}/{old_n} stars agree).",
            "",
        ]
        if old_n and a.inliers < 0.5 * old_n:
            lines += ["> ⚠️ Fewer than half the existing stars lined up. The map may have changed too much for "
                      "automatic matching. Check the overlay carefully, or fix ids in the editor.", ""]

    def section(title, items):
        if items:
            lines.extend([f"<details><summary>{title} ({len(items)})</summary>", ""] + [f"- {i}" for i in items] + ["", "</details>", ""])

    section("New systems: add them to the Systems tab", [f"`{i}`" for i in rec.added])
    held = {}
    for p in (game or {}).get("presence", []):
        held.setdefault(p["systemId"], []).append(p["nationId"])
    names = {s["id"]: s["name"] for s in (game or {}).get("systems", [])}
    label = lambda i: f"`{i}`" + (f" ({names[i]})" if i in names else "")
    orphaned = [s["id"] for s in rec.removed if s["id"] in held]
    if orphaned:
        lines.extend(["> ⚠️ **Removed systems still have nations in the sheet.** Check these are real removals, "
                      "then remove their Presence rows:", ""]
                     + [f"> - {label(i)}: {', '.join(held[i])}" for i in orphaned] + [""])
    section("Removed systems", [label(s["id"]) for s in rec.removed])
    section("Moved systems", [f"{label(i)} by {d}px" for i, d in rec.moved])
    section("Lanes added", [f"`{a}` ↔ `{b}`" for a, b in rec.lanes_added])
    section("Lanes removed", [f"`{a}` ↔ `{b}`" for a, b in rec.lanes_removed])
    lines += [
        "Overlay legend: white = matched, green = new, orange = moved, red ✕ = removed, red line = lane removed.",
        "",
        "To fix mistakes, run `npm run dev`, open `/?edit=1`, load `map.proposed.json` and edit it.",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", type=Path, default=Path(__file__).with_name("config.yaml"))
    ap.add_argument("--image", type=Path, help="map image (default: config 'image')")
    ap.add_argument("--src", help="image path to record in map.json, relative to public/ (default: derived from --image)")
    ap.add_argument("--game", type=Path, default=PUBLIC / "data/game.json", help="game.json, for naming systems in the report")
    ap.add_argument("--current",type=Path, default=PUBLIC / "data/map.json", help="existing map.json to keep ids from")
    ap.add_argument("--fresh", action="store_true", help="ignore the existing map.json and number from 1")
    ap.add_argument("--out", type=Path, default=ROOT / "detect-out")
    ap.add_argument("--write", action="store_true", help="overwrite --current with the proposal")
    ap.add_argument("--debug", action="store_true", help="write colour masks for tuning")
    args = ap.parse_args()

    cfg = yaml.safe_load(args.config.read_text(encoding="utf8"))
    image_path = (args.image or ROOT / cfg["image"]).resolve()
    try:
        image_rel = args.src or image_path.relative_to(PUBLIC).as_posix()
    except ValueError:
        sys.exit(f"The map image must live under public/ so the site can serve it (or pass --src): {image_path}")

    img = cv2.imread(str(image_path), cv2.IMREAD_COLOR)
    if img is None:
        sys.exit(f"Could not read image {image_path}")
    size = (img.shape[1], img.shape[0])
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    stars, star_mask = detect_stars(hsv, cfg["stars"])
    lanes, lane_mask = detect_lanes(hsv, stars, cfg["lanes"])

    current = None
    if not args.fresh and args.current.exists():
        current = json.loads(args.current.read_text(encoding="utf8"))
    rec = reconcile(current, stars, lanes, size, cfg["matching"])

    proposal = {
        "version": 1,
        "image": {"src": image_rel, "width": size[0], "height": size[1]},
        "nextId": rec.next_id,
        "systems": rec.systems,
        "lanes": rec.lanes,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "map.proposed.json").write_text(json.dumps(proposal, indent=2) + "\n", encoding="utf8")
    game = json.loads(args.game.read_text(encoding="utf8")) if args.game.exists() else None
    write_report(rec, current, game, args.out / "detect-report.md", image_rel, size)
    draw_overlay(img, rec, args.out)
    if args.debug:
        cv2.imwrite(str(args.out / "mask-stars.png"), star_mask)
        cv2.imwrite(str(args.out / "mask-lanes.png"), lane_mask)
    if args.write:
        args.current.write_text(json.dumps(proposal, indent=2) + "\n", encoding="utf8")

    print(
        f"{len(rec.systems)} systems ({len(rec.added)} new, {len(rec.removed)} removed, {len(rec.moved)} moved), "
        f"{len(rec.lanes)} lanes (+{len(rec.lanes_added)}/-{len(rec.lanes_removed)}). Output in {args.out}"
    )


if __name__ == "__main__":
    main()
