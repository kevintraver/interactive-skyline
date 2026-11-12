"""Low-poly model of a downtown Las Vegas twin-tower hotel and casino (id w33967431), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up. Logos and signage deliberately not modeled (sign areas plain).

Sources:
  - height 81.7 m: project data (lidar), trusted
  - plans and part heights (north tower 66.1 m, south tower 81.8 m, podium 21.8 m): footprint.json, offset 0,0
  - facade (white concrete piers over dark window columns, plain white parapet, flat roofs, blue night
    wash): read off Wikimedia Commons search thumbnails ("Plaza Hotel & Casino - North Tower",
    "Vegas Plaza Hotel.JPG"); pier spacing, parapet depth and podium colors est.
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "plaza_hotel_casino_w33967431"
MAX_TRIS = 2_500

BURY = -2.0
HEIGHT = 81.7        # project data (south tower)
NORTH_TOP = 66.1     # footprint.json
PODIUM_TOP = 21.8    # footprint.json
PARAPET = 3.5        # plain white band at the top (est.)
PIER_STEP = 4.6      # pier spacing along long faces (est. from photo)
PIER_W, PIER_OUT = 2.3, 0.7

COLORS = {
    "Wall": "E6E4DE",    # white concrete
    "Glass": "2B3440",   # dark window columns
    "Podium": "CFC8BA",  # casino podium / garage
    "Base": "5A4038",    # street level
    "Roof": "8C8A84",
}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM, BLUE = (1.0, 0.82, 0.58), (0.45, 0.55, 1.0)


def glow(material, point, center):
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":
        return kit.scaled(BLUE, 0.45)
    if material == "Podium":
        return kit.scaled(WARM, 0.15)
    if material == "Base":
        return kit.scaled(WARM, 0.5)
    return (0.0, 0.0, 0.0)


def clean(outline, tol=1.2):
    """Drop points closer than tol to the previous kept one (mapped outlines carry rounded corners)."""
    out = []
    for p in outline:
        if not out or math.dist(p, out[-1]) > tol:
            out.append(tuple(p))
    if len(out) > 1 and math.dist(out[0], out[-1]) <= tol:
        out.pop()
    return out


def piers(b, plan, z0, z1):
    pts = kit.ccw_polygon(plan)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        length = math.hypot(x1 - x0, y1 - y0)
        if length < 5:
            continue
        solid = length < 14  # short end walls are plain concrete
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        nx, ny = uy, -ux  # outward for a counter-clockwise plan
        n = 1 if solid else max(2, round(length / PIER_STEP))
        for k in range(n):
            t = (k + 0.5) * length / n
            cx, cy = x0 + ux * t, y0 + uy * t
            h = length * 0.42 if solid else PIER_W / 2
            rect = [(cx - ux * h - nx * 0.3, cy - uy * h - ny * 0.3), (cx + ux * h - nx * 0.3, cy + uy * h - ny * 0.3),
                    (cx + ux * h + nx * PIER_OUT, cy + uy * h + ny * PIER_OUT),
                    (cx - ux * h + nx * PIER_OUT, cy - uy * h + ny * PIER_OUT)]
            b.extrude(rect, z0, z1, "Wall")


def tower(b, plan, z0, top):
    lo, hi = z0 + 3.0, top - PARAPET
    levels, mats = [z0, lo], ["Wall"]
    for k in range(1, 4):  # white spandrel bands (est.)
        z = lo + (hi - lo) * k / 4
        levels += [z - 0.8, z + 0.8]
        mats += ["Glass", "Wall"]
    levels += [hi, (hi, 0.7), top]
    mats += ["Glass", "Wall", "Wall"]
    b.loft(kit.footprint_rings(plan, levels), mats)
    piers(b, plan, z0 + 3.0, top - PARAPET + 0.01)


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    vols = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"]
    north, south, podium = (clean(v["outline"]) for v in vols)

    # casino podium and garage, low (the mapped hole is the north tower, which rises through it)
    b.extrude(podium, BURY, 5.0, "Base")
    b.extrude(podium, 5.0, PODIUM_TOP, "Podium", top="Roof")

    tower(b, kit.offset_polygon(north, -0.2), PODIUM_TOP - 1.0, NORTH_TOP)
    tower(b, kit.offset_polygon(south, -0.3), BURY, HEIGHT)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
