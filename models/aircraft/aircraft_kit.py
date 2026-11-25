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
  on it: the lamp's photometry toward the corner (a table by angle, `Lamp.beam`), inverse square with a floor at
  the lamp's lens radius, the surface's cosine, and occlusion by the other parts, by ray casting. The result is
  irradiance per candela of the lamp's peak (lux/cd, i.e. 1/m^2), summed per channel and written as two
  four-component per-corner attributes `_LIGHTS0` and `_LIGHTS1`. Encoding (stated in the returned stats and in
  the model's rig.json): each channel c has a scale S_c, its largest value, and stores v = sqrt(E / S_c), so
  E = v^2 * S_c; nothing is clipped. Blender holds them as float colour attributes (no colour conversion), and
  `Model.export` rewrites the two accessors as normalized unsigned shorts (8 bytes a vertex for both), so the
  file is the size byte colours gave. A lamp may be confined to a region of the span (`Lamp.region`), which lets
  two groups whose light never meets share one channel.
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


def encode_light(e: float, scale: float) -> float:
    """Irradiance per candela (1/m^2) as the 0..1 the attribute stores: sqrt(E / scale)."""
    return math.sqrt(min(1.0, max(0.0, e / scale))) if scale > 0 else 0.0


def decode_light(v: float, scale: float) -> float:
    return v * v * scale


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
def _table(rows: Sequence[Sequence[float]], x: float) -> float:
    """Piecewise-linear lookup in ((x, y), ...) sorted by x, holding the ends."""
    if x <= rows[0][0]:
        return float(rows[0][1])
    for (x0, y0), (x1, y1) in zip(rows, rows[1:]):
        if x <= x1:
            return float(y0 + (y1 - y0) * (x - x0) / (x1 - x0)) if x1 > x0 else float(y1)
    return float(rows[-1][1])


@dataclass(frozen=True)
class Lamp:
    """A lamp for the bake: model-frame position and aim, attribute channel 0..7, and its photometry.

    `beam` is None (the first version's cone: 1 inside 70% of the half angle of `cone_deg`, smooth to 0 at its edge)
    or a dict: {"kind": "polar", "table": ((deg, ratio), ...)} by the angle from the aim (with "inboard_cut_deg",
    nothing more than that many degrees inboard of the aim in plan view: a lamp in a recess), or {"kind": "sector",
    "horizontal": ..., "vertical": ...} by the horizontal angle from the model's forward (+Y), positive toward the
    aim's side, times a factor by the elevation from the model's horizontal plane (the form of 14 CFR 25.1391-1401).
    `region` (min, max) of |x| confines the lamp's light to that part of the span; `radius` is the lens radius."""
    name: str
    position: Point
    direction: Point
    cone_deg: float
    channel: int
    beam: dict | None = None
    region: tuple[float, float] | None = None
    radius: float = 0.02

    def weight(self, to_point: Vector) -> float:
        """Relative intensity (peak 1) toward `to_point`, a vector from the lamp."""
        d = to_point.normalized()
        aim = Vector(self.direction).normalized()
        if self.beam is None:
            if self.cone_deg >= 359.0:
                return 1.0
            cos_a = aim.dot(d)
            half = math.radians(self.cone_deg / 2)
            inner, outer = math.cos(half * 0.7), math.cos(half)
            if cos_a >= inner:
                return 1.0
            if cos_a <= outer:
                return 0.0
            t = (cos_a - outer) / (inner - outer)
            return t * t * (3 - 2 * t)
        if self.beam["kind"] == "polar":
            cut = self.beam.get("inboard_cut_deg")
            if cut is not None and (d.x or d.y):
                # a lamp in a recess: nothing more than `cut` degrees inboard of its aim, in plan view
                side = 1.0 if aim.x >= 0 else -1.0
                if math.degrees(math.atan2(side * d.x, d.y) - math.atan2(side * aim.x, aim.y)) < -cut:
                    return 0.0
            angle = math.degrees(math.acos(max(-1.0, min(1.0, aim.dot(d)))))
            return _table(self.beam["table"], angle)
        # sector: horizontal angle from ahead (+Y), positive toward the side the lamp aims at (sign of aim.x)
        side = 1.0 if aim.x >= 0 else -1.0
        elevation = math.degrees(math.asin(max(-1.0, min(1.0, d.z))))
        h = math.degrees(math.atan2(side * d.x, d.y)) if (d.x or d.y) else 0.0
        return _table(self.beam["horizontal"], h) * _table(self.beam["vertical"], abs(elevation))

    def reaches(self, p: Vector) -> bool:
        return self.region is None or self.region[0] <= abs(p.x) < self.region[1]


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

    def snap_lamps(self, lamps: Sequence[Lamp], offset: float = 0.05,
                   offsets: dict[str, float] | None = None) -> list[Lamp]:
        """Each lamp moved onto the nearest point of the skin, then `offset` (or `offsets[name]`) out along the
        skin's normal: a lamp position from a table sits on the structure, not inside it."""
        tree = self._tree()
        out = []
        for lamp in lamps:
            loc, normal, _, _ = tree.find_nearest(Vector(lamp.position))
            p = loc + normal.normalized() * (offsets or {}).get(lamp.name, offset)
            out.append(Lamp(lamp.name, tuple(p), lamp.direction, lamp.cone_deg, lamp.channel, lamp.beam, lamp.region,
                            lamp.radius))
        return out

    # -- light bake
    def bake_lights(self, lamps: Sequence[Lamp], floor: float | None = None, max_range: float = 30.0,
                    occlude: bool = True, skip: Iterable[str] = (), not_occluding: Iterable[str] = ()) -> dict:
        """Write `_LIGHTS0` / `_LIGHTS1` on every part (zeros on parts in `skip`), encoded as the module's docstring
        says, for the parts in the pose they are in now (the rest pose, when called before export). Parts in
        `not_occluding` cast no shadow (parts that are away most of the time, such as the gear). `floor` overrides
        each lamp's lens radius. Returns per channel (named after plan 03's light bit field): scale (the largest
        value, lux per candela), corners lit, and the largest value again as `max`."""
        bpy.context.view_layer.update()
        skip, quiet = set(skip), set(not_occluding)
        verts, polys = [], []
        if occlude:
            for info in self.parts.values():
                if info.role != "part" or info.name in quiet:
                    continue
                mw = info.obj.matrix_world
                base = len(verts)
                verts += [mw @ v.co for v in info.obj.data.vertices]
                polys += [[base + i for i in p.vertices] for p in info.obj.data.polygons]
        tree = BVHTree.FromPolygons(verts, polys, epsilon=0.0) if occlude and polys else None
        names = ["NAV", "BEACON", "STROBE", "LANDING", "TAXI", "TURNOFF", "LOGO", "WING"]
        used = sorted({lamp.channel for lamp in lamps})
        raw: dict[str, list[list[float]]] = {}
        for info in self.parts.values():
            mesh = info.obj.data
            values = [[0.0] * 8 for _ in range(len(mesh.loops))]
            raw[info.name] = values
            if info.name in skip or info.role != "part":
                continue
            mw = info.obj.matrix_world
            nm = mw.to_3x3().inverted().transposed()
            corner_normals = mesh.corner_normals
            world = [mw @ v.co for v in mesh.vertices]
            for lamp in lamps:
                lp = Vector(lamp.position)
                r_min = lamp.radius if floor is None else floor
                seen: dict[int, float] = {}  # per vertex: photometry x visibility
                for loop in mesh.loops:
                    vi = loop.vertex_index
                    p = world[vi]
                    to_l = lp - p
                    dist = to_l.length
                    if dist > max_range or not lamp.reaches(p):
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
                    values[loop.index][lamp.channel] += w * cos_i / max(dist, r_min) ** 2
        scale = [0.0] * 8
        for values in raw.values():
            for row in values:
                for c in range(8):
                    scale[c] = max(scale[c], row[c])
        stats = {names[c]: {"scale": scale[c], "lit_corners": 0, "max": scale[c]} for c in used}
        for info in self.parts.values():
            mesh = info.obj.data
            for n_ in LIGHT_ATTRIBUTES:
                old = mesh.color_attributes.get(n_)
                if old is not None:
                    mesh.color_attributes.remove(old)
            layers = [mesh.color_attributes.new(n_, "FLOAT_COLOR", "CORNER") for n_ in LIGHT_ATTRIBUTES]
            values = raw[info.name]
            for c in used:
                stats[names[c]]["lit_corners"] += sum(1 for row in values if row[c] > 0)
            for k, layer in enumerate(layers):
                flat = []
                for row in values:
                    flat += [encode_light(row[4 * k + c], scale[4 * k + c]) for c in range(4)]
                layer.data.foreach_set("color", flat)
        self.light_scale = scale
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
        repack_light_attributes(glb_path)
        return glb_path

    def save_blend(self, path: str) -> None:
        if bpy.app.background:
            bpy.context.preferences.filepaths.save_version = 0
        bpy.ops.wm.save_as_mainfile(filepath=path)

    def rig_entry(self, name: str) -> dict:
        info = self.parts[name]
        return {"node": name, "parent": info.parent or self.root_name, "pivot": [round(c, 4) for c in to_gltf(info.pivot)],
                "axis": [round(c, 6) for c in to_gltf(info.axis)]}


def repack_light_attributes(path: str) -> int:
    """Rewrite the `_LIGHTS0` / `_LIGHTS1` accessors of a GLB from float to normalized unsigned short, in place
    (the exporter writes float colour attributes as floats). Returns the number of accessors rewritten."""
    with open(path, "rb") as fh:
        data = fh.read()
    jlen = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + jlen])
    blen = struct.unpack_from("<I", data, 20 + jlen)[0]
    bin_ = data[28 + jlen:28 + jlen + blen]
    targets = set()
    for mesh in doc["meshes"]:
        for prim in mesh["primitives"]:
            for a in LIGHT_ATTRIBUTES:
                if a in prim["attributes"]:
                    targets.add(prim["attributes"][a])
    users: dict[int, list[int]] = {}
    for i, acc in enumerate(doc["accessors"]):
        if "bufferView" in acc:
            users.setdefault(acc["bufferView"], []).append(i)
    replaced: dict[int, bytes] = {}
    for i in sorted(targets):
        acc = doc["accessors"][i]
        if acc["componentType"] == 5123:
            continue
        if acc["componentType"] != 5126 or acc["type"] != "VEC4":
            raise ValueError(f"accessor {i}: expected float VEC4, got {acc['componentType']} {acc['type']}")
        view_i = acc["bufferView"]
        if users[view_i] != [i]:
            raise ValueError(f"buffer view {view_i} is shared; cannot rewrite accessor {i} alone")
        view = doc["bufferViews"][view_i]
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        stride = view.get("byteStride", 16)
        out = bytearray()
        for k in range(acc["count"]):
            for c in struct.unpack_from("<4f", bin_, start + k * stride):
                out += struct.pack("<H", int(min(1.0, max(0.0, c)) * 65535 + 0.5))
        replaced[view_i] = bytes(out)
        acc["componentType"] = 5123
        acc["normalized"] = True
        acc.pop("byteOffset", None)
        acc.pop("min", None)
        acc.pop("max", None)
    if not replaced:
        return 0
    new_bin = bytearray()
    for vi, view in enumerate(doc["bufferViews"]):
        chunk = replaced.get(vi)
        if chunk is None:
            o = view.get("byteOffset", 0)
            chunk = bin_[o:o + view["byteLength"]]
        else:
            view.pop("byteStride", None)
        while len(new_bin) % 4:
            new_bin += b"\0"
        view["byteOffset"] = len(new_bin)
        view["byteLength"] = len(chunk)
        new_bin += chunk
    while len(new_bin) % 4:
        new_bin += b"\0"
    doc["buffers"][0]["byteLength"] = len(new_bin)
    js = json.dumps(doc, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(new_bin)
    with open(path, "wb") as fh:
        fh.write(struct.pack("<III", 0x46546C67, 2, total))
        fh.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        fh.write(struct.pack("<II", len(new_bin), 0x004E4942) + bytes(new_bin))
    return len(replaced)


def glb_json(path: str) -> dict:
    """The JSON chunk of a GLB, for checks after export."""
    with open(path, "rb") as fh:
        data = fh.read()
    length = struct.unpack_from("<I", data, 12)[0]
    return json.loads(data[20:20 + length])


def reset_scene() -> None:
    kit.reset_scene()
