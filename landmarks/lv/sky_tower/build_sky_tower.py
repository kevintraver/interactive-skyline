"""Low-poly model of a 152 m condominium slab tower on the north Strip (Las Vegas), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_sky_tower.py -- --out .

Units are meters. +X east, +Y north, +Z up; origin = the app's placement point (footprint.json frame).
Logos, wordmarks and brand signage are deliberately not modeled.

Sources:
  - height 152.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint, OSM outline); volume 0 = tower slab, volume 1 = podium
  - shoulder height (0.74 H), curved glass upper block, crown steps, band spacing: ratios read off
    refs/2013-0222-Sky.jpg and refs/Sky-Las-Vegas-tower.jpg (est.)
  - podium height 14 m, which end carries the shoulder (south): estimated
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "sky_tower"
MAX_TRIS = 3_000

BURY = -2.0
HEIGHT = 152.0             # project data
ROOF = 145.0               # main roof line (est. from photo: penthouse/mech ~5% of height)
SHOULDER = 112.0           # 0.74 H, refs/2013-0222-Sky.jpg (est.)
UPPER_TOP = 139.0          # curved glass block above the shoulder (est.)
PODIUM = 14.0              # est.
SPLIT = 0.38               # share of the slab length taken by the shoulder wing (photo, est.)
BAND_STEP = 3.3            # white balcony/slab band per floor (est. 3.3 m floors)

FP = kit.load_footprint(os.path.join(HERE, "footprint.json"))
NE, NW, SW, SE = FP["volumes"][0]["outline"]


def P(s: float, t: float) -> tuple:
    """Point on the slab: s 0 (south end) .. 1 (north end), t 0 (west face) .. 1 (east face)."""
    w = (SW[0] + (NW[0] - SW[0]) * s, SW[1] + (NW[1] - SW[1]) * s)
    e = (SE[0] + (NE[0] - SE[0]) * s, SE[1] + (NE[1] - SE[1]) * s)
    return (w[0] + (e[0] - w[0]) * t, w[1] + (e[1] - w[1]) * t)


def rect(s0, s1, t0, t1):
    return [P(s0, t0), P(s0, t1), P(s1, t1), P(s1, t0)]


def curved():
    """Upper block over the shoulder: glass face bowed toward the south."""
    pts = [P(SPLIT, 0.06), P(SPLIT, 0.94)]
    n = 6
    for k in range(n + 1):
        t = 0.94 - 0.88 * k / n
        pts.append(P(0.17 - 0.11 * math.sin(math.pi * k / n), t))
    return pts


def dedupe(points, tol=0.6):
    out = []
    for p in points:
        if not out or math.dist(p, out[-1]) > tol:
            out.append(p)
    if len(out) > 1 and math.dist(out[0], out[-1]) <= tol:
        out.pop()
    return out


COLORS = {
    "Glass": "3F7FA6",      # blue-green facade glass
    "Band": "E9E6DC",       # white slab edges / balcony bands
    "Pier": "DDD9CC",       # white vertical piers and frame
    "Crown": "CFCFC8",
    "Podium": "D9D6CC",
    "Roof": "8C9094",
}
ROUGHNESS = {"Glass": 0.25}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(COOL, 0.03)
    if material == "Band":
        return kit.scaled(COOL, 0.06)
    if material == "Pier":
        return kit.scaled(COOL, 0.05 + 0.12 * max(0.0, (z - 100.0) / 52.0))
    if material == "Crown":
        return kit.scaled(COOL, 0.45)
    if material == "Podium":
        return kit.scaled(WARM, 0.22 * math.exp(-max(z, 0.0) / 12.0) + 0.05)
    return (0.0, 0.0, 0.0)


def bands(b, outline, z0, z1, k=1.035):
    ring = kit.scale_polygon(outline, k)
    z = z0
    while z < z1 - 1.0:
        b.extrude(ring, z, z + 1.3, "Band")
        z += BAND_STEP


def build_body(b):
    pod = dedupe(FP["volumes"][1]["outline"])
    b.extrude(pod, BURY, PODIUM, "Podium", top="Roof")
    b.extrude(kit.scale_polygon(pod, 1.01), PODIUM, PODIUM + 1.2, "Band")

    tall = rect(SPLIT, 1.0, 0.0, 1.0)
    b.extrude(tall, BURY, ROOF, "Glass", top="Roof")
    bands(b, tall, 7.0, ROOF)
    # white piers at the north end corners and a frame line where the tall part meets the shoulder
    for t0, t1 in ((-0.04, 0.10), (0.90, 1.04)):
        b.extrude(rect(0.955, 1.02, t0, t1), BURY, ROOF + 1.5, "Pier")
    b.extrude(rect(SPLIT - 0.02, SPLIT + 0.025, -0.05, 1.05), BURY, ROOF + 1.5, "Pier")

    wing = rect(0.0, SPLIT, 0.0, 1.0)
    b.extrude(wing, BURY, SHOULDER, "Glass", top="Roof")
    bands(b, wing, 7.0, SHOULDER, k=1.03)
    # the shoulder reads as a dense white grid: piers on the end and along both faces
    for s0 in (0.11, 0.235):
        b.extrude(rect(s0, s0 + 0.03, -0.05, 1.05), BURY, SHOULDER + 1.5, "Pier")
    for t0, t1 in ((-0.05, 0.10), (0.90, 1.05)):
        b.extrude(rect(-0.015, 0.03, t0, t1), BURY, SHOULDER + 1.5, "Pier")
    b.extrude(rect(-0.015, 0.02, 0.40, 0.60), BURY, SHOULDER + 1.5, "Pier")

    up = curved()
    b.extrude(up, SHOULDER, UPPER_TOP, "Glass", top="Roof")
    bands(b, up, SHOULDER + 5.0, UPPER_TOP + 1.0, k=1.03)

    # crown: parapet band, stepped mechanical penthouse (plain, no sign)
    b.extrude(kit.scale_polygon(tall, 1.03), ROOF, ROOF + 1.6, "Crown")
    b.extrude(rect(0.50, 0.93, 0.12, 0.88), ROOF, HEIGHT - 2.5, "Crown", top="Roof")
    b.extrude(rect(0.60, 0.85, 0.25, 0.75), HEIGHT - 2.5, HEIGHT, "Crown", top="Roof")


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"Glass": 1.0})
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("SkyTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
