"""Review renders of the traffic bodies, made from the exported GLB (so they show what the app will load).

    python .claude/skills/blender-landmark-model/scripts/run_blender.py models/drive/vehicles/render_sheet.py \
        -- --glb public/models/drive/vehicles.glb --sidecar public/models/drive/vehicles.json --out DIR

Writes to DIR:
  sheet_lod0.png, sheet_lod1.png  columns: sedan, crossover, pickup, van, tractor_trailer, coach;
                                  rows: front three-quarter, side (orthographic), rear three-quarter
  lineup.png                      all six side-on at one scale (1 m grid), both levels: proportions
  road_day.png                    from 1.2 m eye height down a six-lane road: the bodies at 20, 60 and 200 m
  road_day_crop200.png            the 200 m row alone, level 1 (left) and level 0 (right), enlarged 6x unsmoothed
  road_night.png                  the same at night: bodies unlit, lamps from the sidecar as small emitters

Paint is applied the way the app does it: colour = COLOR_0 * mix(1, paint colour, _PAINT).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

BODIES = ["sedan", "crossover", "pickup", "van", "tractor_trailer", "coach"]
PAINTS = {  # linear RGB, a few of the palette's colours
    "sedan": (0.45, 0.012, 0.015), "crossover": (0.40, 0.42, 0.44), "pickup": (0.012, 0.025, 0.08),
    "van": (0.88, 0.88, 0.86), "tractor_trailer": (0.35, 0.01, 0.012), "coach": (0.80, 0.80, 0.78),
}
TILE = (480, 320)


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--glb", required=True)
    p.add_argument("--sidecar", required=True)
    p.add_argument("--out", required=True)
    return p.parse_args(argv)


def setup(glb):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("w")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.55, 0.68, 0.85, 1)
    bg.inputs[1].default_value = 0.9
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 3.5
    sun.angle = math.radians(3)
    so = bpy.data.objects.new("sun", sun)
    so.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    scene.collection.objects.link(so)
    mat = paint_material()
    meshes = {}
    for o in list(scene.objects):
        if o.type == "MESH":
            o.data.materials.clear()
            o.data.materials.append(mat)
            meshes[o.name] = o
            o.hide_render = True
    ground = bpy.data.meshes.new("ground")
    ground.from_pydata([(-2000, -2000, 0), (2000, -2000, 0), (2000, 2000, 0), (-2000, 2000, 0)], [], [(0, 1, 2, 3)])
    gm = bpy.data.materials.new("groundmat")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.16, 0.16, 0.16, 1)
    ground.materials.append(gm)
    g = bpy.data.objects.new("ground", ground)
    g.location.z = -0.002
    scene.collection.objects.link(g)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam
    return scene, meshes, cam, bg, sun, gm


def paint_material():
    mat = bpy.data.materials.new("PaintPreview")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.45
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Color"
    paint = nt.nodes.new("ShaderNodeAttribute")
    paint.attribute_name = "_PAINT"
    info = nt.nodes.new("ShaderNodeObjectInfo")
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs["A"].default_value = (1, 1, 1, 1)
    nt.links.new(paint.outputs["Fac"], mix.inputs["Factor"])
    nt.links.new(info.outputs["Color"], mix.inputs["B"])
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    nt.links.new(vc.outputs["Color"], mul.inputs["A"])
    nt.links.new(mix.outputs["Result"], mul.inputs["B"])
    nt.links.new(mul.outputs["Result"], bsdf.inputs["Base Color"])
    return mat


def copy(src, loc, paint, rot_z=0.0):
    o = src.copy()
    o.location = loc
    o.rotation_mode = "XYZ"  # the glTF importer leaves objects in quaternion mode
    o.rotation_euler = (0, 0, rot_z)
    o.color = (*paint, 1)
    o.hide_render = False
    bpy.context.scene.collection.objects.link(o)
    return o


def look(cam, eye, target, lens=50, ortho=None):
    cam.location = eye
    d = Vector(target) - Vector(eye)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    cam.data.sensor_fit = "HORIZONTAL"
    cam.data.sensor_width = 36
    if ortho:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = ortho
    else:
        cam.data.type = "PERSP"
        cam.data.lens = lens
    cam.data.clip_end = 3000


def render(scene, path, size):
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def load(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    return a


def save(arr, path):
    h, w = arr.shape[:2]
    img = bpy.data.images.new("sheet", w, h, alpha=True)
    img.pixels = arr.ravel()
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def grid(tiles, rows, cols, pad=6):
    th, tw = tiles[0].shape[:2]
    out = np.ones(((th + pad) * rows + pad, (tw + pad) * cols + pad, 4), np.float32)
    for k, t in enumerate(tiles):
        r, c = divmod(k, cols)
        y0 = out.shape[0] - pad - (r + 1) * (th + pad) + pad  # numpy rows run bottom-up in Blender images
        x0 = pad + c * (tw + pad)
        out[y0:y0 + th, x0:x0 + tw] = t
    return out


def main():
    a = args()
    os.makedirs(a.out, exist_ok=True)
    tmp = os.path.join(a.out, "tiles")
    os.makedirs(tmp, exist_ok=True)
    side = json.load(open(a.sidecar))["bodies"]
    scene, meshes, cam, bg, sun, gm = setup(os.path.abspath(a.glb))

    # 1. per-body tiles
    for lod in ("lod0", "lod1"):
        tiles = []
        for view in ("front", "side", "rear"):
            for body in BODIES:
                s = side[body]
                L, H = s["length"], s["height"]
                o = copy(meshes[f"{body}_{lod}"], (0, 0, 0), PAINTS[body])
                R = 0.5 * math.sqrt(L * L + s["width"] ** 2 + H * H)
                tgt = (0, 0, H * 0.45)
                if view == "side":
                    look(cam, (-60, 0, H * 0.5), (0, 0, H * 0.5), ortho=L * 1.12)
                else:
                    az = math.radians(35 if view == "front" else 180 - 35)
                    sx = 1 if view == "front" else -1
                    d = R / math.sin(math.radians(17)) * 1.05
                    eye = (sx * -d * math.sin(az) * -1, d * math.cos(az), max(1.6, d * 0.18))
                    look(cam, eye, tgt, lens=50)
                p = os.path.join(tmp, f"{lod}_{view}_{body}.png")
                render(scene, p, TILE)
                tiles.append(load(p))
                bpy.data.objects.remove(o)
        save(grid(tiles, 3, 6), os.path.join(a.out, f"sheet_{lod}.png"))

    # 2. lineup, side on, one scale, with a 1 m grid of thin posts
    objs = []
    x = 0.0
    for lod_row, z_off in (("lod0", 0.0), ("lod1", -8.0)):
        y = -2.0
        for body in BODIES:
            L = side[body]["length"]
            objs.append(copy(meshes[f"{body}_{lod_row}"], (0, y - L / 2, 0), PAINTS[body]))
            objs[-1].location.z = -z_off * 0.75   # level-1 row drawn 6 m above the level-0 row
            y -= L + 2.0
    total = y
    look(cam, (-200, total / 2, 4.5), (0, total / 2, 4.5), ortho=-total * 1.03)
    render(scene, os.path.join(a.out, "lineup.png"), (2400, 560))
    for o in objs:
        bpy.data.objects.remove(o)

    # 3. down the road: six lanes, seen from 1.2 m with a 70 degree horizontal field of view.
    # First the 200 m row alone, at each level (no nearer traffic in the way), cropped and enlarged 6x.
    lanes = [-9.25, -5.55, -1.85, 1.85, 5.55, 9.25]
    lens = 18 / math.tan(math.radians(35))
    eye = (0, 0, 1.2)
    look(cam, eye, (0, 400, 1.2 - 400 * math.tan(math.radians(1))), lens=lens)
    crops = []
    for lod in ("lod0", "lod1"):
        row = [copy(meshes[f"{b}_{lod}"], (lanes[k], 200 + (k % 2) * 4, 0), PAINTS[b],
                    rot_z=math.pi if k % 2 else 0.0) for k, b in enumerate(BODIES)]
        p = os.path.join(tmp, f"far_{lod}.png")
        render(scene, p, (1920, 1080))
        full = load(p)
        h, w = full.shape[:2]
        top, bottom = h // 2 - 70, h // 2 + 10        # image rows, counted from the top
        crops.append(full[h - bottom: h - top, w // 2 - 110: w // 2 + 110])
        for o in row:
            bpy.data.objects.remove(o)
    pair = np.concatenate([crops[1], np.ones((crops[0].shape[0], 4, 4), np.float32), crops[0]], axis=1)
    save(np.kron(pair, np.ones((6, 6, 1), np.float32)), os.path.join(a.out, "road_day_crop200.png"))
    # then the whole road: bodies at 20 and 60 m (level 0) and 200 m (level 1); odd lanes are oncoming
    objs = []
    for dist, lod in ((20, "lod0"), (60, "lod0"), (200, "lod1")):
        for k, body in enumerate(BODIES):
            objs.append(copy(meshes[f"{body}_{lod}"], (lanes[k], dist + (k % 2) * 3, 0), PAINTS[body],
                             rot_z=math.pi if k % 2 else 0.0))
    look(cam, (0, -side["sedan"]["length"], 1.2), (0, 400, 1.2 - 400 * math.tan(math.radians(1))), lens=lens)
    render(scene, os.path.join(a.out, "road_day.png"), (1920, 1080))

    # 4. night: dark sky, dim ground, lamps as emitters at the sidecar positions (glTF -> Blender axes)
    bg.inputs[0].default_value = (0.004, 0.006, 0.012, 1)
    bg.inputs[1].default_value = 1.0
    sun.energy = 0.002
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.05, 0.05, 0.05, 1)
    em = {}
    for name, rgb, strength in (("white", (1.0, 0.95, 0.85), 40), ("red", (1, 0.02, 0.01), 12),
                                ("amber", (1, 0.35, 0.02), 12)):
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        b = m.node_tree.nodes["Principled BSDF"]
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = strength
        b.inputs["Base Color"].default_value = (0, 0, 0, 1)
        em[name] = m
    sphere = bpy.data.meshes.new("lamp")
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=1, radius=0.07)
    bm.to_mesh(sphere)
    bm.free()

    def lamp(world_obj, p, colour, scale=1.0):
        local = Vector((p[0], -p[2], p[1]))
        q = world_obj.matrix_world @ local
        lo = bpy.data.objects.new("l", sphere.copy())
        lo.data.materials.append(em[colour])
        lo.location = q
        lo.scale = (scale,) * 3
        scene.collection.objects.link(lo)
    bpy.context.view_layer.update()
    for o in objs:
        body = o.name.split("_lod")[0]
        L = side[body]["lamps"]
        for p in L["head"]:
            lamp(o, p, "white", 1.3)
        for p in L["tail"]:
            lamp(o, p, "red")
        if L["chmsl"]:
            lamp(o, L["chmsl"], "red", 0.7)
        for p in L["side_marker_front"]:
            lamp(o, p, "amber", 0.6)
        for p in L["side_marker_rear"]:
            lamp(o, p, "red", 0.6)
        for c in L["clearance"]:
            lamp(o, c["p"], c["color"], 0.6)
    render(scene, os.path.join(a.out, "road_night.png"), (1920, 1080))
    print("renders in", a.out)


if __name__ == "__main__":
    main()
