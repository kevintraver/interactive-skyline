"""Low-poly model of <LANDMARK> (<CITY>), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources:
  - height 81.4 m: project data (osm-height, 18 floors)
  - plan: mapped footprint (footprint.json, one volume)
  - crown/podium/pier proportions (est.) read off refs/Zions_Bank_Tower_seen_from_LDS_...jpg
  The name sign near the top is left as plain surface.
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

STEM = "zions_bank_building"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 81.4              # project data
PODIUM_TOP = 8.0           # (est.) two-storey base
CROWN_BOT = 72.0           # (est.) tan crown band starts
CROWN_TOP = 79.4           # (est.)

# ---------------------------------------------------------------------- style
COLORS = {
    "Precast": "C9BBA2",
    "Glass": "4A5560",
    "Roof": "8C8A86",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}  # facade glass that gets the app's procedural lit windows at night ({} for none)

# Night light per face corner, linear RGB (0 = unlit, ~1 = bright). Read it off night photos: what is
# flood-lit, what glows from inside, what stays dark. Keep most surfaces low (0.02-0.2) and save values near
# 1 for the few elements that really shine; a model that glows everywhere reads as a white blob at night.
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material == "Precast":  # soft warm wash, stronger at base and crown
        return kit.scaled(WARM, 0.08 + 0.3 * math.exp(-max(z, 0.0) / 12.0) + (0.2 if z > 70 else 0.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    b.extrude(fp, BURY, PODIUM_TOP, "Precast", top="Precast")
    b.extrude(kit.scale_polygon(fp, 0.995), PODIUM_TOP, CROWN_BOT, "Glass")
    b.fins(fp, PODIUM_TOP, CROWN_BOT, 5.6, 0.45, 0.5, "Precast")
    b.extrude(fp, CROWN_BOT, CROWN_TOP, "Precast", top="Roof")
    b.extrude(kit.scale_polygon(fp, 0.55), CROWN_TOP, HEIGHT, "Precast", top="Roof")


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
