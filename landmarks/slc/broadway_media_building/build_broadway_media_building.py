"""Low-poly model of <LANDMARK> (<CITY>), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - <height: source>
  - <plan size / footprint: source>
  - <proportions read off <photo file> (side elevation), scaled by the published height>
"""
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402  (copied next to this script)

# Split for parallel part-modelers? Move the dimensions, COLORS, ROUGHNESS and glow below into spec.py,
# replace them here with `from spec import *`, and let each modeler write part_<name>.py (assets/part_template.py).

STEM = "broadway_media_building"
MAX_TRIS = 3_000
BURY = -2.0
HEIGHT = 48.8   # project data (lidar)
# Plan: footprint.json (mapped, 2 volumes: tower 48.8 m, low block 12.9 m). Facade read from Commons photos
# (beige precast piers, tall vertical dark glass strips, dark roof parapet); strip count/pitch estimated.
COLORS = {"Precast": "CFC3A8", "Podium": "B8A98C", "Glass": "26303A", "Roof": "5A5148", "Band": "DDD3BC"}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material in ("Precast", "Podium", "Band"):
        return kit.scaled((0.9, 0.85, 0.75), 0.04 + 0.12 * math.exp(-max(point[2], 0.0) / 15.0))
    return (0.0, 0.0, 0.0)


def clean(pts, tol=0.03):
    out = list(pts)
    changed = True
    while changed and len(out) > 3:
        changed = False
        for i in range(len(out)):
            a, c, d = out[i - 1], out[i], out[(i + 1) % len(out)]
            cross = (c[0]-a[0])*(d[1]-a[1]) - (c[1]-a[1])*(d[0]-a[0])
            L = math.hypot(d[0]-a[0], d[1]-a[1]) or 1e-9
            if abs(cross) / L < tol:
                del out[i]
                changed = True
                break
    return out


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    for v in fp["volumes"]:
        tall = v["top"] > 30
        b.extrude(clean(v["outline"]), BURY, v["top"], "Precast" if tall else "Podium", top="Roof")
    # parapet band and dark cap on the tower
    tower = [v for v in fp["volumes"] if v["top"] > 30][0]
    b.block((23.55, 3.2), 11.4, 22.4, tower["top"] - 3.0, tower["top"], "Band", top="Roof")
    # vertical glass strips on the long east and west faces of the tower
    pitch, w = 4.3, 2.4
    for i in range(10):
        y = -16.0 + i * pitch
        b.block((34.7, y), 0.2, w / 2, 3.0, 45.0, "Glass")
        b.block((12.4, y), 0.2, w / 2, 14.0, 45.0, "Glass")
    # narrow end faces: one strip each
    b.block((23.5, 24.85), w / 2, 0.2, 3.0, 45.0, "Glass")
    b.block((23.5, -18.3), w / 2, 0.2, 3.0, 45.0, "Glass")


def part_files() -> dict:
    """part_<name>.py files next to this script, imported only when built, so one broken part never stops
    another modeler from building theirs with --only."""
    names = sorted(f[5:-3] for f in os.listdir(HERE) if f.startswith("part_") and f.endswith(".py"))
    return {n: (lambda b, n=n: importlib.import_module(f"part_{n}").build(b)) for n in names}


PARTS = {"body": build_body, **part_files()}  # build order; --only body,top builds a subset


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
