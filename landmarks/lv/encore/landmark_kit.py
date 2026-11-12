"""Helpers for building low-poly landmark models procedurally in Blender (bpy + bmesh).

Copy this file next to a model's build script; the script imports it, so the model folder stays
self-contained and can be rebuilt later without the skill.

Conventions: meters; Blender axes +X east, +Y north, +Z up; origin at the landmark's center on the
ground. The GLB export is Y-up, so a three.js scene gets (east, up, -north) with no rotation.

Night lighting rides along as a per-corner float color attribute `_GLOW` (linear RGB; 0 = unlit,
above 1 = very bright). A renderer can add it as emissive light at night and ignore it by day.

Typical build script:

    import landmark_kit as kit
    COLORS = {"Concrete": "EDE6CC", "Glass": "1C222A"}
    def glow(material, point, center): return (0.0, 0.0, 0.0)
    def build():
        b = kit.Builder(COLORS, glow)
        b.prism(8.0, 0.0, 120.0, 12, "Concrete")
        return b.finish("Tower")
    if __name__ == "__main__":
        kit.main(build, stem="tower", script_file=__file__)
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

import bmesh
import bpy
from mathutils import Vector

Point = tuple[float, float, float]
RGB = tuple[float, float, float]
UV = tuple[float, float]           # a point on a band: u counts facets around, v runs 0..1 upward
Line = tuple[float, float, float]  # the line a*u + b*v = c across a band
GlowFn = Callable[[str, Point, Point], RGB]  # (material, corner, face center) -> linear RGB

GLOW_ATTRIBUTE = "_GLOW"
WINDOWS_ATTRIBUTE = "_WINDOWS"  # 0..1 per corner: how much procedural lit-window pattern the app draws at night
UV_QUANTUM = 100_000  # band coordinates are snapped to 1e-5 so neighboring cells share their corners
CUT_EPSILON = 1e-9
DEGENERATE_AREA = 1e-8   # m^2
NONPLANAR_TOLERANCE = 1e-3  # m: an n-gon bent more than this may triangulate differently in each viewer

log = logging.getLogger("landmark")


# --------------------------------------------------------------------- numbers
def lerp_table(table: Sequence[tuple[float, float]], z: float) -> float:
    """Piecewise-linear lookup in a (z, value) table sorted by z; extrapolates past either end."""
    if len(table) < 2:
        raise ValueError("a lerp table needs at least two rows")
    if z <= table[0][0]:
        (z0, v0), (z1, v1) = table[0], table[1]
    elif z >= table[-1][0]:
        (z0, v0), (z1, v1) = table[-2], table[-1]
    else:
        (z0, v0), (z1, v1) = next((a, b) for a, b in zip(table, table[1:]) if a[0] <= z <= b[0])
    return v0 if z1 == z0 else v0 + (v1 - v0) * (z - z0) / (z1 - z0)


def circle(radius: float, z: float, segments: int, phase: float = 0.0,
           center: tuple[float, float] = (0.0, 0.0)) -> list[Point]:
    """`segments` points counter-clockwise on a circle; `phase` in radians turns the first one."""
    return [(center[0] + radius * math.cos(phase + math.tau * i / segments),
             center[1] + radius * math.sin(phase + math.tau * i / segments), z) for i in range(segments)]


def polar(bearing_deg: float, radial: float, tangential: float, z: float) -> Point:
    """A point `radial` out along a bearing (degrees counter-clockwise from east) and `tangential` across it."""
    a = math.radians(bearing_deg)
    return (radial * math.cos(a) - tangential * math.sin(a),
            radial * math.sin(a) + tangential * math.cos(a), z)


def compass_to_math(bearing_deg: float) -> float:
    """Compass bearing (0 = north, clockwise) to the math angle polar() takes (0 = east, counter-clockwise)."""
    return (90.0 - bearing_deg) % 360.0


def scale_polygon(points: Sequence[tuple[float, float]], k: float,
                  center: tuple[float, float] | None = None) -> list[tuple[float, float]]:
    """Shrink (k < 1) or grow a footprint toward its centroid: a quick setback for stepped towers."""
    if center is None:
        center = (sum(p[0] for p in points) / len(points), sum(p[1] for p in points) / len(points))
    return [(center[0] + (x - center[0]) * k, center[1] + (y - center[1]) * k) for x, y in points]


def load_footprint(path: str) -> dict:
    """Read a footprint.json written by skyline_tool.py footprint (outlines in meters east/north of the center)."""
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    for v in doc["volumes"]:
        v["outline"] = [tuple(p) for p in v["outline"]]
    return doc


def scaled(color: RGB, strength: float) -> RGB:
    return (color[0] * strength, color[1] * strength, color[2] * strength)


def srgb_to_linear(hex_color: str) -> tuple[float, float, float, float]:
    """'EDE6CC' (sRGB, as picked from a photo) to linear RGBA for Blender's shader inputs."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        raise ValueError(f"color {hex_color!r} is not six hex digits")
    def channel(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return tuple(channel(int(hex_color[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1.0,)


def no_glow(material: str, point: Point, center: Point) -> RGB:
    return (0.0, 0.0, 0.0)


# ------------------------------------------------------------------ patterns
@dataclass(frozen=True)
class Pattern:
    """A flat two-color pattern on a band: cut along `lines`, then each piece takes the material `paint` names."""
    lines: tuple[Line, ...]
    paint: Callable[[float, float], str]


PatternFactory = Callable[[int, float, float], Pattern]  # (segments, facet width m, band slant length m) -> Pattern


def split(poly: list[UV], line: Line) -> list[list[UV]]:
    """Cut a convex polygon in two along a line; a polygon the line misses comes back whole."""
    a, b, c = line
    d = [a * u + b * v - c for u, v in poly]
    if min(d) > -CUT_EPSILON or max(d) < CUT_EPSILON:
        return [poly]
    above, below = [], []
    for i, (p, dp) in enumerate(zip(poly, d)):
        q, dq = poly[(i + 1) % len(poly)], d[(i + 1) % len(poly)]
        if dp > -CUT_EPSILON:
            above.append(p)
        if dp < CUT_EPSILON:
            below.append(p)
        if (dp > CUT_EPSILON and dq < -CUT_EPSILON) or (dp < -CUT_EPSILON and dq > CUT_EPSILON):
            # the cell on the other side of this edge walks it the other way: take the endpoints in a fixed
            # order so both cells compute the very same point, and snap it to the same vertex
            (s, ds), (e, de) = sorted(((p, dp), (q, dq)))
            t = ds / (ds - de)
            x = (s[0] + (e[0] - s[0]) * t, s[1] + (e[1] - s[1]) * t)
            above.append(x)
            below.append(x)
    return [piece for piece in (above, below) if len(piece) >= 3]


def curtain_wall(segments: int, facet_width: float, slant: float, columns: int, rows: int,
                 mullion_width: float, glass: str, mullion: str) -> Pattern:
    """Glass panes on a grid of mullions: `columns` panes across each facet, `rows` up the band.

    The band's own top and bottom edges are left to the neighboring trim bands."""
    if columns < 1 or rows < 1:
        raise ValueError("a curtain wall needs at least one column and one row")
    pitch, mullion_u, mullion_v = 1 / columns, mullion_width / facet_width, mullion_width / slant
    rails = [k / rows for k in range(1, rows)]
    # each mullion starts at a multiple of the pitch; the first of those is the facet's own edge, so no cut there
    cuts = [k * pitch + e for k in range(columns) for e in (0.0, mullion_u)][1:]
    lines = [(1.0, 0.0, j + cut) for j in range(segments) for cut in cuts]
    lines += [(0.0, 1.0, v + e) for v in rails for e in (-mullion_v / 2, mullion_v / 2)]
    def paint(u: float, v: float) -> str:
        on_rail = any(abs(v - rail) < mullion_v / 2 for rail in rails)
        return mullion if u % pitch < mullion_u or on_rail else glass
    return Pattern(tuple(lines), paint)


def diamond_bracing(segments: int, facet_width: float, slant: float, diamonds: int,
                    bar_width: float, glass: str, bar: str) -> Pattern:
    """Two families of diagonals running corner to corner up the band and crossing at half height."""
    if not 1 <= diamonds <= segments:
        raise ValueError(f"diamonds must be 1..{segments}: a diamond narrower than a facet leaves slivers")
    period = segments / diamonds  # facets across one diamond
    # a diagonal climbs `period` facets over the band; offset its center line this far in u for the bar's edges
    offset = bar_width / 2 * math.hypot(slant, period * facet_width) / (slant * facet_width)
    lines = tuple((1.0, slope, k * period + e) for k in range(-1, diamonds + 2)
                  for slope in (-period, period) for e in (-offset, offset))
    def on_bar(x: float) -> bool:
        return min(x % period, period - x % period) < offset
    def paint(u: float, v: float) -> str:
        return bar if on_bar(u - period * v) or on_bar(u + period * v) else glass
    return Pattern(lines, paint)


def stripes(segments: int, facet_width: float, slant: float, count: int, stripe_width: float,
            base: str, stripe: str) -> Pattern:
    """Horizontal stripes (floor bands, light strips) evenly spaced up the band."""
    width_v = stripe_width / slant
    centers = [(k + 0.5) / count for k in range(count)]
    lines = tuple((0.0, 1.0, c + e) for c in centers for e in (-width_v / 2, width_v / 2))
    def paint(u: float, v: float) -> str:
        return stripe if any(abs(v - c) < width_v / 2 for c in centers) else base
    return Pattern(lines, paint)


# ------------------------------------------------------------------ builder
class Builder:
    """Collects faces into one bmesh. Every face gets a material and a night-glow color at each corner."""

    def __init__(self, colors: dict[str, str], glow: GlowFn | None = None,
                 roughness: dict[str, float] | None = None, windows: dict[str, float] | None = None) -> None:
        """`windows` maps materials (usually the facade glass) to how much of the app's procedural lit-window
        pattern they get at night, 0..1; it is stored as the `_WINDOWS` attribute."""
        if not colors:
            raise ValueError("colors must name at least one material")
        self.colors = dict(colors)
        self.mat_index = {name: i for i, name in enumerate(self.colors)}
        self.glow = glow or no_glow
        self.roughness = dict(roughness or {})
        self.windows = dict(windows or {})
        unknown = [m for m in self.windows if m not in self.mat_index]
        if unknown:
            raise KeyError(f"windows names materials that are not in COLORS: {unknown}")
        self.bm = bmesh.new()
        self._glow_layer = self.bm.loops.layers.float_color.new(GLOW_ATTRIBUTE)
        self._win_layer = self.bm.loops.layers.float.new(WINDOWS_ATTRIBUTE) if self.windows else None

    # -- faces
    def face(self, verts: Sequence[bmesh.types.BMVert], material: str) -> bmesh.types.BMFace:
        index = self.mat_index.get(material)
        if index is None:
            raise KeyError(f"material {material!r} is not in COLORS")
        center = tuple(sum(v.co[i] for v in verts) / len(verts) for i in range(3))
        try:
            f = self.bm.faces.new(verts)
        except ValueError as err:  # duplicate face, or repeated vertex
            raise ValueError(f"{err} ({material} face around {tuple(round(c, 2) for c in center)})") from err
        f.material_index = index
        win = self.windows.get(material, 0.0)
        for loop in f.loops:
            loop[self._glow_layer] = (*self.glow(material, tuple(loop.vert.co), center), 1.0)
            if self._win_layer is not None:
                loop[self._win_layer] = win
        return f

    def loft(self, rings: Sequence[Sequence[Point]], materials: str | Sequence[str], cap: bool = True) -> None:
        """Skin consecutive rings of equal vertex count; materials[i] colors band i (or one material for all)."""
        if len(rings) < 2:
            raise ValueError("a loft needs at least two rings")
        n = len(rings[0])
        if n < 3 or any(len(r) != n for r in rings):
            raise ValueError("loft rings must all have the same number (>= 3) of points")
        bands = [materials] * (len(rings) - 1) if isinstance(materials, str) else list(materials)
        if len(bands) != len(rings) - 1:
            raise ValueError(f"{len(rings) - 1} bands need {len(rings) - 1} materials, got {len(bands)}")
        vert_rings = [[self.bm.verts.new(p) for p in ring] for ring in rings]
        for i, (lower, upper) in enumerate(zip(vert_rings, vert_rings[1:])):
            for j in range(n):
                k = (j + 1) % n
                self.face((lower[j], lower[k], upper[k], upper[j]), bands[i])
        if cap:
            self.face(vert_rings[0][::-1], bands[0])
            self.face(vert_rings[-1], bands[-1])

    # -- solids
    def box(self, half: float, z0: float, z1: float, material: str, half_top: float | None = None,
            center: tuple[float, float] = (0.0, 0.0)) -> None:
        """A square prism, optionally tapering to `half_top`."""
        def square(h: float, z: float) -> list[Point]:
            return [(center[0] + sx * h, center[1] + sy * h, z) for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
        self.loft([square(half, z0), square(half if half_top is None else half_top, z1)], [material])

    def block(self, center: tuple[float, float], half_x: float, half_y: float, z0: float, z1: float,
              material: str, turn_deg: float = 0.0, top: str | None = None) -> None:
        """A rectangular block turned `turn_deg` counter-clockwise; `top` colors the roof if given."""
        a = math.radians(turn_deg)
        ca, sa = math.cos(a), math.sin(a)
        corners = [(center[0] + x * ca - y * sa, center[1] + x * sa + y * ca)
                   for x, y in ((half_x, half_y), (-half_x, half_y), (-half_x, -half_y), (half_x, -half_y))]
        self.extrude(corners, z0, z1, material, top=top)

    def prism(self, radius: float, z0: float, z1: float, segments: int, material: str,
              radius_top: float | None = None, center: tuple[float, float] = (0.0, 0.0), phase: float = 0.0) -> None:
        """A cylinder or frustum; with radius_top=0 it becomes a cone with a point at the top."""
        top = radius if radius_top is None else radius_top
        if top > 0:
            self.loft([circle(radius, z0, segments, phase, center), circle(top, z1, segments, phase, center)], [material])
            return
        base = [self.bm.verts.new(p) for p in circle(radius, z0, segments, phase, center)]
        apex = self.bm.verts.new((center[0], center[1], z1))
        for j in range(segments):
            self.face((base[j], base[(j + 1) % segments], apex), material)
        self.face(base[::-1], material)

    def extrude(self, footprint: Sequence[tuple[float, float]], z0: float, z1: float, material: str,
                top: str | None = None, bottom: str | None = None) -> None:
        """Extrude a footprint polygon (any winding, may be concave) from z0 to z1."""
        pts = list(footprint)
        area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1])) / 2
        if abs(area) < DEGENERATE_AREA:
            raise ValueError("footprint has no area")
        if area < 0:
            pts.reverse()  # counter-clockwise, so the walls face out
        lower = [self.bm.verts.new((x, y, z0)) for x, y in pts]
        upper = [self.bm.verts.new((x, y, z1)) for x, y in pts]
        n = len(pts)
        for j in range(n):
            k = (j + 1) % n
            self.face((lower[j], lower[k], upper[k], upper[j]), material)
        self.face(lower[::-1], bottom or material)
        self.face(upper, top or material)

    def beam(self, bearing_deg: float, start: tuple[float, float], end: tuple[float, float],
             half_width: float, half_depth: float, material: str) -> None:
        """A straight box in the vertical radial plane of `bearing_deg`, from (radius, z) to (radius, z)."""
        (r0, z0), (r1, z1) = start, end
        length = math.hypot(r1 - r0, z1 - z0)
        if length == 0:
            raise ValueError("a beam needs two different ends")
        nr, nz = -(z1 - z0) / length * half_depth, (r1 - r0) / length * half_depth  # across the beam
        def section(r: float, z: float) -> list[Point]:
            return [polar(bearing_deg, r + nr, half_width, z + nz), polar(bearing_deg, r - nr, half_width, z - nz),
                    polar(bearing_deg, r - nr, -half_width, z - nz), polar(bearing_deg, r + nr, -half_width, z + nz)]
        self.loft([section(r0, z0), section(r1, z1)], [material])

    def strut(self, a: Point, b: Point, half: float, facing: Point, material: str) -> None:
        """A square bar from `a` to `b`, turned so that one pair of its sides faces along `facing`."""
        axis = Vector(b) - Vector(a)
        if axis.length == 0:
            raise ValueError("a strut needs two different ends")
        axis.normalize()
        side = axis.cross(Vector(facing))
        if side.length < 1e-9:
            raise ValueError("strut `facing` must not be parallel to the strut")
        side.normalize()
        out = side.cross(axis)
        corners = [half * (s * side + o * out) for s, o in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
        self.loft([[tuple(Vector(end) + c) for c in corners] for end in (a, b)], [material])

    def lattice_mast(self, z0: float, z1: float, chord: float, bays: int, post: float, bar: float,
                     post_material: str, bar_material: str) -> None:
        """An open square lattice: four corner posts at +-chord, a girt at every bay and an X on every face."""
        corners = [(sx * chord, sy * chord) for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
        for corner in corners:
            self.box(post, z0, z1, post_material, center=corner)
        levels = [z0 + (z1 - z0) * i / bays for i in range(bays + 1)]
        for (x0, y0), (x1, y1) in zip(corners, corners[1:] + corners[:1]):
            facing = (x0 + x1, y0 + y1, 0.0)
            for z in levels[1:-1]:
                self.strut((x0, y0, z), (x1, y1, z), bar, facing, bar_material)
            for za, zb in zip(levels, levels[1:]):
                self.strut((x0, y0, za), (x1, y1, zb), bar, facing, bar_material)
                self.strut((x1, y1, za), (x0, y0, zb), bar, facing, bar_material)

    def revolve(self, profile: Sequence[tuple[float, float, str]], segments: int,
                patterns: dict[str, PatternFactory] | None = None, phase: float = 0.0) -> None:
        """A closed surface of revolution from (radius, height, band) points, bottom to top.

        Each point's `band` colors the band from it up to the next point (the last point's is unused): a
        material, or a key of `patterns` for a band cut into a flat two-color pattern (mullions, bracing,
        stripes). A patterned band needs a plain band below and above it. Equal heights make flat rings;
        the first and last rings are capped."""
        patterns = dict(patterns or {})
        bands = [band for _, _, band in profile[:-1]]
        for i, band in enumerate(bands):
            if band in patterns:
                if i in (0, len(bands) - 1) or {bands[i - 1], bands[i + 1]} & patterns.keys():
                    raise ValueError(f"profile band {i} ({band}) needs a plain band below and above it")
            elif band not in self.mat_index:
                raise ValueError(f"profile band {i}: {band!r} is neither a material nor a pattern")
        surface = RingSurface(self, [circle(r, z, segments, phase) for r, z, _ in profile])
        for i, band in enumerate(bands):  # patterns first, so plain neighbors can pick up their extra vertices
            if band in patterns:
                (r0, z0), (r1, z1) = profile[i][:2], profile[i + 1][:2]
                facet_width = (r0 + r1) * math.sin(math.pi / segments)  # chord at half height
                surface.patterned_band(i, patterns[band](segments, facet_width, math.hypot(r1 - r0, z1 - z0)))
        for i, band in enumerate(bands):
            if band not in patterns:
                surface.plain_band(i, band)
        surface.cap(0, bands[0], downward=True)
        surface.cap(len(profile) - 1, bands[-1], downward=False)

    # -- output
    def finish(self, name: str) -> bpy.types.Object:
        """Fix normals, turn the bmesh into a mesh object with its materials, link it and select it."""
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for material, hex_color in self.colors.items():
            mesh.materials.append(make_material(material, hex_color, self.roughness.get(material, 0.85)))
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        for other in bpy.context.scene.objects:
            other.select_set(False)
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        return obj


@dataclass
class RingSurface:
    """Bands between coaxial rings of equal vertex count that share their vertices, so the skin stays closed.

    On band i a point is (u, v): u in facets around from vertex 0, v from 0 on ring i to 1 on ring i + 1.
    A band cut into a pattern leaves extra vertices on its rings, which the plain bands next to it pick up."""
    builder: Builder
    rings: list[list[Point]]
    verts: dict[tuple[int, int, int], bmesh.types.BMVert] = field(default_factory=dict, init=False, repr=False)
    on_ring: dict[int, set[int]] = field(default_factory=dict, init=False, repr=False)

    @property
    def segments(self) -> int:
        return len(self.rings[0])

    def point(self, ring: int, u: float, v: float) -> Point:
        j, t = int(u) % self.segments, u - int(u)
        def along(r: int) -> Vector:
            pts = self.rings[r]
            return Vector(pts[j]).lerp(Vector(pts[(j + 1) % self.segments]), t)
        return tuple(along(ring).lerp(along(ring + 1), v) if v > 0.0 else along(ring))

    def vert(self, ring: int, u: float, v: float) -> bmesh.types.BMVert:
        qu, qv = round(u * UV_QUANTUM) % (self.segments * UV_QUANTUM), round(v * UV_QUANTUM)
        if qv in (0, UV_QUANTUM):  # on a ring: shared with the band on its other side
            ring, qv = ring + qv // UV_QUANTUM, 0
            self.on_ring.setdefault(ring, set()).add(qu)
        key = (ring, qu, qv)
        if key not in self.verts:
            self.verts[key] = self.builder.bm.verts.new(self.point(ring, qu / UV_QUANTUM, qv / UV_QUANTUM))
        return self.verts[key]

    def ring_row(self, ring: int, j: int) -> list[tuple[float, bmesh.types.BMVert]]:
        lo, hi = j * UV_QUANTUM, (j + 1) * UV_QUANTUM
        between = sorted(q for q in self.on_ring.get(ring, ()) if lo < q < hi)
        return [(q / UV_QUANTUM, self.vert(ring, q / UV_QUANTUM, 0.0)) for q in (lo, *between, hi)]

    def patterned_band(self, ring: int, pattern: Pattern) -> None:
        for j in range(self.segments):
            cells = [[(j, 0.0), (j + 1, 0.0), (j + 1, 1.0), (j, 1.0)]]
            for line in pattern.lines:
                cells = [piece for cell in cells for piece in split(cell, line)]
            for cell in cells:
                verts = [self.vert(ring, u, v) for u, v in cell]
                verts = [vert for i, vert in enumerate(verts) if vert is not verts[i - 1]]
                if len(verts) >= 3:
                    u, v = (sum(p[0] for p in cell) / len(cell), sum(p[1] for p in cell) / len(cell))
                    self.builder.face(verts, pattern.paint(u, v))

    def plain_band(self, ring: int, material: str) -> None:
        for j in range(self.segments):
            lower, upper = self.ring_row(ring, j), self.ring_row(ring + 1, j)
            if len(lower) == 2 and len(upper) == 2:
                self.builder.face((lower[0][1], lower[1][1], upper[1][1], upper[0][1]), material)
                continue
            i = k = 0
            while i < len(lower) - 1 or k < len(upper) - 1:
                if k == len(upper) - 1 or (i < len(lower) - 1 and lower[i + 1][0] <= upper[k + 1][0]):
                    self.builder.face((lower[i][1], lower[i + 1][1], upper[k][1]), material)
                    i += 1
                else:
                    self.builder.face((lower[i][1], upper[k + 1][1], upper[k][1]), material)
                    k += 1

    def cap(self, ring: int, material: str, downward: bool) -> None:
        verts = [self.vert(ring, j, 0.0) for j in range(self.segments)]
        self.builder.face(verts[::-1] if downward else verts, material)


# ------------------------------------------------------------- scene + files
def make_material(name: str, hex_color: str, roughness: float = 0.85) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    if mat.node_tree is None:
        mat.use_nodes = True
    shader = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")  # by type: names are localized
    linear = srgb_to_linear(hex_color)
    shader.inputs["Base Color"].default_value = linear
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = 0.0
    mat.diffuse_color = linear  # viewport and Workbench color
    return mat


def reset_scene() -> None:
    """Remove everything a fresh (factory) scene or an earlier build left behind."""
    for collection in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for item in list(collection):
            collection.remove(item)


def check_mesh(obj: bpy.types.Object) -> dict:
    """Facts about the mesh, plus `errors` (would break a renderer or a BVH) and `warnings` (worth a look)."""
    mesh = obj.data
    mesh.calc_loop_triangles()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.faces.ensure_lookup_table()
    seen: set[int] = set()
    islands = []
    for start in bm.faces:
        if start.index in seen:
            continue
        stack, faces = [start], []
        seen.add(start.index)
        while stack:
            f = stack.pop()
            faces.append(f)
            for e in f.edges:
                for g in e.link_faces:
                    if g.index not in seen:
                        seen.add(g.index)
                        stack.append(g)
        volume = 0.0
        for f in faces:
            co = [l.vert.co for l in f.loops]
            for i in range(1, len(co) - 1):
                volume += co[0].dot(co[i].cross(co[i + 1])) / 6
        open_edges = {e.index for f in faces for e in f.edges if len(e.link_faces) != 2}
        islands.append({"faces": len(faces), "volume": round(volume, 3), "open_edges": len(open_edges)})
    nonmanifold = sum(1 for e in bm.edges if len(e.link_faces) != 2)
    degenerate = sum(1 for f in bm.faces if f.calc_area() < DEGENERATE_AREA)
    loose = sum(1 for v in bm.verts if not v.link_faces)
    nonplanar = 0
    for f in bm.faces:
        if len(f.verts) > 3:
            center = f.calc_center_median()
            if max(abs((v.co - center).dot(f.normal)) for v in f.verts) > NONPLANAR_TOLERANCE:
                nonplanar += 1
    names = [m.name if m else "?" for m in mesh.materials]
    usage = {name: 0 for name in names}
    for f in bm.faces:
        usage[names[f.material_index]] = usage.get(names[f.material_index], 0) + 1
    glow_layer = bm.loops.layers.float_color.get(GLOW_ATTRIBUTE)
    glow = None
    if glow_layer is not None:
        values = [loop[glow_layer] for f in bm.faces for loop in f.loops]
        dark = sum(1 for f in bm.faces if all(max(loop[glow_layer][:3]) <= 0 for loop in f.loops))
        glow = {"max": round(max(max(v[:3]) for v in values), 3), "dark_faces": dark}
    win_layer = bm.loops.layers.float.get(WINDOWS_ATTRIBUTE)
    windowed = sum(1 for f in bm.faces if f.loops[0][win_layer] > 0) if win_layer is not None else 0
    bm.free()
    xs, ys, zs = zip(*(v.co[:] for v in mesh.vertices))
    report = {
        "object": obj.name,
        "verts": len(mesh.vertices), "faces": len(mesh.polygons), "tris": len(mesh.loop_triangles),
        "bbox_min": [round(min(xs), 3), round(min(ys), 3), round(min(zs), 3)],
        "bbox_max": [round(max(xs), 3), round(max(ys), 3), round(max(zs), 3)],
        "islands": len(islands),
        "open_islands": sum(1 for i in islands if i["open_edges"]),
        "inside_out_islands": sum(1 for i in islands if i["volume"] <= 0 and not i["open_edges"]),
        "nonmanifold_edges": nonmanifold, "degenerate_faces": degenerate, "loose_verts": loose,
        "nonplanar_ngons": nonplanar, "materials": usage, "glow": glow, "windowed_faces": windowed,
    }
    errors, warnings = [], []
    if degenerate:
        errors.append(f"{degenerate} degenerate (zero-area) faces")
    if loose:
        errors.append(f"{loose} loose vertices")
    if report["inside_out_islands"]:
        errors.append(f"{report['inside_out_islands']} closed islands are inside out (negative volume)")
    if nonmanifold:
        warnings.append(f"{nonmanifold} open or non-manifold edges in {report['open_islands']} islands "
                        "(fine for a deliberate single-sided detail, otherwise a hole)")
    if nonplanar:
        warnings.append(f"{nonplanar} n-gons are not flat; split them so every viewer triangulates them alike")
    unused = [name for name, count in usage.items() if count == 0]
    if unused:
        warnings.append(f"unused materials: {', '.join(unused)}")
    if glow is None:
        warnings.append(f"no {GLOW_ATTRIBUTE} attribute: the model will be dark at night")
    if min(zs) > 0.01:
        warnings.append(f"lowest point is {min(zs):.2f} m above the origin: the model will float")
    report["errors"], report["warnings"] = errors, warnings
    return report


def export(obj: bpy.types.Object, out_dir: str, stem: str) -> dict[str, str]:
    """Save <stem>.blend and <stem>.glb. The glow travels only as `_GLOW`, never as COLOR_0, which viewers
    would multiply into the base color."""
    os.makedirs(out_dir, exist_ok=True)
    if bpy.app.background:
        bpy.context.preferences.filepaths.save_version = 0  # no .blend1 backups; not saved in a factory session
    blend = os.path.join(out_dir, f"{stem}.blend")
    glb = os.path.join(out_dir, f"{stem}.glb")
    for other in bpy.context.scene.objects:
        other.select_set(other is obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_yup=True,
                              export_apply=True, export_attributes=True, export_vertex_color="NONE",
                              export_all_vertex_colors=False, export_active_vertex_color_when_no_material=False)
    return {"blend": blend, "glb": glb}


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Options after Blender's `--` separator: blender -b --python build.py -- --out DIR."""
    argv = list(sys.argv if argv is None else argv)
    argv = argv[argv.index("--") + 1:] if "--" in argv else []
    parser = argparse.ArgumentParser(prog="build script")
    parser.add_argument("--out", help="folder for the .blend, .glb and report (default: next to the script)")
    parser.add_argument("--skip-export", action="store_true", help="build and check only")
    parser.add_argument("--max-tris", type=int, help="fail if the model has more triangles than this")
    parser.add_argument("--allow-errors", action="store_true", help="export even if the mesh check finds errors")
    parser.add_argument("--only", default="", help="comma-separated part names to build (see selected())")
    return parser.parse_args(argv)


def selected(parts: dict[str, Callable[["Builder"], None]]) -> list[Callable[["Builder"], None]]:
    """The parts named by --only (all of them without it), so parallel part-modelers can build just theirs."""
    wanted = [p.strip() for p in parse_args().only.split(",") if p.strip()]
    unknown = [p for p in wanted if p not in parts]
    if unknown:
        raise SystemExit(f"--only names unknown parts {unknown}; known: {sorted(parts)}")
    return [fn for name, fn in parts.items() if not wanted or name in wanted]


def main(build: Callable[[], bpy.types.Object], stem: str, script_file: str, max_tris: int | None = None) -> dict:
    """Reset the scene, build, check, write <stem>.report.json, export. Raises on a failed check, which a
    headless run with --python-exit-code 1 turns into a non-zero exit."""
    logging.basicConfig(level=logging.INFO, stream=sys.stdout, format="%(message)s", force=True)
    args = parse_args()
    out_dir = os.path.abspath(args.out or os.path.dirname(os.path.abspath(script_file)))
    reset_scene()
    obj = build()
    report = check_mesh(obj)
    limit = args.max_tris or max_tris
    if limit and report["tris"] > limit:
        report["errors"].append(f"{report['tris']} triangles is over the budget of {limit}")
    if not args.skip_export and (not report["errors"] or args.allow_errors):
        report["files"] = export(obj, out_dir, stem)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, f"{stem}.report.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    log.info("%s: %d verts, %d tris, %d islands, z %.1f..%.1f m", stem, report["verts"], report["tris"],
             report["islands"], report["bbox_min"][2], report["bbox_max"][2])
    for line in report["warnings"]:
        log.info("warning: %s", line)
    for line in report["errors"]:
        log.info("ERROR: %s", line)
    if report["errors"] and not args.allow_errors:
        raise RuntimeError(f"mesh check failed for {stem}: " + "; ".join(report["errors"]))
    return report
