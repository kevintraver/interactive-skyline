"""Low-poly model of a 75.5 m hotel slab near the Las Vegas Convention Center (id w313762434).

Units are meters; +X east, +Y north, +Z up; origin at the footprint center. No logos or signs modeled.

Sources:
  - height 75.5 m (north bar) / 72.5 m (south bar): project data (lidar), via skyline_tool.py footprint
  - plan: footprint.json (mapped outline), offset 0,0
  - garage podium height, floor bands, colors, crown: estimated (no usable Commons photo found)
"""
import math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "springhill_suites_by_m_w313762434"
MAX_TRIS = 2500
BURY = -2.0
PODIUM = 16.0      # (est.) parking levels under the hotel floors
BAND_STEP = 6.2    # (est.) spandrel band every two floors

COLORS = {"Wall": "C9B596", "Accent": "8A5A42", "Glass": "2A3742", "Garage": "B8AFA0",
          "Roof": "8C8A86", "Crown": "E4DCCB"}
ROUGHNESS = {"Glass": 0.3}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.82, 0.58)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Crown":
        return kit.scaled(WARM, 0.45)
    if material == "Garage":
        return kit.scaled(WARM, 0.12)
    if material in ("Wall", "Accent"):
        return kit.scaled(WARM, 0.04 + 0.12 * math.exp(-max(z, 0.0) / 20.0))
    return (0.0, 0.0, 0.0)


def dedupe(pts):
    out = []
    for p in pts:
        if not out or math.dist(p, out[-1]) > 0.05:
            out.append(p)
    if math.dist(out[0], out[-1]) < 0.05:
        out.pop()
    keep = []
    n = len(out)
    for i in range(n):  # drop near-collinear points (they make zero-area cap triangles)
        a, q, c = out[i - 1], out[i], out[(i + 1) % n]
        cross = (q[0] - a[0]) * (c[1] - q[1]) - (q[1] - a[1]) * (c[0] - q[0])
        if abs(cross) > 0.02 * math.dist(a, q) * math.dist(q, c):
            keep.append(q)
    return keep


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    for i, v in enumerate(fp["volumes"]):
        o = dedupe(v["outline"])
        top = v["top"]
        b.extrude(o, BURY, PODIUM, "Garage", top="Roof")
        b.extrude(kit.offset_polygon(o, 0.25), PODIUM - 1.2, PODIUM, "Crown")       # podium cornice
        body = kit.offset_polygon(o, -0.3)
        b.extrude(body, PODIUM, top - 1.5, "Glass", top="Roof")
        z = PODIUM + BAND_STEP
        while z < top - 4.0:                                                       # spandrel bands
            b.extrude(o, z - 0.9, z + 0.9, "Wall")
            z += BAND_STEP
        b.extrude(kit.offset_polygon(o, 0.2), top - 2.6, top, "Crown", top="Roof")  # lit parapet
        xs = [p[0] for p in o]; ys = [p[1] for p in o]
        cy, hy = (min(ys) + max(ys)) / 2, (max(ys) - min(ys)) / 2
        for x in (min(xs) + 2.2, max(xs) - 2.2 - (2.6 if i == 0 else 0.0)):         # solid end piers
            b.block((x, cy), 2.6, hy + 0.15, PODIUM, top - 2.6, "Accent")
    # stair/elevator core rising through the north bar, and rooftop plant
    b.block((0.0, 7.5), 5.0, 9.2, PODIUM, 75.5 - 2.6, "Wall")
    b.block((-6.0, -9.5), 8.0, 3.5, 72.5, 75.5, "Roof")  # plant on the lower south bar


PARTS = {"body": build_body}


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Hotel_Slab")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
