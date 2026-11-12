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

STEM = "136_south_temple_street"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 83.5             # project data (osm-height, 24 floors)
FOOT = kit.load_footprint(os.path.join(HERE, "footprint.json"))  # skyline_tool footprint
PODIUM_TOP = 14.0         # (est.) mapped 12 m low volumes; 0 and wide volume read as 3-4 storey base in photo
WIDE_TOP = 22.0           # (est.) mapped 79 m wide volume contradicted by photo (slender tower over low base)
GREEN_Z = (70.0, 79.0)    # (est.) green accent panels near top, photo commons 'Slc 136 east south temple'

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Wall": "D9CFB4",
    "Base": "B59E7A",
    "Glass": "3A4F5C",
    "Green": "6E9A5A",
    "Roof": "8C9094",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material in ("Wall", "Base"):  # floodlights at the base, fading upward
        return kit.scaled(COOL, 0.08 + 0.3 * math.exp(-max(z, 0.0) / 30.0))
    if material == "Green":
        return kit.scaled(WARM, 0.12)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    v = FOOT["volumes"]
    b.extrude(v[0]["outline"], BURY, WIDE_TOP, "Base", top="Roof")
    b.extrude(v[1]["outline"], BURY, PODIUM_TOP, "Base", top="Roof")
    b.extrude(v[2]["outline"], BURY, PODIUM_TOP, "Base", top="Roof")
    tower = v[3]["outline"]
    b.extrude(tower, BURY, HEIGHT - 2.0, "Wall", top="Roof")
    glass = kit.scale_polygon(tower, 1.012)
    z = WIDE_TOP + 2.0
    while z + 2.2 < GREEN_Z[0]:  # strip-window bands, 2 floors apart
        b.extrude(glass, z, z + 2.2, "Glass")
        z += 3.5
    b.extrude(kit.scale_polygon(tower, 1.015), GREEN_Z[0], GREEN_Z[1], "Green")
    b.extrude(kit.scale_polygon(tower, 1.0), HEIGHT - 2.0, HEIGHT, "Roof", top="Roof")


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
