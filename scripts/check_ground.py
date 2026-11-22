# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Usage: check_ground.py <city> [route ...] [--bilinear] [--out <file>]

Measure whether everything the drive draws meets the ground it draws (lib/groundcheck.py): per
route and per kind of object, how many are wrong and the worst cases with their chainage. The
ground is the drawn surface (lib.heights: Heights.drawn_at, the triangles of every grid the drive
draws). --bilinear stands billboards, poles and buildings on the bilinear height instead (how the
runtime placed them before the drawn ground was its one definition), to measure that.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.groundcheck import check_route, check_water  # noqa: E402
from lib.heights import load_heights  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def main(argv):
    args = list(argv)
    out = None
    if "--out" in args:
        k = args.index("--out")
        out = args[k + 1]
        del args[k:k + 2]
    bilinear = "--bilinear" in args
    if bilinear:
        args.remove("--bilinear")
    city, routes = args[0], args[1:]
    if not routes:
        routes = [r["id"] for r in json.loads((ROOT / "public" / "data" / city / "routes.json").read_text())["routes"]]
    hs = load_heights(city)
    ground = hs.drawn_at
    placed = hs.height_at if bilinear else ground
    rep = {"routes": [check_route(city, r, ground, placed) for r in routes], "water": check_water(city, ground)}
    for r in rep["routes"]:
        print(f"== {r['route']}")
        for k, v in r["kinds"].items():
            w = v["worst"][0] if v["worst"] else None
            print(f"  {k:22s} {v['wrong']:6d} / {v['count']:7d} wrong (tol {v['tol_m']} m), max {v['max_m']} m"
                  + (f"  worst {json.dumps(w)}" if w else ""))
    for w in rep["water"]:
        print("  water", json.dumps(w))
    if out:
        Path(out).write_text(json.dumps(rep, indent=1))
    return rep


if __name__ == "__main__":
    main(sys.argv[1:])
