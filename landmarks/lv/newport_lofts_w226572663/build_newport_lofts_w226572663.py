"""Low-poly model of Newport Lofts (Las Vegas), built procedurally with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled.

Sources:
  - height 102.0 m: project data (osm-height)
  - plan: footprint.json (skyline_tool.py footprint): one 45.9 m square, rotated
  - facade (grey-blue glass with pale balcony slab bands, pale corner piers, stepped top with a thin
    floating ring canopy): Wikimedia Commons search sheet, "Newport Lofts (2020).jpg"
    (refs/search.json/commons_sheet.jpg); band count, setback sizes and ring size are estimates.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "newport_lofts_w226572663"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 102.0      # project data (osm-height)
BASE_TOP = 9.0      # podium / lobby levels (est.)
ROOF = 84.0         # main roof before the stepped top (est. from photo)
STEP1 = 92.0        # first setback top (est.)
STEP2 = 97.0        # second setback / core top (est.)
RING_Z = 100.8      # underside of ring canopy (est.)
BAND = 0.9          # pale slab band height (est.)
N_BANDS = 18

COLORS = {
    "Frame": "D5D8D6",   # pale slab bands and piers
    "Glass": "5F7F8E",   # grey-blue glazing
    "Podium": "B5B0A6",
    "Roof": "888C90",
    "Crown": "DCE2E4",   # ring canopy and top core
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Frame":
        return kit.scaled(COOL, 0.08)
    if material == "Podium":
        return kit.scaled(WARM, 0.12)
    if material == "Crown":
        return kit.scaled(COOL, 0.5)
    return (0.0, 0.0, 0.0)


def disc(radius, n=20):
    return [(radius * math.cos(2 * math.pi * i / n), radius * math.sin(2 * math.pi * i / n)) for i in range(n)]


def banded(b, plan, z0, z1, n, first=None):
    levels, mats = [z0], []
    step = (z1 - z0) / n - BAND
    z = z0
    for _ in range(n):
        levels += [z + step, z + step + BAND]
        mats += ["Glass", "Frame"]
        z += step + BAND
    b.loft(kit.footprint_rings(plan, levels), mats)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    plan = list(kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"])
    b.extrude(plan, BURY, BASE_TOP, "Podium", top="Roof")
    tower = kit.offset_polygon(plan, -1.5)
    banded(b, tower, BASE_TOP, ROOF, N_BANDS)
    b.fins(tower, BASE_TOP, ROOF, 11.5, 0.6, 1.4, "Frame")   # pale balcony piers (est. spacing)
    s1 = kit.scale_polygon(plan, 0.74)
    banded(b, s1, ROOF, STEP1, 2)
    b.extrude(kit.scale_polygon(plan, 0.42), STEP1, STEP2, "Crown", top="Roof")
    b.extrude(disc(4.0, 10), STEP2, RING_Z, "Roof")            # ring support core
    b.extrude(disc(14.0, 24), RING_Z, HEIGHT, "Crown")         # floating ring canopy
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
