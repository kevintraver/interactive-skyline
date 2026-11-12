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

STEM = "grand_america_hotel"
MAX_TRIS = 5_000

# Sources: height 100.6 m and volume tops (75 / 80 / 100.6 / 17.8) from project footprint (osm-height);
# plan from footprint.json. Colors and roof read off Wikimedia Commons thumbnails (cream precast, blue-grey glass
# bands, slate mansard, round cupola). Band spacing, crown finial: estimated. Signage deliberately omitted.
BURY = -2.0
HEIGHT = 100.6

COLORS = {
    "Precast": "E3DDCF",
    "Glass": "5E7388",
    "Slate": "4A4C52",
    "Base": "CFC6B2",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}

WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point, center) -> kit.RGB:
    z = center[2]
    if material == "Precast":
        return kit.scaled(WARM, 0.10 + 0.25 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Base":
        return kit.scaled(WARM, 0.30)
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Slate":
        return kit.scaled(COOL, 0.08)
    return (0.0, 0.0, 0.0)


def build_body(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    vols = fp["volumes"]
    wing = next(v for v in vols if v["top"] == 75.0)
    tower = next(v for v in vols if v["top"] == 80.0)
    drum = next(v for v in vols if v["bottom"] == 80.0)
    podium = next(v for v in vols if v["top"] < 30)
    b.extrude(podium["outline"], BURY, podium["top"], "Base", top="Base")
    # glass-banded wing with cream floor bands and a darker cornice
    b.extrude(wing["outline"], BURY, 71.0, "Glass")
    b.extrude(kit.offset_polygon(wing["outline"], 0.4), 71.0, 75.0, "Precast", top="Slate")
    b.extrude(kit.offset_polygon(wing["outline"], 0.4), BURY, 13.0, "Precast")
    for z in (20.0, 27.0, 34.0, 41.0, 48.0, 55.0, 62.0, 69.0):
        b.extrude(kit.offset_polygon(wing["outline"], 0.3), z, z + 1.0, "Precast")
    # central tower
    b.extrude(tower["outline"], BURY, 77.0, "Glass")
    b.extrude(kit.offset_polygon(tower["outline"], 0.4), 77.0, 80.0, "Precast", top="Slate")
    # round cupola with slate roof and plain finial
    cx = sum(p[0] for p in drum["outline"]) / len(drum["outline"])
    cy = sum(p[1] for p in drum["outline"]) / len(drum["outline"])
    pts = drum["outline"]
    roof = [(cx + (x - cx) * 0.55, cy + (y - cy) * 0.55) for x, y in pts]
    b.extrude(pts, 80.0, 93.0, "Precast")
    b.extrude(roof, 93.0, 97.0, "Slate", top="Slate")
    b.extrude([(cx - 0.4, cy - 0.4), (cx + 0.4, cy - 0.4), (cx + 0.4, cy + 0.4), (cx - 0.4, cy + 0.4)],
              97.0, HEIGHT, "Precast", top="Precast")


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
