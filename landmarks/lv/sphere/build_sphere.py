"""Low-poly model of the Sphere (Las Vegas), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_sphere.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the footprint center on the ground.
Logos, wordmarks, brand signage and show content are deliberately not modeled: the LED skin is plain panels
(`LedSkin`, `LedSkinB`) on a dark steel lattice (`Steel`); the app animates the `Led*` materials with generic
patterns.

Sources (see refs/sources.json for the photos):
  - height 112 m: project data (osm-height), same as the published 366 ft
  - exosphere width 157 m (published 516 ft) -> sphere radius 78.5 m, center 33.5 m above ground
  - footprint: OpenStreetMap way 976405284, a circle of radius ~87.3 m centered on the origin (footprint.json);
    wider than the sphere, so it is modeled as the low plinth/terrace the sphere sits in
  - LED skin starts ~13 m above ground: refs/The_Sphere_54760281448_.jpg (skin 610 px of a 985 px = 157 m width
    -> 97 m of skin; the dark base below it ~11-14 m)
  - plinth height, base drum inset, entrance pavilion and bridge stub sizes: estimated from the same photo
"""
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402  (copied next to this script)

STEM = "sphere"
MAX_TRIS = 5_000

# ----------------------------------------------------------------- dimensions
BURY = -2.0
HEIGHT = 112.0                      # project data / published 366 ft
RADIUS = 78.5                       # published 157 m (516 ft) width
CENTER_Z = HEIGHT - RADIUS          # 33.5 m: the widest point; 30% of the ball's height is below it or cut off
SKIN_Z0 = 13.0                      # bottom edge of the LED skin (night photo: skin 610 px of a 992 px width)
PLINTH_R = 87.3                     # OSM footprint radius
PLINTH_Z = 3.0                      # (est.) low plaza terrace around the base
DRUM_R = 72.5                       # (est.) recessed dark base wall under the skin
LOBBY_Z = (PLINTH_Z + 0.8, PLINTH_Z + 5.0)  # (est.) glazed lobby band around the base drum (night photo)
SEGMENTS = 48
# exosphere lattice: LED bands separated by steel latitude rings, cut by meridian ribs
LED_BANDS = 12                      # LED latitude bands between the skin's bottom edge and LATTICE_TOP
LATTICE_TOP = math.radians(86.0)    # above this a plain LED cap closes the pole
RING_W = 1.1                        # (est.) width of a steel latitude ring as it reads from afar, m
RIB_W = 1.1                         # (est.) width of a meridian rib, m
MIN_PANEL = 7.5                     # ribs thin out toward the pole: never closer together than this, m

# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex, from daylight photos
    "LedSkin": "4A4E57",   # the unlit LED mesh reads dark charcoal by day
    "LedSkinB": "555A65",  # every other panel a touch lighter, so the skin reads as panels, not paint
    "Steel": "282B30",     # exosphere frame: latitude rings and meridian ribs
    "Base": "24262B",      # dark base wall and soffit under the skin
    "Lobby": "34424F",     # glazed lobby band around the base
    "Plinth": "6E7074",    # concrete terrace / podium
    "Entry": "3A4A58",     # entrance glazing
    "Canopy": "55585C",    # entrance pavilion roofs, bridge
}
ROUGHNESS = {"LedSkin": 0.5, "LedSkinB": 0.5, "Steel": 0.7, "Entry": 0.3, "Lobby": 0.3}
WINDOWS = {"Lobby": 1.0}
SKIN = ("LedSkin", "LedSkinB", "Steel")  # smooth-shaded, so 48 facets read as a round ball

WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)
LED_LOW, LED_HIGH = (0.50, 0.30, 1.0), (0.20, 0.70, 1.0)  # generic violet-to-cyan wash, no imagery


def led_glow(material: str, point: kit.Point) -> kit.RGB:
    """A moderate base glow that drifts in hue up the ball and in strength around it (the app animates the
    `Led*` materials on top of this from integration v5 on)."""
    t = min(1.0, max(0.0, (point[2] - SKIN_Z0) / (HEIGHT - SKIN_Z0)))
    swirl = math.sin(2.0 * math.atan2(point[1], point[0]) + 3.0 * t)
    strength = (0.21 + 0.05 * swirl) * (1.12 if material == "LedSkinB" else 1.0)
    return kit.scaled(tuple(lo + (hi - lo) * t for lo, hi in zip(LED_LOW, LED_HIGH)), strength)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    if material in ("LedSkin", "LedSkinB"):
        return led_glow(material, point)
    if material == "Steel":
        return kit.scaled(COOL, 0.03)              # the frame stays dark between the lit panels
    if material == "Lobby":
        return kit.scaled(WARM, 0.03)              # the app draws the lit windows
    if material == "Entry":
        return kit.scaled(WARM, 0.5)               # lit entrance glazing
    if material == "Base":
        return kit.scaled(COOL, 0.05)
    if material == "Plinth":
        return kit.scaled(WARM, 0.05)              # spill light on the terrace, never pitch black
    if material == "Canopy":
        return kit.scaled(WARM, 0.08)
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def on_sphere(lat: float) -> tuple[float, float]:
    """(radius, height) of the skin at a latitude in radians."""
    return RADIUS * math.cos(lat), CENTER_Z + RADIUS * math.sin(lat)


def rib_period(lat: float) -> int:
    """Facets between meridian ribs at this latitude (0: too close to the pole for ribs)."""
    facet = 2.0 * RADIUS * math.cos(lat) * math.sin(math.pi / SEGMENTS)
    return next((n for n in (1, 2, 4, 8) if n * facet >= MIN_PANEL and RIB_W < 0.5 * facet), 0)


def led_panels(band: int, period: int) -> kit.PatternFactory:
    """One LED band: a steel rib every `period` facets, the panels between them in two alternating tones."""
    def factory(segments: int, facet_width: float, slant: float) -> kit.Pattern:
        rib_u = RIB_W / facet_width
        lines = tuple((1.0, 0.0, j + rib_u) for j in range(0, segments, period))

        def paint(u: float, v: float) -> str:
            if u % period < rib_u:
                return "Steel"
            return "LedSkin" if (int(u // period) + band) % 2 == 0 else "LedSkinB"
        return kit.Pattern(lines, paint)
    return factory


def build_body(b: kit.Builder) -> None:
    """Plinth, recessed base drum and the cut-off sphere as one closed surface of revolution. The skin is
    LED bands (cut by meridian ribs) alternating with thin steel latitude rings."""
    lat0 = math.asin((SKIN_Z0 - CENTER_Z) / RADIUS)
    ring = RING_W / RADIUS                                   # angular height of a steel ring
    led = (LATTICE_TOP - lat0) / LED_BANDS - ring            # angular height of an LED band
    profile = [
        (PLINTH_R, BURY, "Plinth"),
        (PLINTH_R, PLINTH_Z, "Plinth"),
        (DRUM_R, PLINTH_Z, "Base"),
        (DRUM_R, LOBBY_Z[0], "Lobby"),
        (DRUM_R, LOBBY_Z[1], "Base"),
        (DRUM_R, SKIN_Z0, "Base"),      # soffit out to the skin's bottom edge
    ]
    patterns: dict[str, kit.PatternFactory] = {}
    for k in range(LED_BANDS):
        lat = lat0 + k * (led + ring)
        period = rib_period(lat + led)  # judged at the band's narrower, upper edge
        name = "LedSkin" if k % 2 == 0 else "LedSkinB"
        if period:
            name = f"panels{k}"
            patterns[name] = led_panels(k, period)
        profile.append((*on_sphere(lat), name))
        profile.append((*on_sphere(lat + led), "Steel"))
    profile.append((*on_sphere(LATTICE_TOP), "LedSkin"))
    r_last, _ = on_sphere(math.radians(88.0))  # the last ring sits 2 degrees from the pole; a flat cap closes it
    profile.append((r_last, HEIGHT, "LedSkin"))  # 5 cm up, so the top is exactly the published height
    b.revolve(profile, SEGMENTS, patterns)


def rect(bearing: float, r0: float, r1: float, half_w: float) -> list:
    """A rectangle in plan running outward along a compass bearing from radius r0 to r1."""
    return [kit.polar(kit.compass_to_math(bearing), r, t, 0.0)[:2] for r, t in ((r0, -half_w), (r1, -half_w), (r1, half_w), (r0, half_w))]


def build_entries(b: kit.Builder) -> None:
    """Entrances (est. from the night photo): glazed lobby fronts set into the base drum on the terrace, the
    main one on the east plaza side, and the enclosed pedestrian bridge arriving on the west (from the
    Venetian side), carried on a pier at the edge of the footprint."""
    for bearing, half_w in ((90.0, 24.0), (0.0, 12.0), (180.0, 12.0)):
        b.extrude(rect(bearing, DRUM_R - 6.0, DRUM_R + 3.0, half_w), PLINTH_Z - 0.5, PLINTH_Z + 5.5, "Entry",
                  top="Canopy")
        b.extrude(rect(bearing, DRUM_R - 6.0, DRUM_R + 6.0, half_w + 1.5), PLINTH_Z + 5.55, PLINTH_Z + 6.4, "Canopy")
    # east plaza stairs down from the terrace
    b.extrude(rect(90.0, PLINTH_R - 1.0, PLINTH_R + 7.0, 20.0), BURY, PLINTH_Z / 2, "Plinth")
    # west: enclosed bridge at about 6-11 m, running into the base under the skin
    b.extrude(rect(270.0, DRUM_R - 6.0, PLINTH_R + 8.0, 5.0), 6.0, 11.0, "Entry", top="Canopy")
    b.extrude(rect(270.0, PLINTH_R + 3.0, PLINTH_R + 6.0, 2.0), BURY, 5.95, "Plinth")


PARTS = {"body": build_body, "entries": build_entries}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    obj = b.finish(STEM.title())
    skin = {list(COLORS).index(name) for name in SKIN}
    for poly in obj.data.polygons:  # smooth normals on the skin only, so 48 facets read as a round ball
        poly.use_smooth = poly.material_index in skin
    return obj


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
