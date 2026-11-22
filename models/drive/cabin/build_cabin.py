"""Cabin of a generic left-hand-drive crossover, seen from the driver's seat (plan 02, task D4.1).

    python .claude/skills/blender-landmark-model/scripts/run_blender.py models/drive/cabin/build_cabin.py
        [-- --glb-dir public/models/drive --out models/drive/cabin]

Builds two levels of detail in one headless Blender run and writes:
    public/models/drive/cabin.glb       (high, <= 40,000 triangles)
    public/models/drive/cabin-low.glb   (low,  <= 15,000 triangles)
    public/models/drive/cabin.json      (eye, mirrors, displays, wheel pivot, windshield opening, view figures)
    models/drive/cabin/cabin.blend      (the high build, for render_cabin.py; git-ignored)
    models/drive/cabin/cabin.report.json  (the kit's mesh check of every node, both levels)

AXES. Built in Blender's frame: +X to the driver's right, +Y forward, +Z up, metres. The glTF export is
Y-up, so the app sees +X right, +Y up, -Z forward (the three.js camera's own convention) with no rotation.
Origin on the road surface directly under the driver's eye; the eye is at (0, 1.2, 0) in glTF.

DIMENSIONS. A generic compact crossover; no particular model. Sources:
  [P]  plan 02, section 2.2 / 7.6: eye 1.2 m above the road (locked); a crossover's seat, above AASHTO's
       1.07 m sedan design eye.
  [C]  typical published compact-crossover figures (2020s class averages, rounded): overall width
       1.85 m excluding mirrors, height 1.66-1.70 m, length 4.55-4.65 m, front shoulder room about 1.45 m,
       steering wheel diameter 360-380 mm, windshield rake about 58-62 degrees from vertical.
  [S]  US mirror rules quoted in plan 02 section 7.6 [G8]: driver's mirror flat, passenger's mirror convex
       (radius 889-1,651 mm), inside mirror shows at least 20 degrees.
  [B]  the brief for D4.1: forward view between the A-pillars >= 60 degrees, road 12 m ahead visible in
       the driver's lane, left mirror at 35-45 degrees yaw, right mirror at 55-65 degrees.
  [E]  estimated: chosen to look right from the eye and to meet [B]; not a measured car.

  body half width            0.925 m      [C] 1.85 m overall
  car centre line            x = +0.37 m  [C]/[E] driver's seat centre about 0.37 m left of centre
  eye                        (0, 0, 1.2)  [P]
  neck pivot                 0.10 m behind the eye   [P] section 4.4
  door inner trim            0.79 m from centre      [C] 1.45 m shoulder room at the upper trim (0.725) [E]
  belt line (door top)       0.975-1.05 m, rising rearward   [E]
  roof outer / lining        1.66 m / 1.50-1.54 m    [C] height 1.66-1.70; lining [E]
  windshield base, centre    1.42 m ahead, 0.965 m up        [E] dash top 9.9 deg below the eye
  windshield header, centre  0.74 m ahead, 1.43 m up         [E] rake 58 deg from vertical [C], 17 deg up
  A-pillar                   0.075 m wide face, base 0.87 m / top 0.81 m from centre   [E]
  hood                       1.47-2.85 m ahead, 0.975 m at the cowl falling to 0.88 m at the nose  [E]
                             (keeps the road visible from about 11 m ahead, [B])
  steering wheel             0.37 m rim diameter [C]; centre 0.55 m ahead, 0.82 m up; column 23 deg
                             above horizontal [E]
  instrument display         0.30 x 0.10 m, 0.86 m ahead, 8-14 deg below the eye [E] (12.3 in class)
  centre screen              0.27 x 0.155 m, centred on the car's centre line [E] (12 in class)
  door mirror glass          0.20 x 0.12 m [E]; centre 1.03 m from the car centre, 0.81 m ahead, 1.07 m up,
                             which puts the left at 39 deg and the right at 60 deg of yaw [B]
  interior mirror glass      0.25 x 0.07 m [E]; centre on the car centre line, 0.62 m ahead, 1.36 m up
  B-pillar                   0.30-0.42 m behind the eye [E]; rear seat back 1.0-1.15 m behind [E]
  rear window opening        2.05-2.15 m behind the eye, 1.03-1.46 m up [E]

No badges, logos, lettering or brand-specific shapes; material and object names are generic.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_kit as kit  # noqa: E402  (this folder's own copy, so the folder rebuilds without the skill)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))

# ------------------------------------------------------------------ numbers (see the table above)
EYE = Vector((0.0, 0.0, 1.2))
NECK_BACK = 0.10
CX = 0.37               # car centre line
HALF_W = 0.925          # body outer
TRIM = 0.79             # door inner trim, from the centre line
FLOOR_Z = 0.40
ROOF_TOP = 1.66

WS_BASE_Y, WS_BASE_Z = 1.42, 0.965   # windshield base at the centre line
WS_TOP_Y, WS_TOP_Z = 0.74, 1.43      # windshield header at the centre line
PILLAR_BASE_XO, PILLAR_TOP_XO = 0.87, 0.81
PILLAR_FACE = 0.075

WHEEL_C = Vector((0.0, 0.55, 0.82))
COLUMN_DEG = 23.0
WHEEL_R = 0.185         # rim centre line radius (0.37 m outer about 0.39)

MIRROR_XO, MIRROR_Y, MIRROR_Z = 1.03, 0.81, 1.07
MIRROR_W, MIRROR_H = 0.20, 0.12
INNER_MIRROR_C = Vector((CX, 0.62, 1.36))
INNER_MIRROR_W, INNER_MIRROR_H = 0.25, 0.07

INSTR_C = Vector((0.0, 0.86, 1.025))
INSTR_W, INSTR_H = 0.30, 0.10
SCREEN_C = Vector((CX, 0.86, 1.01))
SCREEN_W, SCREEN_H = 0.27, 0.155

COLORS = {  # sRGB hex; dark and matte inside so the dashboard does not glare in the windshield
    "CabinDash": "1C1D1F",
    "CabinTrim": "424346",
    "CabinPillar": "6B6B69",
    "Hood": "8C939B",
    "MirrorHousing": "202123",
    "Mirror": "AEB4BA",
    "Screen": "07080A",
}
ROUGHNESS = {"CabinDash": 0.92, "CabinTrim": 0.85, "CabinPillar": 0.95, "Hood": 0.5,
             "MirrorHousing": 0.6, "Mirror": 0.05, "Screen": 0.25}

LODS = {
    "high": dict(stations=34, smooth=2, rim=64, tube=12, hood=(28, 16), roof=(24, 12), round=2, slats=True,
                 budget=40000, file="cabin.glb"),
    "low": dict(stations=12, smooth=1, rim=28, tube=6, hood=(10, 6), roof=(8, 4), round=1, slats=False,
                budget=15000, file="cabin-low.glb"),
}

MATS: dict[str, bpy.types.Material] = {}


def glow(material, point, center):
    if material == "Screen":
        return (0.05, 0.06, 0.07)   # displays faintly lit at night; the app draws their content
    return (0.0, 0.0, 0.0)


# ------------------------------------------------------------------ small geometry helpers
def X(side: int, xo: float) -> float:
    """x of a point `xo` outboard of the car's centre line on `side` (-1 left/driver, +1 right)."""
    return CX + side * xo


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def ws_base_y(xo):
    return WS_BASE_Y - 0.09 * (xo / PILLAR_BASE_XO) ** 2


def ws_top_y(xo):
    return WS_TOP_Y - 0.05 * (xo / PILLAR_TOP_XO) ** 2


def chaikin(points, mats, iterations):
    """Corner-cut a closed polygon; each new edge keeps the material of the edge it came from."""
    for _ in range(iterations):
        pts, ms = [], []
        n = len(points)
        for i in range(n):
            a, c = points[i], points[(i + 1) % n]
            pts += [lerp(a, c, 0.25), lerp(a, c, 0.75)]
            ms += [mats[i], mats[i]]
        points, mats = pts, ms
    return points, mats


def quad(b, a, c, d, e, mat):
    """A quad, split into two triangles when it is not flat (so every viewer triangulates it alike)."""
    n = (c.co - a.co).cross(d.co - a.co)
    if n.length > 1e-12 and abs((e.co - a.co).dot(n.normalized())) > 4e-4:
        b.face((a, c, d), mat)
        b.face((a, d, e), mat)
    else:
        b.face((a, c, d, e), mat)


def loft(b, rings, seg_mats, cap_mat, caps=True):
    """Skin planar rings of equal size; seg_mats[j] colours the strip between ring points j and j+1."""
    vr = [[b.bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    if isinstance(seg_mats, str):
        seg_mats = [seg_mats] * n
    for lo, hi in zip(vr, vr[1:]):
        for j in range(n):
            k = (j + 1) % n
            quad(b, lo[j], lo[k], hi[k], hi[j], seg_mats[j])
    if caps:
        b.face(vr[0][::-1], cap_mat)
        b.face(vr[-1], cap_mat)


def prism(b, outline, origin, s_axis, t_axis, d_axis, d0, d1, mat, scale1=1.0, side_mats=None):
    """Extrude a 2D outline (in the s/t plane through origin) from depth d0 to d1; scale1 shrinks the far cap."""
    r0 = [origin + s_axis * s + t_axis * t + d_axis * d0 for s, t in outline]
    r1 = [origin + (s_axis * s + t_axis * t) * scale1 + d_axis * d1 for s, t in outline]
    loft(b, [r0, r1], side_mats or mat, mat)


def cuboid(b, lo, hi, mat):
    """Axis-aligned box from corner lo to corner hi."""
    prism(b, [(lo.x, lo.y), (hi.x, lo.y), (hi.x, hi.y), (lo.x, hi.y)], Vector((0, 0, 0)),
          Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)), lo.z, hi.z, mat)


def side_slab(b, outline_yz, x0, x1, mat, rounding=0):
    """A y/z outline extruded across x (door panels, seats, pillars seen side-on)."""
    pts = [Vector((0.0, y, z)) for y, z in outline_yz]
    if rounding:
        pts, _ = chaikin(pts, [mat] * len(pts), rounding)
    outline = [(p.y, p.z) for p in pts]
    prism(b, outline, Vector((0, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)), Vector((1, 0, 0)), x0, x1, mat)


def cushion(b, outline_yz, x0, x1, mat, rounding=1, bevel=0.03, steps=None):
    """Like side_slab, but its ends are rounded over too (seats, headrests): extra stations near each end,
    each a shrunken copy of the outline."""
    pts = [Vector((0.0, y, z)) for y, z in outline_yz]
    if rounding:
        pts, _ = chaikin(pts, [mat] * len(pts), rounding)
    c = sum(pts, Vector()) / len(pts)
    span_y = max(p.y for p in pts) - min(p.y for p in pts)
    span_z = max(p.z for p in pts) - min(p.z for p in pts)
    steps = steps or max(1, rounding)
    stations = []
    for i in range(steps + 1):          # quarter-circle profile at each end
        a = math.pi / 2 * i / steps
        inset = bevel * (1 - math.sin(a))
        along = bevel * (1 - math.cos(a))
        stations.append((along, inset))
    xs = [(x0 + al, ins) for al, ins in stations] + [(x1 - al, ins) for al, ins in reversed(stations)]
    rings = []
    for x, ins in xs:
        ky = max(0.2, 1 - 2 * ins / max(span_y, 1e-3))
        kz = max(0.2, 1 - 2 * ins / max(span_z, 1e-3))
        rings.append([Vector((x, c.y + (p.y - c.y) * ky, c.z + (p.z - c.z) * kz)) for p in pts])
    loft(b, rings, mat, mat)


def rrect(w, h, r, seg):
    """Rounded rectangle, counter-clockwise, centred on 0."""
    pts = []
    corners = [(w / 2 - r, -h / 2 + r, -90), (w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90),
               (-w / 2 + r, -h / 2 + r, 180)]
    for cx, cy, a0 in corners:
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def facing_frame(normal, world_up=Vector((0, 0, 1))):
    """(right, up) for a flat face whose front looks along `normal`, upright for a viewer in front of it."""
    n = normal.normalized()
    up = (world_up - n * world_up.dot(n)).normalized()
    right = up.cross(n).normalized()
    return right, up


def sheet(b, fn, nu, nv, thick, mat):
    """A closed slab: the surface fn(u, v) for u, v in 0..1, and a copy `thick` metres below (or above, < 0)."""
    top = [[b.bm.verts.new(fn(i / nu, j / nv)) for j in range(nv + 1)] for i in range(nu + 1)]
    bot = [[b.bm.verts.new(top[i][j].co - Vector((0, 0, thick))) for j in range(nv + 1)] for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv):
            quad(b, top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1], mat)
            quad(b, bot[i][j], bot[i][j + 1], bot[i + 1][j + 1], bot[i + 1][j], mat)
    ring = ([top[i][0] for i in range(nu + 1)] + [top[nu][j] for j in range(1, nv + 1)]
            + [top[i][nv] for i in range(nu - 1, -1, -1)] + [top[0][j] for j in range(nv - 1, 0, -1)])
    ring_b = ([bot[i][0] for i in range(nu + 1)] + [bot[nu][j] for j in range(1, nv + 1)]
              + [bot[i][nv] for i in range(nu - 1, -1, -1)] + [bot[0][j] for j in range(nv - 1, 0, -1)])
    for k in range(len(ring)):
        m = (k + 1) % len(ring)
        b.face((ring[k], ring[m], ring_b[m], ring_b[k]), mat)


# ------------------------------------------------------------------ parts of the static cabin
def dash_profile(x):
    """Closed (y, z) cross-section of the instrument panel at x, and the material of each edge."""
    xo = abs(x - CX)
    yb = ws_base_y(min(xo, PILLAR_BASE_XO))
    # weights: driver zone (in front of the wheel), centre stack, passenger side
    w_drv = 1.0 - smoothstep(0.17, 0.27, x)
    w_ctr = smoothstep(0.17, 0.27, x) * (1.0 - smoothstep(0.50, 0.62, x))
    w_pas = smoothstep(0.50, 0.62, x)
    end = smoothstep(0.62, 0.80, xo)   # the panel rolls down a little toward the doors

    def mix(d, c, p):
        return tuple(w_drv * d[i] + w_ctr * c[i] + w_pas * p[i] for i in range(2))

    pts = [
        (yb + 0.10, 0.93),                                                    # under the glass
        (yb - 0.01, 0.955 - 0.01 * end),                                      # top at the glass
        mix((1.12, 0.972), (1.12, 0.978), (1.14, 0.985)),                     # top pad
        mix((0.98, 0.975), (0.96, 0.99), (1.00, 1.0)),                        # top rear
        mix((0.90, 0.950), (0.90, 0.975), (0.95, 0.985)),                     # roll-over
        mix((0.855, 0.910), (0.875, 0.93), (0.915, 0.945)),                   # upper face (trim band starts)
        mix((0.835, 0.860), (0.855, 0.84), (0.90, 0.875)),                    # trim band ends
        mix((0.855, 0.765), (0.81, 0.70), (0.92, 0.76)),                      # lower face / stack / glovebox
        mix((0.92, 0.630), (0.79, 0.56), (0.99, 0.62)),                       # knee bolster
        mix((1.00, 0.500), (0.80, 0.44), (1.08, 0.52)),                       # bottom rear
        (1.40, 0.48),                                                         # bottom front
    ]
    pts = [Vector((x, y, z - 0.02 * end)) for y, z in pts]
    mats = ["CabinDash", "CabinDash", "CabinDash", "CabinDash", "CabinTrim", "CabinTrim",
            "CabinDash", "CabinDash", "CabinDash", "CabinDash", "CabinDash"]
    return pts, mats


def build_dash(b, lod):
    x0, x1 = CX - TRIM + 0.005, CX + TRIM - 0.005
    n = lod["stations"]
    xs = [lerp(x0, x1, 0.5 - 0.5 * math.cos(math.pi * i / n)) for i in range(n + 1)]  # denser at the ends
    rings, mats = [], None
    for x in xs:
        pts, ms = dash_profile(x)
        pts, ms = chaikin(pts, ms, lod["smooth"])
        rings.append(pts)
        mats = ms
    loft(b, rings, mats, "CabinDash")


def build_cowl_and_hood(b, lod):
    # black cowl panel between the windshield base and the hood's rear edge, outside the (absent) glass
    def cowl(u, v):
        x = lerp(CX - 0.86, CX + 0.86, u)
        xo = abs(x - CX)
        y = lerp(ws_base_y(xo) - 0.02, 1.50, v)
        return Vector((x, y, 0.945 + 0.01 * v - 0.012 * (xo / 0.86) ** 2))
    sheet(b, cowl, max(4, lod["hood"][0] // 2), 2, 0.03, "CabinTrim")

    def hood(u, v):
        y = lerp(1.47, 2.85, v)
        half = lerp(0.90, 0.80, v ** 1.5)
        xs = lerp(-half, half, u)       # signed, from the centre line
        zc = 0.975 - 0.07 * v ** 1.5 - 0.025 * smoothstep(0.88, 1.0, v)
        crown = -0.035 * (xs / 0.85) ** 2
        ridge = 0.016 * math.exp(-((abs(xs) - 0.70) / 0.07) ** 2)   # fender character line
        edge = -0.03 * smoothstep(0.84, 1.0, abs(xs) / half)        # the hood rolls over into the fenders
        return Vector((CX + xs, y, zc + crown + ridge + edge))
    nu, nv = lod["hood"]
    sheet(b, hood, nu, nv, 0.03, "Hood")


def build_pillars(b, lod):
    corners = {}
    for side in (-1, 1):
        bot = Vector((X(side, PILLAR_BASE_XO), ws_base_y(PILLAR_BASE_XO) + 0.01, WS_BASE_Z - 0.005))
        top = Vector((X(side, PILLAR_TOP_XO), ws_top_y(PILLAR_TOP_XO) - 0.01, WS_TOP_Z + 0.01))
        mid = (bot + top) / 2
        axis = (top - bot).normalized()
        view = mid - EYE
        e = (view - axis * view.dot(axis)).normalized()   # depth, along the line of sight
        s = axis.cross(e).normalized()                    # across the line of sight
        w = PILLAR_FACE / 2
        sec = [(-w, -0.02), (w, -0.02), (w * 1.1, 0.06), (-w * 1.1, 0.06)]
        r0 = [bot - axis * 0.06 + s * a + e * d for a, d in sec]
        r1 = [top + axis * 0.04 + s * a + e * d for a, d in sec]
        loft(b, [r0, r1], "CabinPillar", "CabinPillar")
        inward = -side
        corners[side] = (bot + Vector((inward * w, 0, 0)), top + Vector((inward * w, 0, 0)))
        # a small triangular sail panel at the pillar's foot, in front of the door window
        y_front, y_back = bot.y - 0.02, 0.98
        tri = [(y_front, 0.955), (y_back, 0.965), (y_back, 0.985), (bot.y - 0.10, 1.05)]
        xa, xb = X(side, 0.85), X(side, 0.92)
        side_slab(b, tri, min(xa, xb), max(xa, xb), "CabinTrim")
    return corners


def build_header_and_roof(b, lod):
    # header: the trim across the windshield's top edge
    n = max(6, lod["stations"] // 2)
    rings = []
    for i in range(n + 1):
        x = lerp(CX - PILLAR_TOP_XO - 0.02, CX + PILLAR_TOP_XO + 0.02, i / n)
        xo = min(abs(x - CX), PILLAR_TOP_XO)
        yh = ws_top_y(xo)
        sec = [(yh + 0.04, 1.47), (yh + 0.03, 1.425), (yh - 0.03, 1.412), (yh - 0.13, 1.45), (yh - 0.15, 1.52)]
        rings.append([Vector((x, y, z)) for y, z in sec])
    loft(b, rings, "CabinPillar", "CabinPillar")

    # roof lining (its underside is what the driver sees) and the roof skin above it
    nu, nv = lod["roof"]

    def lining(u, v):
        x = lerp(CX - 0.80, CX + 0.80, u)
        y = lerp(-2.10, ws_top_y(0) - 0.10, v)
        xs = (x - CX) / 0.80
        return Vector((x, y, 1.535 - 0.035 * xs ** 2 - 0.02 * smoothstep(0.85, 1.0, 1 - v)))
    sheet(b, lining, nu, nv, -0.11, "CabinPillar")

    # roof rails above the side windows, both sides
    for side in (-1, 1):
        ys = [ws_top_y(PILLAR_TOP_XO) + 0.02, 0.0, -0.36, -1.0, -1.6, -2.12]
        rings = []
        for y in ys:
            zb = 1.445 - 0.012 * max(0.0, -y - 0.4)   # the roofline sinks a little toward the rear
            xi, xo_ = X(side, 0.77), X(side, 0.86)
            sec = [(xi, zb + 0.02), (xo_, zb), (xo_, 1.60), (xi, 1.56)]
            rings.append([Vector((xx, y, zz)) for xx, zz in sec])
        loft(b, rings[::-1] if side > 0 else rings, "CabinPillar", "CabinPillar")
        # sun visors folded up under the lining
        vx0, vx1 = (X(side, 0.77), X(side, 0.40)) if side < 0 else (X(side, 0.40), X(side, 0.77))
        cuboid(b, Vector((min(vx0, vx1), 0.44, 1.475)), Vector((max(vx0, vx1), 0.62, 1.505)), "CabinPillar")
        # grab handle above the passenger doors
        if side > 0:
            for y0 in (-0.05, -1.05):
                cuboid(b, Vector((X(side, 0.76), y0 - 0.12, 1.43)), Vector((X(side, 0.74), y0 + 0.12, 1.455)),
                       "CabinTrim")
    # overhead console with the map lights, behind the interior mirror
    cuboid(b, Vector((CX - 0.13, 0.42, 1.485)), Vector((CX + 0.13, 0.64, 1.53)), "CabinTrim")
    # rear header across the top of the rear window
    cuboid(b, Vector((CX - 0.80, -2.18, 1.44)), Vector((CX + 0.80, -2.04, 1.56)), "CabinPillar")


def build_pillars_rear(b, lod):
    for side in (-1, 1):
        def ring(z, xin, xout, y0, y1):
            xa, xb = X(side, xin), X(side, xout)
            return [Vector((xa, y0, z)), Vector((xb, y0, z)), Vector((xb, y1, z)), Vector((xa, y1, z))]
        # B-pillar
        loft(b, [ring(FLOOR_Z, 0.78, 0.93, -0.30, -0.43), ring(0.99, 0.78, 0.91, -0.30, -0.43),
                 ring(1.47, 0.76, 0.84, -0.31, -0.41)], "CabinPillar", "CabinPillar")
        # C-pillar between the rear door window and the quarter window
        loft(b, [ring(0.98, 0.78, 0.92, -1.30, -1.37), ring(1.45, 0.76, 0.84, -1.31, -1.36)],
             "CabinPillar", "CabinPillar")
        # D-pillar: wide, sloping forward toward the roof
        loft(b, [ring(0.98, 0.77, 0.92, -1.86, -2.16), ring(1.43, 0.75, 0.84, -1.94, -2.16)],
             "CabinPillar", "CabinPillar")


def build_doors(b, lod):
    r = lod["round"]
    for side in (-1, 1):
        x_in, x_out = X(side, TRIM), X(side, HALF_W)
        lo_x, hi_x = min(x_in, x_out), max(x_in, x_out)
        # front door (with the sill forward to the pillar's foot), rear door, quarter panel
        panels = [
            [(1.30, FLOOR_Z), (-0.36, FLOOR_Z), (-0.36, 0.99), (0.6, 0.982), (1.30, 0.975)],
            [(-0.37, FLOOR_Z), (-1.30, FLOOR_Z), (-1.30, 1.005), (-0.37, 0.99)],
            [(-1.31, 0.60), (-2.16, 0.60), (-2.16, 1.03), (-1.31, 1.008)],
        ]
        for outline in panels:
            side_slab(b, outline, lo_x, hi_x, "CabinTrim")
        # upper trim pads along the window sills: a softer, darker roll toward the cabin
        for (y0, y1, z0, z1) in ((1.10, -0.35, 0.985, 0.975), (-0.38, -1.29, 0.995, 0.99)):
            xa, xb = X(side, TRIM - 0.035), X(side, TRIM + 0.02)
            side_slab(b, [(y0, 0.86), (y1, 0.86), (y1, z1 + 0.02), (y0, z0 + 0.02)], min(xa, xb), max(xa, xb),
                      "CabinDash", rounding=r)
        # armrests and door pulls
        for (y0, y1, z) in ((0.48, -0.20, 0.66), (-0.55, -1.15, 0.67)):
            xa, xb = X(side, TRIM - 0.075), X(side, TRIM + 0.01)
            side_slab(b, [(y0, z), (y1, z), (y1, z + 0.06), (y0, z + 0.07)], min(xa, xb), max(xa, xb),
                      "CabinDash", rounding=r)
        # speaker grille, low on the front door
        xa, xb = X(side, TRIM - 0.012), X(side, TRIM + 0.01)
        side_slab(b, [(0.60, 0.46), (0.30, 0.46), (0.30, 0.58), (0.60, 0.58)], min(xa, xb), max(xa, xb),
                  "CabinDash", rounding=r)


def build_floor_and_cargo(b, lod):
    cuboid(b, Vector((CX - TRIM, -2.16, FLOOR_Z - 0.04)), Vector((CX + TRIM, 1.40, FLOOR_Z)), "CabinDash")
    # cargo floor, cargo cover, tailgate inner panel
    cuboid(b, Vector((CX - TRIM, -2.10, 0.60)), Vector((CX + TRIM, -1.15, 0.66)), "CabinDash")
    cuboid(b, Vector((CX - TRIM + 0.02, -2.06, 1.0)), Vector((CX + TRIM - 0.02, -1.20, 1.02)), "CabinTrim")
    cuboid(b, Vector((CX - TRIM, -2.20, 0.55)), Vector((CX + TRIM, -2.08, 1.04)), "CabinTrim")
    # firewall / footwell front so the floor meets the dash
    cuboid(b, Vector((CX - TRIM, 1.0, FLOOR_Z)), Vector((CX + TRIM, 1.42, 0.52)), "CabinDash")


def build_console_and_screen_housing(b, lod):
    r = lod["round"]
    # centre console between the seats, running into the stack
    side_slab(b, [(0.84, 0.46), (-0.30, 0.46), (-0.30, 0.70), (0.10, 0.71), (0.55, 0.66), (0.80, 0.70)],
              CX - 0.13, CX + 0.13, "CabinTrim", rounding=r)
    side_slab(b, [(0.10, 0.705), (-0.28, 0.705), (-0.28, 0.745), (0.10, 0.74)], CX - 0.12, CX + 0.12,
              "CabinDash", rounding=r)   # armrest lid
    cuboid(b, Vector((CX - 0.035, 0.30, 0.66)), Vector((CX + 0.035, 0.40, 0.74)), "CabinDash")  # selector
    # the centre screen's housing and its stalk into the dash
    n = (EYE - SCREEN_C).normalized()
    n = (n * 0.6 + Vector((0, -0.985, 0.17)) * 0.4).normalized()
    right, up = facing_frame(n)
    outline = rrect(SCREEN_W + 0.02, SCREEN_H + 0.02, 0.012, 2 * r)
    prism(b, outline, SCREEN_C, right, up, n, -0.003, -0.022, "CabinDash")
    cuboid(b, Vector((CX - 0.06, 0.88, 0.90)), Vector((CX + 0.06, 0.96, 0.96)), "CabinDash")
    # vents: dark recesses on the trim band, with slats on the high build
    vents = [(-0.38, -0.25, 0.86, 0.90), (0.93, 1.09, 0.88, 0.92)]
    vents += [(CX - 0.15, CX - 0.05, 0.765, 0.80), (CX + 0.05, CX + 0.15, 0.765, 0.80)]
    for x0, x1, z0, z1 in vents:
        drop = 0.02 * smoothstep(0.62, 0.80, abs((x0 + x1) / 2 - CX))   # follow the panel's roll-down at the ends
        z0, z1 = z0 - drop, z1 - drop
        y = dash_face_y(x0, x1, (z0 + z1) / 2, lod["smooth"])
        cuboid(b, Vector((x0, y - 0.03, z0)), Vector((x1, y + 0.002, z1)), "MirrorHousing")
        if lod["slats"]:
            for k in range(1, 4):
                zz = lerp(z0, z1, k / 4)
                cuboid(b, Vector((x0 + 0.004, y - 0.02, zz - 0.002)), Vector((x1 - 0.004, y + 0.006, zz + 0.002)),
                       "CabinTrim")
    return n


def dash_face_y(x0, x1, z, smooth):
    """y of the dashboard's driver-facing surface at height z, averaged over x0..x1 (smoothed profile)."""
    ys = []
    for x in (x0, (x0 + x1) / 2, x1):
        pts, ms = dash_profile(x)
        pts, _ = chaikin(pts, ms, smooth)
        face = [p for p in pts if p.y < 1.05 and p.z > 0.55]
        face.sort(key=lambda p: -p.z)
        for a, c in zip(face, face[1:]):
            if min(a.z, c.z) <= z <= max(a.z, c.z) and abs(a.z - c.z) > 1e-6:
                t = (z - a.z) / (c.z - a.z)
                ys.append(lerp(a.y, c.y, t))
                break
    return sum(ys) / len(ys)


def build_instrument_pod(b, lod):
    n = (EYE - INSTR_C).normalized()
    right, up = facing_frame(n)
    sec = [(-0.004, -0.058), (-0.004, 0.053), (0.022, 0.056), (0.03, 0.07), (-0.10, 0.075), (-0.11, -0.07)]
    pts = [Vector((d, v, 0)) for d, v in sec]
    pts, _ = chaikin(pts, ["x"] * len(pts), max(0, lod["round"] - 1))
    rings = []
    k = max(4, lod["stations"] // 4)
    half = INSTR_W / 2 + 0.018
    stations = [-half] + [lerp(-INSTR_W / 2, INSTR_W / 2, i / k) for i in range(k + 1)] + [half]
    for s in stations:
        drop = 0.012 * smoothstep(INSTR_W / 2, half, abs(s))   # the visor's ends turn down, clear of the display
        rings.append([INSTR_C + right * s + n * p.x + up * (p.y - drop) for p in pts])
    loft(b, rings, "CabinDash", "CabinDash")
    return n


def build_column(b, axis):
    right = Vector((1, 0, 0))
    upw = axis.cross(right).normalized()
    outline = [(-0.05, -0.06), (0.05, -0.06), (0.045, 0.05), (-0.045, 0.05)]
    prism(b, outline, WHEEL_C, right, upw, axis, -0.07, -0.42, "CabinDash")
    # stalks behind the wheel, left and right
    for sgn in (-1, 1):
        a = WHEEL_C - axis * 0.10 + right * (sgn * 0.05)
        prism(b, [(0, -0.008), (sgn * 0.11, -0.012), (sgn * 0.11, 0.0), (0, 0.008)], a, right, upw, axis,
              -0.006, 0.006, "CabinDash")


def build_seats(b, lod):
    r = lod["round"]

    def front_seat(xc):
        cushion(b, [(0.35, 0.50), (-0.22, 0.50), (-0.26, 0.64), (0.35, 0.62)], xc - 0.25, xc + 0.25,
                  "CabinTrim", rounding=r)                                       # cushion
        cushion(b, [(-0.14, 0.60), (-0.29, 0.60), (-0.43, 1.12), (-0.31, 1.13)], xc - 0.25, xc + 0.25,
                  "CabinTrim", rounding=r)                                       # back
        cushion(b, [(-0.33, 1.15), (-0.43, 1.15), (-0.45, 1.36), (-0.36, 1.37)], xc - 0.12, xc + 0.12,
                  "CabinTrim", rounding=r, bevel=0.035)                          # headrest
        for sgn in (-1, 1):                                                      # headrest posts
            cuboid(b, Vector((xc + sgn * 0.07 - 0.006, -0.40, 1.10)), Vector((xc + sgn * 0.07 + 0.006, -0.388, 1.16)),
                   "CabinDash")
    front_seat(0.0)
    front_seat(2 * CX)
    # rear bench, its back and three headrests
    cushion(b, [(-0.40, 0.48), (-0.95, 0.48), (-0.98, 0.62), (-0.40, 0.60)], CX - 0.72, CX + 0.72,
              "CabinTrim", rounding=r)
    cushion(b, [(-0.96, 0.58), (-1.10, 0.58), (-1.17, 1.08), (-1.04, 1.09)], CX - 0.74, CX + 0.74,
              "CabinTrim", rounding=r)
    for xc in (0.0, CX, 2 * CX):
        cushion(b, [(-1.07, 1.10), (-1.16, 1.10), (-1.18, 1.27), (-1.09, 1.28)], xc - 0.12, xc + 0.12,
                  "CabinTrim", rounding=r)


def mirror_housing(b, center, normal, w, h, depth, arm_to=None, r=2):
    right, up = facing_frame(normal)
    outer = rrect(w + 0.03, h + 0.03, min(0.04, h / 2), 2 * r)
    inner = rrect(w + 0.004, h + 0.004, min(0.03, h / 2 - 0.01), 2 * r)
    n = len(outer)
    # a cup: outer wall, back, rim, inner wall, and the recess floor just behind the glass
    o_front = [b.bm.verts.new(center + right * s + up * t + normal * 0.012) for s, t in outer]
    o_back = [b.bm.verts.new(center + (right * s + up * t) * 0.82 - normal * depth) for s, t in outer]
    i_front = [b.bm.verts.new(center + right * s + up * t + normal * 0.012) for s, t in inner]
    i_floor = [b.bm.verts.new(center + right * s + up * t - normal * 0.004) for s, t in inner]
    for j in range(n):
        k = (j + 1) % n
        quad(b, o_front[j], o_back[j], o_back[k], o_front[k], "MirrorHousing")
        quad(b, o_front[j], o_front[k], i_front[k], i_front[j], "MirrorHousing")
        quad(b, i_front[j], i_front[k], i_floor[k], i_floor[j], "MirrorHousing")
    b.face(o_back[::-1], "MirrorHousing")
    b.face(i_floor, "MirrorHousing")
    if arm_to is not None:
        a0 = center - normal * depth * 0.6
        axis = (arm_to - a0)
        length = axis.length
        axis.normalize()
        s = axis.cross(Vector((0, 0, 1))).normalized()
        t = s.cross(axis).normalized()
        prism(b, [(-0.03, -0.02), (0.03, -0.02), (0.025, 0.02), (-0.025, 0.02)], a0, s, t, axis, 0.0, length,
              "MirrorHousing")


# ------------------------------------------------------------------ flat faces (mirrors, displays)
def flat_face(name, center, normal, w, h, material, outline=None):
    """A flat polygon facing `normal`, with UVs 0..1 (u to the viewer's right, v up), as its own object."""
    right, up = facing_frame(normal)
    outline = outline or [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]
    b = kit.Builder(COLORS, glow, ROUGHNESS)
    verts = [b.bm.verts.new(center + right * s + up * t) for s, t in outline]
    b.face(verts, material)
    obj = finish(b, name, recalc=False, smooth=False)
    uv = obj.data.uv_layers.new(name="UVMap")
    for loop in obj.data.loops:
        p = obj.data.vertices[loop.vertex_index].co - center
        uv.data[loop.index].uv = (p.dot(right) / w + 0.5, p.dot(up) / h + 0.5)
    face_n = obj.data.polygons[0].normal
    if face_n.dot(normal) < 0.999:
        raise RuntimeError(f"{name}: face normal {tuple(face_n)} does not match {tuple(normal)}")
    return obj, right, up


def mirror_normal(center, toward):
    """Normal of a flat mirror at `center` that shows the eye the direction `toward`."""
    to_eye = (EYE - center).normalized()
    return (to_eye + toward.normalized()).normalized()


# ------------------------------------------------------------------ assembly
def finish(b, name, recalc=True, smooth=True, origin=None):
    if recalc:
        bmesh.ops.recalc_face_normals(b.bm, faces=b.bm.faces[:])
    names = list(b.colors)
    used = sorted({f.material_index for f in b.bm.faces})
    remap = {old: i for i, old in enumerate(used)}
    for f in b.bm.faces:
        f.material_index = remap[f.material_index]
    if origin is not None:
        for v in b.bm.verts:
            v.co -= origin
    mesh = bpy.data.meshes.new(name)
    b.bm.to_mesh(mesh)
    b.bm.free()
    for old in used:
        mesh.materials.append(MATS[names[old]])
    if smooth:
        for p in mesh.polygons:
            p.use_smooth = True
        mesh.set_sharp_from_angle(angle=math.radians(40))
    obj = bpy.data.objects.new(name, mesh)
    if origin is not None:
        obj.location = origin
    bpy.context.scene.collection.objects.link(obj)
    return obj


def make_materials():
    MATS.clear()
    for name, hex_color in COLORS.items():
        MATS[name] = kit.make_material(name, hex_color, ROUGHNESS[name])
    shader = next(n for n in MATS["Mirror"].node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Metallic"].default_value = 1.0


def build(lod_name):
    lod = LODS[lod_name]
    kit.reset_scene()
    make_materials()
    info = {}

    axis = Vector((0, -math.cos(math.radians(COLUMN_DEG)), math.sin(math.radians(COLUMN_DEG))))  # toward driver

    # -- static cabin
    b = kit.Builder(COLORS, glow, ROUGHNESS)
    build_dash(b, lod)
    build_cowl_and_hood(b, lod)
    corners = build_pillars(b, lod)
    build_header_and_roof(b, lod)
    build_pillars_rear(b, lod)
    build_doors(b, lod)
    build_floor_and_cargo(b, lod)
    screen_n = build_console_and_screen_housing(b, lod)
    instr_n = build_instrument_pod(b, lod)
    build_column(b, axis)
    build_seats(b, lod)

    # mirrors: centres and normals
    mirrors = {}
    for key, side, toward in (("left", -1, Vector((-0.10, -1, -0.01))), ("right", 1, Vector((0.16, -1, -0.01)))):
        c = Vector((X(side, MIRROR_XO), MIRROR_Y, MIRROR_Z))
        n = mirror_normal(c, toward)
        mirrors[key] = (c, n, MIRROR_W, MIRROR_H)
        arm_end = Vector((X(side, 0.90), 0.93, 0.995))
        mirror_housing(b, c, n, MIRROR_W, MIRROR_H, 0.10, arm_to=arm_end, r=lod["round"])
    rear_target = Vector((CX, -2.1, 1.25)) - INNER_MIRROR_C
    n_in = mirror_normal(INNER_MIRROR_C, Vector((0, rear_target.y, rear_target.z * 0.3)))
    mirrors["center"] = (INNER_MIRROR_C, n_in, INNER_MIRROR_W, INNER_MIRROR_H)
    mirror_housing(b, INNER_MIRROR_C, n_in, INNER_MIRROR_W, INNER_MIRROR_H, 0.04,
                   arm_to=Vector((CX, ws_top_y(0) - 0.02, 1.44)), r=lod["round"])
    cabin = finish(b, "Cabin")

    # -- steering wheel, its own node with its origin at the pivot
    wb = kit.Builder(COLORS, glow, ROUGHNESS)
    right = Vector((1, 0, 0))
    upw = axis.cross(right).normalized()
    nu, nv = lod["rim"], lod["tube"]
    rings = []
    for i in range(nu):
        a = 2 * math.pi * i / nu
        radial = right * math.cos(a) + upw * math.sin(a)
        c = WHEEL_C + radial * WHEEL_R
        rings.append([wb.bm.verts.new(c + radial * (0.016 * math.cos(2 * math.pi * j / nv))
                                      + axis * (0.019 * math.sin(2 * math.pi * j / nv))) for j in range(nv)])
    for i in range(nu):
        for j in range(nv):
            i2, j2 = (i + 1) % nu, (j + 1) % nv
            wb.face((rings[i][j], rings[i2][j], rings[i2][j2], rings[i][j2]), "CabinDash")
    hub_c = WHEEL_C - axis * 0.03
    prism(wb, rrect(0.14, 0.11, 0.035, 2 * lod["round"]), hub_c, right, upw, axis, -0.035, 0.012, "CabinDash")
    for ang, width in ((0, 0.05), (180, 0.05), (270, 0.06)):
        a = math.radians(ang)
        radial = right * math.cos(a) + upw * math.sin(a)
        across = axis.cross(radial).normalized()
        r_in, r_out = 0.06, WHEEL_R - 0.008
        sec = [(-width / 2, -0.012), (width / 2, -0.012), (width / 2, 0.008), (-width / 2, 0.008)]
        inner = [hub_c + radial * r_in + across * s + axis * d for s, d in sec]
        outer = [WHEEL_C + radial * r_out + across * (s * 0.7) + axis * d for s, d in sec]
        loft(wb, [inner, outer], "CabinDash", "CabinDash")
    wheel = finish(wb, "Wheel", origin=WHEEL_C.copy())

    # -- flat faces
    mobjs = {}
    for key, node in (("left", "MirrorLeft"), ("right", "MirrorRight"), ("center", "MirrorCenter")):
        c, n, w, h = mirrors[key]
        outline = rrect(w, h, min(0.028, h / 2 - 0.005), 3 if lod_name == "high" else 1)
        obj, r_, u_ = flat_face(node, c, n, w, h, "Mirror", outline)
        mobjs[key] = (node, c, n, r_, u_, w, h)
    instr, ir, iu = flat_face("Instruments", INSTR_C, instr_n, INSTR_W, INSTR_H, "Screen")
    screen, sr, su = flat_face("CenterScreen", SCREEN_C, screen_n, SCREEN_W, SCREEN_H, "Screen")

    info.update(axis=axis, mirrors=mobjs, instruments=(INSTR_C, instr_n, ir, iu, INSTR_W, INSTR_H),
                screen=(SCREEN_C, screen_n, sr, su, SCREEN_W, SCREEN_H), windshield=corners)
    return info


# ------------------------------------------------------------------ checks from the eye
def ray_first(origin, target):
    """Name of the first object hit on the way from origin to target, or None when the way is clear."""
    deps = bpy.context.evaluated_depsgraph_get()
    d = target - origin
    hit, _, _, _, obj, _ = bpy.context.scene.ray_cast(deps, origin, d.normalized(), distance=d.length - 1e-4)
    return obj.name if hit else None


def ray_dir(origin, direction, dist=50.0):
    deps = bpy.context.evaluated_depsgraph_get()
    hit, loc, _, _, obj, _ = bpy.context.scene.ray_cast(deps, origin, direction.normalized(), distance=dist)
    return (obj.name, loc) if hit else (None, None)


def view_checks(info):
    out, problems = {}, []
    bpy.context.view_layer.update()

    def scan(sign):
        yaw = 0.0
        while yaw < 120:
            a = math.radians(yaw) * sign
            name, _ = ray_dir(EYE, Vector((-math.sin(a), math.cos(a), 0)))
            if name:
                return yaw
            yaw += 0.1
        return None
    left, right = scan(1), scan(-1)
    out["pillarYawLeftDeg"], out["pillarYawRightDeg"] = round(left, 1), round(right, 1)
    out["forwardViewDeg"] = round(left + right, 1)
    if left + right < 60:
        problems.append(f"forward view between the pillars is {left + right:.1f} deg (< 60)")
    # the nearest visible road straight ahead in the driver's lane
    near = None
    for d10 in range(30, 400):
        d = d10 / 10
        if all(ray_first(EYE, Vector((x, d, 0.0))) is None for x in (-0.6, 0.0, 0.6)):
            near = d
            break
    out["roadVisibleFromM"] = near
    lane_ok = all(ray_first(EYE, Vector((x, 12.0, 0.0))) is None for x in (-1.0, -0.5, 0.0, 0.5, 1.0))
    out["roadAt12mVisible"] = lane_ok
    if not lane_ok:
        problems.append("the road 12 m ahead is hidden in the driver's lane")
    for key, (node, c, n, r_, u_, w, h) in info["mirrors"].items():
        pts = [c + r_ * (w * s) + u_ * (h * t) for s in (-0.4, 0, 0.4) for t in (-0.35, 0, 0.35)]
        seen = sum(1 for p in pts if ray_first(EYE, p + n * 0.002) is None)
        yaw = math.degrees(math.atan2(-(c.x - EYE.x), c.y - EYE.y))
        pitch = math.degrees(math.atan2(c.z - EYE.z, math.hypot(c.x - EYE.x, c.y - EYE.y)))
        out[f"mirror_{key}"] = {"yawDeg": round(yaw, 1), "pitchDeg": round(pitch, 1), "visibleSamples": f"{seen}/9"}
        if seen < 9:
            problems.append(f"{node}: only {seen}/9 sample points visible from the eye")
    for key in ("instruments", "screen"):
        c, n, r_, u_, w, h = info[key]
        pts = [c + r_ * (w * s) + u_ * (h * t) for s in (-0.4, -0.2, 0, 0.2, 0.4) for t in (-0.35, 0, 0.35)]
        seen = sum(1 for p in pts if ray_first(EYE, p + n * 0.002) is None)
        out[f"{key}VisibleSamples"] = f"{seen}/15"
        if seen < 12:
            problems.append(f"{key}: only {seen}/15 sample points visible from the eye")
    return out, problems


# ------------------------------------------------------------------ export
def g(v):
    """Blender (x right, y forward, z up) -> glTF (x right, y up, -z forward), rounded to the millimetre."""
    return [round(v.x, 4) + 0.0, round(v.z, 4) + 0.0, round(-v.y, 4) + 0.0]   # + 0.0: no "-0.0" in the JSON


def export_glb(path):
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=True, export_attributes=True, export_vertex_color="NONE",
                              export_all_vertex_colors=False, export_active_vertex_color_when_no_material=False,
                              export_texcoords=True, export_normals=True, export_materials="EXPORT",
                              export_cameras=False, export_lights=False)


def face_json(node, c, n, r_, u_, w, h, extra=None):
    d = {"node": node, "center": g(c), "normal": g(n), "right": g(r_), "up": g(u_),
         "width": w, "height": h,
         "corners": {"bottomLeft": g(c - r_ * w / 2 - u_ * h / 2), "bottomRight": g(c + r_ * w / 2 - u_ * h / 2),
                     "topRight": g(c + r_ * w / 2 + u_ * h / 2), "topLeft": g(c - r_ * w / 2 + u_ * h / 2)}}
    d.update(extra or {})
    return d


def inside_out_islands(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    seen, bad = set(), 0
    for start in bm.faces:
        if start.index in seen:
            continue
        stack, faces = [start], []
        seen.add(start.index)
        while stack:
            f = stack.pop()
            faces.append(f)
            for e in f.edges:
                for o in e.link_faces:
                    if o.index not in seen:
                        seen.add(o.index)
                        stack.append(o)
        if any(len(e.link_faces) != 2 for f in faces for e in f.edges):
            continue
        vol = 0.0
        for f in faces:
            co = [l.vert.co for l in f.loops]
            for i in range(1, len(co) - 1):
                vol += co[0].dot(co[i].cross(co[i + 1])) / 6
        bad += vol <= 0
    bm.free()
    return bad


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser(prog="build_cabin.py")
    ap.add_argument("--glb-dir", default=os.path.join(REPO, "public", "models", "drive"))
    ap.add_argument("--out", default=HERE, help="folder for the .blend and the report")
    args = ap.parse_args(argv)
    os.makedirs(args.glb_dir, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)
    reports, errors, tris = {}, [], {}
    meta = None
    for lod_name in ("low", "high"):   # high last, so the saved .blend and the view checks are the high build
        info = build(lod_name)
        total = 0
        for obj in [o for o in bpy.context.scene.objects if o.type == "MESH"]:
            rep = kit.check_mesh(obj)
            # the kit rounds island volumes to 0.001 m^3 (sized for buildings), so a car's small closed parts
            # (vent slats, headrest posts) read as zero and get reported inside out: recount them exactly
            exact = inside_out_islands(obj)
            rep["errors"] = [e for e in rep["errors"] if "inside out" not in e]
            rep["inside_out_islands"] = exact
            if exact:
                rep["errors"].append(f"{exact} closed islands are inside out (negative volume)")
            rep["warnings"] = [w for w in rep["warnings"] if "will float" not in w]   # placed by the app
            # the flat mirror and display faces are deliberately single-sided: an open quad is expected there
            if obj.name != "Cabin" and obj.name != "Wheel":
                rep["warnings"] = [w for w in rep["warnings"] if "non-manifold" not in w]
            elif rep["open_islands"]:
                rep["errors"].append(f"{rep['open_islands']} open islands in a part that should be closed")
            reports[f"{lod_name}/{obj.name}"] = rep
            errors += [f"{lod_name}/{obj.name}: {e}" for e in rep["errors"]]
            total += rep["tris"]
        tris[lod_name] = total
        if total > LODS[lod_name]["budget"]:
            errors.append(f"{lod_name}: {total} triangles is over the budget of {LODS[lod_name]['budget']}")
        if lod_name == "high":
            view, problems = view_checks(info)
            errors += problems
            meta = (info, view)
        export_glb(os.path.join(args.glb_dir, LODS[lod_name]["file"]))
        print(f"[cabin] {lod_name}: {total} triangles -> {LODS[lod_name]['file']}")
    if bpy.app.background:
        bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.out, "cabin.blend"))

    info, view = meta
    m = info["mirrors"]
    wl, wr = info["windshield"][-1], info["windshield"][1]
    doc = {
        "version": 1,
        "units": "metres",
        "axes": "glTF: +X right, +Y up, -Z forward (the car faces -Z); origin on the road surface under the "
                "driver's eye. Place the model with the camera rig's body frame directly.",
        "files": {"high": "cabin.glb", "low": "cabin-low.glb"},
        "triangles": tris,
        "eye": g(EYE),
        "neckPivot": g(EYE - Vector((0, NECK_BACK, 0))),
        "carCenterX": CX,
        "body": {"width": 2 * HALF_W, "roofTop": ROOF_TOP, "front": g(Vector((CX, 2.95, 0)))[2],
                 "rear": g(Vector((CX, -2.20, 0)))[2], "note": "front/rear are glTF z of the modelled extent"},
        "mirrors": {
            "left": face_json(*m["left"], extra={"kind": "flat"}),
            "right": face_json(*m["right"], extra={"kind": "convex", "radiusM": 1.4}),
            "center": face_json(*m["center"], extra={"kind": "flat", "minFovDeg": 20}),
        },
        "mirrorsNote": "Each mirror face's UVs run 0..1 with u to the driver's right and v up as seen from the "
                       "eye; a reflection rendered from the mirrored eye must be flipped in u.",
        "instruments": face_json("Instruments", *info["instruments"]),
        "centerScreen": face_json("CenterScreen", *info["screen"]),
        "displaysNote": "UVs 0..1, u to the right and v up as the driver reads them.",
        "wheel": {"node": "Wheel", "pivot": g(WHEEL_C), "axis": g(info["axis"]), "rimRadius": WHEEL_R,
                  "note": "The Wheel node's origin is the pivot and its rotation is identity; axis points from the "
                          "wheel toward the driver, so a positive angle about it turns the wheel anticlockwise "
                          "as the driver sees it (a left turn)."},
        "windshield": {
            "corners": {"bottomLeft": g(wl[0]), "bottomRight": g(wr[0]), "topRight": g(wr[1]), "topLeft": g(wl[1])},
            "note": "The opening between the A-pillars' inner edges, the cowl and the header, on the glass line. "
                    "No glass is modelled.",
        },
        "view": view,
        "materials": list(COLORS),
    }
    with open(os.path.join(args.glb_dir, "cabin.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")
    with open(os.path.join(args.out, "cabin.report.json"), "w", encoding="utf-8") as fh:
        json.dump({"triangles": tris, "view": view, "errors": errors, "nodes": reports}, fh, indent=2)
    print("[cabin] view:", json.dumps(view))
    for name, rep in reports.items():
        for w in rep["warnings"]:
            print(f"[cabin] warning {name}: {w}")
    for e in errors:
        print(f"[cabin] ERROR {e}")
    if errors:
        raise RuntimeError("cabin checks failed: " + "; ".join(errors))


if __name__ == "__main__":
    main()
