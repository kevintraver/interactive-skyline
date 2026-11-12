"""Low-poly model of a 145 m condo-hotel slab tower (Las Vegas, id w95223232), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center. No logos or signs modeled.

Sources:
  - height 145.0 m: project data (osm-height), trusted
  - plan: footprint.json from skyline_tool.py footprint (OSM outline), offset 0,0
  - facade: Commons search thumbnails (cream frame, gold-tinted glass, arched parapet with central fins);
    band spacing, crown heights and pier spacing are estimates (est.)
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "the_signature_at_mgm_g_w95223232"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 145.0            # project data
BASE_TOP = 6.0            # cream lobby base (est.)
BODY_TOP = 133.0          # top of banded shaft (est. from photos, ~92 % of height)
CROWN_EDGE = 136.5        # parapet height at the slab ends (est.)
CROWN_PEAK = 141.5        # arched parapet peak at mid-length (est.)
GROUPS = 14               # glass + spandrel groups, each about 3 floors (est.)
BAND = 2.2                # cream spandrel band height (est.)
HALF_LEN = 41.0           # half length of slab along its long axis (from footprint, ~bearing 45)

COLORS = {
    "Frame": "E6DCC6",    # cream stucco frame
    "Glass": "B8944A",    # gold-tinted glazing
    "Crown": "EFE7D4",
    "Roof": "8C8A84",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Frame":
        return kit.scaled(WARM, 0.05 + 0.25 * math.exp(-max(z, 0.0) / 20.0))
    if material == "Crown":
        return kit.scaled(WARM, 0.55)
    return (0.0, 0.0, 0.0)


def along(x, y):
    """Signed distance along the slab's long axis (bearing 45 deg)."""
    return (x + y) / math.sqrt(2.0)


def roofline(x, y):
    t = min(1.0, abs(along(x, y)) / HALF_LEN)
    return CROWN_EDGE + (CROWN_PEAK - CROWN_EDGE) * (1.0 - t * t)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    plan = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]

    # shaft: cream base, then glass bands separated by cream spandrels
    levels, mats = [BURY, BASE_TOP], ["Frame"]
    step = (BODY_TOP - BASE_TOP) / GROUPS
    for i in range(GROUPS):
        z = BASE_TOP + i * step
        levels += [z + step - BAND, z + step]
        mats += ["Glass", "Frame"]
    b.loft(kit.footprint_rings(plan, levels), mats)

    # cream vertical piers around the perimeter
    b.fins(plan, BASE_TOP, BODY_TOP, 6.0, 0.6, 2.4, "Frame")

    # arched parapet crown, slightly proud of the shaft
    b.extrude_sloped(kit.offset_polygon(plan, 0.5), BODY_TOP, roofline, "Crown", top="Roof", max_edge=7.0)

    # central fins rising to the full height (three thin blades across the slab)
    c = 1.0 / math.sqrt(2.0)
    for s, top in ((-4.0, HEIGHT - 2.0), (0.0, HEIGHT), (4.0, HEIGHT - 2.0)):
        cx, cy = s * c, s * c
        hw, hl = 0.6, 13.5  # half thickness along the slab, half length across it
        ax, ay = c, c       # along
        px, py = -c, c      # across
        quad = [(cx + ax * i * hw + px * j * hl, cy + ay * i * hw + py * j * hl)
                for i, j in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        b.extrude(quad, BODY_TOP + 1.0, top, "Crown")
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
