"""Low-poly model of Salt Lake Temple (Salt Lake City), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 64 m (project osm-height); six tower footprints and tops 60/62/64 m from the mapped volumes
  - plan: skyline_tool footprint (7 volumes: 6 towers + 50 m main body outline)
  - refine pass: tower tops east 64 / 57.3 m, west 62.2 / 55.5 m (published 210/188/204/182 ft, from memory,
    consistent with refs UT2 where side towers reach ~88% of the centre one); shaft 60% of each tower, two
    stepped battlement tiers, octagonal spire; body parapet 30 m with buttresses: estimated from the refs.
    No statue or figure modeled: a plain finial only.
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
COLORS = {"Stone": "DAD8D0", "Tier": "E2E0D8", "Spire": "E4E2DA", "Roof": "7A828C", "Gold": "C9A24A",
          "Window": "6E7078"}
ROUGHNESS = {}
WINDOWS = {}
WARM = (1.0, 0.82, 0.58)
FLOOD = (1.0, 0.93, 0.80)       # warm-white floodlight on the granite
BODY_TOP = 30.0                 # parapet of the main body (estimated from refs; mapped volume says 50 m)
# tower tops by position (east is +x): centre towers taller than the corner ones, east group taller than west
TOPS = {(1, 0): 64.0, (1, 1): 57.3, (1, -1): 57.3, (-1, 0): 62.2, (-1, 1): 55.5, (-1, -1): 55.5}
SHAFT, TIER1, TIER2 = 0.60, 0.69, 0.765   # fractions of a tower's height where each stage ends


def glow(material, point, center):
    z = point[2]
    if material == "Spire":
        return kit.scaled(WARM, 0.75)
    if material == "Gold":
        return kit.scaled(WARM, 0.9)
    if material == "Tier":
        return kit.scaled(FLOOD, 0.95)
    if material == "Stone":
        return kit.scaled(FLOOD, 0.22 + 0.33 * math.exp(-max(z, 0.0) / 30.0))
    if material == "Window":
        return kit.scaled(WARM, 0.22)
    return (0.0, 0.0, 0.0)


def bounds(pts):
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (max(xs) - min(xs)) / 2, (max(ys) - min(ys)) / 2


def pinnacle(b, x, y, half, z0, z1, tip, material):
    """A square pier with a pyramid cap."""
    b.block((x, y), half, half, z0, z1, material)
    b.prism(half * 1.15 * math.sqrt(2), z1, tip, 4, material, radius_top=0.0, center=(x, y), phase=math.pi / 4)


def corners(cx, cy, hx, hy):
    return [(cx + sx * hx, cy + sy * hy) for sx in (-1, 1) for sy in (-1, 1)]


def build_body(b):
    body = [v for v in FP["volumes"] if len(v["outline"]) > 8][0]
    o = [tuple(p) for p in body["outline"]]
    cx, cy, hx, hy = bounds(o)
    b.extrude(o, BURY, BODY_TOP, "Stone", top="Roof")
    b.block((cx, cy), hx - 9.0, hy - 2.5, BODY_TOP, BODY_TOP + 1.6, "Roof")   # low roof behind the parapet
    # buttresses along the long (north and south) walls, rising past the parapet as battlement piers
    n = 8
    span = 2 * (hx - 8.5)
    for i in range(n):
        x = cx - span / 2 + span * i / (n - 1)
        for sy in (-1, 1):
            pinnacle(b, x, cy + sy * (hy + 0.25), 0.75, BURY, BODY_TOP + 1.2, BODY_TOP + 3.0, "Stone")
    # tall window bays between the buttresses, two storeys, standing 8 cm proud
    for i in range(n - 1):
        x = cx - span / 2 + span * (i + 0.5) / (n - 1)
        for sy in (-1, 1):
            for z0, z1 in ((4.0, 12.5), (15.5, 24.0)):
                b.block((x, cy + sy * (hy + 0.04)), 0.8, 0.04, z0, z1, "Window")


def build_towers(b):
    for v in FP["volumes"]:
        if len(v["outline"]) > 8:
            continue
        cx, cy, hx, hy = bounds([tuple(p) for p in v["outline"]])
        key = (1 if cx > 0 else -1, 0 if abs(cy) < 4 else (1 if cy > 0 else -1))
        top = TOPS[key]
        s, t1, t2 = top * SHAFT, top * TIER1, top * TIER2
        # square shaft with corner buttress piers and a battlement cornice
        b.block((cx, cy), hx, hy, BURY, s, "Stone")
        b.block((cx, cy), hx + 0.35, hy + 0.35, s - 1.2, s + 0.5, "Stone")
        for x, y in corners(cx, cy, hx, hy):
            pinnacle(b, x, y, 0.75, BURY, s + 1.6, s + 5.0, "Stone")
        # two stepped tiers, each with corner pinnacles
        for k, z0, z1 in ((0.80, s + 0.5, t1), (0.62, t1, t2)):
            b.block((cx, cy), hx * k, hy * k, z0, z1, "Tier")
            for x, y in corners(cx, cy, hx * k, hy * k):
                pinnacle(b, x, y, 0.45, z0, z1 + 0.7, z1 + 3.4, "Tier")
        # slender octagonal spire and a plain finial
        r = min(hx, hy) * 0.56
        b.prism(r, t2, top - 1.6, 8, "Spire", radius_top=0.22, center=(cx, cy), phase=math.pi / 8)
        b.prism(0.22, top - 1.6, top - 0.9, 6, "Gold", radius_top=0.5, center=(cx, cy))
        b.prism(0.5, top - 0.9, top, 6, "Gold", radius_top=0.0, center=(cx, cy))
        # one tall window bay per outer face
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            if dx and dx * cx < 0 or (dy and key[1] != dy):
                continue   # faces turned toward the body or a neighbouring tower stay plain
            hw = (0.04, 0.9) if dx else (0.9, 0.04)
            for z0, z1 in ((4.0, 13.0), (16.0, 25.0), (27.5, s - 3.5)):
                b.block((cx + dx * (hx + 0.04), cy + dy * (hy + 0.04)), hw[0], hw[1], z0, z1, "Window")


PARTS = {"body": build_body, "towers": build_towers}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
