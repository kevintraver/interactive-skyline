"""The landmark kit for a model made of moving parts (plan 03, task F3.2).

`landmark_kit.py` beside this file is a verbatim copy of the blender-landmark-model skill's kit (as models/drive
keeps one), so this folder rebuilds without the skill; this module imports it and adds what an aircraft needs:

- `PartBuilder`: the kit's Builder (lofts, boxes, prisms, extrusions, struts, revolves) for ONE part, without the
  `_GLOW` attribute (the aircraft's night light comes from its own lamps, below), with materials shared by name
  across parts, and with optional smooth shading by angle.
- `Model.part(builder, name, pivot, axis, parent)`: finishes the builder into an object whose origin is the
  part's pivot (a point on its hinge line or track) and whose rest rotation is identity, parented to another
  part or to the model's root. Geometry is given in the MODEL frame; the kit moves it into the part's own frame.
- `Model.bake_lights(lamps)`: for each corner of every part, how much light each of the aircraft's lamps throws
  on it (inverse square, the lamp's cone, the surface's cosine, and occlusion by every other part, by ray
  casting), written as two four-component per-corner attributes `_LIGHTS0` and `_LIGHTS1`. They are byte
  colours, which the glTF exporter writes as normalized unsigned shorts (8 bytes a vertex for both); values are
  0..1 in linear units of the lamp's on-axis irradiance at the reference distance.
- `Model.check(budget, proxy_names)`: the kit's mesh check per part, plus a triangle budget for the whole.
- `Model.export(path)`: one GLB, every part a named node with its transform (translation = pivot relative to its
  parent), its hinge axis in the node's `extras.hingeAxis` (glTF axes), Y-up.

Frames. Blender model frame: +X right wing, +Y forward (the nose), +Z up, metres, origin on the centre line at
the main-gear contact plane. The glTF exporter turns Blender (x, y, z) into glTF (x, z, -y): so in the GLB the
nose points -Z, the right wing +X and up is +Y, as plan 03's section 5.5 wants. `to_gltf()` converts a vector.
"""
from __future__ import annotations

import json
import math
import os
import struct
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

import landmark_kit as kit

LIGHT_ATTRIBUTES = ("_LIGHTS0", "_LIGHTS1")
Point = tuple[float, float, float]


def to_gltf(v: Sequence[float]) -> tuple[float, float, float]:
    """A Blender model-frame vector in glTF axes (Y-up, -Z forward); no negative zeros, rounded to a micrometre."""
    return tuple(round(c, 6) + 0.0 for c in (float(v[0]), float(v[2]), -float(v[1])))


def linear_to_srgb(c: float) -> float:
    """Byte-colour layers hold sRGB; the exporter linearizes them. Writing srgb(v) makes v come out."""
    c = min(1.0, max(0.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


# ------------------------------------------------------------------------------------------------ builder
class PartBuilder(kit.Builder):
    """kit.Builder for one part: no `_GLOW` layer, materials shared by name, optional smooth shading."""

    def __init__(self, colors: dict[str, str], roughness: dict[str, float] | None = None,
                 metallic: dict[str, float] | None = None, smooth_deg: float | None = None,
                 smooth: Iterable[str] | None = None) -> None:
        super().__init__(colors, glow=None, roughness=roughness)
        self.bm.loops.layers.float_color.remove(self._glow_layer)
        self._glow_layer = None
        self.metallic = dict(metallic or {})
        self.smooth_deg = smooth_deg
        self.smooth = set(smooth) if smooth is not None else None  # materials shaded smooth (None: all)

    def face(self, verts, material):
        index = self.mat_index.get(material)
        if index is None:
            raise KeyError(f"material {material!r} is not in COLORS")
        try:
            f = self.bm.faces.new(verts)
        except ValueError as err:
            center = tuple(round(sum(v.co[i] for v in verts) / len(verts), 2) for i in range(3))
            raise ValueError(f"{err} ({material} face around {center})") from err
        f.material_index = index
        return f

    def finish(self, name: str) -> bpy.types.Object:
        # triangulate every face that is not flat, so every viewer splits it the same way
        self.bm.normal_update()       # faces made with faces.new have no normal until this
        bent = [f for f in self.bm.faces if len(f.verts) > 3 and max(
            abs((v.co - f.calc_center_median()).dot(f.normal)) for v in f.verts) > kit.NONPLANAR_TOLERANCE * 0.5]
        if bent:
            bmesh.ops.triangulate(self.bm, faces=bent, quad_method="BEAUTY", ngon_method="BEAUTY")
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces[:])
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for material, hex_color in self.colors.items():
            mat = bpy.data.materials.get(material)
            if mat is None:
                mat = kit.make_material(material, hex_color, self.roughness.get(material, 0.6))
                shader = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
                shader.inputs["Metallic"].default_value = self.metallic.get(material, 0.0)
            mesh.materials.append(mat)
        if self.smooth_deg is not None:
            names = [m.name for m in mesh.materials]
            for poly in mesh.polygons:
                poly.use_smooth = self.smooth is None or names[poly.material_index] in self.smooth
            mesh.set_sharp_from_angle(angle=math.radians(self.smooth_deg))
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


def unused_materials_trimmed(obj: bpy.types.Object) -> None:
    """Drop material slots no face uses, so each node's primitives are only the ones it draws."""
    mesh = obj.data
    indices = [p.material_index for p in mesh.polygons]
    used = sorted(set(indices))
    remap = {old: new for new, old in enumerate(used)}
    keep = [mesh.materials[i] for i in used]
    mesh.materials.clear()          # resets the faces' indices, so they are set again after
    for m in keep:
        mesh.materials.append(m)
    mesh.polygons.foreach_set("material_index", [remap[i] for i in indices])
    mesh.update()


# ------------------------------------------------------------------------------------------------ lamps
@dataclass(frozen=True)
class Lamp:
    """A lamp for the bake: model-frame position and aim, full cone angle, attribute channel 0..7."""
    name: str
    position: Point
    direction: Point
    cone_deg: float
    channel: int

    def weight(self, to_point: Vector) -> float:
        """The cone: 1 inside 70% of the half angle, smooth to 0 at the edge; omni at 360 degrees."""
        if self.cone_deg >= 359.0:
            return 1.0
        d = Vector(self.direction).normalized()
        cos_a = d.dot(to_point.normalized())
        half = math.radians(self.cone_deg / 2)
        inner, outer = math.cos(half * 0.7), math.cos(half)
        if cos_a >= inner:
            return 1.0
        if cos_a <= outer:
            return 0.0
        t = (cos_a - outer) / (inner - outer)
        return t * t * (3 - 2 * t)


# ------------------------------------------------------------------------------------------------ model
@dataclass
class PartInfo:
    name: str
    obj: bpy.types.Object
    pivot: Vector          # model frame
    axis: Vector           # model frame, unit
    parent: str | None
    role: str              # "part" or "proxy"


@dataclass
class Model:
    """The parts of one GLB, under a root empty."""
    root_name: str = "Airframe"
    parts: dict[str, PartInfo] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.root = bpy.data.objects.new(self.root_name, None)
        bpy.context.scene.collection.objects.link(self.root)

    def part(self, builder: PartBuilder, name: str, pivot: Point = (0.0, 0.0, 0.0),
             axis: Point = (1.0, 0.0, 0.0), parent: str | None = None, role: str = "part") -> bpy.types.Object:
        """Finish `builder` as part `name`: origin on `pivot` (model frame), hinge `axis` (model frame)."""
        if name in self.parts:
            raise ValueError(f"part {name!r} twice")
        obj = builder.finish(name)
        unused_materials_trimmed(obj)
        pv = Vector(pivot)
        obj.data.transform(Matrix.Translation(-pv))
        parent_info = self.parts[parent] if parent else None
        if parent and parent_info is None:
            raise KeyError(f"parent {parent!r} is not a part yet")
        obj.parent = parent_info.obj if parent_info else self.root
        obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.location = pv - (parent_info.pivot if parent_info else Vector())
        ax = Vector(axis)
        if ax.length == 0:
            raise ValueError(f"{name}: hinge axis is zero")
        ax.normalize()
        self.parts[name] = PartInfo(name, obj, pv, ax, parent, role)
        obj["hingeAxis"] = list(to_gltf(ax))
        obj["hingePoint"] = list(to_gltf(pv))  # not "pivot": three.js 0.187 GLTFLoader reserves extras.pivot
        return obj

    def _tree(self) -> BVHTree | None:
        bpy.context.view_layer.update()
        verts, polys = [], []
        for info in self.parts.values():
            if info.role != "part":
                continue
            mw = info.obj.matrix_world
            base = len(verts)
            verts += [mw @ v.co for v in info.obj.data.vertices]
            polys += [[base + i for i in p.vertices] for p in info.obj.data.polygons]
        return BVHTree.FromPolygons(verts, polys, epsilon=0.0) if polys else None

    def snap_lamps(self, lamps: Sequence[Lamp], offset: float = 0.05) -> list[Lamp]:
        """Each lamp moved onto the nearest point of the skin, then `offset` out along the skin's normal: a lamp
        position from a table sits on the structure, not inside it."""
        tree = self._tree()
        out = []
        for lamp in lamps:
            loc, normal, _, _ = tree.find_nearest(Vector(lamp.position))
            p = loc + normal.normalized() * offset
            out.append(Lamp(lamp.name, tuple(p), lamp.direction, lamp.cone_deg, lamp.channel))
        return out

    # -- light bake
    def bake_lights(self, lamps: Sequence[Lamp], reference: float = 1.0, floor: float = 0.02,
                    max_range: float = 30.0, occlude: bool = True, skip: Iterable[str] = ()) -> dict:
        """Write `_LIGHTS0` / `_LIGHTS1` on every part (zeros on parts in `skip`). Returns stats per channel
        (channel names are those of plan 03's light bit field)."""
        bpy.context.view_layer.update()
        skip = set(skip)
        verts, polys = [], []
        if occlude:
            for info in self.parts.values():
                if info.role != "part":
                    continue
                mw = info.obj.matrix_world
                base = len(verts)
                verts += [mw @ v.co for v in info.obj.data.vertices]
                polys += [[base + i for i in p.vertices] for p in info.obj.data.polygons]
        tree = BVHTree.FromPolygons(verts, polys, epsilon=0.0) if occlude and polys else None
        names = ["NAV", "BEACON", "STROBE", "LANDING", "TAXI", "TURNOFF", "LOGO", "WING"]
        stats = {names[c]: {"lit_corners": 0, "max": 0.0} for c in sorted({lamp.channel for lamp in lamps})}
        for info in self.parts.values():
            mesh = info.obj.data
            layers = [mesh.color_attributes.get(n) or mesh.color_attributes.new(n, "BYTE_COLOR", "CORNER")
                      for n in LIGHT_ATTRIBUTES]
            values = [[0.0] * 8 for _ in range(len(mesh.loops))]
            if info.name not in skip and info.role == "part":
                mw = info.obj.matrix_world
                nm = mw.to_3x3().inverted().transposed()
                mesh.calc_loop_triangles()
                corner_normals = mesh.corner_normals
                world = [mw @ v.co for v in mesh.vertices]
                for li, lamp in enumerate(lamps):
                    lp = Vector(lamp.position)
                    seen: dict[int, float] = {}  # per vertex: visibility and distance factor, cone
                    for loop in mesh.loops:
                        vi = loop.vertex_index
                        p = world[vi]
                        to_l = lp - p
                        dist = to_l.length
                        if dist > max_range:
                            continue
                        n = (nm @ corner_normals[loop.index].vector).normalized()
                        cos_i = n.dot(to_l) / max(dist, 1e-9)
                        if cos_i <= 0:
                            continue
                        if vi not in seen:
                            w = lamp.weight(-to_l)
                            if w > 0 and tree is not None:
                                start = p + to_l.normalized() * 0.02 + n * 0.005
                                hit = tree.ray_cast(start, to_l.normalized(), max(0.0, dist - 0.06))
                                if hit[0] is not None:
                                    w = 0.0
                            seen[vi] = w
                        w = seen[vi]
                        if w <= 0:
                            continue
                        e = w * cos_i * (reference / max(dist, floor)) ** 2
                        values[loop.index][lamp.channel] += e
                for row in values:
                    for c in range(8):
                        row[c] = min(1.0, row[c])
                for c in sorted({lamp.channel for lamp in lamps}):
                    col = [row[c] for row in values]
                    stats[names[c]]["lit_corners"] += sum(1 for v in col if v > 0.004)
                    stats[names[c]]["max"] = max(stats[names[c]]["max"], max(col) if col else 0.0)
            for k, layer in enumerate(layers):
                flat = []
                for row in values:
                    flat += [linear_to_srgb(row[4 * k + c]) for c in range(4)]
                layer.data.foreach_set("color", flat)
        return stats

    # -- checks
    def check(self, max_tris: int | None = None, proxy_max_tris: int | None = None) -> dict:
        reports, errors, total, proxy = {}, [], 0, 0
        for info in self.parts.values():
            r = kit.check_mesh(info.obj)
            r["warnings"] = [w for w in r["warnings"] if "_GLOW" not in w and "will float" not in w]
            for k in ("glow", "windowed_faces"):
                r.pop(k, None)
            r["role"] = info.role
            r["pivot"] = [round(c, 4) for c in info.pivot]
            reports[info.name] = r
            errors += [f"{info.name}: {e}" for e in r["errors"]]
            if info.role == "proxy":
                proxy += r["tris"]
            else:
                total += r["tris"]
        if max_tris is not None and total > max_tris:
            errors.append(f"{total} triangles is over the budget of {max_tris}")
        if proxy_max_tris is not None and proxy > proxy_max_tris:
            errors.append(f"shadow proxy has {proxy} triangles, over {proxy_max_tris}")
        return {"parts": reports, "tris": total, "proxy_tris": proxy, "errors": errors}

    # -- export
    def export(self, glb_path: str) -> str:
        os.makedirs(os.path.dirname(os.path.abspath(glb_path)), exist_ok=True)
        for o in bpy.context.scene.objects:
            o.select_set(False)
        self.root.select_set(True)
        for info in self.parts.values():
            info.obj.select_set(True)
        bpy.context.view_layer.objects.active = self.root
        bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB", use_selection=True, export_yup=True,
                                  export_apply=True, export_attributes=True, export_vertex_color="NONE",
                                  export_all_vertex_colors=False, export_active_vertex_color_when_no_material=False,
                                  export_extras=True, export_texcoords=False, export_materials="EXPORT")
        return glb_path

    def save_blend(self, path: str) -> None:
        if bpy.app.background:
            bpy.context.preferences.filepaths.save_version = 0
        bpy.ops.wm.save_as_mainfile(filepath=path)

    def rig_entry(self, name: str) -> dict:
        info = self.parts[name]
        return {"node": name, "parent": info.parent or self.root_name, "pivot": [round(c, 4) for c in to_gltf(info.pivot)],
                "axis": [round(c, 6) for c in to_gltf(info.axis)]}


def glb_json(path: str) -> dict:
    """The JSON chunk of a GLB, for checks after export."""
    with open(path, "rb") as fh:
        data = fh.read()
    length = struct.unpack_from("<I", data, 12)[0]
    return json.loads(data[20:20 + length])


def reset_scene() -> None:
    kit.reset_scene()
