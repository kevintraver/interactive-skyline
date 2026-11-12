"""Low-poly American Towers (Salt Lake City). Units meters, +X east, +Y north, origin footprint center.
Sources: height 98.8 m and plan volumes (tops 98.8 / 98.8 / 77.4) from project footprint.json (osm-height / OSM).
No usable Commons photos found: colors, the setback crown and the floor bands are estimated (est.).
No logos or signs modeled."""
import math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "american_towers"
MAX_TRIS = 3000
COLORS = {"Glass": "5E7C93", "Precast": "CFC6B4", "Roof": "8A8D91", "Crown": "B9B2A2"}  # est.
ROUGHNESS = {"Glass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = center[2] if material == "Glass" else point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Crown":
        return kit.scaled(WARM, 0.45)
    if material == "Precast":
        return kit.scaled(WARM, 0.06 + 0.25 * math.exp(-max(point[2], 0) / 25.0))
    return (0.0, 0.0, 0.0)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    for v in fp["volumes"]:
        plan, z0, top = v["outline"], v["bottom"], v["top"]
        if top > 90:
            # glass shaft with a precast base, a mid band, then a stepped crown (est.)
            b.extrude(plan, z0, 6.0, "Precast")
            b.extrude(kit.offset_polygon(plan, -0.3), 6.0, top - 8.0, "Glass")
            b.extrude(plan, top - 8.0, top - 5.0, "Precast")
            b.extrude(kit.offset_polygon(plan, -1.5), top - 5.0, top - 2.0, "Crown")
            b.extrude(kit.offset_polygon(plan, -4.0), top - 2.0, top, "Crown", top="Roof")
        else:
            b.extrude(plan, z0, 6.0, "Precast")
            b.extrude(kit.offset_polygon(plan, -0.3), 6.0, top - 1.5, "Glass")
            b.extrude(plan, top - 1.5, top, "Precast", top="Roof")
    return b.finish("AmericanTowers")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
