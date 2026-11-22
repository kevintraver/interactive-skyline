# /// script
# requires-python = ">=3.11"
# dependencies = ["pyproj"]
# ///
"""Usage: uv run tests/fixtures/make_frame_fixture.py

Write tests/fixtures/frame.json: reference points for the Las Vegas frame, projected by pyproj
from the proj string in public/data/lv/terrain.json. src/world/frame.js and scripts/lib/frame.py
are held to these.
"""
import json
import math
from pathlib import Path

from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
META = json.loads((ROOT / "public" / "data" / "lv" / "terrain.json").read_text())
to_xy = Transformer.from_crs("EPSG:4326", META["projection"], always_xy=True)
to_ll = Transformer.from_crs(META["projection"], "EPSG:4326", always_xy=True)

NAMED = [
    ("origin", 36.1147, -115.1728),
    ("Strat", 36.14725, -115.15558),
    ("Spaghetti Bowl", 36.17320, -115.15730),
    ("Sloan", 35.94350, -115.21760),
    ("Jean", 35.77890, -115.32390),
    ("Primm", 35.61060, -115.38840),
    ("Apex", 36.41060, -114.92330),
    ("Hoover Dam", 36.01600, -114.73770),
    ("Boulder City", 35.97860, -114.83250),
    ("Henderson", 36.03970, -114.98190),
    ("Mount Charleston", 36.27180, -115.69540),
    ("Pahrump", 36.20830, -115.98390),
    ("Mesquite", 36.80550, -114.06720),
    ("Baker CA", 35.26530, -116.07330),
    ("Kingman", 35.18940, -114.05300),
    ("Barstow", 34.89580, -117.01730),
    ("St George", 37.09650, -113.56840),
    ("Death Valley Furnace Creek", 36.45750, -116.86720),
    ("Mount Whitney", 36.57850, -118.29200),
    ("Los Angeles", 34.05220, -118.24370),
    ("Flagstaff", 35.19830, -111.65130),
]
# points at fixed map distances in eight directions, out to 400 km
RINGS = [(d, b) for d in (80_000, 250_000, 400_000) for b in range(0, 360, 45)]

points = []
for name, lat, lon in NAMED:
    x, y = to_xy.transform(lon, lat)
    points.append({"name": name, "lat": lat, "lon": lon, "x": x, "y": y})
for d, b in RINGS:
    x, y = d * math.sin(math.radians(b)), d * math.cos(math.radians(b))
    lon, lat = to_ll.transform(x, y)
    points.append({"name": f"{d // 1000} km at {b} deg", "lat": lat, "lon": lon, "x": x, "y": y})
for p in points:
    p["dist"] = math.hypot(p["x"], p["y"])

out = {"city": "lv", "origin": META["origin"], "base": 620, "projection": META["projection"], "points": points}
(Path(__file__).parent / "frame.json").write_text(json.dumps(out, indent=1) + "\n")
print(f"{len(points)} points, farthest {max(p['dist'] for p in points) / 1000:.0f} km")
