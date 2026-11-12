"""Low-poly model of Salt Lake Temple (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 64 m (project osm-height); six tower footprints and tops 60/62/64 m from the mapped volumes
  - plan: skyline_tool footprint (7 volumes: 6 towers + 50 m main body outline)
  - shaft/spire split (spire starts 22 m under each top), corner pinnacles, body wall 26 m + roof: estimated
    from refs Salt_Lake_Temple_UT2.jpg (east elevation). No statue modeled, plain finial only.
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

STEM = "salt_lake_temple"
MAX_TRIS = 5_000
BURY = -2.0
FP = kit.load_footprint(os.path.join(HERE, "footprint.json"))
COLORS = {"Stone": "C8C4B8", "Spire": "D4D0C4", "Roof": "7A828C", "Gold": "C9A24A"}
ROUGHNESS = {}
WINDOWS = {}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Spire":
        return kit.scaled(WARM, 0.55)
    if material == "Gold":
        return kit.scaled(WARM, 0.9)
    if material == "Stone":
        return kit.scaled(WARM, 0.12 + 0.25 * math.exp(-max(z, 0.0) / 14.0) + (0.25 if z > 34 else 0.0))
    return (0.0, 0.0, 0.0)


def centroid(pts):
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))


def build_body(b):
    body = [v for v in FP["volumes"] if len(v["outline"]) > 8][0]
    o = [tuple(p) for p in body["outline"]]
    b.extrude(o, BURY, 28.0, "Stone", top="Roof")
    b.extrude(kit.scale_polygon(o, 0.78), 28.0, 40.0, "Roof")


def build_towers(b):
    for v in FP["volumes"]:
        if len(v["outline"]) > 8:
            continue
        o = [tuple(p) for p in v["outline"]]
        top = v["top"]
        cx, cy = centroid(o)
        hx = (max(p[0] for p in o) - min(p[0] for p in o)) / 2
        hy = (max(p[1] for p in o) - min(p[1] for p in o)) / 2
        base = top - 22.0
        b.extrude(o, BURY, base, "Stone", top="Stone")
        b.block((cx, cy), hx * 1.02, hy * 1.02, base - 2.0, base + 1.0, "Stone")  # cornice
        r = min(hx, hy) * 0.95
        b.prism(r, base + 1.0, base + 4.0, 8, "Spire", radius_top=r * 0.95, center=(cx, cy), phase=math.pi / 8)
        b.prism(r * 0.95, base + 4.0, base + 9.0, 8, "Spire", radius_top=r * 0.7, center=(cx, cy), phase=math.pi / 8)
        b.prism(r * 0.7, base + 9.0, top - 0.6, 8, "Spire", radius_top=r * 0.1, center=(cx, cy), phase=math.pi / 8)
        b.prism(r * 0.12, top - 0.6, top, 6, "Gold", radius_top=0.0, center=(cx, cy))
        for sx in (-1, 1):
            for sy in (-1, 1):
                px, py = cx + sx * (hx - 1.1), cy + sy * (hy - 1.1)
                b.prism(1.1, base + 1.0, base + 9.0, 4, "Spire", radius_top=0.0, center=(px, py), phase=math.pi / 4)


PARTS = {"body": build_body, "towers": build_towers}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
