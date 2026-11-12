"""Low-poly model of the three-wing hotel tower w30618090 (Las Vegas), built with landmark_kit.

Units are meters. +X east, +Y north, +Z up; origin = footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the sign strips on the wing ends are plain.

Sources:
  - height 145.0 m: project data (osm-height), trusted
  - plan: footprint.json (skyline_tool.py footprint), exact mapped Y-shaped outline
  - crown / cornice / base levels: ratios read off refs/Venetian_Las_Vegas_NV.jpg (est.)
  - pier spacing, wing-end tower depth, colors: estimated from the same photo
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "venetian_tower"
MAX_TRIS = 5_000

BURY = -2.0
HEIGHT = 145.0        # project data
BASE_TOP = 10.0       # cream base storeys (est.)
CORNICE = 116.0       # 0.80 H, lower cornice (photo ratio, est.)
ARCADE0, ARCADE1 = 119.0, 134.0   # arched top storeys (est.)
WING_TOP = 138.0      # wing roof; wing-end towers rise to HEIGHT (est.)
END_DEPTH = 14.0      # depth of the wing-end towers (est.)
BAY = 7.0             # pier spacing (est.)
END_EDGES = {(3, 4), (7, 8), (12, 0)}  # footprint edges that are wing ends

COLORS = {
    "Wall": "C48E6E",      # salmon-terracotta piers (lighter, as in the daylight photos)
    "Glass": "4B6F8A",     # blue glass strips
    "Stone": "EAD9B8",     # cream cornices, arcade, wing ends, pier centers
    "ArchGlass": "2C4A63", # arcade windows
    "Roof": "9A948A",
}
ROUGHNESS = {"Glass": 0.35, "ArchGlass": 0.35}
WINDOWS = {"Glass": 1.0}
WARM = (1.0, 0.84, 0.62)


def glow(material, point, center):
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Wall":   # flood-lit from below and from the cornice
        return kit.scaled(WARM, 0.17 + 0.12 * math.exp(-max(z, 0.0) / 35.0))
    if material == "Stone":  # crown brighter than the shaft, but not blown out (night photos)
        if z >= HEIGHT - 5.5:
            return kit.scaled(WARM, 0.22)
        return kit.scaled(WARM, 0.36 if z >= CORNICE - 1 else 0.2 + 0.1 * math.exp(-max(z, 0.0) / 25.0))
    if material == "ArchGlass":  # lit from inside the arches
        return kit.scaled((1.0, 0.78, 0.5), 0.3)
    return (0.0, 0.0, 0.0)


def offset(points, d):
    """True outward offset (miter) of a counter-clockwise polygon."""
    n = len(points)
    out = []
    for i in range(n):
        (x0, y0), (x1, y1), (x2, y2) = points[i - 1], points[i], points[(i + 1) % n]
        a = math.hypot(x1 - x0, y1 - y0)
        c = math.hypot(x2 - x1, y2 - y1)
        n1 = ((y1 - y0) / a, -(x1 - x0) / a)
        n2 = ((y2 - y1) / c, -(x2 - x1) / c)
        mx, my = n1[0] + n2[0], n1[1] + n2[1]
        k = d / max(0.35, (mx * n1[0] + my * n1[1]))
        out.append((x1 + mx * k, y1 + my * k))
    return out


def slab(b, p, t, nrm, s, w, proud, z0, z1, material):
    """Thin box on a wall: centered s along tangent t from p, width w, sticking out `proud`."""
    def pt(u, v):
        return (p[0] + t[0] * u + nrm[0] * v, p[1] + t[1] * u + nrm[1] * v)
    b.extrude([pt(s - w / 2, -0.5), pt(s + w / 2, -0.5), pt(s + w / 2, proud), pt(s - w / 2, proud)],
              z0, z1, material)


def arch(b, p, t, nrm, s, w, v0, v1, z0, z1, material, seg=4):
    """Round-headed window: an arch outline (in the wall plane) lofted from depth v0 out to v1."""
    r = w / 2
    zs = z1 - r
    prof = [(s - r, z0), (s + r, z0)] + [
        (s + r * math.cos(math.pi * i / seg), zs + r * math.sin(math.pi * i / seg)) for i in range(seg + 1)]

    def ring(v):
        return [(p[0] + t[0] * u + nrm[0] * v, p[1] + t[1] * u + nrm[1] * v, z) for u, z in prof]
    b.loft([ring(v0), ring(v1)], material)


def build_body(b):
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))["volumes"][0]["outline"]
    pts = list(fp)
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1])) / 2
    idx = list(range(len(pts)))
    if area < 0:
        pts.reverse(); idx.reverse()
    n = len(pts)
    b.extrude(offset(pts, 0.8), BURY, BASE_TOP, "Stone")
    b.extrude(pts, BASE_TOP, CORNICE, "Glass")
    b.extrude(offset(pts, 1.3), CORNICE, ARCADE0, "Stone")
    b.extrude(pts, ARCADE0, ARCADE1, "Stone")
    b.extrude(offset(pts, 1.3), ARCADE1, ARCADE1 + 2.5, "Stone")
    b.extrude(offset(pts, -2.5), ARCADE1 + 2.5, WING_TOP, "Stone", top="Roof")

    for j in range(n):
        k = (j + 1) % n
        p, q = pts[j], pts[k]
        L = math.hypot(q[0] - p[0], q[1] - p[1])
        t = ((q[0] - p[0]) / L, (q[1] - p[1]) / L)
        nrm = (t[1], -t[0])
        is_end = (idx[j], idx[k]) in END_EDGES or (idx[k], idx[j]) in END_EDGES
        if is_end:
            build_end(b, p, t, nrm, L)
            continue
        short = L < 20   # crotch walls of the Y: one pier, two arches
        if L < 6:
            continue
        end_j = any(j in (pts.index(fp[a]), pts.index(fp[c])) for a, c in END_EDGES)
        end_k = any(k in (pts.index(fp[a]), pts.index(fp[c])) for a, c in END_EDGES)
        s0 = END_DEPTH if end_j else 0.0
        s1 = L - (END_DEPTH if end_k else 0.0)
        bays = max(2 if short else 1, round((s1 - s0) / BAY))
        step = (s1 - s0) / bays
        for i in range(bays + 1):
            s = s0 + i * step
            if (i == 0 and (end_j or short)) or (i == bays and (end_k or short)):
                continue
            slab(b, p, t, nrm, s, step * 0.62, 0.6, BASE_TOP, CORNICE, "Wall")
            slab(b, p, t, nrm, s, step * 0.2, 0.95, BASE_TOP, CORNICE, "Stone")
        for i in range(bays):
            arch(b, p, t, nrm, s0 + (i + 0.5) * step, step * 0.5, -0.5, 0.3, ARCADE0 + 1.5, ARCADE1 - 1.0,
                 "ArchGlass")


def build_end(b, p, t, nrm, L):
    """Wing-end tower: cream block rising above the wing roof, plain central strip (sign not modeled)."""
    def pt(u, v):
        return (p[0] + t[0] * u + nrm[0] * v, p[1] + t[1] * u + nrm[1] * v)

    def rect(grow, v_out):
        return [pt(-grow, -END_DEPTH), pt(L + grow, -END_DEPTH), pt(L + grow, v_out), pt(-grow, v_out)]
    b.extrude(rect(1.2, 1.2), BURY, HEIGHT - 5.0, "Stone")
    b.extrude(rect(2.4, 2.4), HEIGHT - 5.0, HEIGHT - 2.5, "Stone")
    b.extrude(rect(0.6, 0.6), HEIGHT - 2.5, HEIGHT, "Stone", top="Roof")
    # end face: glass | terracotta | plain cream strip | terracotta | glass
    for frac, w, mat in ((0.19, 4.2, "Glass"), (0.34, 4.6, "Wall"), (0.66, 4.6, "Wall"), (0.81, 4.2, "Glass")):
        slabz = (BASE_TOP, CORNICE - 2.0)
        b.extrude([pt(L * frac - w / 2, 0.5), pt(L * frac + w / 2, 0.5), pt(L * frac + w / 2, 1.55),
                   pt(L * frac - w / 2, 1.55)], slabz[0], slabz[1], mat)
    for frac in (0.25, 0.75):
        arch(b, p, t, nrm, L * frac, 5.0, 0.5, 1.5, ARCADE0 + 1.0, HEIGHT - 6.5, "ArchGlass", seg=6)
    # side faces of the end tower: glass strip each side
    for u0, sgn in ((-1.2, -1.0), (L + 1.2, 1.0)):
        b.extrude([pt(u0, -END_DEPTH / 2 - 2.5), pt(u0, -END_DEPTH / 2 + 2.5),
                   pt(u0 + sgn * 0.35, -END_DEPTH / 2 + 2.5), pt(u0 + sgn * 0.35, -END_DEPTH / 2 - 2.5)],
                  BASE_TOP, ARCADE1 - 1.0, "Glass")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    build_body(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
