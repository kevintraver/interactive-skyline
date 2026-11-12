"""Low-poly model of The STRAT tower (Las Vegas), built procedurally with landmark_kit.

    python run_blender.py build_strat.py -- --out <folder>

Units are meters. Blender axes: +X east, +Y north, +Z up, origin at the tower's center on the ground.

Sources for the proportions:
  - Wikimedia Commons aerial photo (2017) and construction photo (1995); Pixabay close-ups and a side elevation
  - Published figures: legs meet the core at 264 ft, pod base at 775 ft, tip at 1,149 ft
  - Leg bearings (75 / 195 / 315 degrees counter-clockwise from east) and the foot distance come from
    interactive-skyline's LiDAR-based overrides (data/overrides.json, w135457469)
Details taken from close-up photos: the mullion grid on the pod's glass, the diamond bracing on its lower
cone, the open lattice of the mast around the red ride column, and the blocks that close the top of each
slot between a leg and the core. Night colors come from two night photos of the tower.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import landmark_kit as kit  # noqa: E402  (copied next to this script)

# ----------------------------------------------------------------- dimensions
LEG_BEARINGS = (75.0, 195.0, 315.0)  # degrees counter-clockwise from east
BURY = -2.0                # how far the base runs below ground, to sit into terrain
LEGS_MEET = 80.5           # 264 ft: legs join the core
POD_BASE = 236.5           # 775 ft: underside of the pod
TIP = 350.2                # 1,149 ft
CORE_RADIUS = 7.5          # hexagonal core, corner radius
CORE_APOTHEM = CORE_RADIUS * math.cos(math.radians(30))
POD_SEGMENTS = 24
COLLAR_SEGMENTS = 12

# leg outer face: a hyperbola through foot, waist and capital
WAIST_Z, WAIST_R = 140.0, 10.4
FOOT_R, CAPITAL_R = 23.0, 15.2
LEG_STATIONS = (BURY, 0, 14, 28, 42, 56, 68, LEGS_MEET, 100, 120, 140, 160, 180, 200, 212, 222, 230, POD_BASE)
LEG_HALF_WIDTH = ((0, 4.4), (LEGS_MEET, 3.3), (140, 2.8), (200, 3.1), (222, 3.4), (230, 3.9), (POD_BASE, 5.2))
# leg inner face: leans in to the core, hides inside it, then peels away under the pod
LEG_INNER = ((0, 12.0), (LEGS_MEET, CORE_APOTHEM), (90, 5.8), (200, 5.8), (210, 6.6), (220, 8.3), (230, 9.3), (POD_BASE, 9.6))
# blocky brackets that close the top of each slot between a leg and the core
BRACKET_Z = (64.0, LEGS_MEET + 1.5)
BRACKET_PROUD = 0.25       # how far a bracket stands out past the sides of its leg
BRACKET_OVERLAP = 1.0      # how far a bracket reaches into the core, and into the leg

# pod facade, in meters: kept bold, since the tower is mostly seen from 300 m to 3 km away
CURTAIN_COLUMNS, CURTAIN_ROWS = 2, 5  # glass panes across each facet, and up the leaning band
MULLION_WIDTH = 0.4
BRACE_DIAMONDS = 12        # diamonds around the lower cone, each braced corner to corner
BRACE_WIDTH = 0.8

# mast: an open square lattice on the ride housing, with the Big Shot column inside its lower part
HOUSING_BASE, HOUSING_HALF = 274.0, 3.75
MAST_BASE, MAST_RED_TOP, MAST_TOP = 283.5, 316.0, 334.0
MAST_CHORD = 2.0           # the corner posts stand at +-2 m
MAST_BAYS = 8
MAST_POST, MAST_BAR = 0.3, 0.18  # half thickness of the corner posts, and of the girts and braces
MAST_COLUMN = 1.25         # half width of the red column
MAST_DECK = (MAST_TOP - 0.4, MAST_TOP + 0.6)
TIP_HALF = (1.0, 0.45)     # the top section tapers from this half width at its foot to this at the tip

COLORS = {  # sRGB hex, picked from the photos
    "Concrete": "EDE6CC",
    "Glass": "1C222A",
    "Mullion": "A7AEB4",
    "ConeGlass": "1F262E",
    "Bracing": "E2E3DE",
    "Trim": "CFCFC8",
    "Deck": "8C9094",
    "Dome": "D9D8D0",
    "MastWhite": "F2F2EE",
    "MastLattice": "F2F2EE",
    "MastRed": "B01E3C",
    "RideTeal": "2FA58E",
    "RideDark": "3A4046",
}
ROUGHNESS = {"Glass": 0.35, "ConeGlass": 0.35}

# Night lighting (linear RGB) from night photos: flood-lit legs brightest at the base, blue-lit cone glass
# crossed by pale lit bracing, a ring of colored bulbs on the rim, a red-lit mast with a red beacon.
FLOOD_COOL, FLOOD_WARM = (0.82, 0.90, 1.0), (1.0, 0.80, 0.55)
BULB_WARM, BULB_ORANGE = (1.0, 0.85, 0.60), (1.0, 0.55, 0.20)
CONE_BLUE, BRACE_LIGHT = (0.015, 0.07, 0.42), (0.55, 0.75, 1.0)
MAST_RED, MAST_WHITE = (1.0, 0.02, 0.04), (1.0, 0.95, 0.90)
RIM_BULBS = ((1.0, 0.05, 0.05), (1.0, 0.85, 0.60), (0.05, 0.9, 0.2), (1.0, 0.85, 0.60), (0.1, 0.3, 1.0), (1.0, 0.85, 0.60))

# pod profile: (radius, height, what the band up to the next point is made of: a material or a pattern)
POD_PROFILE = (
    (10.5, POD_BASE, "Trim"),      # underside
    (13.7, POD_BASE, "DiamondBracing"),  # glass cone, crossed by white diamond bracing
    (17.7, 247.3, "Trim"),         # bold light ring between the cone and the glass
    (18.9, 247.3, "Trim"),
    (19.8, 249.6, "CurtainWall"),  # leaning glass band on a grid of mullions
    (24.7, 260.5, "Trim"),         # rim
    (24.9, 260.5, "Trim"),
    (24.9, 261.5, "Deck"),         # roof ring
    (21.0, 261.5, "Trim"),         # parapet
    (21.0, 263.0, "Deck"),         # outdoor deck
    (14.5, 263.0, "Dome"),         # low faceted dome
    (13.4, 267.0, "Dome"),
    (11.4, 271.0, "Dome"),
    (9.8, 274.0, "Trim"),          # crown platform
    (10.2, 274.0, "Trim"),
    (10.2, 275.0, "Deck"),
)
PATTERNS = {
    "CurtainWall": lambda n, width, slant: kit.curtain_wall(
        n, width, slant, CURTAIN_COLUMNS, CURTAIN_ROWS, MULLION_WIDTH, "Glass", "Mullion"),
    "DiamondBracing": lambda n, width, slant: kit.diamond_bracing(
        n, width, slant, BRACE_DIAMONDS, BRACE_WIDTH, "ConeGlass", "Bracing"),
}


def leg_outer(z: float) -> float:
    span, end = (WAIST_Z, FOOT_R) if z < WAIST_Z else (POD_BASE - WAIST_Z, CAPITAL_R)
    k = math.sqrt(end ** 2 - WAIST_R ** 2) / span
    return math.sqrt(WAIST_R ** 2 + ((z - WAIST_Z) * k) ** 2)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    """Night light at one corner of a face: `point` is the corner, `center` the middle of its face."""
    z, face_z = point[2], center[2]
    if material == "Concrete":  # floodlights at the feet, warm light under the pod
        if z >= 229.0:
            return kit.scaled(FLOOD_WARM, 0.55)
        return kit.scaled(FLOOD_COOL, 0.18 + 0.70 * math.exp(-max(z, 0.0) / 50.0))
    if material == "ConeGlass":
        return CONE_BLUE
    if material == "Bracing":
        return BRACE_LIGHT
    if material == "Trim":
        if face_z < 240.0:
            return kit.scaled(FLOOD_WARM, 0.5)       # underside of the pod
        if face_z < 249.7:
            return kit.scaled(BULB_WARM, 1.0)        # bulbs along the ring
        if face_z < 261.6:                           # colored bulbs around the rim
            segment = int((math.atan2(center[1], center[0]) % math.tau) / math.tau * POD_SEGMENTS)
            return kit.scaled(RIM_BULBS[segment % len(RIM_BULBS)], 1.0)
        if face_z < 273.0:
            return kit.scaled(MAST_WHITE, 0.15)      # parapet
        return kit.scaled(BULB_ORANGE, 0.9)          # crown platform
    if material == "Glass":
        return kit.scaled(BULB_WARM, 0.09)           # lit rooms behind the panes
    if material == "Mullion":
        return kit.scaled(BULB_WARM, 0.015)          # the grid stays dark against the lit panes
    if material == "Dome":
        return kit.scaled(BULB_WARM, 0.12)
    if material == "Deck":
        return kit.scaled(BULB_WARM, 0.03)
    if material == "MastRed":
        return kit.scaled(MAST_RED, 0.85)
    if material == "MastLattice":
        return kit.scaled(MAST_WHITE, 0.06)          # girts and braces are only caught by the posts' light
    if material == "MastWhite":
        if face_z < MAST_BASE + 0.5:
            return kit.scaled(MAST_WHITE, 0.25)      # machinery housing
        if math.hypot(center[0], center[1]) > MAST_CHORD and face_z < MAST_TOP:
            return kit.scaled(MAST_RED, 0.7)         # corner posts carry red strips
        if z > MAST_TOP + 0.5:
            return kit.scaled(MAST_RED, 1.0)         # beacon at the tip
        return kit.scaled(MAST_WHITE, 0.8)
    if material == "RideTeal":
        return (0.12, 0.70, 0.58)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_core(b: kit.Builder) -> None:
    phase = math.radians(LEG_BEARINGS[0] + 30)  # faces point at the legs and at the gaps between them
    b.prism(CORE_RADIUS, BURY, POD_BASE, 6, "Concrete", phase=phase)
    b.prism(10.5, 229.5, POD_BASE, COLLAR_SEGMENTS, "Concrete")  # windowed collar the pod sits on


def build_legs(b: kit.Builder) -> None:
    for bearing in LEG_BEARINGS:
        rings = []
        for z in LEG_STATIONS:
            outer, inner = leg_outer(z), kit.lerp_table(LEG_INNER, z)
            half = kit.lerp_table(LEG_HALF_WIDTH, z)
            rings.append([kit.polar(bearing, outer, half, z), kit.polar(bearing, inner, half, z),
                          kit.polar(bearing, inner, -half, z), kit.polar(bearing, outer, -half, z)])
        b.loft(rings, "Concrete")


def build_brackets(b: kit.Builder) -> None:
    z0, z1 = BRACKET_Z
    inner = CORE_APOTHEM - BRACKET_OVERLAP                      # from inside the core...
    outer = kit.lerp_table(LEG_INNER, z0) + BRACKET_OVERLAP     # ...to inside the leg
    half = kit.lerp_table(LEG_HALF_WIDTH, z0) + BRACKET_PROUD
    for bearing in LEG_BEARINGS:
        b.beam(bearing, ((inner + outer) / 2, z0), ((inner + outer) / 2, z1), half, (outer - inner) / 2, "Concrete")


def build_pod(b: kit.Builder) -> None:
    b.revolve(POD_PROFILE, POD_SEGMENTS, PATTERNS)
    b.box(HOUSING_HALF, HOUSING_BASE, MAST_BASE, "MastWhite")  # ride machinery housing under the mast


def build_mast(b: kit.Builder) -> None:
    b.box(MAST_COLUMN, MAST_BASE, MAST_RED_TOP, "MastRed")    # Big Shot column
    b.lattice_mast(MAST_BASE, MAST_TOP, MAST_CHORD, MAST_BAYS, MAST_POST, MAST_BAR, "MastWhite", "MastLattice")
    b.box(MAST_CHORD, *MAST_DECK, "MastLattice")
    b.box(TIP_HALF[0], MAST_TOP, TIP, "MastWhite", half_top=TIP_HALF[1])


def build_rides(b: kit.Builder) -> None:
    # X-Scream: a see-saw track that tips over the west edge of the pod
    b.beam(172, (15.0, 264.0), (27.0, 266.6), 1.4, 0.7, "RideTeal")
    b.beam(172, (26.6, 266.5), (33.0, 271.2), 1.4, 0.7, "RideTeal")
    b.beam(172, (22.5, 263.0), (22.5, 265.8), 1.4, 0.8, "RideTeal")
    # Insanity: an arm that swings riders out past the east-south-east edge, shown stowed
    b.beam(338, (17.0, 263.0), (17.0, 268.6), 1.1, 1.1, "RideDark")
    b.beam(338, (13.0, 267.6), (27.0, 270.4), 0.8, 0.6, "RideDark")


def build():
    b = kit.Builder(COLORS, glow, ROUGHNESS)
    for part in (build_core, build_legs, build_brackets, build_pod, build_mast, build_rides):
        part(b)
    return b.finish("Strat")


if __name__ == "__main__":
    kit.main(build, stem="strat", script_file=__file__, max_tris=10_000)
