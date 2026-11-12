"""Low-poly model of Aztec Condominium (Salt Lake City), built with landmark_kit.

Sources: height 37.1 m = project data (lidar); plan = mapped footprint (footprint.json).
No Commons photos were found: floor count (~11), colors, balcony bands and roof boxes are estimated.
No signage is modeled.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "aztec_condominium"
MAX_TRIS = 3_000
BURY = -2.0
TOP = 34.2

COLORS = {  # estimated
    "Wall": "B9A98F", "Band": "DCD7CC", "Glass": "3A4652", "Roof": "7C7F82", "Core": "A09580",
}
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material in ("Wall", "Band", "Core"):
        return kit.scaled(COOL, 0.08 + 0.3 * math.exp(-max(z, 0.0) / 20.0))
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    return (0.0, 0.0, 0.0)


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    outline = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    inner = kit.scale_polygon(outline, 0.985)
    b.extrude(outline, BURY, 3.5, "Wall", top="Band")  # ground floor base (est.)
    b.extrude(inner, 3.5, TOP - 0.6, "Glass")  # window-wall floors (est.)
    for z in [3.5 + 2.85 * i for i in range(1, 11)]:  # floor slab bands (est.)
        b.extrude(outline, z - 0.2, z + 0.25, "Band")
    b.extrude(outline, TOP - 0.8, TOP, "Band", top="Roof")  # parapet cap
    b.block((0.0, 0.0), 6.0, 4.0, TOP, TOP + 2.9, "Core", top="Roof")  # rooftop mechanical (est.)
    b.block((-5.0, 12.0), 2.5, 2.5, TOP, TOP + 2.5, "Core", top="Roof")
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
