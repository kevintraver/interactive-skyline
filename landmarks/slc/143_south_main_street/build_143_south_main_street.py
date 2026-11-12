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

STEM = "143_south_main_street"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 44.9              # project data (lidar)

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Wall": "B8946A",      # tan brick/terra cotta (photo: Tribune building slc.jpg)
    "Base": "C9A97C",      # lighter two-story arched base
    "Cornice": "D2B88E",
    "Glass": "3A4650",
    "Roof": "7A7468",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material in ("Wall", "Base"):  # soft warm uplight at the base, fading upward
        return kit.scaled(WARM, 0.05 + 0.2 * math.exp(-max(z, 0.0) / 12.0))
    if material == "Cornice":
        return kit.scaled(WARM, 0.12)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    ring = fp["volumes"][0]["outline"]
    BASE_H, CORN = 9.0, 2.0
    top = HEIGHT - CORN
    b.extrude(ring, BURY, BASE_H, "Base")                     # two-story arcaded base (est. 9 m)
    b.extrude(kit.scale_polygon(ring, 0.995), BASE_H, top, "Wall")
    b.extrude(ring, BASE_H - 0.3, BASE_H + 0.3, "Cornice")    # string course
    b.extrude(ring, top, HEIGHT - 1.0, "Cornice", top="Roof")       # cornice band
    # long edges: south runs ring[0]->ring[1]... find them by y (south = lower two points, north = upper two)
    pts = sorted(ring, key=lambda q: q[1])
    south = sorted(pts[:2]); north = sorted(pts[2:])

    def edge_y(e, x, inset):
        (x0, y0), (x1, y1) = e
        t = (x - x0) / (x1 - x0)
        return y0 + t * (y1 - y0), (inset if e is north else -inset)

    for i in range(10):  # crenellated parapet blocks (est.)
        x = south[0][0] + 3.0 + i * (south[1][0] - south[0][0] - 6.0) / 9
        for e in (south, north):
            y, d = edge_y(e, x, 0.6)
            b.block((x, y - d), 1.0, 0.5, HEIGHT - 1.0, HEIGHT, "Cornice")
    for i in range(10):  # window bays: dark glass slabs flush on the long faces
        x = south[0][0] + 2.4 + i * (south[1][0] - south[0][0] - 4.8) / 9
        for e in (south, north):
            y, d = edge_y(e, x, 0.0)
            sgn = -1 if e is south else 1
            for f in range(9):  # one window per floor pair (~3.6 m)
                z0 = BASE_H + 1.0 + f * 3.7
                b.block((x, y + sgn * 0.02), 1.1, 0.12, z0, z0 + 2.2, "Glass")


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
