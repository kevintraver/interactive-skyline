"""Low-poly model of a slab hotel tower (Las Vegas, id w316174410), built procedurally with landmark_kit.

    python <skill>/scripts/run_blender.py build_<stem>.py -- --out .

Units are meters. Blender axes: +X east, +Y north, +Z up; origin at the landmark's center on the ground.
Logos, wordmarks and brand signage are deliberately not modeled: sign areas are plain surfaces.

Sources (one line per number family; see refs/sources.json for the photos):
  - height 146.0 m: project data (osm-height)
  - block plan: footprint.json (skyline_tool footprint), used for the podium
  - tower slab position/size, podium height, roof slope, crown band, screen panel: ratios read off
    refs/Circa_Resort.jpg (view from the west), scaled by the height; all (est.)
"""
import importlib
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import landmark_kit as kit  # noqa: E402  (copied next to this script)

# Split for parallel part-modelers? Move the dimensions, COLORS, ROUGHNESS and glow below into spec.py,
# replace them here with `from spec import *`, and let each modeler write part_<name>.py (assets/part_template.py).

STEM = "circa"
MAX_TRIS = 3_000

# ----------------------------------------------------------------- dimensions
BURY = -2.0
HEIGHT = 146.0             # project data (osm-height): tip of the roof prow
PODIUM_H = 28.0            # (est.) photo ratio
# Block axes: U along the long street edge (bearing 27.7 deg, from footprint.json), V across (to ESE).
UX, UY = math.sin(math.radians(27.7)), math.cos(math.radians(27.7))
VX, VY = UY, -UX
V0, V1 = -41.0, -17.0      # (est.) slab 24 m thick, along the west street edge
U_S = -45.0                # (est.) south end of the slab
U_N0, U_N1 = 26.0, 19.5    # (est.) north end at podium / at top: raked back, photo
GLASS_N, GLASS_S = 112.0, 128.0   # (est.) glass top at north / south end, photo
SLAB_U = (22.0, -55.0)     # (est.) roof slab north edge / prow tip
SLAB_Z = (124.0, 144.0)    # underside at those ends; 2 m thick -> 146 at the prow


def P(u, v, z):
    return (u * UX + v * VX, u * UY + v * VY, z)


def slab_under(u):
    t = (u - SLAB_U[0]) / (SLAB_U[1] - SLAB_U[0])
    return SLAB_Z[0] + t * (SLAB_Z[1] - SLAB_Z[0])


def oriented(rings):
    """Reverse ring winding if needed so the loft's faces point outward."""
    r = rings[0]
    n = [0.0, 0.0, 0.0]
    for a, c in zip(r, r[1:] + r[:1]):
        n[0] += (a[1] - c[1]) * (a[2] + c[2]); n[1] += (a[2] - c[2]) * (a[0] + c[0]); n[2] += (a[0] - c[0]) * (a[1] + c[1])
    c0 = [sum(p[i] for p in rings[0]) / len(r) for i in range(3)]
    c1 = [sum(p[i] for p in rings[-1]) / len(r) for i in range(3)]
    if sum(n[i] * (c1[i] - c0[i]) for i in range(3)) < 0:
        return [list(reversed(x)) for x in rings]
    return rings


# ---------------------------------------------------------------------- style
COLORS = {  # sRGB hex from refs/Circa_Resort.jpg
    "Glass": "A88377",     # rose-bronze reflective glass
    "Crown": "3E241B",     # dark brown roof fascia (sign area left plain)
    "RoofSlab": "E4DCCF",  # pale roof edge / prow soffit
    "Trim": "D9D4CA",      # pale end bands
    "Podium": "B9B4AA",
    "Deck": "7E7A72",
    "Screen": "2A7FD0",    # plain blue media panel, no content
}
ROUGHNESS = {"Glass": 0.3, "Screen": 0.4}
WINDOWS = {"Glass": 1.0}
WARM, COOL = (1.0, 0.82, 0.58), (0.80, 0.88, 1.0)


def glow(material: str, point: kit.Point, center: kit.Point) -> kit.RGB:
    z = point[2]
    if material == "Glass":
        return kit.scaled(WARM, 0.03)
    if material == "Screen":
        return (0.15, 0.55, 1.0)
    if material == "Crown":
        return kit.scaled(WARM, 0.45)
    if material == "RoofSlab":
        return kit.scaled(WARM, 0.25)
    if material == "Trim":
        return kit.scaled(COOL, 0.12)
    if material == "Podium":
        return kit.scaled(WARM, 0.12 + 0.3 * math.exp(-max(z, 0.0) / 12.0))
    return (0.0, 0.0, 0.0)


# --------------------------------------------------------------------- parts
def build_podium(b: kit.Builder) -> None:
    fp = kit.load_footprint(os.path.join(HERE, "footprint.json"))
    b.extrude(fp["volumes"][0]["outline"], BURY, PODIUM_H, "Podium", top="Deck")


def ring(u_s, u_n, v0, v1, z_s, z_n):
    return [P(u_s, v0, z_s), P(u_n, v0, z_n), P(u_n, v1, z_n), P(u_s, v1, z_s)]


def build_tower(b: kit.Builder) -> None:
    z0 = PODIUM_H - 0.5
    crown_n, crown_s = slab_under(U_N1) + 0.5, slab_under(U_S) + 0.5
    b.loft(oriented([
        ring(U_S, U_N0, V0, V1, z0, z0),
        ring(U_S, U_N1, V0, V1, GLASS_S, GLASS_N),
        ring(U_S, U_N1 - 0.3, V0, V1, crown_s, crown_n),
    ]), ["Glass", "Crown"])


def build_roof(b: kit.Builder) -> None:
    (un, us), (zn, zs) = SLAB_U, SLAB_Z
    prof = [(un, zn), (us, zs), (us, zs + 2.0), (un, zn + 2.0)]
    b.loft(oriented([[P(u, V0 - 1.5, z) for u, z in prof], [P(u, V1 + 1.5, z) for u, z in prof]]), "RoofSlab")
    # brown roof skin on top of the slab
    prof = [(un - 1, zn + 2.2), (us + 1, zs + 1.9), (us + 1, zs + 2.0), (un - 1, zn + 2.6)]
    b.loft(oriented([[P(u, V0 - 1.0, z) for u, z in prof], [P(u, V1 + 1.0, z) for u, z in prof]]), "Crown")


def build_prow(b: kit.Builder) -> None:
    # pale wedge under the overhanging roof at the south end (photo), set in from the faces (est.)
    b.loft(oriented([
        ring(U_S - 5.0, U_S + 9.0, V0 + 3.0, V1 - 3.0, GLASS_S, GLASS_S),
        ring(U_S - 8.5, U_S + 9.0, V0 + 3.0, V1 - 3.0, slab_under(U_S - 8.5) + 0.5, slab_under(U_S + 9.0) + 0.5),
    ]), "RoofSlab")


def build_screen(b: kit.Builder) -> None:
    # tall media panel on the west face near the south end (photo); plain color, no content
    b.loft(oriented([
        ring(-43.0, -28.0, V0 - 0.5, V0 + 0.5, 50.0, 50.0),
        ring(-43.0, -28.0, V0 - 0.5, V0 + 0.5, 124.0, 124.0),
    ]), "Screen")


PARTS = {"podium": build_podium, "tower": build_tower, "roof": build_roof, "prow": build_prow, "screen": build_screen}


def build() -> "bpy.types.Object":  # noqa: F821
    b = kit.Builder(COLORS, glow, ROUGHNESS, windows=WINDOWS)
    for part in kit.selected(PARTS):
        part(b)
    return b.finish("Tower")


if __name__ == "__main__":
    kit.main(build, stem=STEM, script_file=__file__, max_tris=MAX_TRIS)
