"""The window-seat airframe (plan 03, task F3.3): a generic 737-800-class narrow-body in a plain livery.

    python .claude/skills/blender-landmark-model/scripts/run_blender.py models/aircraft/build_airframe.py \
        -- --out public/models/aircraft [--blend /path/outside/the/repo/airframe.blend]

Writes <out>/airframe.glb, <out>/rig.json and, beside this script, airframe.report.json (the kit's mesh check
per node). Every dimension comes from spec.py (sources in research/dimensions.md); the shapes that no source
gives (aerofoil, fillets, fairings, flap and slat motion, gear retraction) are marked ESTIMATED there.

Nodes (glTF: +Y up, nose -Z, right wing +X, origin on the centre line at the main-gear tyre contact plane; every
rest rotation identity, every translation = the part's pivot relative to its parent):

  Airframe                     root
    Body                       fuselage, fin and rudder, tailplane and elevators, cockpit and cabin windows
    NoseGear                   strut and two wheels; pivot on the retraction trunnion
    MainGear_L/_R              leg and two wheels; pivot on the trunnion
    Wing_L/_R                  fixed wing, winglet, flap-track fairings; pivot at the root leading edge
      Engine_L/_R              nacelle (fan cowl, cascades, core, plug) and pylon
        ReverserSleeve_L/_R    translating sleeve; pivot at its front on the nacelle axis
      Slat1.._4_L/_R           pivot on the slat's trailing edge
      Krueger1.._2_L/_R        pivot on the hinge at the front of the stowed panel
      FlapInboard_L/_R, FlapOutboard_L/_R            main flaps; pivot on the leading edge (track carriage)
        FlapInboardAft_L/_R, FlapOutboardAft_L/_R    aft flaps; pivot on their leading edge
      Spoiler1.._6_L/_R        pivot on the hinge at the panel's leading edge
      Aileron_L/_R             pivot on the hinge at its nose
  ShadowProxy                  under 2,000 triangles, for the shadow pass only (no light attributes worth using)

rig.json: for each moving node, its parent, pivot and unit hinge axis (glTF axes, in the parent's frame, which
has no rotation), and per channel a table of rows {at, t, r}: at a channel value `at` the node is translated by
`t` (metres) and turned by `r` degrees about `axis` through the pivot; between rows the app interpolates. Axes
are oriented so a positive angle is the natural deflection on both sides: flaps, aileron and Krueger trailing
edge down, spoilers up, slats nose down, gear retracting. Spoilers carry two tables (`speedbrake`,
`groundSpoiler`); the app uses the larger angle. See the `channels` block of rig.json for each channel's range.

No logo, lettering, registration or airline colours: white and light grey paint, bare metal leading edges and
inlet lip, dark tyres and windows.
"""
from __future__ import annotations

import json
import math
import os
import sys

import bpy
from mathutils import Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import aircraft_kit as ak  # noqa: E402
import spec as S  # noqa: E402

F = float
MAIN = F(S.STATIONS["main_gear"])
DEG = math.radians

COLORS = {
    "Paint": "EEF0F1",        # white fuselage, fin, nacelles
    "PaintGrey": "C3C8CD",    # light grey wings and tailplane
    "BareMetal": "AEB3B8",    # leading edges, inlet lip, slats
    "Walk": "B7BCC1",         # wing root fairing grey
    "Window": "1A1F26",
    "Windscreen": "14181D",
    "Fan": "2B2E33",
    "Exhaust": "45474B",
    "Cascade": "2E3034",
    "Tyre": "1D1D1F",
    "Hub": "8B9095",
    "Strut": "A9AEB3",
}
ROUGH = {"Paint": 0.35, "PaintGrey": 0.45, "BareMetal": 0.3, "Walk": 0.5, "Window": 0.15, "Windscreen": 0.1,
         "Fan": 0.5, "Exhaust": 0.6, "Cascade": 0.7, "Tyre": 0.85, "Hub": 0.4, "Strut": 0.35}
METAL = {"BareMetal": 0.85, "Hub": 0.6, "Strut": 0.7, "Exhaust": 0.5}


def builder(smooth_deg=38.0):
    return ak.PartBuilder(COLORS, roughness=ROUGH, metallic=METAL, smooth_deg=smooth_deg)


def P(x, y, z):
    """Spec frame (station aft of the nose, buttock line, body height) to the Blender model frame."""
    return (y, MAIN - x, z)


# ============================================================================================= sections
def naca(s, t, camber=0.018, p=0.45):
    """Upper and lower surface heights (fractions of chord) of a cambered 4-digit-style section at s."""
    s = min(max(s, 0.0), 1.0)
    yt = 5 * t * (0.2969 * math.sqrt(s) - 0.1260 * s - 0.3516 * s ** 2 + 0.2843 * s ** 3 - 0.1036 * s ** 4)
    yc = camber / p ** 2 * (2 * p * s - s * s) if s < p else camber / (1 - p) ** 2 * (1 - 2 * p + 2 * p * s - s * s)
    return yc + yt, yc - yt


def cos_space(a, b, n):
    return [a + (b - a) * (1 - math.cos(math.pi * i / (n - 1))) / 2 for i in range(n)]


def lin_space(a, b, n):
    return [a + (b - a) * i / (n - 1) for i in range(n)]


class WingSection:
    """The wing's section at semispan y (positive; mirrored by `side`)."""

    def __init__(self, y, side=1):
        self.y, self.side = y, side
        self.le, self.te = S.wing_le(y), S.wing_te(y)
        self.c = self.te - self.le
        root, kink, tip = F(S.WING["root_y"]), 5.53, 17.16
        t_root, t_kink, t_tip = F(S.WING["thickness_root"]), F(S.WING["thickness_kink"]), F(S.WING["thickness_tip"])
        self.t = (t_root + (t_kink - t_root) * (y - root) / (kink - root)) if y < kink else (
            t_kink + (t_tip - t_kink) * (y - kink) / (tip - kink))
        self.t = max(self.t, t_tip)
        twist = F(S.WING["twist_tip"]) * max(0.0, min(1.0, (y - root) / (tip - root)))
        self.inc = DEG(F(S.WING["incidence_root"]) + twist)
        lowest = min(naca(s, self.t)[1] * self.c - s * self.c * math.sin(self.inc) for s in lin_space(0, 1, 41))
        self.z_le = S.wing_lower_z(y) - lowest

    def point(self, s, h):
        """Spec-frame point at chord fraction s, height h (fraction of chord) above the chord line."""
        x = self.le + s * self.c * math.cos(self.inc) + h * self.c * math.sin(self.inc)
        z = self.z_le - s * self.c * math.sin(self.inc) + h * self.c * math.cos(self.inc)
        return (x, self.side * self.y, z)

    def upper(self, s, lift=0.0):
        return self.point(s, naca(s, self.t)[0] + lift / self.c)

    def lower(self, s, drop=0.0):
        return self.point(s, naca(s, self.t)[1] - drop / self.c)

    def ring(self, s0_up, s0_lo, s1, n=9, te_gap=0.004):
        """A closed ring: upper surface s0_up -> s1, lower s1 -> s0_lo (spec frame). s0 = 0 shares the nose."""
        up = [self.upper(s) for s in cos_space(s0_up, s1, n)]
        lo = [self.lower(s) for s in cos_space(s0_lo, s1, n)][::-1]
        if s0_up == 0 and s0_lo == 0:
            lo = lo[:-1]                       # the nose point once
        if s1 >= 1.0:                          # a blunt trailing edge a few millimetres thick
            x, y, z = up[-1]
            up[-1] = (x, y, z + te_gap / 2)
            x, y, z = lo[0]
            lo[0] = (x, y, z - te_gap / 2)
        return up + lo


# ============================================================================================= fuselage
def fuselage_ring(x, n=36):
    top, bottom = S.lerp(S.FUSELAGE["side"], x, 1), S.lerp(S.FUSELAGE["side"], x, 2)
    w = S.lerp(S.FUSELAGE["plan"], x)
    frac = F(S.FUSELAGE["belly_to_max_breadth"]) / F(S.FUSELAGE["height"])
    zmb = bottom + (top - bottom) * frac
    pts = []
    for i in range(n):
        a = math.tau * i / n
        c, s = math.cos(a), math.sin(a)
        z = zmb + (top - zmb) * s if s >= 0 else zmb + (zmb - bottom) * s
        pts.append((x, w * c, z))
    return pts


def fuselage_surface(x, a):
    """Spec-frame point and outward normal at station x and ring angle a (0 = right side, pi/2 = top)."""
    eps = 1e-3
    def pt(xx, aa):
        top, bottom = S.lerp(S.FUSELAGE["side"], xx, 1), S.lerp(S.FUSELAGE["side"], xx, 2)
        w = S.lerp(S.FUSELAGE["plan"], xx)
        frac = F(S.FUSELAGE["belly_to_max_breadth"]) / F(S.FUSELAGE["height"])
        zmb = bottom + (top - bottom) * frac
        c, s = math.cos(aa), math.sin(aa)
        z = zmb + (top - zmb) * s if s >= 0 else zmb + (zmb - bottom) * s
        return Vector((xx, w * c, z))
    p = pt(x, a)
    dx = pt(x + eps, a) - pt(x - eps, a)
    da = pt(x, a + eps) - pt(x, a - eps)
    n = da.cross(dx).normalized()
    if n.dot(Vector((0, math.cos(a), math.sin(a)))) < 0:
        n = -n
    return p, n


def angle_at_height(x, z, side=1):
    """Ring angle on the fuselage side where the skin is at height z."""
    top, bottom = S.lerp(S.FUSELAGE["side"], x, 1), S.lerp(S.FUSELAGE["side"], x, 2)
    frac = F(S.FUSELAGE["belly_to_max_breadth"]) / F(S.FUSELAGE["height"])
    zmb = bottom + (top - bottom) * frac
    s = (z - zmb) / (top - zmb) if z >= zmb else (z - zmb) / (zmb - bottom)
    a = math.asin(max(-1.0, min(1.0, s)))
    return a if side > 0 else math.pi - a


def decal(b, x, a, half_w, half_h, radius, material, lift=0.004, segs=3, inner=False):
    """A rounded rectangle lying on the skin around (station x, ring angle a): half_w along the fuselage, half_h
    around it; a fan of triangles around a centre vertex, lifted `lift` off the skin."""
    centre, n0 = fuselage_surface(x, a)
    r_ring = (fuselage_surface(x, a + 1e-3)[0] - fuselage_surface(x, a - 1e-3)[0]).length / 2e-3
    pts = []
    r = min(radius, half_w, half_h)
    corners = [(half_w - r, half_h - r, 0), (-half_w + r, half_h - r, 90), (-half_w + r, -half_h + r, 180),
               (half_w - r, -half_h + r, 270)]
    for cx, cy, start in corners:
        for k in range(segs + 1):
            t = DEG(start + 90 * k / segs)
            pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    def on_skin(u, v):
        p, n = fuselage_surface(x + u, a + v / r_ring)
        return b.bm.verts.new(P(*(p + n * lift)))
    if inner:      # long straight edges get extra points, so a large panel follows a strongly curved skin
        dense = []
        for (u0, v0), (u1, v1) in zip(pts, pts[1:] + pts[:1]):
            k = max(1, math.ceil(math.hypot(u1 - u0, v1 - v0) / 0.06))
            dense += [(u0 + (u1 - u0) * i / k, v0 + (v1 - v0) * i / k) for i in range(k)]
        pts = dense
    verts = [on_skin(u, v) for u, v in pts]
    if inner:      # and inner rings at two thirds and one third of the size
        for scale in (2 / 3, 1 / 3):
            mid = [on_skin(u * scale, v * scale) for u, v in pts]
            for i in range(len(verts)):
                j = (i + 1) % len(verts)
                b.face((mid[i], verts[i], verts[j], mid[j]), material)
            verts = mid
    c = centre + n0 * lift
    cv = b.bm.verts.new(P(*c))
    for i in range(len(verts)):
        b.face((cv, verts[i], verts[(i + 1) % len(verts)]), material)


def build_body(model):
    b = builder(smooth_deg=50.0)
    stations = [0.10, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 12.0, 14.0,
                16.0, 18.0, 20.0, 22.0, 24.0, 25.0, 26.0, 27.0, 28.0, 29.0, 30.0, 31.0, 32.0, 33.0, 34.0, 35.0,
                36.0, 36.5, 37.0, 37.5, 37.8, 38.02]
    rings = [fuselage_ring(x) for x in stations]
    vr = [[b.bm.verts.new(P(*p)) for p in r] for r in rings]
    n = len(rings[0])
    for i in range(len(vr) - 1):
        for j in range(n):
            k = (j + 1) % n
            b.face((vr[i][j], vr[i][k], vr[i + 1][k], vr[i + 1][j]), "Paint")
    tip = b.bm.verts.new(P(0.0, 0.0, F(S.FUSELAGE["nose_tip_z"]) + 0.02))
    for j in range(n):
        b.face((vr[0][(j + 1) % n], vr[0][j], tip), "Paint")
    b.face(vr[-1], "Exhaust")                             # the APU exhaust at the tail cone
    # cockpit windows: (station, ring angle from the side, half length, half height) a side
    for side in (1, -1):
        for xc, a_deg, hl, hh in S.COCKPIT["panes"].value:
            a = DEG(a_deg) if side > 0 else math.pi - DEG(a_deg)
            decal(b, xc, a, hl, hh, 0.05, "Windscreen", lift=0.012, segs=2, inner=True)
    # cabin windows
    w, h = S.WINDOWS["opening"].value
    zc = F(S.FUSELAGE["floor_z"]) + F(S.WINDOWS["centre_above_floor"])
    for side, key in ((1, "right"), (-1, "left")):
        for x in S.WINDOWS[key].value:
            decal(b, x, angle_at_height(x, zc, side), w / 2, h / 2, F(S.WINDOWS["corner_radius"]), "Window")
    build_tail(b)
    model.part(b, "Body", pivot=(0.0, 0.0, 0.0), axis=(1.0, 0.0, 0.0))


def build_tail(b):
    # fin: sections from the traced outline, heights through spec.fin_z
    rows = list(S.VERTICAL_TAIL["outline"].value)
    t = F(S.VERTICAL_TAIL["thickness"])
    secs = []
    for zd, le, te in [(4.4, rows[0][1] + 0.6, rows[0][2])] + rows:
        z = S.fin_z(zd) if zd >= rows[0][0] else F(S.FUSELAGE["top_z"]) - 0.35
        c = te - le
        tc = min(t, 0.46 / c)
        ring = []
        m = 9
        for s in cos_space(0, 1, m):
            ring.append((le + s * c, 5 * tc * c * (0.2969 * math.sqrt(s) - 0.1260 * s - 0.3516 * s ** 2
                                                       + 0.2843 * s ** 3 - 0.1015 * s ** 4) + 0.003, z))
        ring = ring + [(x, -y, z) for x, y, _ in ring[::-1][1:-1]]
        secs.append(ring)
    b.loft([[P(*p) for p in r] for r in secs], "Paint", cap=True)
    # tailplane: one loft from tip to tip through the centre line
    sec_y = [-7.175, -6.6, -5.0, -3.0, -1.2, 0.0, 1.2, 3.0, 5.0, 6.6, 7.175]
    tt = F(S.HORIZONTAL_TAIL["thickness"])
    z0 = F(S.HORIZONTAL_TAIL["root_z"])
    dih = math.tan(DEG(F(S.HORIZONTAL_TAIL["dihedral"])))
    rings = []
    for y in sec_y:
        le, te = S.lerp(S.HORIZONTAL_TAIL["le"], abs(y)), S.lerp(S.HORIZONTAL_TAIL["te"], abs(y))
        c = te - le
        zc = z0 + dih * abs(y)
        ring = []
        for s in cos_space(0, 1, 9):
            hu, hl = naca(s, tt, camber=-0.01)
            ring.append((le + s * c, y, zc + hu * c))
        for s in cos_space(0, 1, 9)[::-1][1:-1]:
            hu, hl = naca(s, tt, camber=-0.01)
            ring.append((le + s * c, y, zc + hl * c))
        rings.append(ring)
    b.loft([[P(*p) for p in r] for r in rings], "PaintGrey", cap=True)


# ============================================================================================= wing
def wing_zone_rings(side, y0, y1, s_front, s_rear, extra=()):
    """Rings for a zone of the fixed wing between y0 and y1 (semispan, positive) with chord fractions s_front(y)
    (a pair: upper, lower) and s_rear(y)."""
    ys = sorted({y0, y1, *[y for y in extra if y0 < y < y1]})
    rings = []
    for y in ys:
        sec = WingSection(y, side)
        fu, fl = s_front(y)
        rings.append(sec.ring(fu, fl, s_rear(y), n=10))
    return rings


def flap_chord_frac(y):
    sec = WingSection(y)
    if y <= S.FLAPS["inboard_y"].value[1] + 0.05:
        return min(0.45, F(S.FLAPS["chord_inboard"]) / sec.c)
    return F(S.FLAPS["chord_outboard_ratio"])


def build_wing(model, side):
    sfx = "R" if side > 0 else "L"
    b = builder(smooth_deg=35.0)
    slat_r = F(S.SLATS["chord_ratio"])
    ib0, ib1 = S.FLAPS["inboard_y"].value
    ob0, ob1 = S.FLAPS["outboard_y"].value
    ail0, ail1 = S.AILERON["y"].value
    slat0, slat1 = S.SLATS["panels"].value[0][0], S.SLATS["panels"].value[-1][1]
    ail_r = F(S.AILERON["chord_ratio"])
    nose = lambda y: (0.0, 0.0)
    slat_cut = lambda y: (slat_r, slat_r * 0.45)
    full = lambda y: 1.0
    flap_rear = lambda y: 1.0 - flap_chord_frac(y)
    ail_rear = lambda y: 1.0 - ail_r
    kinks = (2.5, 3.5, 4.5, 5.52, 5.53)
    zones = [
        (1.20, ib0, nose, full, "PaintGrey"),
        (ib0, ib1, nose, flap_rear, "PaintGrey"),
        (ib1, ob0, nose, full, "PaintGrey"),
        (ob0, ob1, slat_cut, flap_rear, "PaintGrey"),
        (ob1, ail0, slat_cut, full, "PaintGrey"),
        (ail0, ail1, slat_cut, ail_rear, "PaintGrey"),
        (ail1, slat1, slat_cut, full, "PaintGrey"),
        (slat1, 17.0, nose, full, "PaintGrey"),
    ]
    for y0, y1, front, rear, mat in zones:
        extra = list(kinks) + [y0 + (y1 - y0) * k / 4 for k in range(1, 4)] if y1 - y0 > 2.0 else list(kinks)
        rings = wing_zone_rings(side, y0, y1, front, rear, extra)
        b.loft([[P(*p) for p in r] for r in rings], mat, cap=True)
    # the fixed leading edge inboard of the slats is bare metal: a thin glove strip
    build_winglet(b, side)
    build_fairings(b, side, "fwd")
    sec = WingSection(F(S.WING["root_y"]), side)
    pivot = P(*sec.point(0.0, 0.0))
    tip = P(*WingSection(17.0, side).point(0.0, 0.0))
    axis = tuple(Vector(tip) - Vector(pivot))
    model.part(b, f"Wing_{sfx}", pivot=pivot, axis=axis)


def solve_winglet(y0, z0, dy, dz, r=0.55, a0=DEG(6)):
    """Arc of radius r from angle a0 (from horizontal), then straight at a1: reach (dy, dz)."""
    best = None
    for k in range(200, 890):
        a1 = DEG(k / 10)
        ey = r * (math.sin(a1) - math.sin(a0))
        ez = r * (math.cos(a0) - math.cos(a1))
        L = (dz - ez) / math.sin(a1)
        err = abs(ey + L * math.cos(a1) - dy)
        if L > 0 and (best is None or err < best[0]):
            best = (err, a1, L)
    return best[1], best[2]


def winglet_path(side):
    """Points along the winglet's quarter-chord-ish spine: (y, z, angle from horizontal, fraction 0..1)."""
    y0 = 17.0
    s0 = WingSection(y0)
    z0 = s0.point(0.25, 0.0)[2]
    top_z = S.body_z_from_ground(F(S.WINGLET["top_z_ground"]), F(S.WINGLET["last_point_station"])) - 0.05
    span_half = F(S.SPAN_WINGLETS) / 2 - 0.04
    r, a0 = 0.55, DEG(F(S.WING["dihedral"]))
    a1, L = solve_winglet(y0, z0, span_half - y0, top_z - z0, r, a0)
    pts = []
    n_arc = 7
    for i in range(n_arc):
        a = a0 + (a1 - a0) * i / (n_arc - 1)
        pts.append((y0 + r * (math.sin(a) - math.sin(a0)), z0 + r * (math.cos(a0) - math.cos(a)), a))
    ya, za = pts[-1][0], pts[-1][1]
    for i in (1, 2, 3, 4):
        f = i / 4
        pts.append((ya + L * f * math.cos(a1), za + L * f * math.sin(a1), a1))
    return pts


def build_winglet(b, side):
    pts = winglet_path(side)
    s0 = WingSection(17.0)
    le0, te0 = s0.le, s0.te
    le_root = F(S.WINGLET["le_root_station"])
    c_root, c_tip = F(S.WINGLET["root_chord"]), F(S.WINGLET["tip_chord"])
    last = F(S.WINGLET["last_point_station"])
    le_tip = last - c_tip
    n_arc = 7
    rings = []
    for i, (y, z, a) in enumerate(pts):
        if i < n_arc:
            f = i / (n_arc - 1)
            le = le0 + (le_root - le0) * f
            c = (te0 - le0) + (c_root - (te0 - le0)) * f
            t = s0.t + (0.09 - s0.t) * f
        else:
            f = (i - n_arc + 1) / 4
            le = le_root + (le_tip - le_root) * f
            c = c_root + (c_tip - c_root) * f
            t = 0.09 - 0.01 * f
        # section in the plane normal to the spine: thickness direction is the spine's normal (-sin a, cos a)
        ny, nz = -math.sin(a), math.cos(a)
        ring = []
        for s in cos_space(0, 1, 10):
            hu = naca(s, t)[0] * c + (0.002 if s >= 1.0 else 0.0)
            ring.append((le + s * c, side * (y + ny * hu), z + nz * hu))
        for s in cos_space(0, 1, 10)[::-1][:-1]:
            hl = naca(s, t)[1] * c - (0.002 if s >= 1.0 else 0.0)
            ring.append((le + s * c, side * (y + ny * hl), z + nz * hl))
        rings.append(ring)
    rings[0] = WingSection(17.0, side).ring(0.0, 0.0, 1.0, n=10)   # meets the wing's last section exactly
    b.loft([[P(*p) for p in r] for r in rings], "Paint", cap=True)


def wing_lower_at(y, x):
    """Height of the wing's lower surface at semispan y and station x (clamped to the chord)."""
    sec = WingSection(y)
    s = max(0.0, min(1.0, (x - sec.le) / sec.c))
    return sec.lower(s)[2]


def build_fairings(b, side, piece="fwd", ys=None):
    """Canoe fairings under the flap tracks. The forward piece is fixed to the wing; the aft piece (from just
    ahead of the trailing edge) is built into the flap it carries, so it swings down with the flap."""
    length, depth, width = F(S.FLAPS["fairing_length"]), F(S.FLAPS["fairing_depth"]), F(S.FLAPS["fairing_width"])
    for y in (ys if ys is not None else S.FLAPS["fairings_y"].value):
        sec = WingSection(y)
        x_te = sec.te
        x0, x1 = x_te - length * 0.62, x_te + length * 0.38
        cut = x_te - flap_chord_frac(y) * sec.c * 0.55      # under the flap: the split line
        xs = lin_space(x0, x1, 13)
        xs = [x for x in xs if x < cut] + [cut] if piece == "fwd" else [cut] + [x for x in xs if x > cut]
        rings = []
        for x in xs:
            f = (x - x0) / (x1 - x0)
            d = depth * math.sin(math.pi * min(1.0, f * 1.15)) ** 0.7 if f < 0.87 else depth * 0.35 * (1 - f) / 0.13
            d = max(d, 0.03)
            hw = width / 2 * max(0.25, math.sin(math.pi * min(1.0, 0.1 + f * 0.9)) ** 0.5)
            top = (wing_lower_at(y, min(x, x_te - 0.05)) + 0.06) if x < x_te else \
                WingSection(y).point(1.0, 0.0)[2] - 0.02 - (x - x_te) * 0.08
            ring = []
            for j in range(8):
                a = math.pi * (j / 7)          # 0..pi along the bottom half
                ring.append((x, side * (y + hw * math.cos(a)), top - d * math.sin(a) if j not in (0, 7) else top))
            ring = ring + [(x, side * (y - hw * 0.6), top + 0.04), (x, side * (y + hw * 0.6), top + 0.04)]
            rings.append(ring)
        b.loft([[P(*p) for p in r] for r in rings], "PaintGrey", cap=True)


# ============================================================================================= moving surfaces
def hinge_axis(a, b, positive_x=True):
    v = Vector(P(*b)) - Vector(P(*a))
    v.normalize()
    if (v.x > 0) != positive_x:
        v = -v
    return tuple(v)


def surface_part(model, name, parent, side, y0, y1, s0, s1, pivot_fn, positive_x, material="PaintGrey",
                 nose=True, n=8, lift=0.0, upper_only=False, thickness=None, extra=None):
    """A part cut from the wing section between chord fractions s0..s1 and semispans y0..y1."""
    b = builder(smooth_deg=35.0)
    if extra is not None:
        extra(b)
    rings = []
    for y in (y0, (y0 + y1) / 2, y1):
        sec = WingSection(y, side)
        a, c = s0(y) if callable(s0) else s0, s1(y) if callable(s1) else s1
        if upper_only:
            up = [sec.upper(s, lift) for s in cos_space(a, c, n)]
            lo = [sec.upper(s, lift - (thickness or 0.03)) for s in cos_space(a, c, n)][::-1]
            ring = up + lo
        else:
            gap = 0.002 if c >= 1.0 else 0.0     # a blunt trailing edge, a few millimetres thick
            up = [sec.upper(s, gap if s >= 1.0 else 0.0) for s in cos_space(a, c, n)]
            lo = [sec.lower(s, gap if s >= 1.0 else 0.0) for s in cos_space(a, c, n)][::-1]
            if nose:   # a rounded nose ahead of the cut, as a flap or aileron has
                xn, yn, zn = sec.point(a - 0.025, (naca(a, sec.t)[0] + naca(a, sec.t)[1]) / 2)
                ring = [(xn, yn, zn)] + up + lo
            else:
                ring = up + lo
        rings.append(ring)
    b.loft([[P(*p) for p in r] for r in rings], material, cap=True)
    pa, pb = pivot_fn(y0), pivot_fn(y1)
    return model.part(b, name, pivot=P(*pa), axis=hinge_axis(pa, pb, positive_x), parent=parent)


def build_wing_parts(model, side, rig):
    sfx = "R" if side > 0 else "L"
    wing = f"Wing_{sfx}"
    ib0, ib1 = S.FLAPS["inboard_y"].value
    ob0, ob1 = S.FLAPS["outboard_y"].value
    aft = F(S.FLAPS["aft_flap_ratio"])
    detents = S.FLAPS["detents"].value
    travel = F(S.FLAPS["travel"])
    slope = F(S.FLAPS["track_slope"])
    for label, (y0, y1) in (("Inboard", (ib0, ib1)), ("Outboard", (ob0, ob1))):
        f0 = lambda y: 1.0 - flap_chord_frac(y) + 0.01
        split = lambda y: 1.0 - flap_chord_frac(y) * aft
        nose_pt = lambda y, f=f0: WingSection(y, side).point(f(y) - 0.025, 0.0)
        canoes = [y for y in S.FLAPS["fairings_y"].value if y0 < y < y1]
        main = surface_part(model, f"Flap{label}_{sfx}", wing, side, y0, y1, f0, split, nose_pt, True,
                            extra=lambda b, c=canoes: build_fairings(b, side, "aft", c))
        aft_nose = lambda y, f=split: WingSection(y, side).point(f(y) - 0.02, 0.0)
        surface_part(model, f"Flap{label}Aft_{sfx}", f"Flap{label}_{sfx}", side, y0, y1,
                     lambda y, f=split: f(y) + 0.005, 1.0, aft_nose, True)
        # rig: travel along streamwise tracks sloping down from the chord, and rotation about the hinge
        ym = (y0 + y1) / 2
        sec = WingSection(ym, side)
        chord = flap_chord_frac(ym) * sec.c
        a = DEG(slope) + sec.inc
        direction = Vector((0.0, -math.cos(a), -math.sin(a)))      # Blender: aft and down
        rows_main, rows_aft = [], []
        for lever, angle, frac, extra in detents:
            t = direction * (frac * travel * chord)
            rows_main.append({"at": lever, "t": [round(c, 4) for c in ak.to_gltf(t)], "r": angle})
            rows_aft.append({"at": lever, "t": [0.0, 0.0, 0.0], "r": extra})
        rig[f"Flap{label}_{sfx}"] = {"flap": rows_main}
        rig[f"Flap{label}Aft_{sfx}"] = {"flap": rows_aft}

    # aileron
    a0, a1 = S.AILERON["y"].value
    ar = 1.0 - F(S.AILERON["chord_ratio"])
    surface_part(model, f"Aileron_{sfx}", wing, side, a0, a1, ar + 0.008, 1.0,
                 lambda y: WingSection(y, side).point(ar - 0.017, 0.0), True)
    mx = F(S.AILERON["max_deg"])
    rig[f"Aileron_{sfx}"] = {"aileron": [{"at": -1, "t": [0, 0, 0], "r": -mx}, {"at": 0, "t": [0, 0, 0], "r": 0},
                                         {"at": 1, "t": [0, 0, 0], "r": mx}]}

    # spoilers: thin panels on the upper surface ahead of the flaps
    sp_r = F(S.SPOILERS["chord_ratio"])
    detent = F(S.SPOILERS["speedbrake_flight_detent"])
    for i, (y0, y1, kind) in enumerate(S.SPOILERS["panels"].value, start=1):
        f_rear = lambda y: 1.0 - flap_chord_frac(y) + 0.03
        f_front = lambda y: 1.0 - flap_chord_frac(y) - sp_r
        surface_part(model, f"Spoiler{i}_{sfx}", wing, side, y0, y1, f_front, f_rear,
                     lambda y, ff=f_front: WingSection(y, side).upper(ff(y), 0.004), False, upper_only=True,
                     lift=0.004, thickness=0.035, n=6)
        mx = F(S.SPOILERS["flight_max_deg"]) if kind == "flight" else F(S.SPOILERS["ground_max_deg"])
        rows = {"groundSpoiler": [{"at": 0, "t": [0, 0, 0], "r": 0}, {"at": 1, "t": [0, 0, 0], "r": mx}]}
        if kind == "flight":
            rows["speedbrake"] = [{"at": 0, "t": [0, 0, 0], "r": 0}, {"at": 1, "t": [0, 0, 0], "r": mx * detent}]
        rig[f"Spoiler{i}_{sfx}"] = rows

    # slats
    slat_r = F(S.SLATS["chord_ratio"])
    states = S.SLATS["states"].value
    for i, (y0, y1) in enumerate(S.SLATS["panels"].value, start=1):
        b = builder(smooth_deg=40.0)
        rings = []
        for y in (y0, (y0 + y1) / 2, y1):
            sec = WingSection(y, side)
            up = [sec.upper(s) for s in cos_space(0.0, slat_r - 0.004, 7)]
            lo = [sec.lower(s) for s in cos_space(0.0, slat_r * 0.45 - 0.004, 4)][::-1][:-1]
            rings.append(up + lo)
        b.loft([[P(*p) for p in r] for r in rings], "BareMetal", cap=True)
        piv = lambda y: WingSection(y, side).upper(slat_r - 0.004)
        model.part(b, f"Slat{i}_{sfx}", pivot=P(*piv(y0)), axis=hinge_axis(piv(y0), piv(y1), False), parent=wing)
        sec = WingSection((y0 + y1) / 2, side)
        fwd = Vector((0.0, math.cos(sec.inc + DEG(25)), -math.sin(sec.inc + DEG(25))))   # forward and down
        rig[f"Slat{i}_{sfx}"] = {"slat": [{"at": st, "t": [round(c, 4) for c in ak.to_gltf(fwd * mv)], "r": rot}
                                          for st, rot, mv in states]}

    # Krueger flaps: panels stowed flush under the inboard leading edge, hinged at their front
    kc = F(S.KRUEGERS["chord"])
    for i, (y0, y1) in enumerate(S.KRUEGERS["panels"].value, start=1):
        b = builder(smooth_deg=40.0)
        rings = []
        for y in (y0, y1):
            sec = WingSection(y, side)
            s_a, s_b = 0.03, 0.03 + kc / sec.c
            lo = [sec.lower(s, 0.004) for s in cos_space(s_a, s_b, 5)]
            inner = [sec.lower(s, -0.03) for s in cos_space(s_a, s_b, 5)][::-1]
            rings.append(lo + inner)
        b.loft([[P(*p) for p in r] for r in rings], "PaintGrey", cap=True)
        piv = lambda y: WingSection(y, side).lower(0.03, 0.004)
        model.part(b, f"Krueger{i}_{sfx}", pivot=P(*piv(y0)), axis=hinge_axis(piv(y0), piv(y1), True), parent=wing)
        rig[f"Krueger{i}_{sfx}"] = {"slat": [{"at": 0, "t": [0, 0, 0], "r": 0},
                                             {"at": 1, "t": [0, 0, 0], "r": F(S.KRUEGERS["open_deg"])},
                                             {"at": 2, "t": [0, 0, 0], "r": F(S.KRUEGERS["open_deg"])}]}


# ============================================================================================= engine
def nacelle_ring(x, r, zc, y, flatten=True, n=24):
    k = (F(S.ENGINE["nacelle_height"]) - F(S.ENGINE["nacelle_width"]) / 2) / (F(S.ENGINE["nacelle_width"]) / 2)
    pts = []
    for i in range(n):
        a = math.tau * i / n
        c, s = math.cos(a), math.sin(a)
        sz = s * (k if (flatten and s < 0) else 1.0)
        pts.append((x, y + r * c, zc + r * sz))
    return pts


def build_engine(model, side, rig):
    sfx = "R" if side > 0 else "L"
    y = side * F(S.ENGINE["y"])
    R = F(S.ENGINE["nacelle_width"]) / 2
    k = (F(S.ENGINE["nacelle_height"]) - R) / R
    zc = F(S.ENGINE["bottom_z"]) + R * k
    x_in, x_cowl = F(S.ENGINE["inlet_station"]), F(S.ENGINE["fan_cowl_end"])
    x_sl = F(S.ENGINE["sleeve_end"])
    x_core, x_plug = F(S.ENGINE["core_nozzle"]), F(S.ENGINE["plug_tip"])
    b = builder(smooth_deg=40.0)
    # fan cowl: a closed annulus, inside surface back to the fan face
    prof = [(x_in + 0.55, 0.80, "Fan"), (x_in + 0.05, 0.84, "BareMetal"), (x_in - 0.03, 0.90, "BareMetal"),
            (x_in + 0.06, 0.98 * R, "Paint"), (x_in + 0.45, R, "Paint"), (x_cowl - 0.3, R, "Paint"),
            (x_cowl, 0.985 * R, "Paint")]
    rings = [nacelle_ring(x, r, zc, y) for x, r, _ in prof]
    b.loft([[P(*p) for p in r] for r in rings], [m for _, _, m in prof[:-1]], cap=True)
    # fan face disc (dark) and spinner
    b.loft([[P(*p) for p in nacelle_ring(x_in + 0.56, 0.80, zc, y, False)],
            [P(*p) for p in nacelle_ring(x_in + 0.60, 0.80, zc, y, False)]], "Fan", cap=True)
    b.loft([[P(*p) for p in nacelle_ring(x_in + 0.55, 0.20, zc, y, False, 12)],
            [P(*p) for p in nacelle_ring(x_in + 0.35, 0.10, zc, y, False, 12)],
            [P(*p) for p in nacelle_ring(x_in + 0.25, 0.01, zc, y, False, 12)]], "Exhaust", cap=True)
    # cascades (seen when the sleeve moves aft)
    b.loft([[P(*p) for p in nacelle_ring(x_cowl - 0.05, 0.93 * R, zc, y)],
            [P(*p) for p in nacelle_ring(x_cowl + F(S.ENGINE["sleeve_travel"]) + 0.05, 0.90 * R, zc, y)]],
           "Cascade", cap=True)
    # core cowl, nozzle and plug
    core = [(x_cowl + 0.2, 0.70), (x_sl, 0.64), (x_core, 0.46), (x_core, 0.32), (x_plug - 0.2, 0.16), (x_plug, 0.02)]
    b.loft([[P(*p) for p in nacelle_ring(x, r, zc, y, False, 16)] for x, r in core],
           ["Paint", "Paint", "Exhaust", "Exhaust", "Exhaust"], cap=True)
    # pylon: a slab in the vertical plane through the engine
    w = F(S.ENGINE["pylon_width"]) / 2
    x_le = S.wing_le(abs(y))
    z_low = S.wing_lower_z(abs(y))
    top_front = zc + R + 0.02
    outline = [(x_in + 0.9, zc + R - 0.15), (x_le + 0.25, top_front + 0.10), (x_le + 1.4, z_low + 0.35),
               (F(S.ENGINE["pylon_end"]), z_low + 0.25), (F(S.ENGINE["pylon_end"]), z_low - 0.06),
               (x_sl + 0.6, zc + 0.55), (x_sl - 0.2, zc + 0.60)]
    rings = []
    for xx, zz in outline:
        rings.append(None)
    lower = [b.bm.verts.new(P(xx, y - w * (0.4 if i in (3, 4) else 1.0), zz)) for i, (xx, zz) in enumerate(outline)]
    upper = [b.bm.verts.new(P(xx, y + w * (0.4 if i in (3, 4) else 1.0), zz)) for i, (xx, zz) in enumerate(outline)]
    nn = len(outline)
    for j in range(nn):
        kk = (j + 1) % nn
        b.face((lower[j], lower[kk], upper[kk], upper[j]), "Paint")
    b.face(lower[::-1], "Paint")
    b.face(upper, "Paint")
    pivot = P(x_in, y, zc)
    model.part(b, f"Engine_{sfx}", pivot=pivot, axis=(0.0, -1.0, 0.0), parent=f"Wing_{sfx}")
    # translating sleeve
    s = builder(smooth_deg=40.0)
    prof = [(x_cowl, 0.985 * R), (x_sl - 0.5, 0.93 * R), (x_sl, 0.80), (x_sl, 0.76), (x_cowl + 0.05, 0.90 * R)]
    s.loft([[P(*p) for p in nacelle_ring(x, r, zc, y)] for x, r in prof], "Paint", cap=True)
    model.part(s, f"ReverserSleeve_{sfx}", pivot=P(x_cowl, y, zc), axis=(0.0, -1.0, 0.0), parent=f"Engine_{sfx}")
    tr = F(S.ENGINE["sleeve_travel"])
    rig[f"ReverserSleeve_{sfx}"] = {"reverser": [{"at": 0, "t": [0, 0, 0], "r": 0},
                                                 {"at": 1, "t": [0.0, 0.0, round(tr, 4)], "r": 0}]}


# ============================================================================================= gear
def wheel(b, centre, axis_y, diameter, width, rim, tyre="Tyre", hub="Hub", n=18):
    """A tyre and hub turning about a lateral axis, centre in the spec frame."""
    x0, y0, z0 = centre
    R, r_rim, hw = diameter / 2, rim / 2, width / 2
    prof = [(r_rim * 0.98, -hw * 0.95), (R * 0.93, -hw), (R, -hw * 0.55), (R, hw * 0.55), (R * 0.93, hw),
            (r_rim * 0.98, hw * 0.95)]
    rings = []
    for rr, a in prof:
        ring = []
        for i in range(n):
            t = math.tau * i / n
            ring.append(P(x0 + rr * math.cos(t), y0 + a, z0 + rr * math.sin(t)))
        rings.append(ring)
    b.loft(rings, tyre, cap=True)
    hub_rings = []
    for rr, a in ((r_rim * 0.98, -hw * 0.9), (r_rim * 0.98, hw * 0.9)):
        hub_rings.append([P(x0 + rr * math.cos(math.tau * i / 12), y0 + a, z0 + rr * math.sin(math.tau * i / 12))
                          for i in range(12)])
    b.loft(hub_rings, hub, cap=True)


def strut(b, a, c, radius, material="Strut", n=10):
    av, cv = Vector(P(*a)), Vector(P(*c))
    axis = (cv - av).normalized()
    ref = Vector((1, 0, 0)) if abs(axis.x) < 0.9 else Vector((0, 1, 0))
    u = axis.cross(ref).normalized()
    v = axis.cross(u)
    rings = [[tuple(p + radius * (math.cos(math.tau * i / n) * u + math.sin(math.tau * i / n) * v))
              for i in range(n)] for p in (av, cv)]
    b.loft(rings, material, cap=True)


def build_gear(model, rig):
    G = S.GEAR
    for side in (1, -1):
        sfx = "R" if side > 0 else "L"
        b = builder(smooth_deg=40.0)
        y_leg = side * F(G["track"]) / 2
        d = F(G["main_tyre_diameter"])
        x = MAIN
        axle_z = d / 2
        tz = F(G["main_trunnion_z"])
        strut(b, (x, y_leg, axle_z), (x, y_leg, tz), 0.13)
        strut(b, (x, y_leg - 0.48, axle_z), (x, y_leg + 0.48, axle_z), 0.07)
        strut(b, (x - 0.05, y_leg, axle_z + 0.4), (x + 0.9, y_leg - side * 0.25, tz - 0.05), 0.05)   # drag brace
        for off in (-0.5, 0.5):
            wheel(b, (x, y_leg + off * F(G["main_wheel_spacing"]), axle_z), 0, d, F(G["main_tyre_width"]),
                  F(G["main_rim_diameter"]))
        piv = (x, side * F(G["main_trunnion_y"]), tz)
        model.part(b, f"MainGear_{sfx}", pivot=P(*piv), axis=(0.0, 1.0 if side > 0 else -1.0, 0.0))
        ang = F(G["main_retract_deg"])
        rig[f"MainGear_{sfx}"] = {"gear": [{"at": 0, "t": [0, 0, 0], "r": ang}, {"at": 1, "t": [0, 0, 0], "r": 0}]}
    b = builder(smooth_deg=40.0)
    xn = F(G["nose_station"])
    d = F(G["nose_tyre_diameter"])
    contact = MAIN - xn
    z_contact = contact * math.tan(DEG(-F(S.GROUND_ATTITUDE)))
    axle_z = z_contact + d / 2
    tz = F(G["nose_trunnion_z"])
    xt = xn + F(G["nose_trunnion_dx"])
    strut(b, (xn, 0.0, axle_z), (xt, 0.0, tz), 0.08)
    strut(b, (xn, -0.26, axle_z), (xn, 0.26, axle_z), 0.04)
    for off in (-0.5, 0.5):
        wheel(b, (xn, off * F(G["nose_wheel_spacing"]), axle_z), 0, d, F(G["nose_tyre_width"]),
              F(G["nose_rim_diameter"]), n=14)
    model.part(b, "NoseGear", pivot=P(xt, 0.0, tz), axis=(1.0, 0.0, 0.0))
    rig["NoseGear"] = {"gear": [{"at": 0, "t": [0, 0, 0], "r": F(G["nose_retract_deg"])},
                                {"at": 1, "t": [0, 0, 0], "r": 0}]}


# ============================================================================================= shadow proxy
def build_proxy(model):
    b = ak.PartBuilder(COLORS)
    stations = [0.3, 1.5, 3.5, 7.0, 20.0, 29.0, 33.0, 36.0, 38.0]
    b.loft([[P(*p) for p in fuselage_ring(x, 12)] for x in stations], "Paint", cap=True)
    for side in (1, -1):
        rings = []
        for y in (1.5, 5.53, 17.0):
            sec = WingSection(y, side)
            rings.append([sec.upper(0.0), sec.upper(0.3), sec.upper(1.0), sec.lower(0.3)])
        b.loft([[P(*p) for p in r] for r in rings], "PaintGrey", cap=True)
        y = side * F(S.ENGINE["y"])
        R = F(S.ENGINE["nacelle_width"]) / 2
        zc = F(S.ENGINE["bottom_z"]) + F(S.ENGINE["nacelle_height"]) - R
        b.loft([[P(*p) for p in nacelle_ring(x, r, zc, y, True, 8)] for x, r in
                ((F(S.ENGINE["inlet_station"]), 0.9 * R), (14.5, R), (F(S.ENGINE["sleeve_end"]), 0.8))],
               "Paint", cap=True)
        tips = winglet_path(side)
        yt, zt, _ = tips[-1]
        le, te = F(S.WINGLET["last_point_station"]) - F(S.WINGLET["tip_chord"]), F(S.WINGLET["last_point_station"])
        s0 = WingSection(17.0, side)
        b.loft([[P(*s0.upper(0.0)), P(*s0.upper(1.0)), P(*s0.lower(0.5))],
                [P(le, side * yt, zt), P(te, side * yt, zt), P((le + te) / 2, side * (yt - 0.05), zt)]],
               "Paint", cap=True)
        le_s, te_s = S.lerp(S.HORIZONTAL_TAIL["le"], 7.1), S.lerp(S.HORIZONTAL_TAIL["te"], 7.1)
        z0 = F(S.HORIZONTAL_TAIL["root_z"])
        b.loft([[P(32.9, 0.0, z0 + 0.15), P(37.2, 0.0, z0), P(35.0, 0.0, z0 - 0.15)],
                [P(le_s, side * 7.1, z0 + 0.87 + 0.04), P(te_s, side * 7.1, z0 + 0.87),
                 P((le_s + te_s) / 2, side * 7.1, z0 + 0.83)]], "PaintGrey", cap=True)
    rows = S.VERTICAL_TAIL["outline"].value
    top = F(S.FUSELAGE["top_z"]) - 0.2
    b.loft([[P(29.5, 0.0, top), P(37.0, 0.2, top), P(37.0, -0.2, top)],
            [P(rows[-2][1], 0.0, S.fin_z(rows[-2][0])), P(rows[-2][2], 0.06, S.fin_z(rows[-2][0])),
             P(rows[-2][2], -0.06, S.fin_z(rows[-2][0]))]], "Paint", cap=True)
    for side in (1, -1):
        y = side * F(S.GEAR["track"]) / 2
        b.block((y, 0.0), 0.35, 0.6, 0.0, 1.6, "Tyre")
    b.block((0.0, MAIN - F(S.GEAR["nose_station"])), 0.3, 0.4, 0.2, 1.6, "Tyre")
    model.part(b, "ShadowProxy", role="proxy")


# ============================================================================================= lamps, rig, main
def lamps():
    out = []
    for name, d in S.LIGHTS.items():
        v = d.value
        x, y, z = v["position"]
        dx, dy, dz = v["direction"]
        out.append(ak.Lamp(name, P(x, y, z), (dy, -dx, dz), v["cone_deg"], S.LIGHT_CHANNELS.index(v["channel"])))
    return out


def write_rig(model, tables, path, snapped):
    channels = {
        "flap": {"range": [0, 40], "units": "flap lever (surface position; 7.5 = between 5 and 10)"},
        "slat": {"range": [0, 2], "units": "0 retracted, 1 extend, 2 full extend (Krueger flaps: 1 and 2 = open)"},
        "gear": {"range": [0, 1], "units": "0 up and locked, 1 down"},
        "speedbrake": {"range": [0, 1], "units": "speed brake lever, flight detent = 1 (flight spoilers only)"},
        "groundSpoiler": {"range": [0, 1], "units": "ground spoilers deployed (all six panels)"},
        "reverser": {"range": [0, 1], "units": "translating sleeve aft"},
        "aileron": {"range": [-1, 1], "units": "roll command, + = this surface trailing edge down"},
    }
    parts = []
    for name, tabs in tables.items():
        entry = model.rig_entry(name)
        entry["tables"] = tabs
        parts.append(entry)
    doc = {
        "version": 1,
        "about": "Moving parts of airframe.glb (plan 03, F3.3/F3.4). Each node turns by r degrees about axis "
                 "through pivot and moves by t metres, both in its parent's frame, interpolated between rows of "
                 "each channel's table; with two tables (spoilers) the larger angle wins. Generated by "
                 "models/aircraft/build_airframe.py from spec.py; motion values are ESTIMATED there.",
        "frame": {"up": "+Y", "nose": "-Z", "right": "+X", "units": "m",
                  "origin": "centre line, main-gear tyre contact plane, main-gear station"},
        "groundPitchDeg": round(F(S.GROUND_ATTITUDE), 4),
        "mainGearStation": round(MAIN, 4),
        "channels": channels,
        "slatSchedule": [list(r) for r in S.SLATS["schedule"].value],
        "flapLimitKt": [list(r) for r in S.FLAPS["limit_speed_kt"].value],
        "flex": {"tipDeflection1g": F(S.FLEX["tip_deflection_1g"]), "frequencyHz": F(S.FLEX["frequency_hz"]),
                 "rootY": F(S.WING["root_y"]), "tipY": F(S.SPAN_WINGLETS) / 2,
                 "nodes": {"L": ["Wing_L", "Engine_L"], "R": ["Wing_R", "Engine_R"]}},
        "lightChannels": {"_LIGHTS0": list(S.LIGHT_CHANNELS[:4]), "_LIGHTS1": list(S.LIGHT_CHANNELS[4:])},
        "lights": {lamp.name: {"position": list(ak.to_gltf(lamp.position)), "channel": S.LIGHTS[lamp.name].value["channel"],
                               "colour": S.LIGHTS[lamp.name].value["colour"],
                               "direction": list(ak.to_gltf(lamp.direction)), "coneDeg": lamp.cone_deg}
                   for lamp in snapped},
        "parts": parts,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1)


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    def opt(name, default=None):
        return args[args.index(name) + 1] if name in args else default
    out = os.path.abspath(opt("--out", os.path.join(HERE, "..", "..", "public", "models", "aircraft")))
    blend = opt("--blend")
    ak.reset_scene()
    model = ak.Model("Airframe")
    tables = {}
    build_body(model)
    for side in (1, -1):
        build_wing(model, side)
        build_engine(model, side, tables)
        build_wing_parts(model, side, tables)
    build_gear(model, tables)
    build_proxy(model)
    snapped = model.snap_lamps(lamps(), offset=F(S.LIGHT_BAKE["snap_offset"]))
    stats = model.bake_lights(snapped, reference=F(S.LIGHT_BAKE["reference_distance"]),
                              floor=F(S.LIGHT_BAKE["falloff_floor"]), max_range=F(S.LIGHT_BAKE["max_range"]),
                              skip=("ShadowProxy",))
    report = model.check(max_tris=int(F(S.BUDGET["airframe_tris"])), proxy_max_tris=int(F(S.BUDGET["shadow_tris"])))
    report["light_channels"] = {k: {"lit_corners": v["lit_corners"], "max": round(v["max"], 4)} for k, v in stats.items()}
    glb = os.path.join(out, "airframe.glb")
    if not report["errors"]:
        model.export(glb)
        write_rig(model, tables, os.path.join(out, "rig.json"), snapped)
        report["files"] = {"glb": "airframe.glb", "rig": "rig.json", "glb_bytes": os.path.getsize(glb)}
    with open(os.path.join(HERE, "airframe.report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1)
    print(f"airframe: {report['tris']} tris (+{report['proxy_tris']} proxy), {len(model.parts)} nodes,"
          f" errors {report['errors']}")
    for name, r in report["parts"].items():
        if r["warnings"]:
            print("  warning", name, r["warnings"])
    if blend:
        model.save_blend(blend)
    if report["errors"]:
        raise RuntimeError("; ".join(report["errors"]))


if __name__ == "__main__":
    main()
