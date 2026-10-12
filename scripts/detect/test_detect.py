"""End-to-end check of detection + id matching on synthetic maps.

    python scripts/detect/test_detect.py

1. Renders the sample galaxy and checks detection recovers every star and lane.
2. Renders the 'next revision' (bigger canvas, 6 stars added, 2 moved, 1 removed) and
   checks every surviving star keeps its id and the changes are reported correctly.
Runs in a temp dir; never touches public/.
"""
from __future__ import annotations

import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = str(HERE / "test-config.yaml")
PY = sys.executable


def run(*args: str):
    subprocess.run([PY, *args], check=True, stdout=subprocess.DEVNULL)


def load(p: Path):
    return json.loads(p.read_text(encoding="utf8"))


def lane_set(lanes):
    return {tuple(sorted(l)) for l in lanes}


def main():
    failures: list[str] = []
    check = lambda ok, msg: ok or failures.append(msg)

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        run(str(HERE / "make_sample_map.py"), "--out-root", str(tmp))
        truth = load(tmp / "public/data/map.json")
        run(str(HERE / "detect_map.py"), "--config", CONFIG, "--image", str(tmp / "public/map/perseus.png"), "--src", "map/perseus.png",
            "--fresh", "--out", str(tmp / "base"))
        base = load(tmp / "base/map.proposed.json")

        # 1. fresh detection on the base map
        check(len(base["systems"]) == len(truth["systems"]), f"base: {len(base['systems'])} stars, expected {len(truth['systems'])}")
        tpts = {s["id"]: s for s in truth["systems"]}
        # --fresh numbers stars itself; pair detections to truth by position
        id_map = {}
        for s in base["systems"]:
            t = min(tpts.values(), key=lambda t: math.hypot(t["x"] - s["x"], t["y"] - s["y"]))
            err = math.hypot(t["x"] - s["x"], t["y"] - s["y"])
            check(err < 3, f"base: {s['id']} is {err:.1f}px from nearest true star")
            id_map[s["id"]] = t["id"]
        mapped = lane_set([[id_map[a], id_map[b]] for a, b in base["lanes"]])
        check(mapped == lane_set(truth["lanes"]),
              f"base lanes: {len(mapped - lane_set(truth['lanes']))} spurious, {len(lane_set(truth['lanes']) - mapped)} missed")

        # 2. next revision, matched against the ground-truth map.json
        run(str(HERE / "make_sample_map.py"), "--variant", "expanded", "--out", str(tmp / "exp"))
        exp_truth = load(tmp / "exp/expanded.truth.json")
        run(str(HERE / "detect_map.py"), "--config", CONFIG, "--image", str(tmp / "exp/expanded.png"), "--src", "map/perseus.png",
            "--current", str(tmp / "public/data/map.json"), "--out", str(tmp / "exp/result"))
        prop = load(tmp / "exp/result/map.proposed.json")
        report = (tmp / "exp/result/detect-report.md").read_text(encoding="utf8")
        got = {s["id"]: s for s in prop["systems"]}

        survivors = [s for s in exp_truth["systems"] if s["id"] not in exp_truth["added"]]
        for s in survivors:
            g = got.get(s["id"])
            ok = g is not None and math.hypot(g["x"] - s["x"], g["y"] - s["y"]) < 3
            check(ok, f"revision: {s['id']} lost its id or landed in the wrong place")
        for rid in exp_truth["removed"]:
            check(rid not in got, f"revision: removed {rid} still present")
            check(f"`{rid}`" in report, f"revision: removal of {rid} not reported")
        for mid in exp_truth["moved"]:
            check(f"`{mid}`" in report, f"revision: move of {mid} not reported")
        new_ids = [i for i in got if i not in tpts]
        check(len(new_ids) == len(exp_truth["added"]), f"revision: {len(new_ids)} new ids, expected {len(exp_truth['added'])}")
        check(all(int(i[4:]) >= truth["nextId"] for i in new_ids), "revision: a new star reused an old id")
        # new stars get fresh ids in our numbering, not the generator's; compare lanes among survivors only
        surv_ids = {s["id"] for s in survivors}
        exp_lanes = {l for l in lane_set(exp_truth["lanes"]) if set(l) <= surv_ids}
        got_lanes = {l for l in lane_set(prop["lanes"]) if set(l) <= surv_ids}
        check(got_lanes == exp_lanes, f"revision lanes: {len(got_lanes - exp_lanes)} spurious, {len(exp_lanes - got_lanes)} missed")

    if failures:
        print("FAIL\n  " + "\n  ".join(failures))
        sys.exit(1)
    print(f"OK: base {len(truth['systems'])} stars / {len(truth['lanes'])} lanes; revision ids preserved, "
          f"{len(exp_truth['added'])} added, {len(exp_truth['moved'])} moved, {len(exp_truth['removed'])} removed detected")


if __name__ == "__main__":
    main()
