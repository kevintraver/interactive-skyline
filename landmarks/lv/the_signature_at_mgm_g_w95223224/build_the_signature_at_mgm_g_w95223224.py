"""Low-poly model of a 145 m condo-hotel slab tower (Las Vegas, id w95223224), built with landmark_kit.

Sources:
  - height 145.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), offset 0,0
  - facade (cream balcony bands, gold glass center stripe, stepped arched crown): read off the Commons
    search sheet (refs/search.json/commons_sheet.jpg); section heights estimated from it
Logos and signage are not modeled.
"""
import math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "the_signature_at_mgm_g_w95223224"
MAX_TRIS = 2500
BURY = -2.0
HEIGHT = 145.0          # project data
ROOF = 133.0            # main parapet (est. from photos: crown ~8% of height)
CROWN1, CROWN2 = 140.0, HEIGHT  # stepped center crown (est.)
PLAN = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

COLORS = {"Glass": "A39A7E", "Cream": "E8E1CC", "GoldGlass": "C29A3E", "Roof": "9A968A", "Base": "CFC6AE"}
ROUGHNESS = {"Glass": 0.35, "GoldGlass": 0.3}
WINDOWS = {"Glass": 1.0, "GoldGlass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material in ("Glass", "GoldGlass"):
        return kit.scaled(WARM, 0.03)
    if material == "Cream":
        return kit.scaled(WARM, 0.45 if z > ROOF - 1 else 0.08)  # flood-lit crown
    if material == "Base":
        return kit.scaled(WARM, 0.2)
    return (0.0, 0.0, 0.0)


def build_body(b):
    b.extrude(PLAN, BURY, ROOF, "Glass", top="Roof")
    band = kit.offset_polygon(PLAN, 0.45)
    b.extrude(band, BURY, 7.0, "Base")                      # lobby base
    z = 13.0
    while z < ROOF - 6:                                      # balcony slab bands every 2 floors (grouped)
        b.extrude(band, z, z + 1.7, "Cream")
        z += 4.6
    b.extrude(kit.offset_polygon(PLAN, 0.7), ROOF - 3.0, ROOF + 1.5, "Cream", top="Roof")  # parapet
    b.fins(PLAN, 7.0, ROOF - 3.0, 9.0, 0.6, 1.2, "Cream")   # vertical piers
    # center bay, across the slab (long axis runs NE-SW): gold glass stripe and stepped crown
    b.block((0.2, -0.2), 5.0, 14.9, 7.0, 124.0, "GoldGlass", turn_deg=45)
    b.block((0.2, -0.2), 9.5, 15.1, 124.0, CROWN1, "Cream", turn_deg=45, top="Roof")
    b.block((0.2, -0.2), 5.0, 13.0, CROWN1, CROWN2 - 1.5, "Cream", turn_deg=45, top="Roof")
    b.block((0.2, -0.2), 1.2, 15.3, 118.0, CROWN2, "Cream", turn_deg=45)  # center fin


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
