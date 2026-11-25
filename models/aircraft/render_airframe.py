"""Preview renders of the airframe for review (plan 03, F3.3): Workbench, small, from a .blend that
build_airframe.py saved with --blend, posed from rig.json.

    blender --background <airframe.blend> --python models/aircraft/render_airframe.py -- \
        --rig public/models/aircraft/rig.json --out DIR [--views a,b,c] [--size 960x600]

Views: front34, side, top, rear34, under34, seat_up (flaps up), seat_f30 (flaps 30, spoilers down),
seat_f30_spoilers (flaps 30, ground spoilers up, reversers open), seat_night (light bake as emission), detail_wing.
The seat views are from the right-side window seat behind the wing (eye 22.9 m aft of the nose, 1.30 m right
of the centre line, 1.20 m above the floor) through a camera clipped at the skin, at a 26 mm-equivalent lens.
"""
from __future__ import annotations

import json
import math
import os
import sys

import bpy
from mathutils import Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import spec as S  # noqa: E402

MAIN = float(S.STATIONS["main_gear"])


def P(x, y, z):
    return Vector((y, MAIN - x, z))


def from_gltf(v):
    return Vector((v[0], -v[2], v[1]))


def args():
    a = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    def opt(n, d=None):
        return a[a.index(n) + 1] if n in a else d
    return opt


def sample(rows, value):
    if value <= rows[0]["at"]:
        r = rows[0]
        return Vector(r["t"]), r["r"]
    for a, b in zip(rows, rows[1:]):
        if value <= b["at"]:
            f = (value - a["at"]) / (b["at"] - a["at"])
            return Vector(a["t"]).lerp(Vector(b["t"]), f), a["r"] + (b["r"] - a["r"]) * f
    r = rows[-1]
    return Vector(r["t"]), r["r"]


def pose(rig, state):
    rest = {}
    for part in rig["parts"]:
        obj = bpy.data.objects[part["node"]]
        if "rest" not in obj:
            obj["rest"] = list(obj.location)
        obj.location = Vector(obj["rest"])
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = Quaternion()
        best_t, best_r = Vector(), None
        for channel, rows in part["tables"].items():
            if channel not in state:
                continue
            t, r = sample(rows, state[channel])
            if best_r is None or abs(r) > abs(best_r) or t.length > best_t.length:
                best_t, best_r = t, r
        if best_r is None:
            continue
        obj.location = Vector(obj["rest"]) + from_gltf(best_t)
        obj.rotation_quaternion = Quaternion(from_gltf(part["axis"]), math.radians(best_r))
    bpy.context.view_layer.update()


def setup(size, night=False):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    w, h = (int(v) for v in size.split("x"))
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = w, h, 100
    sh = sc.display.shading
    sh.light = "STUDIO"
    sh.color_type = "MATERIAL"
    sh.show_shadows = True
    sh.shadow_intensity = 0.35
    sh.show_cavity = False
    sh.show_backface_culling = True
    sc.display.light_direction = (0.35, -0.45, 0.82)
    sc.render.film_transparent = False
    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    sc.world = world
    world.color = (0.55, 0.66, 0.8) if not night else (0.01, 0.012, 0.02)
    sh.background_type = "WORLD"
    if "ShadowProxy" in bpy.data.objects:
        bpy.data.objects["ShadowProxy"].hide_render = True
        bpy.data.objects["ShadowProxy"].hide_viewport = True
    # a ground plane for the exterior views
    if "Ground" not in bpy.data.objects:
        me = bpy.data.meshes.new("Ground")
        me.from_pydata([(-80, -80, 0), (80, -80, 0), (80, 80, 0), (-80, 80, 0)], [], [(0, 1, 2, 3)])
        mat = bpy.data.materials.new("GroundMat")
        mat.diffuse_color = (0.33, 0.33, 0.31, 1)
        me.materials.append(mat)
        g = bpy.data.objects.new("Ground", me)
        sc.collection.objects.link(g)


def camera(loc, target, lens=26.0, clip_start=0.05, up_roll=0.0):
    sc = bpy.context.scene
    cam = bpy.data.objects.get("PreviewCam")
    if cam is None:
        cam = bpy.data.objects.new("PreviewCam", bpy.data.cameras.new("PreviewCam"))
        sc.collection.objects.link(cam)
    cam.location = loc
    d = (Vector(target) - Vector(loc)).normalized()
    cam.rotation_mode = "QUATERNION"
    cam.rotation_quaternion = d.to_track_quat("-Z", "Y")
    cam.data.lens = lens
    cam.data.sensor_width = 36.0
    cam.data.clip_start = clip_start
    cam.data.clip_end = 2000
    sc.camera = cam


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def night_materials(on):
    """Show the baked light as colour: NAV green on the right (red left), STROBE white, BEACON red, WING white."""
    for mat in bpy.data.materials:
        if "day" not in mat:
            mat["day"] = list(mat.diffuse_color)
        mat.diffuse_color = mat["day"] if not on else (0.02, 0.02, 0.022, 1)
    sh = bpy.context.scene.display.shading
    if on:
        sh.color_type = "VERTEX"   # Workbench shows the active colour attribute
        for obj in bpy.data.objects:
            if obj.type == "MESH" and "_LIGHTS0" in obj.data.color_attributes:
                obj.data.color_attributes.active_color = obj.data.color_attributes["_LIGHTS0"]
        sh.light = "FLAT"
    else:
        sh.color_type = "MATERIAL"
        sh.light = "STUDIO"


def main():
    opt = args()
    rig = json.load(open(opt("--rig"), encoding="utf-8"))
    out = opt("--out")
    os.makedirs(out, exist_ok=True)
    views = opt("--views", "front34,side,top,rear34,under34,seat_up,seat_f30,seat_f30_spoilers,detail_wing").split(",")
    size = opt("--size", "960x600")
    setup(size)
    clean = {"flap": 0, "slat": 0, "gear": 0, "speedbrake": 0, "groundSpoiler": 0, "reverser": 0}
    landing = {"flap": 30, "slat": 2, "gear": 1, "speedbrake": 0, "groundSpoiler": 0, "reverser": 0}
    rollout = {"flap": 30, "slat": 2, "gear": 1, "speedbrake": 0, "groundSpoiler": 1, "reverser": 1}
    ground = {"flap": 0, "slat": 0, "gear": 1, "speedbrake": 0, "groundSpoiler": 0, "reverser": 0}
    floor = float(S.FUSELAGE["floor_z"])
    eye = P(22.9, 1.30, floor + 1.20)
    look = P(23.2, 12.0, floor - 2.6)
    shots = {
        "front34": (ground, P(-14, 24, 9), P(18, 0, 3), 50, 0.1),
        "side": (ground, P(19.7, 70, 4), P(19.7, 0, 4), 50, 0.1),
        "top": (clean, P(19.7, 0, 75), P(19.7, 0.01, 0), 50, 0.1),
        "rear34": (landing, P(50, 22, 10), P(20, 0, 3), 50, 0.1),
        "under34": (landing, P(4, 22, -1.0), P(22, 4, 2.5), 35, 0.1),
        "seat_up": (clean, eye, look, 26, 0.55),
        "seat_f30": (landing, eye, look, 26, 0.55),
        "seat_f30_spoilers": (rollout, eye, look, 26, 0.55),
        "behind_rollout": (rollout, P(62, 0, 7.5), P(20, 0, 3.0), 50, 0.1),
        "under_clean": (clean, P(4, 22, -1.0), P(22, 4, 2.5), 35, 0.1),
        "nose": (ground, P(-5.5, 7.5, 5.0), P(2.2, 0, 4.1), 50, 0.1),
        "detail_wing": (landing, P(30, 11, 6.5), P(19, 8, 2.4), 35, 0.1),
    }
    for name in views:
        if name == "seat_night":
            pose(rig, landing)
            night_materials(True)
            camera(eye, look, 26, 0.55)
            render(os.path.join(out, "seat_night_lightbake.png"))
            night_materials(False)
            continue
        state, loc, target, lens, clip = shots[name]
        pose(rig, state)
        bpy.data.objects["Ground"].hide_render = name.startswith("seat") or name == "top"
        camera(loc, target, lens, clip)
        render(os.path.join(out, f"{name}.png"))


main()
