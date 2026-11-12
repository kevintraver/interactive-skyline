"""Low-poly model of <LANDMARK> (<CITY>), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_95_state_at_city_creek.py -- --out .

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

STEM = "95_state_at_city_creek"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
# Every number gets a source or a "(est.)" note. Heights are above ground; BURY sinks the base into terrain.
BURY = -2.0
HEIGHT = 119.8            # project data (osm-height)
PODIUM_TOP = 19.0         # mapped podium volume top
LOBBY_TOP = 11.0          # recessed colonnaded lobby (est. from photo)
CROWN_BASE = 112.0        # open mechanical screen band (est. from photo)

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, picked from daylight photos (not from logos or signs)
    "Wall": "D9D6CE",
    "Glass": "2C4A66",
    "Lobby": "1E2A34",
    "Crown": "7E8A94",
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
    if material == "Wall":
        return kit.scaled(COOL, 0.12 + 0.3 * math.exp(-max(z, 0.0) / 30.0))
    if material == "Lobby":
        return kit.scaled(WARM, 0.5)
    if material == "Crown":
        return kit.scaled(COOL, 0.25)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)  # low: the lit-window pattern supplies the light (see WINDOWS)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    tower, podium = fp["volumes"][0]["outline"], fp["volumes"][1]["outline"]
    b.extrude(kit.scale_polygon(podium, 0.985), BURY, PODIUM_TOP, "Wall", top="Roof")
    b.extrude(kit.scale_polygon(tower, 0.93), BURY, LOBBY_TOP, "Lobby")
    b.extrude(tower, LOBBY_TOP, CROWN_BASE, "Glass")
    b.extrude(kit.scale_polygon(tower, 0.985), CROWN_BASE, HEIGHT, "Crown", top="Roof")


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
