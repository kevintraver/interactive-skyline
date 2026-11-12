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

STEM = "astra_tower"
MAX_TRIS = 3_000

# Sources: height 137.5 m and plan/volume tops from project data (osm-height, footprint.json: podium 28 m,
# west wing 70 m, tower 137.5 m). Colors/crown/fins read off Commons photos (SW and SE corner views):
# white precast grid podium, copper-toned soffit, dark blue glass tower with white edge fins, white cap.
# Fin spacing, cap height (4.5 m), soffit band are estimated. No signage modeled.
BURY = -2.0
HEIGHT = 137.5
PODIUM_TOP = 28.0
WING_TOP = 70.0
PODIUM = [(24.98, -27.49), (-24.87, -27.54), (-24.89, -5.04), (-24.92, 27.55), (24.93, 27.6)]
TOWER = [(5.0, -27.5), (24.98, -27.49), (24.93, 27.6), (4.92, 27.57), (5.0, -5.1)]
WING = [(-24.87, -27.54), (5.0, -27.52), (5.0, -5.1), (-24.89, -5.04)]

COLORS = {
    "Precast": "E4E2DC",
    "Glass": "1F3350",
    "Copper": "9A6238",
    "Roof": "8C9094",
    "PodiumGlass": "2A3A4C",
}
ROUGHNESS = {"Glass": 0.3, "PodiumGlass": 0.35}
WINDOWS = {"Glass": 1.0}

WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point, center):
    z = center[2]
    if material == "Precast":
        return kit.scaled(COOL, 0.06 + 0.12 * math.exp(-max(z, 0.0) / 25.0) + (0.25 if z > HEIGHT - 5 else 0.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "PodiumGlass":
        return kit.scaled(WARM, 0.25)
    if material == "Copper":
        return kit.scaled(WARM, 0.3)
    return (0.0, 0.0, 0.0)


def build_body(b: kit.Builder) -> None:
    b.extrude(PODIUM, BURY, PODIUM_TOP, "Precast", top="Roof")
    b.fins(PODIUM, 1.5, PODIUM_TOP - 1.0, 3.2, 0.3, 2.0, "PodiumGlass")
    b.extrude(PODIUM, PODIUM_TOP, PODIUM_TOP + 1.5, "Copper")
    b.extrude(WING, PODIUM_TOP + 1.5, WING_TOP, "Glass", top="Roof")
    b.extrude(TOWER, PODIUM_TOP + 1.5, HEIGHT - 4.5, "Glass")
    b.fins(TOWER, PODIUM_TOP + 1.5, HEIGHT - 4.5, 6.0, 0.7, 1.4, "Precast")
    b.extrude(kit.scale_polygon(TOWER, 1.02), HEIGHT - 4.5, HEIGHT, "Precast", top="Roof")


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
