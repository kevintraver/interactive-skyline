"""Low-poly model of Hyatt Regency Salt Lake City, built with landmark_kit.

Sources: height 99.7 m = project data (osm-height); plan and volume tops (94 / 99.7 / 20 m) from footprint.json
(skyline_tool.py footprint); colors and grey precast east spine read off
refs/Hyatt_Regency_Salt_Lake_City_-_21_April_2024.jpg (spine size and band spacing estimated).
Brand signage near the top is deliberately not modeled.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "hyatt_regency_slc"
MAX_TRIS = 3_000
BURY = -2.0
FP = os.path.join(HERE, "footprint.json")

COLORS = {
    "Glass": "3F7F94",
    "Podium": "5C7A8C",
    "Precast": "B9BDBF",
    "Band": "D9DDDF",
    "Roof": "8C9094",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Podium":
        return kit.scaled(WARM, 0.12)
    if material == "Precast":
        return kit.scaled(COOL, 0.08 + 0.2 * math.exp(-max(z, 0.0) / 25.0))
    if material == "Band":
        return kit.scaled(COOL, 0.08)
    return (0.0, 0.0, 0.0)


def build_body(b):
    for v in kit.load_footprint(FP)["volumes"]:
        top, ring = v["top"], v["outline"]
        if top < 30:  # podium at mapped height
            b.extrude(ring, BURY, top, "Podium", top="Roof")
            continue
        b.extrude(ring, BURY, 6.0, "Podium")
        b.extrude(ring, 6.0, top - 1.5, "Glass")
        b.extrude(kit.scale_polygon(ring, 1.012), top - 1.5, top, "Roof", top="Roof")
        for z in range(10, int(top - 3), 13):
            b.extrude(kit.scale_polygon(ring, 1.008), z, z + 0.7, "Band")
    b.extrude([(30.4, -44.0), (31.6, -44.0), (31.6, 30.0), (30.4, 30.0)], 8.0, 92.0, "Precast")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
