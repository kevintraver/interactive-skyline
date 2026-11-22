"""Six generic traffic bodies for the drive (plan 02, task D6.3), built procedurally in headless Blender.

    python .claude/skills/blender-landmark-model/scripts/run_blender.py models/drive/vehicles/build_vehicles.py \
        -- --out public/models/drive

Writes <out>/vehicles.glb (twelve mesh nodes, `<body>_lod0` and `<body>_lod1`), <out>/vehicles.json (the
sidecar: dimensions, budgets, lamp positions, traffic mix, paint palette), and next to this script
vehicles.report.json (the kit's mesh check per node) and vehicles.blend (git-ignored).

Made for instancing: every mesh has ONE material (`VehicleBody`, white, roughness 0.55) and carries its colour
per corner in COLOR_0 (linear RGB). Paintable surfaces are white in COLOR_0 and 1.0 in the `_PAINT` attribute
(float scalar, 0 or 1; three.js's GLTFLoader names it `_paint`); everything else (glass, tyres, rims, trim,
bumpers, lamp lenses, the trailer box) has its own baked colour and `_PAINT` 0. The app multiplies paint by a
per-instance colour: colour = COLOR_0 * mix(1, instanceColor, _paint).

Axes in the GLB: glTF, +Y up, the vehicle faces -Z, right side +X, origin on the ground under the centre of
the footprint, metres. (Inside Blender: faces +Y, up +Z; the exporter turns Blender (x, y, z) into glTF
(x, z, -y).)

No badges, wordmarks, recognisable grilles or lamp signatures: grilles are plain dark rectangles, lamps plain
rectangular lenses. Nothing here is named after a maker or a model.

DIMENSIONS, metres (L length, W body width without mirrors, H height, WB wheelbase, D tyre diameter)
Class ranges are from published specifications of current US vehicles of each class, recalled rather than
re-fetched for this build ("recalled"); the regulation figures are cited.

  sedan        L 4.90  W 1.84  H 1.45  WB 2.83  D 0.67   US midsize sedan: L 4.80-5.00, W 1.80-1.87,
               H 1.42-1.48, WB 2.75-2.92 (recalled). Tyre 215/55R17 = 0.668 m (tyre-size arithmetic).
  crossover    L 4.60  W 1.86  H 1.70  WB 2.69  D 0.73   US compact crossover/SUV, the best-selling class:
               L 4.50-4.75, W 1.82-1.90, H 1.62-1.75, WB 2.62-2.78 (recalled). Tyre 225/65R17 = 0.725 m.
  pickup       L 5.89  W 2.03  H 1.97  WB 3.68  D 0.82   US full-size crew-cab pickup, 5.5 ft bed:
               L 5.80-5.95, W 2.00-2.06, H 1.90-2.00, WB 3.60-3.70 (recalled). Tyre 275/65R18 = 0.815 m.
  van          L 5.93  W 2.02  H 2.55  WB 3.66  D 0.74   US full-size van, 148 in wheelbase, medium roof:
               L 5.90-6.00, W 2.00-2.05, H 2.45-2.60, WB 3.60-3.70 (recalled). Tyre 235/65R16 = 0.711 m,
               drawn 0.74 (estimated, LT sizes run larger).
  tractor_trailer  L 22.3 overall, W 2.59, H 4.11, tractor WB 5.90, D 1.05
               Trailer: 53 ft = 16.15 m dry van, the US standard (STAA 1982 lets states set >= 48 ft; 53 ft
               is the common maximum). Width 102 in = 2.59 m, the federal maximum (23 CFR 658.15). Height
               13 ft 6 in = 4.11 m, the usual western-state limit (no federal limit). Kingpin 36 in = 0.91 m
               behind the trailer front (standard setting, recalled). Tractor: long-nose sleeper,
               bumper-to-back-of-cab 125 in = 3.18 m plus a 72 in = 1.83 m sleeper (common spec, recalled),
               wheelbase 5.90 m (typical 220-250 in, recalled), tandem spread 52 in = 1.32 m (recalled).
               Overall 22.3 m = 73 ft, inside the 70-75 ft that a 53 ft trailer behind a sleeper gives.
               Tyres 11R22.5 = 1.05 m (tyre-size arithmetic, rounded). Trailer tandem at the rear,
               spread 1.22 m, rear axle 1.5 m from the rear (estimated, slider positions vary).
  coach        L 13.72 W 2.59 H 3.50  WB 7.24 (front to drive axle), tag axle 1.37 behind, D 1.05
               45 ft intercity coach: L 45 ft = 13.72 m, W 102 in, H about 11 ft 6 in = 3.5 m, front-to-drive
               axle about 285 in = 7.24 m (published coach specs, recalled).

Everything else (overhangs, belt and roof heights, glass rake, lamp sizes and heights) is estimated from the
proportions of the classes; lamp heights are inside the FMVSS 108 mounting-height windows (headlamps
22-54 in = 0.56-1.37 m, tail and stop lamps 15-72 in = 0.38-1.83 m), recalled.

Lamps (sidecar `lamps`): headlamps, tail lamps (also stop and turn), the centre high-mounted stop lamp
(FMVSS 108 requires it below 80 in = 2.03 m overall width: so the four light bodies have one and the
tractor-trailer and coach do not), front (amber) and rear (red) side markers, and for vehicles 80 in or wider
the clearance, identification and intermediate side marker lamps.

MIX (sidecar `mix`, ASSUMED, not data): light vehicles sedan 0.28, crossover 0.46 (SUVs and minivans fold in
here), pickup 0.20, van 0.06. Trucks (FHWA classes 4-13): tractor_trailer 0.90, coach 0.10 (single-unit
trucks have no body of their own and are drawn as tractor_trailer or van by the renderer's choice).
PALETTE (sidecar `palette`, ASSUMED): twelve common US paint colours, weights shaped like the published
popularity surveys (white, black, grey and silver about three quarters), not taken from one.
"""
from __future__ import annotations

import json
import math
import os
import sys

import bmesh
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_kit as kit  # noqa: E402

# ---------------------------------------------------------------------------------------------- colours
# sRGB hex. Only "Paint" is paint; it is white so the instance colour shows as it is.
COLORS = {
    "Paint": "FFFFFF",
    "Glass": "1B2128",
    "Tyre": "1B1B1C",
    "Rim": "8C9094",
    "Trim": "2B2C2E",
    "Under": "161718",
    "Grille": "141516",
    "HeadLens": "C9CDD2",
    "TailLens": "7C1515",
    "Amber": "B8690F",
    "Chrome": "B3B7BB",
    "BedLiner": "232425",
    "Plate": "D9D9D0",
    "Trailer": "E4E4E0",
    "TrailerDoor": "CBCBC6",
    "Skirt": "4A4D51",
    "Frame": "1F2022",
}
PAINT = "Paint"
MATERIAL_NAME = "VehicleBody"
PAINT_ATTRIBUTE = "_PAINT"
COLOR_ATTRIBUTE = "Col"
LOD0_BUDGET = {"sedan": 700, "crossover": 700, "pickup": 700, "van": 700, "tractor_trailer": 950, "coach": 800}
LOD1_BUDGET = {"sedan": 70, "crossover": 70, "pickup": 80, "van": 70, "tractor_trailer": 100, "coach": 70}

# ---------------------------------------------------------------------------------------------- specs
# y runs rear (-L/2) to front (+L/2); x is the body's right; z up. Per body: dimensions (see the table at the
# top), the lower-body profile (y, bottom, top, half-width scale), the greenhouse, lamps.
CARS = {
    "sedan": dict(
        L=4.90, W=1.84, H=1.45, WB=2.83, front_overhang=0.98, tyre_d=0.668, tyre_w=0.22, track=1.60,
        sill=0.20,
        profile=[(-2.45, 0.34, 0.92, 0.90), (-2.32, 0.24, 1.02, 0.97), (-1.60, 0.20, 1.00, 1.0),
                 (0.95, 0.20, 0.97, 1.0), (1.95, 0.20, 0.88, 0.99), (2.33, 0.22, 0.80, 0.95),
                 (2.45, 0.30, 0.72, 0.86)],
        rocker=PAINT,
        gh=dict(z0=0.95, zroof=1.45, wb=0.86, wr=0.64,
                stations=[(0.95, 0.10, "Glass"), (-0.12, -0.12, "Trim"), (-0.24, -0.24, "Glass"),
                          (-1.05, -0.78, PAINT), (-1.58, -0.92, None)],
                front="Glass", rear="Glass"),
        head_z=(0.60, 0.70), head_x=(0.40, 0.76), grille=(0.34, 0.42, 0.56), bumper_z=(0.22, 0.42),
        tail_z=(0.82, 0.94), tail_x=(0.50, 0.86), rear_bumper_z=(0.26, 0.48), plate_z=(0.58, 0.72),
        chmsl="backlight", mirrors=True,
    ),
    "crossover": dict(
        L=4.60, W=1.86, H=1.70, WB=2.69, front_overhang=0.92, tyre_d=0.725, tyre_w=0.23, track=1.60,
        sill=0.30,
        profile=[(-2.30, 0.42, 1.08, 0.94), (-2.18, 0.32, 1.14, 0.98), (-1.70, 0.30, 1.14, 1.0),
                 (0.85, 0.30, 1.11, 1.0), (1.75, 0.30, 1.05, 0.99), (2.17, 0.32, 0.98, 0.96),
                 (2.30, 0.40, 0.88, 0.88)],
        rocker="Trim",
        gh=dict(z0=1.09, zroof=1.70, wb=0.86, wr=0.71,
                stations=[(0.85, 0.06, "Glass"), (-0.16, -0.16, "Trim"), (-0.28, -0.28, "Glass"),
                          (-1.40, -1.40, "Trim"), (-1.52, -1.52, "Glass"), (-1.86, -1.80, PAINT),
                          (-2.20, -2.02, None)],
                front="Glass", rear="Glass"),
        head_z=(0.80, 0.90), head_x=(0.42, 0.78), grille=(0.36, 0.48, 0.70), bumper_z=(0.32, 0.50),
        tail_z=(0.98, 1.12), tail_x=(0.54, 0.88), rear_bumper_z=(0.34, 0.56), plate_z=(0.70, 0.84),
        chmsl="spoiler", mirrors=True,
    ),
    "pickup": dict(
        L=5.89, W=2.03, H=1.97, WB=3.68, front_overhang=0.98, tyre_d=0.815, tyre_w=0.27, track=1.74,
        sill=0.42,
        profile=[(-2.945, 0.52, 1.33, 0.99), (-1.00, 0.42, 1.33, 1.0), (1.10, 0.42, 1.31, 1.0),
                 (2.75, 0.42, 1.25, 0.99), (2.945, 0.46, 1.16, 0.95)],
        rocker="Trim",
        bed=(-2.90, -0.97),
        gh=dict(z0=1.29, zroof=1.97, wb=0.95, wr=0.80,
                stations=[(1.10, 0.38, "Glass"), (-0.02, -0.02, "Trim"), (-0.14, -0.14, "Glass"),
                          (-0.92, -0.88, None)],
                front="Glass", rear=PAINT),
        head_z=(0.98, 1.10), head_x=(0.60, 0.88), grille=(0.56, 0.58, 1.08), bumper_z=(0.42, 0.64),
        bumper_mat="Chrome",
        tail_z=(0.92, 1.28), tail_x=(0.86, 0.98), rear_bumper_z=(0.50, 0.72), rear_bumper_mat="Chrome",
        plate_z=(0.54, 0.68), chmsl="cab", mirrors=True, cab_window=(0.62, 1.48, 1.80),
    ),
    "van": dict(
        L=5.93, W=2.02, H=2.55, WB=3.66, front_overhang=0.95, tyre_d=0.74, tyre_w=0.24, track=1.72,
        sill=0.40,
        profile=[(-2.965, 0.50, 1.21, 0.99), (-2.85, 0.42, 1.21, 1.0), (2.15, 0.40, 1.20, 1.0),
                 (2.80, 0.40, 1.04, 0.98), (2.965, 0.44, 0.95, 0.93)],
        rocker="Trim",
        gh=dict(z0=1.18, zroof=2.55, wb=1.00, wr=0.94, rail=0.10,
                stations=[(2.15, 1.25, "Glass"), (0.98, 0.98, "Trim"), (0.86, 0.86, PAINT),
                          (-2.955, -2.955, None)],
                front="Glass", rear=PAINT, lod1_side=PAINT),
        head_z=(0.88, 1.00), head_x=(0.50, 0.84), grille=(0.42, 0.56, 0.84), bumper_z=(0.40, 0.60),
        tail_z=(0.82, 1.30), tail_x=(0.86, 0.98), rear_bumper_z=(0.42, 0.62), plate_z=(0.68, 0.82),
        chmsl="roof", mirrors=True, rear_windows=(0.14, 0.84, 1.50, 2.08),
    ),
}

# FMVSS-style lamp colours in the sidecar
AMBER, RED, WHITE = "amber", "red", "white"


# ---------------------------------------------------------------------------------------------- helpers
def lerp(a, b, t):
    return a + (b - a) * t


def interp(profile, y, k):
    """Column k of a profile sorted by y, linearly interpolated (clamped)."""
    if y <= profile[0][0]:
        return profile[0][k]
    for p, q in zip(profile, profile[1:]):
        if y <= q[0]:
            return lerp(p[k], q[k], (y - p[0]) / (q[0] - p[0]))
    return profile[-1][k]


def skin(b, rings, mat, cap0, cap1):
    """Faces between consecutive rings (mat(i, j) colours band i, edge j), plus end caps."""
    vr = [[b.bm.verts.new(p) for p in r] for r in rings]
    n = len(rings[0])
    for i in range(len(vr) - 1):
        for j in range(n):
            k = (j + 1) % n
            b.face((vr[i][j], vr[i][k], vr[i + 1][k], vr[i + 1][j]), mat(i, j))
    if cap0:
        b.face(vr[0][::-1], cap0)
    if cap1:
        b.face(vr[-1], cap1)


def cuboid(b, x0, x1, y0, y1, z0, z1, mat, front=None, top=None):
    """An axis-aligned box; `front` colours its +Y face, `top` its +Z face."""
    p = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
         (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    v = [b.bm.verts.new(c) for c in p]
    b.face((v[0], v[3], v[2], v[1]), mat)              # bottom
    b.face((v[4], v[5], v[6], v[7]), top or mat)       # top
    b.face((v[0], v[1], v[5], v[4]), mat)              # -Y
    b.face((v[2], v[3], v[7], v[6]), front or mat)     # +Y
    b.face((v[1], v[2], v[6], v[5]), mat)              # +X
    b.face((v[3], v[0], v[4], v[7]), mat)              # -X


def wheel(b, x, y, r, width, n=8, rim=True):
    """A wheel on the ground at (x, y): an n-sided prism along X whose flats touch r (so it stands on z=0).
    With `rim`, the outer face shows a recessed rim disc inside a tyre sidewall."""
    rp = r / math.cos(math.pi / n)
    side = 1.0 if x >= 0 else -1.0
    x_in, x_out = x - side * width / 2, x + side * width / 2

    def ring(xx, rr):
        return [(xx, y + rr * math.cos(2 * math.pi * (j + 0.5) / n), r + rr * math.sin(2 * math.pi * (j + 0.5) / n))
                for j in range(n)]
    if rim:
        rings = [ring(x_in, rp), ring(x_out, rp), ring(x_out - side * 0.025, rp * 0.62)]
        skin(b, rings, lambda i, j: "Tyre", "Tyre", "Rim")
    else:
        skin(b, [ring(x_in, rp), ring(x_out, rp)], lambda i, j: "Tyre", "Tyre", "Rim")


def lower_body(b, profile, arches, rocker, top_mat=None):
    """The body below the belt: an 8-point section lofted front to back; wheel arches lift its bottom.
    profile rows: (y, bottom, top, half-width); arches: (y, centre z, radius)."""
    ys = {round(p[0], 4) for p in profile}
    sill = min(p[1] for p in profile)
    for (yw, zc, R) in arches:
        t0 = math.asin(max(-1.0, min(1.0, (sill - zc) / R)))
        for k in range(5):
            t = lerp(t0, math.pi - t0, k / 4)
            ys.add(round(yw + R * math.cos(t), 4))
    ys = sorted(ys)
    rings, mids = [], []
    for y in ys:
        zb, zt, w = interp(profile, y, 1), interp(profile, y, 2), interp(profile, y, 3)
        for (yw, zc, R) in arches:
            dy = y - yw
            if abs(dy) < R - 1e-6:
                zb = max(zb, zc + math.sqrt(R * R - dy * dy))
        h = zt - zb
        c1, c2 = min(0.10, 0.25 * h), min(0.14, 0.3 * h)
        wi = w - min(0.07, 0.08 * w)
        rings.append([(-0.92 * w, y, zb), (-w, y, zb + c1), (-w, y, zt - c2), (-wi, y, zt),
                      (wi, y, zt), (w, y, zt - c2), (w, y, zb + c1), (0.92 * w, y, zb)])
    for a, c in zip(ys, ys[1:]):
        mids.append((a + c) / 2)

    def mat(i, j):
        if j == 7:
            return "Under"
        if j in (0, 6):
            return rocker
        if j == 3 and top_mat:
            return top_mat(mids[i])
        return PAINT
    skin(b, rings, mat, PAINT, PAINT)


def greenhouse(b, z0, zroof, wb, wr, stations, front, rear, rail=0.07, rail_mat=PAINT):
    """Cabin above the belt: a 6-point section per station, belt points at y_belt and roof points at
    y_roof (so windshield and backlight rake). stations: (y_belt, y_roof, material of the side faces from
    this station to the next), front to rear."""
    zrail = zroof - rail
    wrail = min(wb, wr + 0.03)
    rings = []
    for yb, yr, _ in stations:
        yrail = lerp(yb, yr, (zrail - z0) / (zroof - z0))
        rings.append([(-wb, yb, z0), (-wrail, yrail, zrail), (-wr, yr, zroof),
                      (wr, yr, zroof), (wrail, yrail, zrail), (wb, yb, z0)])

    def mat(i, j):
        if j in (0, 4):
            return stations[i][2]
        if j in (1, 3):
            return rail_mat
        if j == 2:
            return PAINT
        return "Under"
    skin(b, rings, mat, front, rear)


# ---------------------------------------------------------------------------------------------- cars
def car_lod0(name, s):
    b = kit.Builder(COLORS)
    L, w = s["L"], s["W"] / 2
    yf, yr = L / 2, -L / 2
    r = s["tyre_d"] / 2
    ya = yf - s["front_overhang"]
    axles = [ya, ya - s["WB"]]
    profile = [(p[0], p[1], p[2], p[3] * w) for p in s["profile"]]
    arches = [(y, r, r + 0.05) for y in axles]
    top_mat = None
    if "bed" in s:
        y0, y1 = s["bed"]
        top_mat = lambda y: "BedLiner" if y0 < y < y1 else PAINT  # noqa: E731
    lower_body(b, profile, arches, s["rocker"], top_mat)
    g = s["gh"]
    greenhouse(b, g["z0"], g["zroof"], g["wb"], g["wr"], g["stations"],
               g["front"], g["rear"], g.get("rail", 0.07))
    for y in axles:
        for sx in (-1, 1):
            wheel(b, sx * (s["track"] / 2), y, r, s["tyre_w"])

    lamps = {"head": [], "tail": [], "chmsl": None, "side_marker_front": [], "side_marker_rear": [],
             "clearance": []}
    wf = interp(profile, yf, 3)       # half-width of the front face
    wr_ = interp(profile, yr, 3)      # and of the rear face
    # front: lower bumper/valance, plain grille, headlamps
    bz0, bz1 = s["bumper_z"]
    cuboid(b, -0.94 * wf, 0.94 * wf, yf - 0.08, yf + 0.02, bz0, bz1, s.get("bumper_mat", "Trim"))
    gw, gz0, gz1 = s["grille"]
    cuboid(b, -gw * wf, gw * wf, yf - 0.05, yf + 0.01, gz0, gz1, "Grille")
    hz0, hz1 = s["head_z"]
    hx0, hx1 = s["head_x"]
    for sx in (-1, 1):
        xa, xb = sorted((sx * hx0 * wf, sx * hx1 * wf))
        cuboid(b, xa, xb, yf - 0.05, yf + 0.01, hz0, hz1, "HeadLens")
        lamps["head"].append((sx * (hx0 + hx1) / 2 * wf, yf + 0.02, (hz0 + hz1) / 2))
    # rear: bumper, tail lamps, plate
    rz0, rz1 = s["rear_bumper_z"]
    cuboid(b, -0.95 * wr_, 0.95 * wr_, yr - 0.02, yr + 0.08, rz0, rz1, s.get("rear_bumper_mat", "Trim"))
    tz0, tz1 = s["tail_z"]
    tx0, tx1 = s["tail_x"]
    for sx in (-1, 1):
        xa, xb = sorted((sx * tx0 * wr_, sx * tx1 * wr_))
        cuboid(b, xa, xb, yr - 0.01, yr + 0.05, tz0, tz1, "TailLens")
        lamps["tail"].append((sx * (tx0 + tx1) / 2 * wr_, yr - 0.02, (tz0 + tz1) / 2))
    pz0, pz1 = s["plate_z"]
    cuboid(b, -0.16, 0.16, yr - 0.015, yr + 0.05, pz0, pz1, "Plate")
    # side markers, near the corners at lamp height
    for sx in (-1, 1):
        y = yf - 0.18
        lamps["side_marker_front"].append((sx * (interp(profile, y, 3) + 0.01), y, (hz0 + hz1) / 2 - 0.04))
        y = yr + 0.16
        lamps["side_marker_rear"].append((sx * (interp(profile, y, 3) + 0.01), y, (tz0 + tz1) / 2))
    # centre high-mounted stop lamp
    zroof, st = g["zroof"], g["stations"]
    if s["chmsl"] == "backlight":
        lamps["chmsl"] = (0.0, st[-1][1] - 0.04, zroof - 0.03)
    elif s["chmsl"] == "spoiler":
        lamps["chmsl"] = (0.0, st[-1][1] - 0.02, zroof - 0.02)
    elif s["chmsl"] == "cab":
        lamps["chmsl"] = (0.0, st[-1][1] - 0.02, zroof - 0.04)
    elif s["chmsl"] == "roof":
        lamps["chmsl"] = (0.0, yr - 0.02, zroof - 0.08)
    if s.get("mirrors"):
        yb0 = st[0][0]
        for sx in (-1, 1):
            xa, xb = sorted((sx * (g["wb"] - 0.02), sx * (g["wb"] + 0.17)))
            cuboid(b, xa, xb, yb0 - 0.50, yb0 - 0.40, g["z0"] - 0.02, g["z0"] + 0.13, PAINT)
    if "cab_window" in s:
        hw, z0, z1 = s["cab_window"]
        y = st[-1][0] + (st[-1][1] - st[-1][0]) * 0.5
        cuboid(b, -hw, hw, y - 0.03, y + 0.01, z0, z1, "Glass")
    if "rear_windows" in s:
        x0, x1, z0, z1 = s["rear_windows"]
        for sx in (-1, 1):
            xa, xb = sorted((sx * x0, sx * x1))
            cuboid(b, xa, xb, yr - 0.012, yr + 0.05, z0, z1, "Glass")
    return b, lamps


def car_lod1(name, s):
    """About 60 triangles: a tapered lower box, a cabin with glass sides, an axle box per axle."""
    b = kit.Builder(COLORS)
    L, w = s["L"], s["W"] / 2
    yf, yr = L / 2, -L / 2
    r = s["tyre_d"] / 2
    ya = yf - s["front_overhang"]
    g = s["gh"]
    st = g["stations"]
    prof = s["profile"]
    zb = s["sill"] + 0.04
    stations = [(yr, interp(prof, yr, 2)), (st[0][0], interp(prof, st[0][0], 2)), (yf, interp(prof, yf, 2))]
    if "bed" in s:
        stations.insert(1, (s["bed"][1], interp(prof, s["bed"][1], 2)))
    rings = []
    for y, zt in stations:
        ww = interp(prof, y, 3) * w
        rings.append([(-ww, y, zb), (-ww, y, zt), (ww, y, zt), (ww, y, zb)])
    mids = [(a[0] + c[0]) / 2 for a, c in zip(stations, stations[1:])]

    def mat(i, j):
        if j == 3:
            return "Under"
        if j == 1 and "bed" in s and mids[i] < s["bed"][1]:
            return "BedLiner"
        return PAINT
    skin(b, rings, mat, PAINT, PAINT)
    # cabin
    z0, zr = g["z0"], g["zroof"]
    gr = []
    for yb, yrr in ((st[0][0], st[0][1]), (st[-1][0], st[-1][1])):
        gr.append([(-g["wb"], yb, z0), (-g["wr"], yrr, zr), (g["wr"], yrr, zr), (g["wb"], yb, z0)])
    side = g.get("lod1_side", "Glass")
    skin(b, gr, lambda i, j: {0: side, 1: PAINT, 2: side, 3: "Under"}[j], "Glass",
         g["rear"] if g["rear"] == PAINT else "Glass")
    for y in (ya, ya - s["WB"]):
        cuboid(b, -s["track"] / 2 - s["tyre_w"] / 2, s["track"] / 2 + s["tyre_w"] / 2, y - r * 0.92, y + r * 0.92,
               0.0, 2 * r * 0.96, "Tyre")
    return b


# ---------------------------------------------------------------------------------------------- tractor-trailer
TT = dict(L_tractor_front=11.0, steer_y=9.75,  # steer axle 1.25 m behind the bumper (estimated)
          WB=5.90, tandem=1.32, fifth_wheel_ahead=0.15, kingpin=0.91,
          trailer_L=16.15, W=2.59, H=4.11, tyre_d=1.05, trailer_floor=1.22, trailer_axle_from_rear=1.50,
          trailer_tandem=1.22)


def tt_layout():
    t = TT
    drive_c = t["steer_y"] - t["WB"]
    fifth = drive_c + t["fifth_wheel_ahead"]
    trailer_front = fifth + t["kingpin"]
    trailer_rear = trailer_front - t["trailer_L"]
    shift = -(t["L_tractor_front"] + trailer_rear) / 2   # centre the footprint on the origin
    return dict(shift=shift, front=t["L_tractor_front"] + shift, steer=t["steer_y"] + shift,
                drive=(drive_c + t["tandem"] / 2 + shift, drive_c - t["tandem"] / 2 + shift),
                trailer_front=trailer_front + shift, trailer_rear=trailer_rear + shift,
                trailer_axles=(trailer_rear + shift + t["trailer_axle_from_rear"] + t["trailer_tandem"],
                               trailer_rear + shift + t["trailer_axle_from_rear"]),
                L=t["L_tractor_front"] - trailer_rear)


def tt_lod0():
    b = kit.Builder(COLORS)
    t, k = TT, tt_layout()
    r = t["tyre_d"] / 2
    w = t["W"] / 2
    yf = k["front"]
    cab_front, cab_back = yf - 1.95, yf - 3.18 - 1.83   # windshield base; back of a 72 in sleeper   # bumper-to-back-of-cab 125 in, + sleeper
    # hood and fenders: a lower body from the bumper back to the cab, arch over the steer wheels
    hood = [(cab_front - 0.05, 0.95, 2.14, 1.14), (yf - 0.45, 0.80, 1.90, 1.10), (yf - 0.12, 0.72, 1.76, 1.02),
            (yf, 0.75, 1.64, 0.92)]
    hood.sort()
    lower_body(b, hood, [(k["steer"], r, r + 0.10)], PAINT)
    cuboid(b, -0.92, 0.92, yf - 0.10, yf + 0.03, 0.42, 0.78, "Chrome")                  # bumper
    cuboid(b, -0.48, 0.48, yf - 0.06, yf + 0.008, 0.88, 1.52, "Grille")                 # plain grille
    lamps = {"head": [], "tail": [], "chmsl": None, "side_marker_front": [], "side_marker_rear": [],
             "clearance": []}
    for sx in (-1, 1):
        xa, xb = sorted((sx * 0.56, sx * 0.86))
        cuboid(b, xa, xb, yf - 0.16, yf - 0.04, 0.95, 1.10, "HeadLens")
        lamps["head"].append((sx * 0.71, yf - 0.03, 1.025))
    # cab and sleeper: lower part, then a greenhouse with the windshield and door glass, sleeper sides paint
    cab_w = 1.22
    cab_prof = [(cab_back, 0.95, 2.14, cab_w), (cab_front, 0.95, 2.14, cab_w)]
    lower_body(b, cab_prof, [], PAINT)
    greenhouse(b, 2.10, 3.10, cab_w, 1.12,
               [(cab_front, cab_front - 0.42, "Glass"), (cab_front - 1.25, cab_front - 1.25, PAINT),
                (cab_back, cab_back, None)], "Glass", PAINT, rail=0.12)
    # roof fairing up to the trailer's height, and the sleeper top
    fair = [(cab_back, 3.04, 4.00, 1.12), (cab_front - 1.95, 3.04, 3.98, 1.10), (cab_front - 0.75, 3.04, 3.12, 1.0)]
    lower_body(b, fair, [], PAINT)
    # frame, fuel tanks, exhaust stacks, fifth wheel deck
    cuboid(b, -0.46, 0.46, k["drive"][1] - 0.95, yf - 0.30, 0.62, 1.00, "Frame")
    for sx in (-1, 1):
        xa, xb = sorted((sx * 0.62, sx * 1.22))
        cuboid(b, xa, xb, cab_back + 0.05, cab_front - 0.25, 0.42, 1.02, "Chrome")       # fuel tank
        xa, xb = sorted((sx * 1.04, sx * 1.16))
        cuboid(b, xa, xb, cab_back - 0.20, cab_back - 0.08, 1.0, 4.05, "Chrome")         # stack
    # wheels: steer singles, drive duals (one wide tyre each side)
    for sx in (-1, 1):
        wheel(b, sx * 1.02, k["steer"], r, 0.30, rim=True)
        for y in k["drive"]:
            wheel(b, sx * (w - 0.31), y, r, 0.58, rim=True)
    # the trailer: 53 ft box on its floor, rear doors, underride guard, skirts, landing gear, tandem
    yt0, yt1 = k["trailer_rear"], k["trailer_front"]
    z0 = t["trailer_floor"]
    v = [(-w, yt0, z0), (w, yt0, z0), (w, yt1, z0), (-w, yt1, z0),
         (-w, yt0, t["H"]), (w, yt0, t["H"]), (w, yt1, t["H"]), (-w, yt1, t["H"])]
    vv = [b.bm.verts.new(p) for p in v]
    b.face((vv[0], vv[3], vv[2], vv[1]), "Frame")
    b.face((vv[4], vv[5], vv[6], vv[7]), "Trailer")
    b.face((vv[0], vv[1], vv[5], vv[4]), "TrailerDoor")
    b.face((vv[2], vv[3], vv[7], vv[6]), "Trailer")
    b.face((vv[1], vv[2], vv[6], vv[5]), "Trailer")
    b.face((vv[3], vv[0], vv[4], vv[7]), "Trailer")
    cuboid(b, -w + 0.02, w - 0.02, yt0 + 0.02, yt1 - 0.02, z0 - 0.16, z0 + 0.01, "Frame")      # bottom rail
    cuboid(b, -1.18, 1.18, yt0 + 0.10, yt0 + 0.22, 0.48, 0.62, "Frame")                        # underride bar
    cuboid(b, -0.03, 0.03, yt0 - 0.01, yt0 + 0.01, z0 + 0.15, t["H"] - 0.15, "Frame")          # door seam
    ta = k["trailer_axles"]
    for sx in (-1, 1):
        xa, xb = sorted((sx * (w - 0.10), sx * (w - 0.07)))
        cuboid(b, xa, xb, ta[0] + 0.85, yt1 - 3.6, 0.42, z0 - 0.10, "Skirt")                   # side skirt
        xa, xb = sorted((sx * 0.70, sx * 0.86))
        cuboid(b, xa, xb, yt1 - 3.05, yt1 - 2.92, 0.05, z0 - 0.10, "Frame")                    # landing gear
        for y in ta:
            wheel(b, sx * (w - 0.31), y, r, 0.58, rim=True)
    cuboid(b, -0.55, 0.55, ta[1] - 0.70, ta[0] + 0.70, r + 0.10, z0 - 0.12, "Frame")           # slider box
    # rear lamps on the trailer, cab-roof lamps on the tractor, trailer markers
    ztail = 1.02
    for sx in (-1, 1):
        xa, xb = sorted((sx * 0.92, sx * 1.18))
        cuboid(b, xa, xb, yt0 - 0.02, yt0 + 0.05, ztail - 0.10, ztail + 0.10, "TailLens")
        lamps["tail"].append((sx * 1.05, yt0 - 0.03, ztail))
        lamps["side_marker_front"].append((sx * 1.13, yf - 0.55, 1.62))
        lamps["side_marker_rear"].append((sx * (w + 0.01), yt0 + 0.30, 1.10))
    C = lamps["clearance"]

    def add(p, color, kind, facing):
        C.append({"p": p, "color": color, "kind": kind, "facing": facing})
    # tractor cab roof (on the fairing's front edge): three identification + two clearance lamps, amber
    zc, yc = 3.13, cab_front - 0.76
    for x in (-0.30, 0.0, 0.30):
        add((x, yc + 0.02, zc + 0.02), AMBER, "identification", "front")
    for sx in (-1, 1):
        add((sx * 1.06, yc + 0.02, zc - 0.05), AMBER, "clearance", "front")
    # trailer front upper corners (amber), rear upper corners (red), rear identification (red)
    for sx in (-1, 1):
        add((sx * (w - 0.04), yt1 + 0.01, t["H"] - 0.08), AMBER, "clearance", "front")
        add((sx * (w - 0.04), yt0 - 0.01, t["H"] - 0.08), RED, "clearance", "rear")
    for x in (-0.25, 0.0, 0.25):
        add((x, yt0 - 0.01, t["H"] - 0.10), RED, "identification", "rear")
    # trailer sides: front marker (amber), intermediate side markers (amber) along the bottom rail,
    # and the upper rail markers many vans carry (amber, estimated spacing)
    for sx in (-1, 1):
        side = "right" if sx > 0 else "left"
        add((sx * (w + 0.01), yt1 - 0.30, z0 - 0.05), AMBER, "side_marker", side)
        for frac in (0.25, 0.5, 0.75):
            add((sx * (w + 0.01), lerp(yt1, yt0, frac), z0 - 0.05), AMBER, "intermediate_side_marker", side)
        for frac in (0.0, 0.5, 1.0):
            add((sx * (w + 0.01), lerp(yt1 - 0.15, yt0 + 0.15, frac), t["H"] - 0.10), AMBER, "upper_marker", side)
    return b, lamps


def tt_lod1():
    b = kit.Builder(COLORS)
    t, k = TT, tt_layout()
    r, w = t["tyre_d"] / 2, t["W"] / 2
    yf = k["front"]
    cab_front, cab_back = yf - 1.95, yf - 3.18 - 1.83   # windshield base; back of a 72 in sleeper
    skin(b, [[(-1.12, cab_front, 0.95), (-1.12, cab_front, 2.12), (1.12, cab_front, 2.12), (1.12, cab_front, 0.95)],
             [(-0.95, yf, 0.75), (-0.95, yf, 1.62), (0.95, yf, 1.62), (0.95, yf, 0.75)]],
         lambda i, j: "Under" if j == 3 else PAINT, PAINT, "Grille")
    cuboid(b, -1.22, 1.22, cab_back, cab_front, 0.95, 3.98, PAINT, front="Glass")
    cuboid(b, -w, w, k["trailer_rear"], k["trailer_front"], t["trailer_floor"] - 0.1, t["H"], "Trailer")
    for ys in ((k["steer"], k["steer"]), k["drive"], k["trailer_axles"]):
        cuboid(b, -w + 0.02, w - 0.02, min(ys) - r * 0.9, max(ys) + r * 0.9, 0.0, 2 * r * 0.95, "Tyre")
    return b


# ---------------------------------------------------------------------------------------------- coach
CO = dict(L=13.72, W=2.59, H=3.50, front_axle_from_front=2.40, WB=7.24, tag=1.37, tyre_d=1.05)


def coach_layout():
    c = CO
    yf = c["L"] / 2
    fa = yf - c["front_axle_from_front"]
    return dict(yf=yf, yr=-yf, axles=(fa, fa - c["WB"], fa - c["WB"] - c["tag"]))


def coach_lod0():
    b = kit.Builder(COLORS)
    c, k = CO, coach_layout()
    r, w = c["tyre_d"] / 2, c["W"] / 2
    yf, yr = k["yf"], k["yr"]
    prof = [(yr, 0.42, 2.02, w), (yr + 0.25, 0.36, 2.02, w), (yf - 0.30, 0.36, 2.02, w), (yf, 0.46, 1.95, w - 0.06)]
    lower_body(b, prof, [(y, r, r + 0.07) for y in k["axles"]], "Trim")
    greenhouse(b, 1.98, c["H"], w - 0.01, w - 0.13,
               [(yf - 0.02, yf - 0.40, "Glass"), (yr + 1.75, yr + 1.75, PAINT), (yr + 0.02, yr + 0.02, None)],
               "Glass", PAINT, rail=0.42)
    lamps = {"head": [], "tail": [], "chmsl": None, "side_marker_front": [], "side_marker_rear": [],
             "clearance": []}
    cuboid(b, -w + 0.04, w - 0.04, yf - 0.06, yf + 0.02, 0.40, 0.66, "Trim")              # bumper
    cuboid(b, -0.70, 0.70, yf - 0.05, yf + 0.008, 0.78, 1.16, "Grille")                    # plain grille
    cuboid(b, -w + 0.06, w - 0.06, yf - 0.43, yf - 0.33, 3.18, 3.42, "Grille")             # sign band, blank
    cuboid(b, -w + 0.04, w - 0.04, yr - 0.02, yr + 0.08, 0.42, 0.66, "Trim")              # rear bumper
    for sx in (-1, 1):
        xa, xb = sorted((sx * 0.80, sx * 1.15))
        cuboid(b, xa, xb, yf - 0.05, yf + 0.01, 0.74, 0.90, "HeadLens")
        lamps["head"].append((sx * 0.975, yf + 0.02, 0.82))
        xa, xb = sorted((sx * 0.98, sx * 1.20))
        cuboid(b, xa, xb, yr - 0.015, yr + 0.05, 0.90, 1.50, "TailLens")
        lamps["tail"].append((sx * 1.09, yr - 0.02, 1.20))
        lamps["side_marker_front"].append((sx * (w + 0.01), yf - 0.35, 0.80))
        lamps["side_marker_rear"].append((sx * (w + 0.01), yr + 0.35, 0.90))
        for y in k["axles"]:
            dual = abs(y - k["axles"][1]) < 1e-6
            wheel(b, sx * (w - (0.31 if dual else 0.20)), y, r, 0.58 if dual else 0.32, rim=True)
    cuboid(b, -0.40, 0.40, yr - 0.015, yr + 0.05, 1.70, 2.80, "Grille")                    # engine grille
    C = lamps["clearance"]

    def add(p, color, kind, facing):
        C.append({"p": p, "color": color, "kind": kind, "facing": facing})
    zt = c["H"] - 0.08
    for sx in (-1, 1):
        add((sx * (w - 0.18), yf - 0.38, zt), AMBER, "clearance", "front")
        add((sx * (w - 0.10), yr - 0.01, zt), RED, "clearance", "rear")
    for x in (-0.25, 0.0, 0.25):
        add((x, yf - 0.40, zt + 0.03), AMBER, "identification", "front")
        add((x, yr - 0.01, zt), RED, "identification", "rear")
    for sx in (-1, 1):
        side = "right" if sx > 0 else "left"
        add((sx * (w + 0.01), (k["axles"][0] + k["axles"][1]) / 2, 0.85), AMBER, "intermediate_side_marker", side)
        for frac in (0.15, 0.5, 0.85):
            add((sx * (w - 0.10), lerp(yf - 0.5, yr + 0.5, frac), c["H"] - 0.10), AMBER, "upper_marker", side)
    return b, lamps


def coach_lod1():
    b = kit.Builder(COLORS)
    c, k = CO, coach_layout()
    r, w = c["tyre_d"] / 2, c["W"] / 2
    yf, yr = k["yf"], k["yr"]
    cuboid(b, -w, w, yr, yf, 0.40, 2.02, PAINT)
    skin(b, [[(-w, yf, 1.98), (-w + 0.12, yf - 0.40, c["H"]), (w - 0.12, yf - 0.40, c["H"]), (w, yf, 1.98)],
             [(-w, yr, 1.98), (-w + 0.12, yr, c["H"]), (w - 0.12, yr, c["H"]), (w, yr, 1.98)]],
         lambda i, j: {0: "Glass", 1: PAINT, 2: "Glass", 3: "Under"}[j], "Glass", PAINT)
    a = k["axles"]
    cuboid(b, -w + 0.02, w - 0.02, a[0] - r * 0.9, a[0] + r * 0.9, 0.0, 2 * r * 0.95, "Tyre")
    cuboid(b, -w + 0.02, w - 0.02, a[2] - r * 0.9, a[1] + r * 0.9, 0.0, 2 * r * 0.95, "Tyre")
    return b


# ---------------------------------------------------------------------------------------------- finishing
def body_material() -> bpy.types.Material:
    mat = bpy.data.materials.get(MATERIAL_NAME)
    if mat:
        return mat
    mat = bpy.data.materials.new(MATERIAL_NAME)
    mat.use_nodes = True
    nt = mat.node_tree
    shader = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Roughness"].default_value = 0.55
    shader.inputs["Metallic"].default_value = 0.0
    mat.use_backface_culling = True   # closed bodies: exported single-sided
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = COLOR_ATTRIBUTE
    nt.links.new(attr.outputs["Color"], shader.inputs["Base Color"])
    return mat


def finish_vehicle(b: kit.Builder, name: str) -> bpy.types.Object:
    """Bake each face's colour slot into COLOR_0 and the paint mask into _PAINT, keep one material."""
    bm = b.bm
    glow = bm.loops.layers.float_color.get(kit.GLOW_ATTRIBUTE)
    if glow is not None:
        bm.loops.layers.float_color.remove(glow)
    col = bm.loops.layers.float_color.new(COLOR_ATTRIBUTE)
    paint = bm.loops.layers.float.new(PAINT_ATTRIBUTE)
    names = list(b.colors)
    lin = {n: kit.srgb_to_linear(h) for n, h in b.colors.items()}
    used = set()
    for f in bm.faces:
        m = names[f.material_index]
        used.add(m)
        for loop in f.loops:
            loop[col] = lin[m]
            loop[paint] = 1.0 if m == PAINT else 0.0
        f.material_index = 0
        f.smooth = True
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bmesh.ops.triangulate(bm, faces=bm.faces[:])   # so every viewer splits the bent quads alike
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(body_material())
    mesh.color_attributes.active_color = mesh.color_attributes[COLOR_ATTRIBUTE]
    mesh.color_attributes.render_color_index = mesh.color_attributes.active_color_index
    mesh.set_sharp_from_angle(angle=math.radians(35))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj["colour_slots"] = ",".join(sorted(used))
    return obj


def to_gltf(p):
    """Blender (x right, y forward, z up) -> glTF (x right, y up, z backward)."""
    return [round(p[0], 3), round(p[2], 3), round(-p[1], 3)]


def gltf_lamps(lamps):
    out = {}
    for key, val in lamps.items():
        if key == "clearance":
            out[key] = [{**c, "p": to_gltf(c["p"])} for c in val]
        elif val is None:
            out[key] = None
        elif isinstance(val, tuple):
            out[key] = to_gltf(val)
        else:
            out[key] = [to_gltf(p) for p in val]   # [left, right]: built in order sx = -1, +1
    return out


def paths():
    args = kit.parse_args()
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.abspath(args.out or here)
    return here, out, args


PALETTE = [  # sRGB, ASSUMED weights shaped like published US colour-popularity surveys
    ("white", "F2F2F0", 0.17), ("pearl white", "E8E6DF", 0.07), ("black", "141517", 0.20),
    ("dark grey", "3C3F44", 0.12), ("medium grey", "6E7276", 0.07), ("silver", "A9ADB1", 0.11),
    ("dark blue", "1E2D4F", 0.06), ("mid blue", "3A5F94", 0.04), ("red", "A0151B", 0.08),
    ("dark red", "5A1418", 0.03), ("beige", "B5A68A", 0.03), ("dark green", "2B3E33", 0.02),
]


def main():
    import logging
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s", force=True)
    here, out, args = paths()
    kit.reset_scene()
    built = {}
    for name, spec in CARS.items():
        b0, lamps = car_lod0(name, spec)
        built[name] = (b0, car_lod1(name, spec), lamps, spec["L"], spec["W"], spec["H"], spec["WB"], spec["tyre_d"])
    b0, lamps = tt_lod0()
    built["tractor_trailer"] = (b0, tt_lod1(), lamps, round(tt_layout()["L"], 3), TT["W"], TT["H"], TT["WB"],
                                TT["tyre_d"])
    b0, lamps = coach_lod0()
    built["coach"] = (b0, coach_lod1(), lamps, CO["L"], CO["W"], CO["H"], CO["WB"], CO["tyre_d"])

    report, bodies, errors, objs = {}, {}, [], []
    for name, (b0, b1, lamps, L, W, H, WB, D) in built.items():
        tris = {}
        for lod, b in (("lod0", b0), ("lod1", b1)):
            node = f"{name}_{lod}"
            obj = finish_vehicle(b, node)
            objs.append(obj)
            rep = kit.check_mesh(obj)
            rep["warnings"] = [x for x in rep["warnings"] if "_GLOW" not in x]
            budget = (LOD0_BUDGET if lod == "lod0" else LOD1_BUDGET)[name]
            if rep["tris"] > budget:
                rep["errors"].append(f"{rep['tris']} triangles is over the budget of {budget}")
            if rep["open_islands"]:
                rep["errors"].append(f"{rep['open_islands']} open islands (bodies must be closed)")
            report[node] = rep
            tris[lod] = rep["tris"]
            errors += [f"{node}: {e}" for e in rep["errors"]]
            logging.info("%s: %d tris, %d islands, bbox %s..%s %s", node, rep["tris"], rep["islands"],
                         rep["bbox_min"], rep["bbox_max"], "; ".join(rep["warnings"]))
        r0 = report[f"{name}_lod0"]
        bodies[name] = {
            "length": L, "width": W, "height": H, "wheelbase": WB, "tyre_diameter": D,
            "bbox_lod0": {"min": to_gltf_bbox(r0["bbox_min"], r0["bbox_max"])[0],
                          "max": to_gltf_bbox(r0["bbox_min"], r0["bbox_max"])[1]},
            "triangles": tris, "nodes": {"lod0": f"{name}_lod0", "lod1": f"{name}_lod1"},
            "lamps": gltf_lamps(lamps),
        }
    bodies["tractor_trailer"]["paint_note"] = "Only the tractor is paint; the trailer box has its own off-white."
    bodies["tractor_trailer"]["trailer_length"] = TT["trailer_L"]
    bodies["coach"]["tag_axle_behind_drive"] = CO["tag"]
    with open(os.path.join(here, "vehicles.report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    if errors:
        for e in errors:
            logging.info("ERROR: %s", e)
        raise RuntimeError("mesh check failed: " + "; ".join(errors))
    if args.skip_export:
        return
    os.makedirs(out, exist_ok=True)
    if bpy.app.background:
        bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(here, "vehicles.blend"))
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    glb = os.path.join(out, "vehicles.glb")
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=True, export_attributes=True, export_texcoords=False,
                              export_normals=True, export_vertex_color="ACTIVE",
                              export_all_vertex_colors=False, export_materials="EXPORT")
    repack(glb)
    sidecar = {
        "version": 1,
        "glb": "vehicles.glb",
        "axes": "glTF: +Y up, vehicle faces -Z, right side +X, origin on the ground under the footprint centre, metres",
        "material": MATERIAL_NAME,
        "colour": {"attribute": "COLOR_0", "three": "color", "space": "linear sRGB",
                   "type": "UNSIGNED_BYTE VEC4 normalized (alpha always 1)",
                   "note": "Per-corner baked colour; paintable surfaces are white. GLTFLoader turns vertexColors on."},
        "extensions_required": ["KHR_mesh_quantization"],
        "extensions_note": "Only NORMAL is quantized (normalized BYTE); GLTFLoader supports it natively.",
        "paint": {
            "attribute": PAINT_ATTRIBUTE, "three": PAINT_ATTRIBUTE.lower(), "type": "FLOAT SCALAR",
            "values": "1 on paint, 0 elsewhere (no values in between)",
            "use": "colour = COLOR_0.rgb * mix(vec3(1), instanceColor, _paint)",
        },
        "lamps_note": ("Positions in each body's glTF frame, about 1-3 cm outside the lens face. Pairs are "
                       "[left, right] (left = -X). chmsl is null where FMVSS 108 does not require one "
                       "(80 in = 2.03 m or wider). clearance entries carry colour, kind and the facing "
                       "direction (front = -Z, rear = +Z, left = -X, right = +X)."),
        "bodies": bodies,
        "mix": {
            "assumed": True,
            "note": "Assumed generic US freeway mix, not data. Light vehicles and trucks are separate shares.",
            "light": {"sedan": 0.28, "crossover": 0.46, "pickup": 0.20, "van": 0.06},
            "truck": {"tractor_trailer": 0.90, "coach": 0.10},
        },
        "palette": {
            "assumed": True,
            "note": "Assumed weights shaped like published US colour-popularity surveys; hex is sRGB.",
            "colors": [{"name": n, "hex": h, "weight": wt} for n, h, wt in PALETTE],
        },
    }
    with open(os.path.join(out, "vehicles.json"), "w", encoding="utf-8") as fh:
        json.dump(sidecar, fh, indent=2)
        fh.write("\n")
    logging.info("wrote %s (%d bytes) and vehicles.json", glb, os.path.getsize(glb))


def repack(path):
    """Shrink the exported GLB without changing what it draws: NORMAL as normalized BYTE (KHR_mesh_quantization,
    which three.js's GLTFLoader supports), COLOR_0 as normalized UNSIGNED_BYTE (core glTF), indices as
    UNSIGNED_SHORT. POSITION and _PAINT stay FLOAT. Every vertex attribute is 4-byte aligned."""
    import struct
    with open(path, "rb") as fh:
        data = fh.read()
    n = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + n])
    blob_off = 20 + n + 8
    blob = data[blob_off:]
    comps = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}
    fmts = {5126: ("f", 4), 5123: ("H", 2), 5125: ("I", 4), 5121: ("B", 1)}

    def read(i):
        acc = doc["accessors"][i]
        view = doc["bufferViews"][acc["bufferView"]]
        c = comps[acc["type"]]
        f, size = fmts[acc["componentType"]]
        stride = view.get("byteStride") or size * c
        base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        out = [struct.unpack_from("<" + f * c, blob, base + k * stride) for k in range(acc["count"])]
        if acc.get("normalized"):
            scale = float((1 << (8 * size)) - 1)
            out = [tuple(v / scale for v in t) for t in out]
        return acc, out

    new_blob, views, accs = bytearray(), [], []

    def add(raw, stride, target, acc):
        while len(new_blob) % 4:
            new_blob.append(0)
        view = {"buffer": 0, "byteOffset": len(new_blob), "byteLength": len(raw), "target": target}
        if stride:
            view["byteStride"] = stride
        new_blob.extend(raw)
        views.append(view)
        acc["bufferView"] = len(views) - 1
        acc.pop("byteOffset", None)
        accs.append(acc)
        return len(accs) - 1

    for mesh in doc["meshes"]:
        for prim in mesh["primitives"]:
            attrs = {}
            for name, i in prim["attributes"].items():
                acc, vals = read(i)
                base = {"count": acc["count"], "type": acc["type"]}
                if name == "NORMAL":
                    raw = b"".join(struct.pack("<bbbx", *(max(-127, min(127, round(v * 127))) for v in t)) for t in vals)
                    attrs[name] = add(raw, 4, 34962, {**base, "componentType": 5120, "normalized": True})
                elif name == "COLOR_0":
                    raw = b"".join(struct.pack("<BBBB", *(max(0, min(255, round(v * 255))) for v in t)) for t in vals)
                    attrs[name] = add(raw, 4, 34962, {**base, "componentType": 5121, "normalized": True})
                else:
                    raw = b"".join(struct.pack("<" + "f" * len(t), *t) for t in vals)
                    extra = {k: acc[k] for k in ("min", "max") if k in acc}
                    attrs[name] = add(raw, 4 * comps[acc["type"]], 34962, {**base, "componentType": 5126, **extra})
            acc, vals = read(prim["indices"])
            raw = b"".join(struct.pack("<H", v[0]) for v in vals)
            prim["indices"] = add(raw, None, 34963, {"count": acc["count"], "type": "SCALAR", "componentType": 5123})
            prim["attributes"] = attrs
    doc["accessors"], doc["bufferViews"] = accs, views
    while len(new_blob) % 4:
        new_blob.append(0)
    doc["buffers"] = [{"byteLength": len(new_blob)}]
    for key in ("extensionsUsed", "extensionsRequired"):
        doc[key] = sorted(set(doc.get(key, [])) | {"KHR_mesh_quantization"})
    js = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(new_blob)
    out = struct.pack("<4sII", b"glTF", 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
    out += struct.pack("<II", len(new_blob), 0x004E4942) + bytes(new_blob)
    with open(path, "wb") as fh:
        fh.write(out)


def to_gltf_bbox(lo, hi):
    a, c = to_gltf(lo), to_gltf(hi)
    return [min(a[i], c[i]) for i in range(3)], [max(a[i], c[i]) for i in range(3)]


if __name__ == "__main__":
    main()
