"""Writes tests/fixtures/drawn-lv.json: the ground as drawn (lib.heights Heights.drawn_at) at points over every grid,
the dam patch and the seams between them, for tests/unit/terrain/drawn.test.js to hold the JavaScript twin
(src/world/terrain/drawn.js) to.

    uv run --with-requirements tests/data/requirements.txt python tests/fixtures/make_drawn_fixture.py
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from lib.heights import load_heights  # noqa: E402

hs = load_heights("lv")
rng = np.random.default_rng(5)
boxes = [(-40000, 20000, -60000, -36000, 80), (*[hs.grid("dam").x0, hs.grid("dam").x1, hs.grid("dam").y0, hs.grid("dam").y1], 50),
         (-47000, 29000, -33000, 37000, 40), (-3500, 4500, -4300, 8100, 30),
         (-48300, -47700, -30000, 30000, 15), (-40000, 20000, -34300, -33700, 15), (-3900, -3300, -4000, 8000, 10)]
pts = []
for x0, x1, y0, y1, n in boxes:
    x, y = rng.uniform(x0, x1, n), rng.uniform(y0, y1, n)
    pts += [{"x": round(float(a), 2), "y": round(float(b), 2)} for a, b in zip(x, y)]
x = np.array([p["x"] for p in pts]); y = np.array([p["y"] for p in pts])
for p, d in zip(pts, hs.drawn_at(x, y)):
    p["drawn"] = float(d)
(ROOT / "tests" / "fixtures" / "drawn-lv.json").write_text(json.dumps({"note": __doc__.split("\n")[0], "points": pts}) + "\n")
print(len(pts), "points")
