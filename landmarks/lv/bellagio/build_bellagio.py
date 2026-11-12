"""Low-poly model of a three-wing resort hotel tower on the Las Vegas Strip (id w25723909), built with landmark_kit.

Units are meters; +X east, +Y north, +Z up; origin at the footprint center (installs with offset 0,0).
Logos, wordmarks and brand signage are deliberately not modeled: the crown sign area is a plain band.

Sources:
  - height 155.0 m: project data (osm-height); wing roof 131.7 m and dome rise 10.3 m: footprint.json
  - plan: footprint.json (skyline_tool.py footprint), exact mapped outline
  - band, cornice, end-block and drum heights: (est.) measured on refs/Bellagio_Las_Vegas_December_2013_panorama.jpg
    (level view from across the lake, scaled so roof = 131.7 m and lantern = 155 m)
  - end-block length (about 29 m N/S, 22 m W): the step points mapped in the footprint outline
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "bellagio"
MAX_TRIS = 5_000

BURY = -2.0
HEIGHT = 155.0        # project data
WING_TOP = 131.7      # footprint.json
BASE_TOP = 12.0       # (est.) podium / casino level
MID_Z = 36.0          # (est.) lower lit band
CORNICE_Z0 = 93.0     # (est.) main cornice
CORNICE_Z1 = 96.0
END_BAND = 110.5      # (est.) wing-end blocks: three floors above the cornice, then their own cornice
END_TOP = 114.0
ARCADE_Z0 = 107.0     # (est.) tall arched windows of the top floors, center sections only
ARCADE_Z1 = 122.5
CROWN_TOP = 128.0     # (est.) crown cornice; dark mansard roof above, set back
DRUM_MID = 140.0      # (est.) plain band of the drum (sign area, left plain)
DRUM_TOP = 148.5      # (est.)
DOME_TOP = 153.2      # (est.)
# wing-end steps: lines a*x + b*y = c through the step points mapped in the footprint
CUTS = [(0.403, 0.915, 91.0), (0.403, -0.915, 91.0), (-1.0, 0.0, 83.0)]

COLORS = {
    "Facade": "E8D8B2",   # cream stucco with punched windows
    "Attic": "EDE0BF",    # floors above the cornice
    "Band": "F4EEDF",     # off-white cornices and arcade piers
    "Arcade": "5E6468",   # glass behind the arcade piers
    "Base": "D2BE96",     # podium
    "Drum": "EFE4C8",
    "Roof": "5A5850",
    "Dome": "8E9288",
}
ROUGHNESS = {"Facade": 0.6, "Arcade": 0.25}
AMBER = (1.0, 0.62, 0.25)
WARM = (1.0, 0.78, 0.45)
CREAM = (1.0, 0.9, 0.68)


def glow(material, point, center):
    """Night photos: the whole stone facade is flood-lit amber, cornices and the arcade piers brighter and
    paler, the drum brightest, roofs dark."""
    if material == "Facade":
        return kit.scaled(AMBER, 0.26)
    if material == "Base":
        return kit.scaled(AMBER, 0.3)
    if material == "Attic":
        return kit.scaled(WARM, 0.34)
    if material == "Arcade":
        return kit.scaled(WARM, 0.14)
    if material == "Band":
        return kit.scaled(CREAM, 0.8)
    if material == "Drum":
        return kit.scaled(CREAM, 1.0)
    if material == "Dome":
        return kit.scaled(CREAM, 0.3)
    return (0.0, 0.0, 0.0)


def dedupe(points, tol=0.4):
    out = []
    for p in points:
        if not out or math.dist(p, out[-1]) > tol:
            out.append(p)
    if len(out) > 1 and math.dist(out[0], out[-1]) <= tol:
        out.pop()
    return out


def clip(points, line, keep_below=True):
    """Half-plane clip (Sutherland-Hodgman) of a polygon by a*x + b*y = c; fine where the line crosses twice."""
    a, b, c = line
    s = 1.0 if keep_below else -1.0
    out = []
    for p, q in zip(points, points[1:] + points[:1]):
        dp, dq = s * (a * p[0] + b * p[1] - c), s * (a * q[0] + b * q[1] - c)
        if dp <= 0:
            out.append(p)
        if (dp < 0 < dq) or (dq < 0 < dp):
            t = dp / (dp - dq)
            out.append((p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t))
    return dedupe(out)


def grow(points, d, center):
    try:
        return kit.offset_polygon(points, d)
    except Exception:
        return kit.scale_polygon(points, 1.0 + d / 60.0, center)


def build_body(b):
    doc = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    hub, wings = doc["volumes"][0]["outline"], dedupe(doc["volumes"][1]["outline"])
    hc = (sum(p[0] for p in hub) / len(hub), sum(p[1] for p in hub) / len(hub))
    main = wings
    for line in CUTS:
        main = clip(main, line)
    ends = [clip(wings, line, keep_below=False) for line in CUTS]

    # shaft on the full plan: podium, lower band, main cornice
    b.extrude(grow(wings, 1.2, hc), BURY, BASE_TOP, "Base", top="Roof")
    b.extrude(wings, BASE_TOP, MID_Z, "Facade")
    b.extrude(grow(wings, 0.6, hc), MID_Z, MID_Z + 2.0, "Band")
    b.extrude(wings, MID_Z + 2.0, CORNICE_Z0, "Facade")
    b.extrude(grow(wings, 1.0, hc), CORNICE_Z0, CORNICE_Z1, "Band")

    # wing-end blocks stop three floors above the cornice
    for end in ends:
        b.extrude(end, CORNICE_Z1, END_BAND, "Attic")
        b.extrude(grow(end, 0.9, hc), END_BAND, END_TOP, "Band", top="Roof")

    # center sections: attic floors, arcade of tall arched windows between piers, crown cornice, mansard
    b.extrude(main, CORNICE_Z1, ARCADE_Z0, "Attic")
    b.extrude(main, ARCADE_Z0, ARCADE_Z1, "Arcade")
    b.fins(main, ARCADE_Z0, ARCADE_Z1, spacing=6.4, depth=0.7, width=3.3, material="Band")
    b.extrude(grow(main, 0.5, hc), ARCADE_Z1, ARCADE_Z1 + 1.5, "Attic")
    b.extrude(grow(main, 1.1, hc), ARCADE_Z1 + 1.5, CROWN_TOP, "Band", top="Roof")
    b.extrude(grow(main, -3.0, hc), CROWN_TOP, WING_TOP, "Roof")

    # round bay on the lake side, full height, carrying the bands around
    bay = kit.scale_polygon(hub, 1.04, hc)
    b.extrude(bay, BURY, MID_Z, "Facade")
    b.extrude(kit.scale_polygon(hub, 1.1, hc), MID_Z, MID_Z + 2.0, "Band")
    b.extrude(bay, MID_Z + 2.0, CORNICE_Z0, "Facade")
    b.extrude(kit.scale_polygon(hub, 1.12, hc), CORNICE_Z0, CORNICE_Z1, "Band")
    b.extrude(bay, CORNICE_Z1, ARCADE_Z1 + 1.5, "Attic")
    b.extrude(kit.scale_polygon(hub, 1.14, hc), ARCADE_Z1 + 1.5, CROWN_TOP, "Band")

    # drum: plain lit band (sign area left plain), arcaded lantern stage, cornice, shallow dome, finial
    b.extrude(bay, CROWN_TOP, DRUM_MID, "Drum")
    b.extrude(kit.scale_polygon(hub, 1.1, hc), DRUM_MID, DRUM_MID + 1.0, "Band")
    stage = kit.scale_polygon(hub, 0.96, hc)
    b.extrude(stage, DRUM_MID + 1.0, DRUM_TOP - 1.5, "Arcade")
    b.fins(stage, DRUM_MID + 1.0, DRUM_TOP - 1.5, spacing=5.4, depth=0.6, width=2.4, material="Drum")
    b.extrude(kit.scale_polygon(hub, 1.14, hc), DRUM_TOP - 1.5, DRUM_TOP, "Band")
    rings = []
    for t in (0.0, 0.35, 0.7, 1.0):
        k = 1.0 * math.cos(t * math.pi / 2 * 0.88)
        z = DRUM_TOP + (DOME_TOP - DRUM_TOP) * math.sin(t * math.pi / 2)
        rings.append([(x, y, z) for x, y in kit.scale_polygon(hub, k, hc)])
    b.loft(rings, "Dome")
    b.extrude(kit.scale_polygon(hub, 0.1, hc), DOME_TOP - 0.3, HEIGHT, "Drum")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={"Facade": 0.6, "Attic": 0.6, "Arcade": 1.0})
    build_body(b)
    return b.finish("ResortTower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
