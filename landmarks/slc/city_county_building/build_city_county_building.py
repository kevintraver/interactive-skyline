"""Low-poly model of the Salt Lake City and County Building (Salt Lake City), built with landmark_kit.

Sources: height 68.9 m = project lidar data; plan and volume tops = mapped footprint (footprint.json);
roof/tower stage heights estimated from Commons photos (refs/), colors from the same (sandstone, grey slate).
No signage modeled.
"""
import importlib, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402

STEM = "city_county_building"
MAX_TRIS = 5_000
BURY = -2.0
HEIGHT = 68.9
FP = kit.load_footprint(os.path.join(HERE, "footprint.json"))
VOL = FP["volumes"]

COLORS = {"Stone": "A89A86", "Slate": "5B6068", "Trim": "C9BFAA", "Clock": "B5A892"}
ROUGHNESS = {"Slate": 0.6}
WARM = (1.0, 0.78, 0.5)


def glow(material, point, center):
    z = max(point[2], 0.0)
    if material == "Slate":
        return kit.scaled(WARM, 0.08)
    if material == "Clock":
        return kit.scaled(WARM, 0.45)
    return kit.scaled(WARM, 0.22 + 0.25 * math.exp(-z / 25.0) + (0.25 if z > 40 else 0.0))


def ccw(poly):
    a = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]))
    return list(poly) if a > 0 else list(reversed(poly))


def hip(b, poly, z_eave, z_top, k, mat="Slate"):
    poly = ccw(poly)
    top = kit.scale_polygon(poly, k)
    b.loft([[(x, y, z_eave) for x, y in poly], [(x, y, z_top) for x, y in top]], [mat])


def build_body(b):
    for i, v in enumerate(VOL):
        if i in (0, 1):
            continue
        poly, top = v["outline"], v["top"]
        if i in (3, 4, 5, 6):  # corner pavilions with hipped slate roofs
            b.extrude(poly, BURY, top - 7, "Stone")
            hip(b, poly, top - 7, top, 0.35)
        elif i == 2:
            b.extrude(poly, BURY, top, "Stone", top="Slate")
        elif i in (15, 20):  # north and south gabled pavilions
            b.extrude(poly, BURY, top - 5, "Stone")
            hip(b, poly, top - 5, top, 0.5)
        else:
            b.extrude(poly, BURY, top, "Stone", top="Slate")


def build_tower(b):
    cx, cy = 0.1, 0.1
    b.block((cx, cy), 5.3, 5.3, BURY, 44.0, "Stone")
    b.block((cx, cy), 5.4, 5.4, 44.0, 45.0, "Trim")
    b.block((cx, cy), 4.5, 4.5, 45.0, 53.0, "Clock")  # clock stage, lit faces
    b.block((cx, cy), 4.7, 4.7, 53.0, 54.0, "Trim")
    hip(b, [(cx + 4.7, cy + 4.7), (cx - 4.7, cy + 4.7), (cx - 4.7, cy - 4.7), (cx + 4.7, cy - 4.7)], 54.0, 58.7, 0.28)
    b.prism(1.4, 58.0, 62.0, 8, "Trim", radius_top=1.0, center=(0.2, -0.3))
    b.prism(1.0, 62.0, HEIGHT, 8, "Slate", radius_top=0.0, center=(0.2, -0.3))
    for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1)):  # corner turrets
        b.prism(1.3, 28.0, 41.0, 8, "Stone", center=(cx + sx * 5.2, cy + sy * 5.2))
        b.prism(1.3, 41.0, 47.0, 8, "Slate", radius_top=0.0, center=(cx + sx * 5.2, cy + sy * 5.2))


def part_files() -> dict:
    """part_<name>.py files next to this script, imported only when built, so one broken part never stops
    another modeler from building theirs with --only."""
    names = sorted(f[5:-3] for f in os.listdir(HERE) if f.startswith("part_") and f.endswith(".py"))
    return {n: (lambda b, n=n: importlib.import_module(f"part_{n}").build(b)) for n in names}


PARTS = {"body": build_body, "tower": build_tower, **part_files()}  # build order; --only body,top builds a subset


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows={})
    for part in kit.selected(PARTS):
        part(b)
    return b.finish(STEM.title())


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
