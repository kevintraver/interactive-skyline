"""Review renders of the cabin from the driver's eye, by day and by night (EEVEE, headless).

    python .claude/skills/blender-landmark-model/scripts/run_blender.py models/drive/cabin/render_cabin.py
        --blend models/drive/cabin/cabin.blend -- --out DIR [--views ahead50,left] [--modes day,night]

Adds a plain sky, a desert ground plane, a three-lane road with markings, posts every 20 m and a few distant
blocks for scale. The head turns about a neck pivot 0.10 m behind the eye (plan 02, section 4.4).
Writes DIR/<view>_<mode>.png (1280 x 720).
"""
from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

CX = 0.37
EYE = Vector((0.0, 0.0, 1.2))
NECK = 0.10

# name: (yaw deg, + is left; pitch deg, + is up; lens mm equivalent on 36 mm)
VIEWS = {
    "ahead50": (0, 0, 50),
    "ahead24": (0, -4, 24),
    "left": (39, -7, 35),
    "right": (-60, -5, 35),
    "up": (-31, 12, 35),
    "down": (0, -22, 35),
    "back": (-150, -4, 24),
}


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--views", default=",".join(VIEWS))
    ap.add_argument("--modes", default="day,night")
    ap.add_argument("--samples", type=int, default=48)
    return ap.parse_args(argv)


def mat(name, rgb, rough=0.9, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Roughness"].default_value = rough
    if emit:
        p.inputs["Emission Color"].default_value = (*emit, 1)
        p.inputs["Emission Strength"].default_value = strength
    return m


def box(name, lo, hi, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2))
    o = bpy.context.active_object
    o.name = name
    o.scale = (hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
    o.data.materials.append(material)
    return o


def environment():
    ground = mat("EnvGround", (0.36, 0.28, 0.20), 0.95)
    asphalt = mat("EnvAsphalt", (0.05, 0.05, 0.055), 0.85)
    paint = mat("EnvPaint", (0.75, 0.75, 0.72), 0.6)
    yellow = mat("EnvYellow", (0.8, 0.6, 0.1), 0.6)
    post = mat("EnvPost", (0.5, 0.5, 0.52), 0.5)
    block = mat("EnvBlock", (0.55, 0.5, 0.45), 0.8)
    bpy.ops.mesh.primitive_plane_add(size=4000, location=(0, 0, -0.01))
    bpy.context.active_object.data.materials.append(ground)
    lane = 3.7
    left_edge = CX - lane / 2 - lane     # the car is in the middle of three lanes
    box("Road", (left_edge - 1.0, -300, -0.005), (left_edge + 3 * lane + 3.0, 1500, 0.0), asphalt)
    box("EdgeL", (left_edge - 0.15, -300, 0.0), (left_edge, 1500, 0.002), yellow)
    box("EdgeR", (left_edge + 3 * lane, -300, 0.0), (left_edge + 3 * lane + 0.15, 1500, 0.002), paint)
    for k in (1, 2):
        x = left_edge + k * lane
        for i in range(-20, 120):
            y = i * 12.2
            box(f"Dash{k}_{i}", (x - 0.075, y, 0.0), (x + 0.075, y + 3.05, 0.002), paint)
    for i in range(-10, 60):
        y = i * 20.0
        box(f"PostR{i}", (left_edge + 3 * lane + 2.0, y, 0), (left_edge + 3 * lane + 2.12, y + 0.12, 1.1), post)
        box(f"PostL{i}", (left_edge - 2.2, y, 0), (left_edge - 2.08, y + 0.12, 1.1), post)
    for i, (x, y, w, h) in enumerate([(-60, 400, 40, 30), (40, 600, 30, 80), (90, 900, 60, 140), (-150, 1200, 80, 60),
                                      (200, 300, 25, 20), (-30, -200, 30, 25), (60, -350, 40, 40)]):
        box(f"Block{i}", (x - w / 2, y - w / 2, 0), (x + w / 2, y + w / 2, h), block)
    return asphalt


def setup(mode, samples):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = samples
    try:
        scene.eevee.use_shadows = True
        scene.eevee.use_raytracing = True
    except AttributeError:
        pass
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("Sky") if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    for o in [o for o in scene.objects if o.type == "LIGHT"]:
        bpy.data.objects.remove(o)
    screen = bpy.data.materials.get("Screen")
    p = next(n for n in screen.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    if mode == "day":
        bg.inputs["Color"].default_value = (0.62, 0.74, 0.92, 1)
        bg.inputs["Strength"].default_value = 1.0
        sun = bpy.data.lights.new("Sun", "SUN")
        sun.energy = 5.0
        sun.color = (1.0, 0.95, 0.88)
        sun.angle = math.radians(1.0)
        o = bpy.data.objects.new("Sun", sun)
        o.rotation_euler = (math.radians(50), 0, math.radians(150))
        scene.collection.objects.link(o)
        p.inputs["Emission Strength"].default_value = 0.0
        scene.view_settings.exposure = 0.0
    else:
        bg.inputs["Color"].default_value = (0.01, 0.015, 0.035, 1)
        bg.inputs["Strength"].default_value = 0.25
        # dipped headlamps, low beams on the road ahead
        for i, x in enumerate((CX - 0.65, CX + 0.65)):
            lamp = bpy.data.lights.new(f"Head{i}", "SPOT")
            lamp.energy = 9000
            lamp.spot_size = math.radians(60)
            lamp.spot_blend = 0.6
            o = bpy.data.objects.new(f"Head{i}", lamp)
            o.location = (x, 3.0, 0.75)
            o.rotation_euler = (math.radians(86), 0, 0)  # local -Z turned forward, a touch down
            scene.collection.objects.link(o)
        dome = bpy.data.lights.new("Interior", "POINT")
        dome.energy = 1.5
        dome.shadow_soft_size = 0.2
        dome.color = (1.0, 0.85, 0.7)
        o = bpy.data.objects.new("Interior", dome)
        o.location = (CX, 0.5, 1.45)
        scene.collection.objects.link(o)
        p.inputs["Emission Color"].default_value = (0.55, 0.75, 1.0, 1)
        p.inputs["Emission Strength"].default_value = 0.12
        scene.view_settings.exposure = 0.5


def camera(yaw, pitch, lens):
    scene = bpy.context.scene
    cam = scene.camera
    if cam is None:
        cam = bpy.data.objects.new("Eye", bpy.data.cameras.new("Eye"))
        scene.collection.objects.link(cam)
        scene.camera = cam
    cam.data.sensor_fit = "HORIZONTAL"
    cam.data.sensor_width = 36
    cam.data.lens = lens
    cam.data.clip_start = 0.03
    cam.data.clip_end = 5000
    a = math.radians(yaw)
    pivot = EYE - Vector((0, NECK, 0))
    cam.location = pivot + Vector((-math.sin(a), math.cos(a), 0)) * NECK
    cam.rotation_euler = (math.radians(90 + pitch), 0, a)


def main():
    a = args()
    os.makedirs(a.out, exist_ok=True)
    environment()
    for mode in a.modes.split(","):
        setup(mode, a.samples)
        for name in a.views.split(","):
            camera(*VIEWS[name])
            path = os.path.join(a.out, f"{name}_{mode}.png")
            bpy.context.scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            print("[render]", path)


if __name__ == "__main__":
    main()
