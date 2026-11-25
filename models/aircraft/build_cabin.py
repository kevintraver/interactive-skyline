"""The window-seat cabin (plan 03, task F3.5): the parts the app places around the chosen seat.

    python3 .claude/skills/blender-landmark-model/scripts/run_blender.py models/aircraft/build_cabin.py \
        -- --out public/models/aircraft [--blend /path/outside/the/repo/cabin.blend]

Writes <out>/cabin.glb, <out>/cabin.json (how the app places and moves the parts) and, beside this script,
cabin.report.json (the kit's mesh check per node, the triangle count, the measured dimensions). Every dimension comes
from spec.py (FUSELAGE, WINDOWS and CABIN; sources in research/dimensions.md); the shapes no source gives (the
bezel, the shade, the seat's back and its tray, the bin's section) are marked ESTIMATED there or noted here.

One window bay, not a length of cabin: the app (src/flight/cabin/cabin.js) instances the bay at every window
station on the seat's side, a plain trim strip (Filler, one metre long, stretched) between bays and over the blank
panels, the bin's lower edge along the run, and the seats and armrests at the rows around the eye. Everything is
built for the RIGHT side; the app mirrors the geometry for the left.

Nodes (glTF: +Y up, nose -Z, right +X; every rest rotation identity, every translation zero):

  Cabin                root
    Bay                sidewall around one window: trim with the window's bezel, the reveal from the bezel to the
                       inner pane, the window's structure from there to the opening in the skin, the dado and its
                       air-return grille. z = 0 at the window's centre station; heights in body axes
    Filler             plain sidewall, the bay's profile without a window, 1 m long (z -0.5..0.5); stretched
    Shade              the window shade, closed (over the inner pane); it opens by sliding cabin.json's
                       shade.travel round its track, the circle of shade.radius about the fuselage's axis (shade.axis is
                       the track's direction at the window's centre)
    PaneInner, PaneMiddle, PaneOuter   the three panes as separate curved quads (for plan 03's Phase 5 material)
    Seat               one economy seat, centred on x = 0, its front at z = 0: cushion, back (cushion face, a shell
                       rounded over its sides and top, the stowed tray table and its latch, the literature pocket
                       under its elastic lip), pan and leg
    Armrest            one armrest centred on x = 0, the seat front at z = 0
    Bin                the bins' lower part over the window side, 1 m long: the underside from the sidewall to the
                       lip, the lip, the door's face, the passenger-service rail and the window-wash light strip
    Psu                the passenger service unit over one row, its front at z = 0: panel, reading lights, gaspers,
                       call button, the signs' box with its lit face (material SignLit) and pictograms

Per corner, one baked attribute `_CABIN` (float RGBA), from ray casting against a context of five bays with their
fillers, the bin, the floor, the shell over the top and the seats of three rows:
  r  ambient occlusion: the cosine-weighted share of the hemisphere with nothing within 0.6 m; on the seats, the
     armrests and the PSUs a hit at d counts as (d / 0.6)^0.7 open (the seat back faces the next row's seat 0.3 m
     off, and closed outright it drew near black)
  g  the window-wash light strip's illuminance, 1.0 at the brightest corner of the sidewall
  b  the cosine-weighted share of the hemisphere that sees out through a window (a form factor): the app multiplies
     the sky's light by it, as light that reaches the point through the windows
  a  1 (0.5 on the PSU's forward half: the signs' face there is the no-smoking sign, always lit)
The materials are plain colours; the app relights them for day, dusk and night (cabinLight).
"""
from __future__ import annotations

import json
import math
import os
import random
import sys

import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import aircraft_kit as ak  # noqa: E402
import spec as S  # noqa: E402

F = float
FU, WI, CA = S.FUSELAGE, S.WINDOWS, S.CABIN
R = F(CA["trim_radius"])                      # the trim, a circle about the line of max breadth
RS = F(FU["half_width"])                      # the skin
AXIS = F(FU["top_z"]) - RS                    # the line of max breadth, body axes
FLOOR = F(FU["floor_z"])
WW, WH = WI["opening"].value                  # the window opening at the skin
CR = F(WI["corner_radius"])
YC = FLOOR + F(WI["centre_above_floor"])      # the window's centre height
FLARE = F(CA["reveal_flare"])
BEZEL = F(CA["frame_width"])
RELIEF = F(CA["frame_relief"])
PANE_IN = F(CA["inner_pane_inset"])
PANE_GAP = F(CA["pane_spacing"])
HALF = F(CA["panel_half_length"])
SQUARE_V = 0.29                               # the square of trim round the opening, up and down (developed)
SHADE_MARGIN = 0.022                          # the shade overlaps the inner pane's opening by this on every side
SHADE_R = R + 0.004                           # the shade's track: 4 mm behind the trim face, in the reveal

COLORS = {
    "Trim": "D8D5CE",       # sidewall: warm light grey plastic
    "Bezel": "E3E0D9",      # the moulded window surround
    "Reveal": "CFCBC3",     # the reveal liner, out to the middle pane
    "Grille": "3B3E42",     # air-return grille at the floor; the gaspers' throats; the latch; the pictograms
    "Seam": "8E8B85",       # the panel seams and the panes' rubber seals: a mid grey (the gap's shadow, seen at a metre)
    "Shade": "ECE9E2",
    "Glass": "B9C6CF",
    "Fabric": "55607A",     # seat covers and the literature pocket: dark blue-grey
    "Shell": "BCBFC3",      # seat back shell, frame, armrests: light grey plastic (photographs of the type's seats)
    "Tray": "8C9096",
    "Bin": "E1DED7",
    "Psu": "D2D3CF",        # the passenger service unit's panels, gaspers and sign box
    "Lens": "F2F0E8",       # reading-light lenses (off)
    "SignLit": "FFFFFF",    # the passenger signs' diffusers (the app lights them)
    "Wash": "FFFFFF",       # the light strip's diffuser
}
ROUGH = {"Glass": 0.05, "Shade": 0.7, "Fabric": 0.95, "Shell": 0.5, "Tray": 0.45, "Grille": 0.8, "Lens": 0.3, "SignLit": 0.4}


def builder():
    return ak.PartBuilder(COLORS, roughness={**{k: 0.8 for k in COLORS}, **ROUGH}, smooth_deg=35.0)


# ------------------------------------------------------------------------------------------------ geometry
def bl(x, y, u):
    """Blender model frame from (x right, y up in body axes, u aft of the part's anchor station)."""
    return (x, -u, y)


def angle_at(r, v):
    """Angle on a circle of radius r about the axis for developed height v from the window centre on the trim."""
    return math.asin((YC - AXIS) / r) + v / r


def cyl(u, v, r):
    """The point at developed height v (metres along the trim from the window centre, up +) and u aft, radius r."""
    t = angle_at(r, v)
    return bl(r * math.cos(t), AXIS + r * math.sin(t), u)


def trim_x(height):
    """The trim's half width at a body height (the circle)."""
    return math.sqrt(max(0.0, R * R - (height - AXIS) ** 2))


def v_of_height(h):
    """Developed height on the trim (from the window centre) of a body height."""
    return R * (math.asin((h - AXIS) / R) - math.asin((YC - AXIS) / R))


def round_rect(phi, a, b, rc):
    """Where a ray at angle phi from the centre leaves a rounded rectangle of half sizes a, b, corner radius rc."""
    def sd(x, y):
        qx, qy = abs(x) - (a - rc), abs(y) - (b - rc)
        return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - rc
    lo, hi = 0.0, math.hypot(a, b) * 1.01
    c, s = math.cos(phi), math.sin(phi)
    for _ in range(48):
        m = (lo + hi) / 2
        if sd(c * m, s * m) > 0:
            hi = m
        else:
            lo = m
    return c * lo, s * lo


def rect(phi, a, b):
    c, s = math.cos(phi), math.sin(phi)
    k = min(a / abs(c) if abs(c) > 1e-12 else 1e9, b / abs(s) if abs(s) > 1e-12 else 1e9)
    return c * k, s * k


CABIN_TRIS = 20000  # section 6.5: 'cabin segment at most 20,000' triangles
N_RING = 64  # smooth-shaded, 5.6 degrees a step: no facets at 13 mm (52 flat-shaded showed them)
PHIS = sorted({round(2 * math.pi * k / N_RING - math.pi, 12) for k in range(N_RING)}
              | {round(math.atan2(sy * SQUARE_V, sx * HALF), 12) for sx in (1, -1) for sy in (1, -1)})


def ring(a, b, rc, r):
    """A rounded-rectangle ring on the cylinder of radius r, sampled on PHIS: half size a along u, b along the
    circle (developed on that radius, so the opening at the skin is the real one), centred at the window's height."""
    return [cyl(*round_rect(phi, a, b, rc), r) for phi in PHIS]


def loft(b, rings, materials):
    """Quads between consecutive closed rings (same length); materials[i] for the band from ring i to i+1."""
    vs = [[b.bm.verts.new(p) for p in rg] for rg in rings]
    n = len(rings[0])
    for i in range(len(vs) - 1):
        for k in range(n):
            j = (k + 1) % n
            b.face((vs[i][k], vs[i][j], vs[i + 1][j], vs[i + 1][k]), materials[i])
    return vs


def fan(b, pts, centre, material, flip=False):
    c = b.bm.verts.new(centre)
    vs = [b.bm.verts.new(p) for p in pts]
    n = len(vs)
    for k in range(n):
        tri = (c, vs[k], vs[(k + 1) % n]) if not flip else (c, vs[(k + 1) % n], vs[k])
        b.face(tri, material)


# the sidewall's rows, developed height from the window centre, shared by the bay's edges and the filler
V_BIN = v_of_height(FLOOR + F(CA["bin_outboard_above_floor"]))
V_DADO = v_of_height(FLOOR + 0.30)
STEP = 0.05  # m of developed height between rows on the plain trim (0.10 drew the wash light in diagonal bands)
SEAM_W = 0.003  # the panel seams: a 3 mm line (ESTIMATED, photographs of the type's sidewall)
SEAM_H = 0.62   # the joint of the lower sidewall panel and the window panel, above the floor (ESTIMATED, photographs)
V_SEAM = (v_of_height(FLOOR + SEAM_H - SEAM_W / 2), v_of_height(FLOOR + SEAM_H + SEAM_W / 2))


def plain_rows(v0, v1):
    n = max(1, math.ceil((v1 - v0) / STEP))
    return [v0 + (v1 - v0) * i / n for i in range(n + 1)]


def lower_rows():
    """The rows from the dado's top to the square's bottom, with the lower panel's seam in them."""
    a, b = V_SEAM
    return plain_rows(V_DADO, a)[:-1] + [a, b] + plain_rows(b, -SQUARE_V)[1:]


def row_material(v0, v1):
    """The material of the band between two rows of the plain trim: the seam's band, or trim."""
    return "Seam" if abs(v0 - V_SEAM[0]) < 1e-9 and abs(v1 - V_SEAM[1]) < 1e-9 else "Trim"


def edge_rows():
    """Developed heights of the bay's vertical edges inside the square: the square ring's samples at u = HALF."""
    vs = sorted({round(rect(phi, HALF, SQUARE_V)[1], 9) for phi in PHIS if abs(rect(phi, HALF, SQUARE_V)[0] - HALF) < 1e-9})
    return vs


ROWS_ABOVE = plain_rows(SQUARE_V, V_BIN)
ROWS_BELOW = lower_rows()
SIDE_ROWS = ROWS_BELOW[:-1] + edge_rows() + ROWS_ABOVE[1:]
# the dado: from the circle 0.30 m above the floor straight down to the floor, 3 cm inboard of the circle there;
# the grille from 4 to 12 cm above the floor
DADO_FOOT_X = trim_x(FLOOR) - F(CA["dado_inset"])
DADO_TOP = (trim_x(FLOOR + 0.30), FLOOR + 0.30)


def dado_point(h):
    t = (DADO_TOP[1] - (FLOOR + h)) / 0.30
    return DADO_TOP[0] + (DADO_FOOT_X - DADO_TOP[0]) * t, FLOOR + h


def wall_column(u):
    """The sidewall's profile at u, from the floor up to the bin: (point, material of the band above it)."""
    pts = [(bl(*dado_point(h), u), m) for h, m in ((0.0, "Trim"), (0.04, "Grille"), (0.12, "Trim"))]
    # SIDE_ROWS[0] is the dado's top, 0.30 m above the floor
    pts += [(cyl(u, v, R), row_material(v, SIDE_ROWS[i + 1]) if i + 1 < len(SIDE_ROWS) else "Trim") for i, v in enumerate(SIDE_ROWS)]
    return pts


def strip(b, u0, u1, columns=4):
    """Plain sidewall between u0 and u1 on the shared rows (the filler, and the bay outside its square), in `columns`
    columns: the filler is stretched to fill a gap, and one quad across a long gap drew the baked light in bands."""
    cols = [[b.bm.verts.new(p) for p, _ in wall_column(u0 + (u1 - u0) * k / columns)] for k in range(columns + 1)]
    mats = [m for _, m in wall_column(u0)]
    for k in range(columns):
        va, vc = cols[k], cols[k + 1]
        for i in range(len(va) - 1):
            b.face((va[i], vc[i], vc[i + 1], va[i + 1]), mats[i])


# ------------------------------------------------------------------------------------------------ parts
# The window surround's section, from the trim out to the skin, as (beyond the window's edge e, inboard of the trim h)
# in metres: the bezel rises from the trim in a cove, runs flat and rolls over a rounded lip into the reveal; the reveal
# liner runs out to the inner pane; a dark seal holds the inner pane; the liner continues to the middle pane and a seal
# to the outer pane at the skin. ESTIMATED from photographs of the type's windows (no drawing gives the moulding).
def bezel_profile():
    fl, bz, rl = FLARE, BEZEL, RELIEF
    prof = [  # (e, h, material of the band from this point to the next)
        (fl + bz, 0.0, "Bezel"),
        (fl + bz - 0.006, 0.18 * rl, "Bezel"),
        (fl + bz - 0.012, 0.55 * rl, "Bezel"),
        (fl + bz - 0.018, 0.88 * rl, "Bezel"),
        (fl + bz - 0.025, rl, "Bezel"),          # the flat top, RELIEF proud of the trim
        (fl + 0.012, rl, "Bezel"),
        (fl + 0.006, 0.93 * rl, "Bezel"),        # the lip rolls over (about a 6 mm radius)
        (fl + 0.002, 0.72 * rl, "Bezel"),
        (fl, 0.40 * rl, "Reveal"),
    ]
    # the reveal: from the lip's foot out to the inner pane, slightly concave
    e0, h0, e1, h1 = fl, 0.40 * rl, 0.012, -PANE_IN
    for t in (0.3, 0.6, 0.85):
        prof.append((e0 + (e1 - e0) * t, h0 + (h1 - h0) * (t ** 1.12), "Reveal"))
    prof.append((e1, h1, "Seam"))                                     # the inner pane's seal, 2 mm
    prof.append((0.010, h1 - 0.002, "Reveal"))                        # the light liner on out between the panes
    prof.append((0.006, -(RS - 0.03 - R), "Reveal"))
    prof.append((0.003, -(RS - 0.012 - R), "Seam"))                   # the outer pane's seal at the skin
    prof.append((0.0, -(RS - 0.002 - R), None))                       # the opening in the skin
    return prof


def build_bay(model):
    b = builder()
    seam_u = HALF - SEAM_W
    # the square of trim round the window, its aft edge short of the bay's edge by the seam
    def square_pt(phi):
        u, v = rect(phi, HALF, SQUARE_V)
        return (seam_u if u > HALF - 1e-9 else u), v
    sq = [square_pt(phi) for phi in PHIS]
    prof = bezel_profile()
    foot = [round_rect(phi, WW / 2 + prof[0][0], WH / 2 + prof[0][0], CR + prof[0][0]) for phi in PHIS]
    rings, mats = [], []
    # from the square in to the bezel's foot in four steps on the trim: no long triangles for the baked light to band on
    for t in (0.0, 0.4, 0.75):
        rings.append([cyl(us + (uf - us) * t, vs + (vf - vs) * t, R) for (us, vs), (uf, vf) in zip(sq, foot)])
        mats.append("Trim")
    for e, h, m in prof:
        r = R - h
        rings.append([cyl(*round_rect(phi, WW / 2 + e, WH / 2 + e, CR + e), r) for phi in PHIS])
        if m is not None:
            mats.append(m)
    loft(b, rings, mats)
    # the seam beside the square: a 4 mm band at the bay's aft edge, on the square's edge rows
    edge = edge_rows()
    a = [b.bm.verts.new(cyl(seam_u, v, R)) for v in edge]
    c = [b.bm.verts.new(cyl(HALF, v, R)) for v in edge]
    for i in range(len(edge) - 1):
        b.face((a[i], c[i], c[i + 1], a[i + 1]), "Seam")
    # outside the square: plain trim above and below, then the dado, on the shared rows; the seam's column at the aft
    us_top = sorted({round(square_pt(p)[0], 9) for p in PHIS if abs(square_pt(p)[1] - SQUARE_V) < 1e-9} | {HALF})
    us_bot = sorted({round(square_pt(p)[0], 9) for p in PHIS if abs(square_pt(p)[1] + SQUARE_V) < 1e-9} | {HALF})
    def col_mat(us, k, base):
        return "Seam" if us[k] >= seam_u - 1e-9 else base
    grid = [[b.bm.verts.new(cyl(u, v, R)) for u in us_top] for v in ROWS_ABOVE]
    for i in range(len(ROWS_ABOVE) - 1):
        for k in range(len(us_top) - 1):
            b.face((grid[i][k], grid[i][k + 1], grid[i + 1][k + 1], grid[i + 1][k]), col_mat(us_top, k, "Trim"))
    rows = ROWS_BELOW
    grid = [[b.bm.verts.new(cyl(u, v, R)) for u in us_bot] for v in rows]
    for i in range(len(rows) - 1):
        for k in range(len(us_bot) - 1):
            b.face((grid[i][k], grid[i][k + 1], grid[i + 1][k + 1], grid[i + 1][k]), col_mat(us_bot, k, row_material(rows[i], rows[i + 1])))
    dado = [[b.bm.verts.new(bl(*dado_point(h), u)) for u in us_bot] for h in (0.0, 0.04, 0.12)] + [grid[0]]
    for i, m in enumerate(("Trim", "Grille", "Trim")):
        for k in range(len(us_bot) - 1):
            b.face((dado[i][k], dado[i][k + 1], dado[i + 1][k + 1], dado[i + 1][k]), m)
    b.bm.verts.ensure_lookup_table()
    import bmesh
    bmesh.ops.remove_doubles(b.bm, verts=b.bm.verts[:], dist=1e-6)
    model.part(b, "Bay")


def build_filler(model):
    """Plain trim 1 m long, stretched by the app to each gap: in its middle the seam between two panels (a 1 m filler
    is a blank position's panel; across a 5 cm gap between bays the seam is thinner than a pixel)."""
    b = builder()
    w = SEAM_W / 2
    strip(b, -0.5, -w, columns=2)
    a, c = wall_column(-w), wall_column(w)
    va = [b.bm.verts.new(p) for p, _ in a]
    vc = [b.bm.verts.new(p) for p, _ in c]
    for i in range(len(va) - 1):
        b.face((va[i], vc[i], vc[i + 1], va[i + 1]), "Seam" if i >= 3 else a[i][1])
    strip(b, w, 0.5, columns=2)
    import bmesh
    bmesh.ops.remove_doubles(b.bm, verts=b.bm.verts[:], dist=1e-7)
    model.part(b, "Filler")


def shade_outline(margin):
    return [round_rect(phi, WW / 2 + margin, WH / 2 + margin, CR + margin) for phi in PHIS]


def build_shade(model):
    """The shade, closed: a closed 6 mm slab on its track with a handle rib along its bottom edge."""
    b = builder()
    outline = shade_outline(SHADE_MARGIN)
    front = [b.bm.verts.new(cyl(u, v, SHADE_R)) for u, v in outline]
    back = [b.bm.verts.new(cyl(u, v, SHADE_R + 0.006)) for u, v in outline]
    cf, cb = b.bm.verts.new(cyl(0, 0, SHADE_R)), b.bm.verts.new(cyl(0, 0, SHADE_R + 0.006))
    n = len(front)
    for k in range(n):
        j = (k + 1) % n
        b.face((cf, front[j], front[k]), "Shade")
        b.face((cb, back[k], back[j]), "Shade")
        b.face((front[k], front[j], back[j], back[k]), "Shade")
    # the handle: a closed rib 15 mm deep along the bottom, 18 cm long
    vb = -(WH / 2 + SHADE_MARGIN) + 0.012
    box_pts = [cyl(u, vv, r) for u in (-0.09, 0.09) for vv in (vb - 0.008, vb + 0.008) for r in (SHADE_R - 0.015, SHADE_R)]
    v = [b.bm.verts.new(p) for p in box_pts]
    def at(i, j, k):
        return v[i * 4 + j * 2 + k]
    for q in (((0, 0, 0), (0, 1, 0), (0, 1, 1), (0, 0, 1)), ((1, 0, 0), (1, 0, 1), (1, 1, 1), (1, 1, 0)),
              ((0, 0, 0), (0, 0, 1), (1, 0, 1), (1, 0, 0)), ((0, 1, 0), (1, 1, 0), (1, 1, 1), (0, 1, 1)),
              ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)), ((0, 0, 1), (0, 1, 1), (1, 1, 1), (1, 0, 1))):
        b.face([at(*c) for c in q], "Shade")
    model.part(b, "Shade")
    t = angle_at(SHADE_R, 0)
    return {"axis": list(ak.to_gltf((math.cos(t + math.pi / 2), 0.0, math.sin(t + math.pi / 2)))),
            "travel": round(F(CA["shade_travel"]), 4), "radius": round(SHADE_R, 4)}


def build_panes(model):
    out = {}
    for name, r, margin in (("PaneInner", R + PANE_IN + 0.002, 0.012), ("PaneMiddle", RS - 0.035 + PANE_GAP / 2, 0.005),
                            ("PaneOuter", RS - 0.012, 0.0)):
        b = builder()
        pts = [cyl(u, v, r) for u, v in shade_outline(margin)]
        fan(b, pts, cyl(0, 0, r), "Glass", flip=True)
        model.part(b, name)
        out[name] = round(r, 4)
    return out


def box(b, x0, x1, y0, y1, u0, u1, material, mats=None):
    """An axis-aligned box: x lateral, y height, u aft. mats: per face (bottom, top, front(u0), back(u1), -x, +x)."""
    P = [b.bm.verts.new(bl(x, y, u)) for x in (x0, x1) for y in (y0, y1) for u in (u0, u1)]
    def v(i, j, k):
        return P[i * 4 + j * 2 + k]
    faces = [((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1)), ((0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0)),
             ((0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0)), ((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)),
             ((0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0)), ((1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1))]
    for i, f in enumerate(faces):
        b.face([v(*c) for c in f], (mats or [material] * 6)[i])


def build_seat(model):
    """One economy seat: x lateral about its centre, heights above the floor, u aft of the seat front."""
    b = builder()
    cush = F(CA["cushion_top"])
    depth = F(CA["cushion_depth"])
    hw = F(CA["seat_width"]) / 2 + 0.005
    top = F(CA["back_top"])
    thick = F(CA["back_thickness"])
    # the back's rake from vertical: the cushion face at the eye's height lies back_face aft of the seat front, where
    # src/flight/cabin/lopa.js and the head's limits put it (18 degrees; [B5] view C-C draws its seat more upright,
    # about 12 degrees, with the face nearer 0.55 m)
    alpha = math.atan((F(CA["back_face"]) - depth) / (F(CA["eye_above_floor"]) - cush))
    y0 = FLOOR
    # the cushion: a slab with a rounded front edge, the seat pan and the leg under it
    prof = [(0.0, cush - 0.05), (0.015, cush - 0.012), (0.045, cush), (depth, cush - 0.02), (depth, cush - 0.13), (0.03, cush - 0.12)]
    xs = (-hw, hw)
    vs = [[b.bm.verts.new(bl(x, y0 + h, u)) for (u, h) in prof] for x in xs]
    n = len(prof)
    for k in range(n):
        j = (k + 1) % n
        b.face((vs[0][k], vs[0][j], vs[1][j], vs[1][k]), "Fabric")
    b.face(vs[1], "Fabric")
    b.face(vs[0][::-1], "Fabric")
    box(b, -hw + 0.02, hw - 0.02, y0 + cush - 0.17, y0 + cush - 0.12, 0.05, depth - 0.02, "Shell")
    box(b, -0.15, -0.12, y0, y0 + cush - 0.17, 0.12, 0.40, "Shell")
    # the back in its own frame: h up the back from the seat reference point, d aft from its cushion face
    srp_u, srp_y = depth, y0 + cush
    h_top = (top - cush) / math.cos(alpha)

    def back(x, h, d):
        return bl(x, srp_y + h * math.cos(alpha) - d * math.sin(alpha), srp_u + h * math.sin(alpha) + d * math.cos(alpha))

    def ramp(t):
        t = min(1.0, max(0.0, t))
        return t * t * (3 - 2 * t)
    # the shell wraps round its sides and over its top (rounded about 3 cm): the rear face's depth falls toward the edges
    def rear_d(h, x=0.0):
        edge = ramp((abs(x) - (hw - 0.045)) / 0.045)
        crown = ramp((h - (h_top - 0.06)) / 0.06)
        return thick - 0.03 * (h / h_top) - 0.028 * edge * edge - 0.03 * crown * crown

    def bulge(x, h):  # the cushion face bulges 2 cm forward in its middle
        return -0.02 * (1 - (abs(x) / hw) ** 2) * math.sin(math.pi * min(1.0, h / h_top))
    xs = [-hw, -hw + 0.012, -hw + 0.03, -hw + 0.06, -0.12, 0.0, 0.12, hw - 0.06, hw - 0.03, hw - 0.012, hw]
    hs = [0.0, 0.06, 0.12, 0.2, 0.28, 0.35, 0.43, 0.52, h_top - 0.1, h_top - 0.06, h_top - 0.035, h_top - 0.015, h_top]
    front = [[b.bm.verts.new(back(x, h, bulge(x, h))) for x in xs] for h in hs]
    rear = [[b.bm.verts.new(back(x, h, rear_d(h, x))) for x in xs] for h in hs]
    for i in range(len(hs) - 1):
        for k in range(len(xs) - 1):
            b.face((front[i][k], front[i + 1][k], front[i + 1][k + 1], front[i][k + 1]), "Fabric")
            b.face((rear[i][k], rear[i][k + 1], rear[i + 1][k + 1], rear[i + 1][k]), "Shell")
    for i in range(len(hs) - 1):  # the sides
        b.face((front[i][0], rear[i][0], rear[i + 1][0], front[i + 1][0]), "Shell")
        b.face((front[i][-1], front[i + 1][-1], rear[i + 1][-1], rear[i][-1]), "Shell")
    for k in range(len(xs) - 1):  # top and bottom
        b.face((front[-1][k], front[-1][k + 1], rear[-1][k + 1], rear[-1][k]), "Shell")
        b.face((front[0][k], rear[0][k], rear[0][k + 1], front[0][k + 1]), "Shell")
    # on the shell: the tray table (stowed, chamfered corners, 7 mm proud), its latch above it, and the literature
    # pocket below, bulging and open at its top under an elastic lip (photographs of the type's economy seats)
    tw, th = CA["tray_size"].value
    def slab(x0, x1, h0, h1, d_of, depth, material, chamfer=0.0, nx=4, ny=3, side=None):
        """A closed slab on the shell over [x0, x1] x [h0, h1], its face `depth` proud of the shell at d_of(x, h), its
        corners chamfered: the face on a grid of nx x ny cells (one n-gon drew the baked light as one big triangle)."""
        xs_ = [x0 + (x1 - x0) * i / nx for i in range(nx + 1)]
        hs_ = [h0 + (h1 - h0) * j / ny for j in range(ny + 1)]
        def pull(i, j, x, h):  # the four corners pulled in along the diagonal
            if (i in (0, nx)) and (j in (0, ny)) and chamfer > 0:
                x += chamfer * 0.5 * (1 if i == 0 else -1)
                h += chamfer * 0.5 * (1 if j == 0 else -1)
            return x, h
        grid = [[pull(i, j, xs_[i], hs_[j]) for i in range(nx + 1)] for j in range(ny + 1)]
        face_v = [[b.bm.verts.new(back(x, h, d_of(x, h) + depth(x, h))) for x, h in row] for row in grid]
        for j in range(ny):
            for i in range(nx):
                b.face((face_v[j][i], face_v[j][i + 1], face_v[j + 1][i + 1], face_v[j + 1][i]), material)
        ring = [(i, 0) for i in range(nx)] + [(nx, j) for j in range(ny)] + [(i, ny) for i in range(nx, 0, -1)] + [(0, j) for j in range(ny, 0, -1)]
        top = [face_v[j][i] for i, j in ring]
        # the back on the same grid, 3 mm inside the shell (one n-gon there was triangulated through the face)
        back_v = [[b.bm.verts.new(back(x, h, d_of(x, h) - 0.003)) for x, h in row] for row in grid]
        for j in range(ny):
            for i in range(nx):
                b.face((back_v[j][i], back_v[j + 1][i], back_v[j + 1][i + 1], back_v[j][i + 1]), side or material)
        base = [back_v[j][i] for i, j in ring]
        n = len(ring)
        for k in range(n):
            m = (k + 1) % n
            b.face((base[k], base[m], top[m], top[k]), side or material)
    shell_d = lambda x, h: rear_d(h, x)  # noqa: E731  the shell's rear face at (x, h)
    tray_top = h_top - 0.13
    slab(-tw / 2, tw / 2, tray_top - th, tray_top, shell_d, lambda x, h: 0.007, "Tray", chamfer=0.03, nx=6, ny=4)
    slab(-0.022, 0.022, tray_top + 0.006, tray_top + 0.026, shell_d, lambda x, h: 0.011, "Grille", chamfer=0.008, nx=1, ny=1)
    p_top, p_bot = tray_top - th - 0.035, 0.07
    slab(-tw / 2 + 0.01, tw / 2 - 0.01, p_bot, p_top, shell_d, lambda x, h: 0.006 + 0.012 * ((h - p_bot) / (p_top - p_bot)), "Fabric",
         chamfer=0.02, nx=6, ny=3)
    slab(-tw / 2 + 0.012, tw / 2 - 0.012, p_top - 0.018, p_top, shell_d, lambda x, h: 0.021, "Shell", nx=4, ny=1)
    model.part(b, "Seat")
    return {"backRake": round(math.degrees(alpha), 2), "trayTop": round(cush + tray_top * math.cos(alpha), 4)}


def build_armrest(model):
    """One armrest: its side profile lofted across four widths, so its top is rounded; a strut under its back."""
    b = builder()
    top = F(CA["armrest_top"])
    y0 = FLOOR
    prof = [(0.06, top - 0.035), (0.064, top - 0.012), (0.075, top - 0.002), (0.09, top), (0.40, top), (0.425, top - 0.008),
            (0.44, top - 0.03), (0.435, top - 0.055), (0.40, top - 0.07), (0.08, top - 0.07)]
    across = ((-0.026, -0.009), (-0.02, -0.001), (0.02, -0.001), (0.026, -0.009))   # (x, drop of the top's edge)
    vs = [[b.bm.verts.new(bl(x, y0 + h + (dh if h > top - 0.02 else 0.0), u)) for (u, h) in prof] for x, dh in across]
    n = len(prof)
    for c in range(len(across) - 1):
        for k in range(n):
            j = (k + 1) % n
            b.face((vs[c][k], vs[c][j], vs[c + 1][j], vs[c + 1][k]), "Shell")
    b.face(vs[-1], "Shell")
    b.face(vs[0][::-1], "Shell")
    box(b, -0.02, 0.02, y0 + F(CA["cushion_top"]) - 0.12, y0 + top - 0.07, 0.30, 0.42, "Shell")  # the support
    model.part(b, "Armrest")


# the bin's section: (x lateral, height above the floor), from the sidewall round the lip and up the door
def bin_section():
    h_wall = F(CA["bin_outboard_above_floor"])
    h_lip = F(CA["bin_lip_above_floor"])
    x_lip = F(CA["bin_clearance"]) / 2
    x_wall = trim_x(FLOOR + h_wall)
    wash_x = x_wall - 0.10
    pts = [
        (x_wall + 0.004, h_wall, "Bin"),          # meets the sidewall's top row (4 mm behind it)
        (wash_x + 0.03, h_wall - 0.012, "Wash"),  # the valance: the window-wash strip faces the sidewall
        (wash_x, h_wall - 0.035, "Bin"),
        (wash_x - 0.04, h_wall - 0.035, "Psu"),
        (x_lip + 0.24, h_lip + 0.03, "Bin"),      # the passenger-service rail ends
        (x_lip + 0.03, h_lip, "Bin"),
        (x_lip, h_lip + 0.03, "Bin"),             # the lip
        (x_lip + 0.01, h_lip + 0.12, "Bin"),
        (x_lip + 0.05, h_lip + 0.38, "Bin"),      # the door's face, leaning outboard
        (trim_x(FLOOR + h_lip + 0.50) - 0.01, h_lip + 0.50, None),   # back to the shell above
    ]
    return pts


def build_bin(model):
    b = builder()
    sec = bin_section()
    cols = [[b.bm.verts.new(bl(x, FLOOR + h, u)) for x, h, _ in sec] for u in (-0.5, 0.5)]
    for k in range(len(sec) - 1):
        b.face((cols[0][k], cols[0][k + 1], cols[1][k + 1], cols[1][k]), sec[k][2])
    model.part(b, "Bin")
    x, h, _ = sec[1]
    return {"washStrip": [round(x, 4), round(FLOOR + h, 4)], "lip": [round(F(CA["bin_clearance"]) / 2, 4),
                                                                      round(FLOOR + F(CA["bin_lip_above_floor"]), 4)]}


# The passenger service unit (PSU) under the bin over each row: a panel on the bin's underside with three reading lights
# and three gaspers in a fore-and-aft line, the call button, and the passenger signs (no smoking, fasten seat belt)
# with their pictograms. On the type the signs are in some rows' units only; here every row has them. Positions along
# the panel and sizes are ESTIMATED from photographs of the type's cabins (no drawing gives them).
PSU = {"from": 0.10, "to": 0.76, "lights_s": 0.16, "gaspers_s": 0.29, "along": (0.22, 0.38, 0.54), "light_r": 0.03,
       "gasper_r": 0.021, "sign": {"s": 0.27, "z": 0.67, "size": (0.13, 0.06), "proud": 0.016}}


def psu_frame():
    """The bin's underside band the PSU sits on: origin (x, height above the floor), the unit vector along it (from
    the sidewall toward the lip) and the unit normal into the cabin (down)."""
    sec = bin_section()
    (x1, h1, _), (x2, h2, _) = sec[3], sec[4]
    L = math.hypot(x2 - x1, h2 - h1)
    a = ((x2 - x1) / L, (h2 - h1) / L)
    n = (a[1], -a[0])
    if n[1] > 0:  # into the cabin is down
        n = (-n[0], -n[1])
    return (x1, h1), a, n, L


def build_psu(model):
    b = builder()
    (x0, h0), a, n, L = psu_frame()

    def P(s, z, d):
        return bl(x0 + a[0] * s + n[0] * d, FLOOR + h0 + a[1] * s + n[1] * d, z)

    def prism(outline, d0, d1, top, side=None):
        """A closed prism on the panel: an outline of (s, z) from d0 to d1 into the cabin."""
        lo = [b.bm.verts.new(P(s_, z, d0)) for s_, z in outline]
        hi = [b.bm.verts.new(P(s_, z, d1)) for s_, z in outline]
        b.face(hi, top)
        b.face(lo[::-1], side or top)
        for k in range(len(outline)):
            j = (k + 1) % len(outline)
            b.face((lo[k], lo[j], hi[j], hi[k]), side or top)

    def circle(s, z, r, seg=14):
        return [(s + r * math.cos(2 * math.pi * k / seg), z + r * math.sin(2 * math.pi * k / seg)) for k in range(seg)]

    def rect_(s0, s1, z0, z1):
        return [(s0, z0), (s1, z0), (s1, z1), (s0, z1)]
    # the panel, proud of the bin's underside by 6 mm, its edges inset 2 cm from the band's
    prism(rect_(0.04, L - 0.04, PSU["from"], PSU["to"]), -0.004, 0.006, "Psu")
    for z in PSU["along"]:
        # a reading light: a lens in a bezel
        prism(circle(PSU["lights_s"], z, PSU["light_r"] + 0.008), 0.0, 0.010, "Psu")
        prism(circle(PSU["lights_s"], z, PSU["light_r"]), 0.008, 0.012, "Lens")
        # a gasper: a ball nozzle standing 15 mm out of its socket, its throat dark
        prism(circle(PSU["gaspers_s"], z, PSU["gasper_r"]), 0.0, 0.014, "Psu")
        prism(circle(PSU["gaspers_s"], z, PSU["gasper_r"] * 0.62, 10), 0.010, 0.022, "Psu")
        prism(circle(PSU["gaspers_s"], z, PSU["gasper_r"] * 0.3, 8), 0.018, 0.0235, "Grille")
    # the call button
    prism(circle(PSU["lights_s"], PSU["sign"]["z"], 0.011, 10), 0.0, 0.012, "Psu")
    prism(circle(PSU["lights_s"], PSU["sign"]["z"], 0.007, 10), 0.010, 0.0135, "Lens")
    # the signs' box and its lit face, with the two pictograms standing 0.6 mm off it
    sg = PSU["sign"]
    zs, ss = sg["size"]
    c_s, c_z, pr = sg["s"], sg["z"], sg["proud"]
    prism(rect_(c_s - ss / 2 - 0.006, c_s + ss / 2 + 0.006, c_z - zs / 2 - 0.006, c_z + zs / 2 + 0.006), 0.0, pr - 0.001, "Psu")
    prism(rect_(c_s - ss / 2, c_s + ss / 2, c_z - zs / 2, c_z + zs / 2), pr - 0.002, pr, "SignLit")
    g0, g1 = pr - 0.0005, pr + 0.0006
    # no smoking (forward half): a ring and its bar
    zc = c_z - zs / 4
    ring_r, ring_w, seg = 0.019, 0.004, 14
    for k in range(seg):
        t0, t1 = 2 * math.pi * k / seg, 2 * math.pi * (k + 1) / seg
        pts = [(c_s + (ring_r - ring_w) * math.cos(t0), zc + (ring_r - ring_w) * math.sin(t0)),
               (c_s + ring_r * math.cos(t0), zc + ring_r * math.sin(t0)),
               (c_s + ring_r * math.cos(t1), zc + ring_r * math.sin(t1)),
               (c_s + (ring_r - ring_w) * math.cos(t1), zc + (ring_r - ring_w) * math.sin(t1))]
        prism(pts, g0, g1, "Grille")
    d = (ring_r - ring_w / 2) * math.sqrt(0.5)
    prism([(c_s - d - 0.002, zc - d + 0.002), (c_s - d + 0.002, zc - d - 0.002), (c_s + d + 0.002, zc + d - 0.002), (c_s + d - 0.002, zc + d + 0.002)],
          g0, g1, "Grille")
    # fasten seat belt (aft half): the two halves of the belt and the buckle between them
    zc = c_z + zs / 4
    prism(rect_(c_s - 0.004, c_s + 0.004, zc - 0.026, zc - 0.007), g0, g1, "Grille")
    prism(rect_(c_s - 0.004, c_s + 0.004, zc + 0.007, zc + 0.026), g0, g1, "Grille")
    prism(rect_(c_s - 0.009, c_s + 0.009, zc - 0.007, zc + 0.007), g0, g1, "Grille")
    model.part(b, "Psu")
    return {"from": PSU["from"], "to": PSU["to"], "sign": {"s": c_s, "z": c_z, "size": [zs, ss]}}


# ------------------------------------------------------------------------------------------------ orientation
def orient(obj, toward=None):
    """Turn every face to the cabin. The kit recalculates normals, which an open surface (the sidewall, the bin)
    can end up facing out of: with `toward(centre) -> point`, a face whose normal points away from that point is
    reversed; without it each closed island is made to enclose a positive volume."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    flip = []
    if toward is not None:
        for f in bm.faces:
            c = f.calc_center_median()
            if f.normal.dot(Vector(toward(c)) - c) < 0:
                flip.append(f)
    else:
        seen = set()
        for f0 in bm.faces:
            if f0.index in seen:
                continue
            island, stack = [], [f0]
            seen.add(f0.index)
            while stack:
                f = stack.pop()
                island.append(f)
                for e in f.edges:
                    for g in e.link_faces:
                        if g.index not in seen:
                            seen.add(g.index)
                            stack.append(g)
            vol = sum(f.verts[0].co.dot(f.verts[i].co.cross(f.verts[i + 1].co)) for f in island
                      for i in range(1, len(f.verts) - 1))
            if vol < 0:
                flip += island
    if flip:
        bmesh.ops.reverse_faces(bm, faces=flip)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def orient_all(model):
    inside = lambda c: (0.0, c.y, YC)                       # noqa: E731  the sidewall, the window and its parts
    below = lambda c: (0.0, c.y, FLOOR)                     # noqa: E731  the bin: everything faces down and in
    for name, info in model.parts.items():
        if name == "Bay":
            # toward the window's own centre line: the reveal's fore and aft faces then face each other
            orient(info.obj, lambda c: (0.0, 0.0, YC))
        elif name == "Filler":
            orient(info.obj, inside)
        elif name.startswith("Pane"):
            orient(info.obj, lambda c: (0.0, 0.0, YC))
        elif name == "Bin":
            orient(info.obj, below)
        else:
            orient(info.obj)


# ------------------------------------------------------------------------------------------------ the bake
def mesh_tris(obj, matrix):
    me = obj.data
    me.calc_loop_triangles()
    vs = [matrix @ v.co for v in me.vertices]
    return vs, [list(t.vertices) for t in me.loop_triangles]


def translation(u, x=0.0):
    """Blender matrix placing a part at u metres aft (and x across)."""
    return Matrix.Translation(Vector((x, -u, 0.0)))


def shell_tris(u0, u1):
    """The rest of the cabin for the bake: the shell over the top and down the far side, the floor, two end caps."""
    verts, tris = [], []
    h_top = FLOOR + F(CA["bin_lip_above_floor"]) + 0.45
    a0 = math.asin((h_top - AXIS) / R)
    a1 = math.pi - math.asin((FLOOR - AXIS) / R)
    n = 24
    angs = [a0 + (a1 - a0) * i / n for i in range(n + 1)]
    for i in range(n):
        for (ua, ub) in ((u0, u1),):
            p = [Vector(bl(R * math.cos(t), AXIS + R * math.sin(t), u)) for t in (angs[i], angs[i + 1]) for u in (ua, ub)]
            base = len(verts)
            verts += p
            tris += [[base, base + 1, base + 3], [base, base + 3, base + 2]]
    fx = trim_x(FLOOR)
    base = len(verts)
    verts += [Vector(bl(x, FLOOR, u)) for x in (fx, -fx) for u in (u0, u1)]
    tris += [[base, base + 1, base + 3], [base, base + 3, base + 2]]
    for u in (u0, u1):
        base = len(verts)
        verts += [Vector(bl(x, y, u)) for x, y in ((2.0, 2.5), (-2.0, 2.5), (-2.0, 6.0), (2.0, 6.0))]
        tris += [[base, base + 1, base + 2], [base, base + 2, base + 3]]
    return verts, tris


def build_context(model, seat_x, seats=True, offset=0.0):
    """Triangles of a stretch of cabin round the window at u = 0, as a BVH, the seats' rows moved `offset` aft. The
    parts every window shares (the bay, the filler, the shade, the panes, the bin) are baked against four of these, the
    seats a quarter of a pitch apart, and the results averaged: the seats stand somewhere else beside each window, and
    one placement baked into the bay drew that seat's shadow on every bezel."""
    pitch = 20.5 * 0.0254
    windows = [-2 * pitch, -pitch, 0.0, pitch, 2 * pitch]
    placed = []
    parts = model.parts
    for u in windows:
        placed.append(("Bay", translation(u)))
    for a, c in zip([-1.6] + [w + HALF for w in windows], [w - HALF for w in windows] + [1.6]):
        placed.append(("Filler", translation((a + c) / 2) @ Matrix.Diagonal(Vector((1, c - a, 1, 1)))))
    for u in (-1.0, 0.0, 1.0):
        placed.append(("Bin", translation(u) @ Matrix.Diagonal(Vector((1, 1.0, 1, 1)))))
    # three rows: the eye's row with its window beside the eye (seat front 0.55 m ahead of the window)
    row_pitch = F(CA["pitch"])
    seat_xs = [seat_x - k * (F(CA["seat_width"]) + 0.0508) for k in range(3)]
    for r in (-1, 0, 1, 2) if seats else ():
        for sx in seat_xs:
            placed.append(("Seat", translation(-0.55 + offset + (r - 1 if offset > 0 else r) * row_pitch, sx)))
    verts, tris = shell_tris(-1.6, 1.6)
    for name, m in placed:
        v, t = mesh_tris(parts[name].obj, m)
        base = len(verts)
        verts += v
        tris += [[base + i for i in tri] for tri in t]
    return BVHTree.FromPolygons(verts, tris, epsilon=0.0)


def hemisphere(n, seed=7):
    """n cosine-weighted directions about +Z (stratified)."""
    rnd = random.Random(seed)
    out = []
    side = int(math.sqrt(n))
    for i in range(side):
        for j in range(side):
            r1 = (i + rnd.random()) / side
            r2 = (j + rnd.random()) / side
            r, phi = math.sqrt(r1), 2 * math.pi * r2
            out.append(Vector((r * math.cos(phi), r * math.sin(phi), math.sqrt(max(0.0, 1 - r1)))))
    return out


def wash_lamps(info):
    """The window-wash strip as point emitters every 10 cm, facing down and outboard onto the sidewall."""
    x, y = info["washStrip"]
    d = Vector((0.55, 0.0, -0.84)).normalized()   # Blender: +x outboard, -z down
    return [(Vector(bl(x - 0.01, y - 0.01, u)), d) for u in [k * 0.1 - 1.5 for k in range(31)]]


FAR_PITCH = 20.5 * 0.0254


def far_window(p):
    """Whether a hit on the far side's shell lands where that side's windows are: the context has no openings there,
    so the band of the window line counts as window for the share of each pitch the opening takes (about half)."""
    if p.x > -1.2 or abs(p.z - YC) > WH / 2:
        return False
    return ((-p.y) % FAR_PITCH) / FAR_PITCH < WW / FAR_PITCH


def bake(model, placements, trees, lamps, rays=144, peak=None, soft=False):
    """Each corner's values against each context in `trees`, averaged."""
    runs = [bake_one(model, placements, t, lamps, rays, soft) for t in trees]
    raw = {name: [tuple(sum(r[name][i][c] for r in runs) / len(runs) for c in range(3)) for i in range(len(runs[0][name]))]
           for name in runs[0]}
    return write_bake(model, raw, peak)


def bake_one(model, placements, tree, lamps, rays=144, soft=False):
    dirs = hemisphere(rays)
    stats = {}
    raw = {}
    for name, m in placements.items():
        obj = model.parts[name].obj
        me = obj.data
        nm = m.to_3x3().inverted().transposed()
        normals = me.corner_normals
        world = [m @ v.co for v in me.vertices]
        vals = []
        cache = {}
        for loop in me.loops:
            p = world[loop.vertex_index]
            n = (nm @ normals[loop.index].vector).normalized()
            key = (loop.vertex_index, round(n.x, 3), round(n.y, 3), round(n.z, 3))
            if key in cache:
                vals.append(cache[key])
                continue
            # a frame about the normal
            t = n.orthogonal().normalized()
            bt = n.cross(t)
            start = p + n * 0.003
            open_near = out = 0
            for d in dirs:
                w = t * d.x + bt * d.y + n * d.z
                hit = tree.ray_cast(start, w, 50.0)
                if hit[0] is None or far_window(hit[0]):
                    out += 1
                    open_near += 1
                elif soft:
                    # a surface near by closes the direction, one further off less so: open by the share of the
                    # 0.6 m a hit leaves (the seat back facing the next row's seat 0.3 m off was closed outright and
                    # drew near black; the cabin's diffuse light reaches it round that seat)
                    open_near += min(1.0, hit[3] / 0.6) ** 0.7
                elif hit[3] > 0.6:
                    open_near += 1
            wash = 0.0
            for lp, ld in lamps:
                to = lp - p
                dist = to.length
                cos_r = n.dot(to) / dist
                cos_e = -ld.dot(to) / dist
                if cos_r <= 0 or cos_e <= 0:
                    continue
                hit = tree.ray_cast(start, to.normalized(), max(0.0, dist - 0.02))
                if hit[0] is not None:
                    continue
                wash += cos_r * cos_e / max(dist, 0.05) ** 2
            v = (open_near / len(dirs), wash, out / len(dirs))
            cache[key] = v
            vals.append(v)
        raw[name] = vals
    return raw


def write_bake(model, raw, peak=None):
    stats = {}
    if peak is None:
        peak = max(v[1] for name in ("Bay", "Filler") for v in raw[name]) or 1.0
    stats["_peak"] = peak
    for name, vals in raw.items():
        me = model.parts[name].obj.data
        layer = me.color_attributes.new("_CABIN", "FLOAT_COLOR", "CORNER")
        flat = []
        # a: 1, but 0.5 on the PSU's forward half (the no-smoking sign's half of the signs' face: always lit)
        half = [0.5 if name == "Psu" and -me.vertices[lp.vertex_index].co.y < PSU["sign"]["z"] else 1.0 for lp in me.loops]
        for (ao, wash, ff), a in zip(vals, half):
            flat += [ao, min(1.0, wash / peak), ff, a]
        layer.data.foreach_set("color", flat)
        stats[name] = {"ao_min": round(min(v[0] for v in vals), 3), "ao_mean": round(sum(v[0] for v in vals) / len(vals), 3),
                       "wash_max": round(max(min(1.0, v[1] / peak) for v in vals), 3),
                       "window_ff_max": round(max(v[2] for v in vals), 3),
                       "window_ff_mean": round(sum(v[2] for v in vals) / len(vals), 4)}
    return stats


# ------------------------------------------------------------------------------------------------ checks
def island_volumes(obj):
    """Signed volume of each closed island, unrounded (the kit's check rounds to 0.001 m^3, so a part smaller than a
    litre, like the shade's handle or an armrest's strut, reads as 0 and is reported inside out)."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    seen, out = set(), []
    for f0 in bm.faces:
        if f0.index in seen:
            continue
        island, stack = [], [f0]
        seen.add(f0.index)
        while stack:
            f = stack.pop()
            island.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        if any(len(e.link_faces) != 2 for f in island for e in f.edges):
            continue
        out.append(sum(f.verts[0].co.dot(f.verts[i].co.cross(f.verts[i + 1].co)) / 6 for f in island
                       for i in range(1, len(f.verts) - 1)))
    bm.free()
    return out


def recheck_small_islands(model, report):
    """Drop the kit's inside-out error for a part whose closed islands all have a positive volume, unrounded."""
    kept = []
    for e in report["errors"]:
        name = e.split(":")[0]
        if "inside out" in e and name in model.parts and all(v > 0 for v in island_volumes(model.parts[name].obj)):
            report["parts"][name].setdefault("notes", []).append(
                "the kit's inside-out count is its rounding: every closed island has a positive volume "
                f"(smallest {min(island_volumes(model.parts[name].obj)):.2e} m^3)")
            report["parts"][name]["inside_out_islands"] = 0
            report["parts"][name]["errors"] = [x for x in report["parts"][name]["errors"] if "inside out" not in x]
            continue
        kept.append(e)
    report["errors"] = kept
    return report
def measured(model):
    """Dimensions read back off the built meshes, for the report and the tests."""
    me = model.parts["Bay"].obj.data
    skin = [v.co for v in me.vertices if abs(math.hypot(v.co.x, v.co.z - AXIS) - (RS - 0.002)) < 1e-4]
    us = [-v.y for v in skin]
    angs = [math.atan2(v.z - AXIS, v.x) for v in skin]
    lip = [v.co for v in me.vertices if abs(math.hypot(v.co.x, v.co.z - AXIS) - (R - RELIEF)) < 1e-4]
    seat = model.parts["Seat"].obj.data
    zs = [v.co.z - FLOOR for v in seat.vertices]
    return {
        "window_opening_at_skin_m": [round(max(us) - min(us), 4), round((RS - 0.002) * (max(angs) - min(angs)), 4)],
        "window_centre_above_floor_m": round(((RS - 0.002) * math.sin((max(angs) + min(angs)) / 2) + AXIS) - FLOOR, 4),
        "trim_opening_m": [round(max(-v.y for v in lip) - min(-v.y for v in lip), 4)],
        "trim_radius_m": round(R, 4),
        "seat_back_top_m": round(max(zs), 4),
        "bay_half_length_m": round(max(-v.co.y for v in me.vertices), 4),
    }


def main():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    def opt(name, default=None):
        return args[args.index(name) + 1] if name in args else default
    out = os.path.abspath(opt("--out", os.path.join(HERE, "..", "..", "public", "models", "aircraft")))
    blend = opt("--blend")
    rays = int(opt("--rays", "144"))
    ak.reset_scene()
    model = ak.Model("Cabin")
    build_bay(model)
    build_filler(model)
    shade = build_shade(model)
    panes = build_panes(model)
    seat_info = build_seat(model)
    build_armrest(model)
    bin_info = build_bin(model)
    psu_info = build_psu(model)
    orient_all(model)
    # the seats' lateral centre for the bake: the F seat (spec's seat and triple widths, aisle)
    arm = (F(CA["triple_width"]) - 3 * F(CA["seat_width"])) / 4
    seat_x = F(CA["aisle"]) / 2 + F(CA["triple_width"]) - arm - F(CA["seat_width"]) / 2
    tree = build_context(model, seat_x)
    wall_trees = [build_context(model, seat_x, offset=k * F(CA["pitch"]) / 4) for k in range(4)]
    pitch = 20.5 * 0.0254
    placements = {"Bay": translation(0.0), "Filler": translation(pitch / 2) @ Matrix.Diagonal(Vector((1, pitch - 2 * HALF, 1, 1))),
                  "Shade": translation(0.0),
                  "Seat": translation(-0.55, seat_x), "Armrest": translation(-0.55, seat_x + F(CA["seat_width"]) / 2 + arm / 2),
                  "Bin": translation(0.0)}
    for p in panes:
        placements[p] = translation(0.0)
    placements["Psu"] = translation(-0.55)
    shared = {"Bay", "Filler", "Shade", "Bin", "PaneInner", "PaneMiddle", "PaneOuter"}
    stats = bake(model, {k: v for k, v in placements.items() if k in shared}, wall_trees, wash_lamps(bin_info), rays=rays)
    rest = bake(model, {k: v for k, v in placements.items() if k not in shared}, [tree], wash_lamps(bin_info), rays=rays,
                peak=stats.pop("_peak"), soft=True)
    rest.pop("_peak")
    stats.update(rest)
    report = recheck_small_islands(model, model.check(max_tris=CABIN_TRIS))
    report["bake"] = stats
    report["measured"] = measured(model)
    glb = os.path.join(out, "cabin.glb")
    if not report["errors"]:
        model.export(glb)
        info = {
            "format": "skyline-cabin/1",
            "frame": "glTF axes: +x right (the model is the right side; mirror x for the left), +y up in body axes "
                     "(metres above the main-gear contact plane), +z aft of each part's anchor station",
            "anchors": {"Bay": "the window's centre station", "Filler": "the middle of the gap it fills; scale z to its "
                        "length (its own length is 1 m)", "Shade": "the window's centre station",
                        "PaneInner": "the window's centre station", "PaneMiddle": "the window's centre station",
                        "PaneOuter": "the window's centre station", "Seat": "the seat's front station, x on its centre",
                        "Armrest": "the seat's front station, x between two seats", "Bin": "any station; scale z (1 m)",
                        "Psu": "each row's front station on the seat's side (its panel runs from psu.from to psu.to aft)"},
            "bay": {"halfLength": HALF, "square": SQUARE_V},
            "shade": shade,
            "panes": panes,
            "seat": seat_info,
            "bin": bin_info,
            "psu": psu_info,
            "attribute": {"name": "_CABIN", "r": "ambient occlusion within 0.6 m (on Seat, Armrest and Psu a hit at d open by (d / 0.6)^0.7)", "g": "window-wash light, 1 at "
                          "the brightest sidewall corner", "b": "window form factor: share of the cosine-weighted "
                          "hemisphere seeing out through a window", "a": "1; 0.5 on the PSU's forward half (the always-lit "
                          "no-smoking sign)"},
            "materials": COLORS,
            "triangles": report["tris"],
        }
        with open(os.path.join(out, "cabin.json"), "w", encoding="utf-8") as fh:
            json.dump(info, fh, indent=1)
        report["files"] = {"glb": "cabin.glb", "json": "cabin.json", "glb_bytes": os.path.getsize(glb)}
    with open(os.path.join(HERE, "cabin.report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=1)
    print(f"cabin: {report['tris']} tris, {len(model.parts)} nodes, errors {report['errors']}")
    for name, r in report["parts"].items():
        if r["warnings"]:
            print("  warning", name, r["warnings"])
    print("  measured", report["measured"])
    print("  bake", stats)
    if blend:
        model.save_blend(blend)
    if report["errors"]:
        raise RuntimeError("; ".join(report["errors"]))


if __name__ == "__main__":
    main()
