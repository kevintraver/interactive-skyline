# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Usage: uv run tests/fixtures/make_heights_fixture.py

Write tests/fixtures/heights-lv.json: heights from scripts/lib/heights.py at points spread over the
near, far and wide grids and along I-15 from Primm. tests/unit/terrain.test.js checks that the
browser's terrain provider gives the same numbers.
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.frame import create_frame  # noqa: E402
from lib.heights import load_heights  # noqa: E402

hs = load_heights("lv")
frame = create_frame(json.loads((ROOT / "data" / "cities.json").read_text())["lv"])
rng = np.random.default_rng(15)

points = []


def add(label, x, y):
    points.append({"label": label, "x": round(float(x), 3), "y": round(float(y), 3)})


# along I-15 northbound, California line to the Strip
for name, lat, lon in [
    ("I-15 at the state line", 35.6036, -115.3895), ("Primm", 35.6106, -115.3884),
    ("I-15 km 10", 35.6930, -115.3660), ("I-15 km 18", 35.7480, -115.3420), ("Jean", 35.7789, -115.3239),
    ("I-15 km 33", 35.8660, -115.2700), ("I-15 km 38", 35.9050, -115.2440), ("Sloan", 35.9435, -115.2176),
    ("I-15 km 48", 35.9900, -115.2020), ("I-15 at Blue Diamond", 36.0230, -115.1880),
    ("Hoover Dam", 36.0160, -114.7377), ("Boulder City", 35.9786, -114.8325), ("Apex", 36.4106, -114.9233),
]:
    x, y = frame.to_local(lat, lon)
    add(name, x, y)
# random points in each grid's own ground (near; far outside near; wide outside far)
near, far, wide = hs.grid("near"), hs.grid("far"), hs.grid("wide")
for label, g, outside, n in [("near", near, None, 14), ("far", far, near, 14), ("wide", wide, far, 14)]:
    k = 0
    while k < n:
        x = rng.uniform(g.x0, g.x1)
        y = rng.uniform(g.y0, g.y1)
        if outside is not None and outside.contains(x, y):
            continue
        add(f"random {label}", x, y)
        k += 1
# edges: on the boundary (contains is strict), just inside, and beyond every grid (clamped)
add("near west edge", near.x0, 100)
add("just inside near", near.x0 + 0.001, 100)
add("far south edge", -12000, far.y0)
add("just inside far", -12000, far.y0 + 0.001)
add("wide corner", wide.x0, wide.y0)
add("beyond wide, south", -20000, -80000)
add("beyond wide, east", 70000, 0)

xs = np.array([p["x"] for p in points])
ys = np.array([p["y"] for p in points])
h, gy = hs.height_at(xs, ys), hs.ground_y(xs, ys)
for p, a, b, x, y in zip(points, h, gy, xs, ys):
    p["grid"] = next((n for n in ("near", "far") if hs.grid(n).contains(x, y)), "wide")
    p["height"], p["groundY"] = float(a), float(b)

out = {"city": "lv", "base": hs.base, "points": points}
(Path(__file__).parent / "heights-lv.json").write_text(json.dumps(out, indent=1) + "\n")
print(f"{len(points)} points: " + ", ".join(f"{n} {sum(p['grid'] == n for p in points)}" for n in ("near", "far", "wide")))
