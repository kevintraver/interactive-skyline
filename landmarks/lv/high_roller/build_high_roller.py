"""Low-poly model of the High Roller observation wheel (LINQ Promenade, Las Vegas), built with landmark_kit.

    python <skill>/scripts/run_blender.py build_high_roller.py -- --out .

The GLB follows SPIN_CONTRACT.md: a static `Support` object, a `Rotor` object whose origin is the hub center
(it turns about its local +Y), and `Cabin_00`..`Cabin_27` parented to `Rotor`, each with its origin at its
pivot (the cabin center, on a line parallel to the axle). kit.main/export handle one object, so this script
has its own main() and export with the same exporter settings as the kit.

Units are meters. LOCAL FRAME (the app rotates the model by extra.json rotation_deg = 90, counter-clockwise):
  +X runs along the wheel plane, +Y is the wheel axis, +Z up; origin under the hub on the ground.
  After the 90 degree rotation: local +X -> north, local +Y -> west, so the brace leg (local -Y) points east.
Logos, wordmarks and brand signage are deliberately not modeled.

Sources:
  - Height 167.6 m (550 ft), diameter 158.5 m (520 ft), 28 cabins, 112 cables: en.wikipedia "High Roller
    (Ferris wheel)". The 158.5 m is taken as the circle through the outer edges of the cabins, so the hub is
    at 167.6 - 79.25 = 88.35 m and the lowest cabin clears the ground by 9.1 m (elevated boarding level).
  - Rim: ONE tube (2 m in reality, 28 sections), not a truss: refs/High_Roller_Observation_Wheel.jpg and the
    night photo both show a single tube with cabins on brackets outside it. Centerline radius 71.0 m and cabin
    size 6.8 m: ratios read off the same photo (cabin centers at 1.06-1.07 rim radii; cabin about 1/21 of the
    rim diameter) (est.). Tube modeled at 2.2 m so it reads from 1-3 km. Section-joint collars (28) and cable
    lugs on the inner side (112) are visible in that photo; their sizes are est.
  - Cabins: glass spheres with white top and bottom shells, two frame rings and two side pivots carried by
    V-arms from the rim (face-on photo). Proportions est. from the photo.
  - Position, wheel plane (north-south) and spindle length (about 30 m, east-west): OpenStreetMap way
    402543930 (spindle stub drawn 13.2 m west / 16.6 m east of the rim line), agreeing with the Wikipedia
    coordinates within 3 m.
  - Hub and spindle: a ribbed drum between the leg tops with a cable flange near each end, read off
    refs/Las_Vegas_High_Roller_Wheel_Mar_2013.jpg (spindle seen full length) and the night photo; flange
    spacing and radii est.
  - Legs: four cigar-tapered tubes in two A-frames whose feet lean in toward the wheel, plus one transverse
    brace leg on the east side, read off the construction photo (looking north) and the face-on photo; foot
    positions est.
  - Cables are about 75 mm thick in reality; modeled 0.24 m wide so they render at all (est.).
  - Station under the wheel: rough size from OSM way 402543933; deck, glazing and side canopies est., plain.
"""
import json
import logging
import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402
from mathutils import Vector  # noqa: E402

log = logging.getLogger("high_roller")

STEM = "high_roller"
MAX_TRIS = 20_000

# ----------------------------------------------------------------- dimensions
BURY = -2.0
HEIGHT = 167.6                 # published
OUTER_R = 158.5 / 2            # published diameter, through the outer edges of the cabins
HUB_Z = HEIGHT - OUTER_R       # 88.35
RIM_R = 71.0                   # rim centerline (photo ratio, est.)
RIM_TUBE = 1.1                 # tube radius (real 1.0, slightly thickened)
RIM_SIDES = 10
RIM_SEGMENTS = 112
CABINS = 28                    # published
CABIN_R = 3.4                  # photo ratio (est.)
CABIN_RING_Y = 1.9             # the two frame rings sit either side of the middle (est.)
CABIN_SEGMENTS = 12
CABIN_LATS = (-72, -30, 6, 42, 72)
CABIN_CENTER_R = OUTER_R - CABIN_R * math.sin(math.radians(CABIN_LATS[-1]))   # 76.0 = 1.07 rim radii (photo)
PIVOT_Y = 4.3                  # side pivots of a cabin (est.)
CABLES = 112                   # published
CABLE_HALF = 0.12
SPINDLE_HALF = 14.9            # OSM spindle stub
SPINDLE_R = 2.3                # est. from construction photo
DRUM_HALF, DRUM_R = 6.4, 3.0   # rotating hub drum (est.)
FLANGE_Y, FLANGE_R = 5.6, 4.8  # cable flanges (est.)
LEG_FOOT_X, LEG_FOOT_Y = 26.0, 9.0    # est. from photos (feet lean in about 6 m)
BRACE_FOOT_Y = -72.0           # east side after rotation (est. from construction photo)
STATION_HALF_X, STATION_HALF_Y, STATION_TOP = 29.0, 12.0, 6.5

# ---------------------------------------------------------------------- style
COLORS = {
    "Steel": "F0F0EA",
    "LedRim": "F4F4F0",
    "Cable": "C4C8CC",
    "CabinGlass": "A4BAC6",
    "CabinShell": "F2F2EE",
    "CabinFloor": "6E7478",
    "Station": "D6CFC2",
    "StationGlass": "5F7686",
    "Roof": "9A9A98",
}
ROUGHNESS = {"CabinGlass": 0.25, "StationGlass": 0.3, "Steel": 0.6}
WINDOWS = {"StationGlass": 1.0}

WARM, COOL, WHITE = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0), (1.0, 1.0, 1.0)
GLOW = {
    "LedRim": (COOL, 0.8),         # moderate base; the app animates Led* materials
    "CabinGlass": (COOL, 0.6),     # lit interiors
    "CabinShell": (WHITE, 0.3),
    "CabinFloor": (WARM, 0.12),
    "Steel": (WHITE, 0.2),         # legs and hub are flood-lit white
    "Cable": (WHITE, 0.1),
    "Station": (WARM, 0.14),
    "StationGlass": (WARM, 0.03),  # the app draws the lit panes
}


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    """Night photo: the rim is one bright LED ring, cabins glow, legs and hub are flood-lit, the rest is low."""
    color, strength = GLOW.get(material, (WARM, 0.03))
    return kit.scaled(color, strength)


# -------------------------------------------------------------------- helpers
def new_builder() -> kit.Builder:
    return kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)


def tube(b: kit.Builder, a, c, radii, sides: int, material: str, ref=(0.0, 0.0, 1.0)) -> None:
    """A closed tube from a to c with len(radii) evenly spaced rings (tapers allowed)."""
    a, c = Vector(a), Vector(c)
    axis = (c - a).normalized()
    e1 = Vector(ref).cross(axis)
    if e1.length < 1e-6:
        e1 = Vector((1.0, 0.0, 0.0)).cross(axis)
    e1.normalize()
    e2 = axis.cross(e1)
    rings = []
    for i, r in enumerate(radii):
        p = a.lerp(c, i / (len(radii) - 1))
        rings.append([tuple(p + r * (math.cos(t) * e1 + math.sin(t) * e2))
                      for t in (2 * math.pi * k / sides for k in range(sides))])
    b.loft(rings, material)


def drum(b: kit.Builder, y0: float, y1: float, radius: float, sides: int, material: str, z: float = 0.0) -> None:
    """A cylinder along the axle (Y) centered on the hub line."""
    tube(b, (0.0, y0, z), (0.0, y1, z), [radius, radius], sides, material)


def spoke_point(angle: float, radius: float, y: float = 0.0) -> kit.Point:
    """A point in the Rotor frame (origin at the hub center)."""
    return (radius * math.cos(angle), y, radius * math.sin(angle))


def cabin_angle(i: int) -> float:
    return math.pi / 2 + 2 * math.pi * i / CABINS  # Cabin_00 at the very top


# ---------------------------------------------------------------- rotor parts
def build_rim(b: kit.Builder) -> None:
    """One round tube; all but the two inward faces carry the LEDs. Collars mark the 28 section joints."""
    grid = []
    for i in range(RIM_SEGMENTS):
        ang = 2 * math.pi * i / RIM_SEGMENTS
        ring = []
        for k in range(RIM_SIDES):
            t = 2 * math.pi * (k + 0.5) / RIM_SIDES  # 0 = radially outward, 90 degrees = +Y
            ring.append(b.bm.verts.new(spoke_point(ang, RIM_R + RIM_TUBE * math.cos(t), RIM_TUBE * math.sin(t))))
        grid.append(ring)
    inward = (RIM_SIDES // 2 - 1, RIM_SIDES // 2)  # the faces on either side of t = 180 degrees
    for i in range(RIM_SEGMENTS):
        j = (i + 1) % RIM_SEGMENTS
        for k in range(RIM_SIDES):
            m = (k + 1) % RIM_SIDES
            b.face((grid[i][k], grid[i][m], grid[j][m], grid[j][k]), "Steel" if k in inward else "LedRim")
    half = 0.4 / RIM_R
    for i in range(CABINS):
        ang = cabin_angle(i) + math.pi / CABINS
        tube(b, spoke_point(ang - half, RIM_R), spoke_point(ang + half, RIM_R), [RIM_TUBE + 0.3] * 2, 8, "Steel",
             ref=(0.0, 1.0, 0.0))


def build_cables(b: kit.Builder) -> None:
    """112 cables, alternately to the two hub flanges, leaving the flange with a tangential lead so they lace."""
    lead = math.radians(35)
    for i in range(CABLES):
        ang = 2 * math.pi * (i + 0.5) / CABLES
        side = 1 if i % 2 == 0 else -1
        twist = lead if (i // 2) % 2 == 0 else -lead
        tube(b, spoke_point(ang + twist, FLANGE_R - 0.5, side * FLANGE_Y), spoke_point(ang, RIM_R - RIM_TUBE * 0.6),
             [CABLE_HALF, CABLE_HALF], 3, "Cable", ref=(0.0, 1.0, 0.0))
        # anchor lug on the inner side of the rim
        tube(b, spoke_point(ang, RIM_R - RIM_TUBE - 0.9, side * 0.35), spoke_point(ang, RIM_R - RIM_TUBE + 0.2),
             [0.3, 0.42], 4, "Steel", ref=(0.0, 1.0, 0.0))


def build_hub(b: kit.Builder) -> None:
    """Rotating drum with stiffening ribs and the two cable flanges."""
    drum(b, -DRUM_HALF, DRUM_HALF, DRUM_R, 16, "Steel")
    for y in (-FLANGE_Y, FLANGE_Y):
        drum(b, y - 0.3, y + 0.3, FLANGE_R, 20, "Steel")
        drum(b, y - 0.9 if y < 0 else y + 0.3, y - 0.3 if y < 0 else y + 0.9, DRUM_R + 0.7, 16, "Steel")
    for y in (-2.8, 0.0, 2.8):
        drum(b, y - 0.2, y + 0.2, DRUM_R + 0.4, 16, "Steel")


def build_mounts(b: kit.Builder) -> None:
    """Per cabin: two pivot bosses on the cabin axis, each carried by a V of two arms from the rim."""
    spread = 3.7 / RIM_R
    for i in range(CABINS):
        ang = cabin_angle(i)
        for side in (1, -1):
            boss = spoke_point(ang, CABIN_CENTER_R, side * PIVOT_Y)
            tube(b, spoke_point(ang, CABIN_CENTER_R, side * (CABIN_R - 0.1)),
                 spoke_point(ang, CABIN_CENTER_R, side * (PIVOT_Y + 0.5)), [0.7, 0.7], 6, "Steel", ref=(1.0, 0.0, 0.0))
            for d in (-spread, spread):
                tube(b, spoke_point(ang + d, RIM_R, side * 0.6), boss, [0.34, 0.3], 4, "Steel", ref=(0.0, 1.0, 0.0))


# ---------------------------------------------------------------------- cabin
def build_cabin(b: kit.Builder) -> None:
    """One cabin around its pivot (0, 0, 0): glass sphere, white top and bottom shells, floor edge, frame rings."""
    around = [2 * math.pi * (k + 0.5) / CABIN_SEGMENTS for k in range(CABIN_SEGMENTS)]
    rings = []
    for lat in CABIN_LATS:
        la = math.radians(lat)
        r, z = CABIN_R * math.cos(la), CABIN_R * math.sin(la)
        rings.append([(r * math.cos(t), r * math.sin(t), z) for t in around])
    b.loft(rings, ["CabinShell", "CabinGlass", "CabinGlass", "CabinShell"])
    # floor edge showing at the bottom of the glass
    floor_z = CABIN_R * math.sin(math.radians(CABIN_LATS[1]))
    floor_r = CABIN_R * math.cos(math.radians(CABIN_LATS[1])) + 0.1
    b.loft([[(floor_r * math.cos(t), floor_r * math.sin(t), z) for t in around]
            for z in (floor_z - 0.15, floor_z + 0.3)], "CabinFloor")
    # two frame rings parallel to the wheel plane, concentric with the pivot axis
    n, half = 12, 0.22
    for ring_y in (-CABIN_RING_Y, CABIN_RING_Y):
        skin = math.sqrt(CABIN_R ** 2 - ring_y ** 2)
        section = [(skin - 0.25, ring_y - half), (skin + 0.22, ring_y - half), (skin + 0.22, ring_y + half),
                   (skin - 0.25, ring_y + half)]
        verts = [[b.bm.verts.new((r * math.cos(t), y, r * math.sin(t))) for r, y in section]
                 for t in (2 * math.pi * k / n for k in range(n))]
        for i in range(n):
            j = (i + 1) % n
            for k in range(4):
                m = (k + 1) % 4
                b.face((verts[i][k], verts[i][m], verts[j][m], verts[j][k]), "CabinShell")


# --------------------------------------------------------------- static parts
def build_spindle(b: kit.Builder) -> None:
    """Fixed spindle through the hub, with a bearing housing and a saddle on each pair of leg tops."""
    drum(b, -SPINDLE_HALF - 0.6, SPINDLE_HALF + 0.6, SPINDLE_R, 14, "Steel", z=HUB_Z)
    for sy in (1, -1):
        y0, y1 = sorted((sy * (SPINDLE_HALF - 3.2), sy * (SPINDLE_HALF + 1.2)))
        drum(b, y0, y1, SPINDLE_R + 0.7, 14, "Steel", z=HUB_Z)
        b.block((0.0, sy * (SPINDLE_HALF - 0.6)), 3.4, 2.2, HUB_Z - 4.6, HUB_Z - 1.6, "Steel")


def build_legs(b: kit.Builder) -> None:
    taper = [1.0, 1.4, 1.6, 1.45, 1.05]
    for sy in (1, -1):
        for sx in (1, -1):
            tube(b, (sx * LEG_FOOT_X, sy * LEG_FOOT_Y, BURY), (sx * 1.6, sy * (SPINDLE_HALF - 0.6), HUB_Z - 3.2),
                 taper, 10, "Steel", ref=(0.0, 1.0, 0.0))
    tube(b, (0.0, BRACE_FOOT_Y, BURY), (0.0, -SPINDLE_HALF - 0.4, HUB_Z - 2.6), [1.1, 1.6, 1.8, 1.55, 1.1], 10,
         "Steel", ref=(1.0, 0.0, 0.0))


def build_station(b: kit.Builder) -> None:
    """Podium with a glazed band, the boarding deck, and a canopy along each side of the path of the cabins."""
    hx, hy = STATION_HALF_X, STATION_HALF_Y
    b.block((0.0, 0.0), hx, hy, BURY, 1.2, "Station")
    b.block((0.0, 0.0), hx - 0.4, hy - 0.4, 1.2, 5.0, "StationGlass")
    b.block((0.0, 0.0), hx, hy, 5.0, STATION_TOP, "Station", top="Roof")
    b.block((0.0, 0.0), 21.0, 9.5, STATION_TOP, STATION_TOP + 0.8, "Station", top="Roof")   # boarding deck
    for sy in (1, -1):
        b.block((0.0, sy * 9.0), 22.0, 2.8, 12.4, 13.0, "Station", top="Roof")
        for x in (-18.0, -6.0, 6.0, 18.0):
            b.block((x, sy * 10.6), 0.35, 0.35, STATION_TOP + 0.8, 12.4, "Steel")


# ------------------------------------------------------------------- assembly
def finish(b: kit.Builder, name: str, shared: dict) -> "bpy.types.Object":
    """kit finish, then point the slots at one shared material per name (no Steel.001 duplicates)."""
    obj = b.finish(name)
    for slot, material in enumerate(COLORS):
        own = obj.data.materials[slot]
        if material in shared:
            obj.data.materials[slot] = shared[material]
            bpy.data.materials.remove(own)
        else:
            own.name = material
            shared[material] = own
    return obj


def build() -> list:
    shared: dict = {}
    b = new_builder()
    for part in (build_spindle, build_legs, build_station):
        part(b)
    support = finish(b, "Support", shared)

    b = new_builder()
    for part in (build_rim, build_cables, build_hub, build_mounts):
        part(b)
    rotor = finish(b, "Rotor", shared)
    rotor.location = (0.0, 0.0, HUB_Z)

    cabins = []
    for i in range(CABINS):
        b = new_builder()
        build_cabin(b)
        cabin = finish(b, f"Cabin_{i:02d}", shared)
        cabin.parent = rotor
        cabin.location = spoke_point(cabin_angle(i), CABIN_CENTER_R)
        cabins.append(cabin)
    bpy.context.view_layer.update()
    return [support, rotor, *cabins]


def check(objects: list) -> dict:
    """kit.check_mesh per object, summed into one report in the kit format (world-space bounds)."""
    parts = {o.name: kit.check_mesh(o) for o in objects}
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for o in objects:
        for corner in o.bound_box:
            p = o.matrix_world @ Vector(corner)
            for k in range(3):
                lo[k], hi[k] = min(lo[k], p[k]), max(hi[k], p[k])
    report = {"object": "HighRoller (Support, Rotor, Cabin_00..Cabin_%02d)" % (CABINS - 1), "objects": len(objects)}
    for key in ("verts", "faces", "tris", "islands", "open_islands", "inside_out_islands", "nonmanifold_edges",
                "degenerate_faces", "loose_verts", "nonplanar_ngons", "windowed_faces"):
        report[key] = sum(p[key] for p in parts.values())
    report["bbox_min"], report["bbox_max"] = [round(v, 3) for v in lo], [round(v, 3) for v in hi]
    report["tris_by_object"] = {"Support": parts["Support"]["tris"], "Rotor": parts["Rotor"]["tris"],
                                "each cabin": parts["Cabin_00"]["tris"]}
    materials: dict = {}
    for p in parts.values():
        for name, count in p["materials"].items():
            materials[name] = materials.get(name, 0) + count
    report["materials"] = materials
    report["glow"] = {"max": max(p["glow"]["max"] for p in parts.values()),
                      "dark_faces": sum(p["glow"]["dark_faces"] for p in parts.values())}
    report["errors"] = [f"{name}: {e}" for name, p in parts.items() for e in p["errors"]]
    report["warnings"] = sorted({w for p in parts.values() for w in p["warnings"]
                                 if not w.startswith(("unused materials", "lowest point"))})
    return report


def export(objects: list, out_dir: str) -> dict:
    """Save the .blend and a GLB that keeps the hierarchy; exporter settings as in kit.export."""
    os.makedirs(out_dir, exist_ok=True)
    if bpy.app.background:
        bpy.context.preferences.filepaths.save_version = 0
    blend, glb = os.path.join(out_dir, f"{STEM}.blend"), os.path.join(out_dir, f"{STEM}.glb")
    for other in bpy.context.scene.objects:
        other.select_set(other in objects)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=True, export_attributes=True, export_vertex_color="NONE",
                              export_all_vertex_colors=False, export_active_vertex_color_when_no_material=False)
    return {"blend": blend, "glb": glb}


def main() -> dict:
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s", force=True)
    args = kit.parse_args()
    out_dir = os.path.abspath(args.out or HERE)
    kit.reset_scene()
    objects = build()
    report = check(objects)
    limit = args.max_tris or MAX_TRIS
    if report["tris"] > limit:
        report["errors"].append(f"{report['tris']} triangles is over the budget of {limit}")
    if not args.skip_export and (not report["errors"] or args.allow_errors):
        report["files"] = export(objects, out_dir)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"{STEM}.report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    log.info("%s: %d objects, %d tris %s, z %.1f..%.1f m", STEM, report["objects"], report["tris"],
             report["tris_by_object"], report["bbox_min"][2], report["bbox_max"][2])
    for line in report["warnings"]:
        log.info("warning: %s", line)
    for line in report["errors"]:
        log.info("ERROR: %s", line)
    if report["errors"] and not args.allow_errors:
        raise RuntimeError(f"mesh check failed for {STEM}: " + "; ".join(report["errors"]))
    return report


if __name__ == "__main__":
    main()
