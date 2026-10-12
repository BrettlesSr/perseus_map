"""Find named regions on the map: their labels, their areas, and which systems they contain.

Regions are drawn as dashed borders with a large bold name printed in, on, or next to
each one. With stars and lanes already detected:

1. Erase stars and lanes from the dark-ink mask. What's left is border dashes, text and
   the little T-bar stubs at the map edge.
2. Labels: glyphs taller than system-name text, merged into lines of text.
3. Borders: keep dash-shaped pieces that belong to a chain of dashes, then link the
   chains into closed walls. Short links may turn corners; long links only bridge
   straight continuations (gaps where a label is printed over the border or a lane
   crosses it); two loose ends whose rays meet are joined at the meeting point.
4. Areas: connected background between the walls. Each label claims the nearest
   enclosed area; systems take the area they sit in (border pixels go to the nearest
   area). Systems in unlabelled areas (the core) get no region.

All sizes scale with R, the median star radius, so a resized map needs no retuning.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np
from scipy import ndimage
from scipy.optimize import linear_sum_assignment
from scipy.spatial import cKDTree


@dataclass
class Region:
    label: tuple[int, int, int, int]  # x, y, w, h of the printed name
    polygon: list[list[float]]  # outline of the area, simplified
    systems: list[int]  # indices into the star list


def _erase_network(ink: np.ndarray, stars, lanes, R: float) -> np.ndarray:
    rest = ink.copy()
    for s in stars:
        cv2.circle(rest, (round(s.x), round(s.y)), int(s.r + 0.8 * R + 2), 0, -1)  # incl. outline / starburst
    lane_w = int(2 * round(0.5 * R) + 3)
    for i, j in lanes:
        a, b = stars[i], stars[j]
        cv2.line(rest, (round(a.x), round(a.y)), (round(b.x), round(b.y)), 0, lane_w)
    return rest


def find_labels(rest: np.ndarray, R: float, cfg) -> list[tuple[int, int, int, int]]:
    n, lab, st, _ = cv2.connectedComponentsWithStats(rest, connectivity=8)
    glyphs = np.zeros_like(rest)
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if 1.4 * R <= h <= 6 * R and w >= 3 and a / (w * h) >= 0.18:
            glyphs[lab == i] = 255
    # join letters and words into lines of text
    lines = cv2.dilate(glyphs, cv2.getStructuringElement(cv2.MORPH_RECT, (int(3.5 * R), 5)))
    n2, _, st2, _ = cv2.connectedComponentsWithStats(lines)
    out = []
    for i in range(1, n2):
        x, y, w, h, _ = st2[i]
        if w >= cfg["label_min_width"] * R and cfg["label_min_height"] * R <= h <= 7 * R:
            out.append((int(x), int(y), int(w), int(h)))
    return out


def _dashes(rest: np.ndarray, R: float):
    """Dash-shaped components: (mask, endpoints[(x, y, dx, dy, dash_id)])."""
    n, lab, _, _ = cv2.connectedComponentsWithStats(rest, connectivity=8)
    ends, masks = [], {}
    for i in range(1, n):
        ys, xs = np.nonzero(lab == i)
        if len(xs) < 4:
            continue
        pts = np.column_stack([xs, ys]).astype(np.float32)
        _, (w, h), _ = cv2.minAreaRect(pts)
        L, T = max(w, h), min(w, h)
        if not (L <= 3.5 * R and T <= 0.6 * R and L >= 2 * max(T, 1)):
            continue
        c = pts - pts.mean(0)
        d = np.linalg.svd(c, full_matrices=False)[2][0]
        proj = c @ d
        p0, p1 = pts.mean(0) + d * proj.min(), pts.mean(0) + d * proj.max()
        ends += [(*p0, *(-d), i), (*p1, *d, i)]
        masks[i] = (ys, xs)
    return masks, np.array(ends).reshape(-1, 5)


def _link(E: np.ndarray, tree: cKDTree, k: int, maxd: float, turn: float, partner: float, allowed) -> int | None:
    x, y, dx, dy, i = E[k]
    best, bestd = None, math.inf
    for j in tree.query_ball_point((x, y), maxd):
        if E[j, 4] == i or not allowed[j]:
            continue
        vx, vy = E[j, 0] - x, E[j, 1] - y
        dist = math.hypot(vx, vy)
        if dist < 1:
            return j
        if (vx * dx + vy * dy) / dist < math.cos(math.radians(turn)):
            continue  # must carry on roughly the way this dash points
        if (-vx * E[j, 2] - vy * E[j, 3]) / dist < math.cos(math.radians(partner)):
            continue  # ...and the partner must point back towards us
        if dist < bestd:
            best, bestd = j, dist
    return best


def build_walls(rest: np.ndarray, R: float, cfg) -> np.ndarray:
    masks, E = _dashes(rest, R)
    walls = np.zeros_like(rest)
    if len(E) == 0:
        return walls
    tree = cKDTree(E[:, :2])
    everyone = np.ones(len(E), bool)
    short = [_link(E, tree, k, cfg["link_short"] * R, 40, 100, everyone) for k in range(len(E))]

    # a real border dash is part of a chain: drop dashes with no neighbour at either end
    linked_dash = {int(E[k, 4]) for k, j in enumerate(short) if j is not None}
    linked_dash |= {int(E[j, 4]) for j in short if j is not None}
    in_chain = np.array([int(e[4]) in linked_dash for e in E])
    for i in linked_dash:
        ys, xs = masks[i]
        walls[ys, xs] = 255

    has_link = np.zeros(len(E), bool)
    for k, j in enumerate(short):
        if j is not None and in_chain[k] and in_chain[j]:
            cv2.line(walls, tuple(np.round(E[k, :2]).astype(int)), tuple(np.round(E[j, :2]).astype(int)), 255, 2)
            has_link[k] = has_link[j] = True

    loose = in_chain & ~has_link  # chain ends
    tree_loose = cKDTree(E[:, :2])
    done = set()
    for k in np.nonzero(loose)[0]:
        if k in done:
            continue
        # straight continuation across a long gap
        j = _link(E, tree_loose, k, cfg["link_long"] * R, 12, 12, loose)
        if j is not None:
            cv2.line(walls, tuple(np.round(E[k, :2]).astype(int)), tuple(np.round(E[j, :2]).astype(int)), 255, 2)
            done |= {k, j}
            continue
        # corner hidden under a label: extend both rays to where they meet
        x, y, dx, dy, _ = E[k]
        best = None
        for j in tree_loose.query_ball_point((x, y), 2 * cfg["link_short"] * R):
            if j == k or not loose[j] or E[j, 4] == E[k, 4] or j in done:
                continue
            x2, y2, dx2, dy2, _ = E[j]
            den = dx * dy2 - dy * dx2
            if abs(den) < 0.3:  # nearly parallel: not a corner
                continue
            t = ((x2 - x) * dy2 - (y2 - y) * dx2) / den
            u = ((x2 - x) * dy - (y2 - y) * dx) / den
            if 0 < t <= cfg["link_short"] * R and 0 < u <= cfg["link_short"] * R and (best is None or t + u < best[0]):
                best = (t + u, j, (x + t * dx, y + t * dy))
        if best:
            _, j, X = best
            X = tuple(np.round(X).astype(int))
            cv2.line(walls, tuple(np.round(E[k, :2]).astype(int)), X, 255, 2)
            cv2.line(walls, tuple(np.round(E[j, :2]).astype(int)), X, 255, 2)
            done |= {k, j}

    # T-junctions: a border that stops just short of another one. Walk each remaining
    # loose end straight on until it meets a wall.
    H, W = walls.shape
    for k in np.nonzero(loose)[0]:
        if k in done:
            continue
        x, y, dx, dy, i = E[k]
        ys, xs = masks[int(i)]
        own = set(zip(xs.tolist(), ys.tolist()))
        for step in range(3, int(cfg["link_short"] * R)):
            px, py = round(x + dx * step), round(y + dy * step)
            if not (0 <= px < W and 0 <= py < H):
                break
            if walls[py, px] and (px, py) not in own:
                cv2.line(walls, (round(x), round(y)), (px, py), 255, 2)
                break
    return cv2.dilate(walls, np.ones((5, 5), np.uint8))


def detect_regions(hsv: np.ndarray, stars, lanes, cfg) -> tuple[list[Region], np.ndarray]:
    R = float(np.median([s.r for s in stars])) if stars else 8.0
    ink = np.zeros(hsv.shape[:2], np.uint8)
    for lower, upper in cfg["ink"]:
        ink |= cv2.inRange(hsv, np.array(lower, np.uint8), np.array(upper, np.uint8))
    rest = _erase_network(ink, stars, lanes, R)
    labels = find_labels(rest, R, cfg)
    walls = build_walls(rest, R, cfg)

    areas, n = ndimage.label(walls == 0)
    H, W = areas.shape
    exterior = set(np.unique(np.concatenate([areas[0], areas[-1], areas[:, 0], areas[:, -1]]))) - {0}
    sizes = np.bincount(areas.ravel(), minlength=n + 1)
    candidates = [a for a in range(1, n + 1) if a not in exterior and sizes[a] >= cfg["min_area"] * R * R]
    # border pixels and small pockets (around stubs, text) belong to the nearest real area
    keep = np.isin(areas, candidates)
    _, (iy, ix) = ndimage.distance_transform_edt(~keep, return_indices=True)
    full = np.where(keep, areas, areas[iy, ix])
    # ...unless they are far from every area (outside the map's borders)
    far = ndimage.distance_transform_edt(~keep) > cfg["edge_reach"] * R
    full[far] = 0

    # pair labels with enclosed areas one-to-one, nearest first (optimal assignment)
    dist = np.full((len(labels), len(candidates)), np.inf)
    for li, (x, y, w, h) in enumerate(labels):
        box = np.ones((H, W), np.uint8)
        box[y : y + h, x : x + w] = 0
        dt = cv2.distanceTransform(box, cv2.DIST_L2, 3)
        if candidates:
            dist[li] = ndimage.minimum(dt, areas, index=candidates)
    pairs = {}
    if candidates and labels:
        cost = np.where(dist <= cfg["label_reach"] * R, dist, 1e9)
        for li, ai in zip(*linear_sum_assignment(cost)):
            if cost[li, ai] < 1e9:
                pairs[li] = candidates[ai]

    regions: list[Region] = []
    for li, box in enumerate(labels):
        area = pairs.get(li)
        if area is None:
            # label found but no closed border near it: a human draws the outline
            regions.append(Region(box, [], []))
            continue
        member = [i for i, s in enumerate(stars) if full[min(H - 1, round(s.y)), min(W - 1, round(s.x))] == area]
        cnts, _ = cv2.findContours((full == area).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cnt = max(cnts, key=cv2.contourArea)
        poly = cv2.approxPolyDP(cnt, 0.5 * R, True)[:, 0, :].astype(float).tolist()
        regions.append(Region(box, poly, member))
    return regions, walls
