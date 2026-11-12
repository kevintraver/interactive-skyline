"""Render preview images of a model headlessly (Workbench), to compare against reference photos.

    python run_blender.py render_views.py --blend MODEL.blend -- --out DIR
        [--views south,east,iso] [--modes day,night] [--size 1000]
        [--photo NAME:BEARING:ELEVATION[:LENS[:TARGET_Z[:DISTANCE]]] ...]

Views:
  south, east, north, west  orthographic elevations seen from that side: true proportions, no perspective,
                            the best match for a side-on photo
  top                       orthographic plan from above
  iso                       perspective three-quarter view from the south-west
  --photo                   a perspective camera placed to match a photo: BEARING is the compass direction
                            from the model to the camera (0 = north, 90 = east), ELEVATION the camera's angle
                            above the horizontal in degrees (negative looks up from below), LENS the focal
                            length in mm (default 50), TARGET_Z the height it aims at (default 55% of the
                            model), DISTANCE in meters (default: far enough to fit the whole model)
Modes:
  day    material colors under studio light
  night  the `_GLOW` attribute alone on a dark background: what will light up at night

Writes DIR/<view>_<mode>.png and prints each path.
"""
from __future__ import annotations

import argparse
import math
import os
import sys

import bpy
from mathutils import Vector

GLOW = "_GLOW"
ELEVATIONS = {"south": 180.0, "east": 90.0, "north": 0.0, "west": 270.0}
NIGHT_BACKGROUND = (0.015, 0.02, 0.04)
DAY_BACKGROUND = (0.55, 0.68, 0.85)
SENSOR_HEIGHT = 24.0  # mm, with vertical sensor fit


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="render_views.py")
    parser.add_argument("--out", required=True)
    parser.add_argument("--views", default="south,east,iso")
    parser.add_argument("--modes", default="day,night")
    parser.add_argument("--size", type=int, default=1000, help="pixels on the long side")
    parser.add_argument("--photo", action="append", default=[], help="NAME:BEARING:ELEVATION[:LENS[:TARGET_Z[:DIST]]]")
    return parser.parse_args(argv)


def model_objects() -> list[bpy.types.Object]:
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH" and o.visible_get()]
    if not objs:
        raise RuntimeError("no visible mesh objects in the scene")
    return objs


def bounds(objs: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    pts = [o.matrix_world @ Vector(c) for o in objs for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def set_engine(scene: bpy.types.Scene) -> None:
    try:
        scene.render.engine = "BLENDER_WORKBENCH"
    except TypeError as err:  # the message lists the valid engines
        options = [e for e in str(err).replace("'", " ").replace(",", " ").split() if "WORKBENCH" in e]
        if not options:
            raise
        scene.render.engine = options[0]
    for prop, value in (("view_transform", "Standard"), ("look", "None")):
        try:
            setattr(scene.view_settings, prop, value)
        except (TypeError, AttributeError):
            pass
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"


def set_mode(scene: bpy.types.Scene, objs: list[bpy.types.Object], mode: str) -> None:
    shading = scene.display.shading
    if scene.world is None:
        scene.world = bpy.data.worlds.new("World")
    if mode == "day":
        shading.light, shading.color_type = "STUDIO", "MATERIAL"
        scene.world.color = DAY_BACKGROUND
    else:
        shading.light, shading.color_type = "FLAT", "VERTEX"
        scene.world.color = NIGHT_BACKGROUND
        for obj in objs:
            attrs = obj.data.color_attributes
            if GLOW not in attrs:
                print(f"[render_views] {obj.name} has no {GLOW}; it renders black at night")
                continue
            for setter in (lambda: setattr(attrs, "active_color", attrs[GLOW]),
                           lambda: setattr(attrs, "active_color_name", GLOW),
                           lambda: setattr(attrs, "render_color_index", attrs.find(GLOW))):
                try:
                    setter()
                except (AttributeError, TypeError):
                    pass
    shading.show_cavity = False
    shading.show_object_outline = False


def aim(cam: bpy.types.Object, target: Vector) -> None:
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()


def compass_dir(bearing: float, elevation: float) -> Vector:
    b, e = math.radians(bearing), math.radians(elevation)
    return Vector((math.cos(e) * math.sin(b), math.cos(e) * math.cos(b), math.sin(e)))


def place_elevation(scene, cam, lo, hi, bearing: float | None, size: int) -> None:
    """Orthographic camera looking at the model from a compass side (or from above when bearing is None)."""
    center = (lo + hi) / 2
    radius = (hi - lo).length
    cam.data.type = "ORTHO"
    if bearing is None:
        width, height = hi.x - lo.x, hi.y - lo.y
        cam.location = center + Vector((0, 0, radius * 2))
        cam.rotation_euler = (0.0, 0.0, 0.0)
    else:
        d = compass_dir(bearing, 0.0)
        across = abs(d.y) * (hi.x - lo.x) + abs(d.x) * (hi.y - lo.y)
        width, height = across, hi.z - lo.z
        cam.location = center + d * radius * 2
        aim(cam, center)
    aspect = max(0.25, min(2.0, width / max(height, 1e-6)))
    scene.render.resolution_x, scene.render.resolution_y = (size, round(size / aspect)) if aspect >= 1 \
        else (round(size * aspect), size)
    cam.data.ortho_scale = max(width, height) * 1.06
    cam.data.clip_end = radius * 6


def place_perspective(scene, cam, lo, hi, bearing, elevation, lens, target_z, distance, size) -> None:
    height = hi.z - lo.z
    target = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z + 0.55 * height if target_z is None else target_z))
    cam.data.type = "PERSP"
    cam.data.lens = lens
    cam.data.sensor_fit = "VERTICAL"
    cam.data.sensor_height = SENSOR_HEIGHT
    scene.render.resolution_x, scene.render.resolution_y = round(size * 0.75), size
    if distance is None:
        corners = [Vector((x, y, z)) for x in (lo.x, hi.x) for y in (lo.y, hi.y) for z in (lo.z, hi.z)]
        reach = max((c - target).length for c in corners)
        half_fov = math.atan(SENSOR_HEIGHT * 0.75 / 2 / lens)  # the narrower, horizontal half-angle
        distance = reach / math.sin(half_fov) * 1.02
    cam.location = target + compass_dir(bearing, elevation) * distance
    aim(cam, target)
    cam.data.clip_start = max(0.1, distance / 2000)
    cam.data.clip_end = distance * 4


def main() -> None:
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    scene = bpy.context.scene
    objs = model_objects()
    lo, hi = bounds(objs)
    set_engine(scene)
    cam = bpy.data.objects.new("PreviewCamera", bpy.data.cameras.new("PreviewCamera"))
    scene.collection.objects.link(cam)
    scene.camera = cam

    shots: list[tuple[str, callable]] = []
    for view in [v.strip() for v in args.views.split(",") if v.strip()]:
        if view in ELEVATIONS:
            shots.append((view, lambda b=ELEVATIONS[view]: place_elevation(scene, cam, lo, hi, b, args.size)))
        elif view == "top":
            shots.append((view, lambda: place_elevation(scene, cam, lo, hi, None, args.size)))
        elif view == "iso":
            shots.append((view, lambda: place_perspective(scene, cam, lo, hi, 225.0, 20.0, 50.0, None, None, args.size)))
        else:
            raise SystemExit(f"unknown view {view!r}; use south, east, north, west, top, iso or --photo")
    for spec in args.photo:
        parts = spec.split(":")
        if len(parts) < 3:
            raise SystemExit(f"--photo {spec!r}: expected NAME:BEARING:ELEVATION[:LENS[:TARGET_Z[:DISTANCE]]]")
        name, bearing, elevation = parts[0], float(parts[1]), float(parts[2])
        lens = float(parts[3]) if len(parts) > 3 and parts[3] else 50.0
        target_z = float(parts[4]) if len(parts) > 4 and parts[4] else None
        distance = float(parts[5]) if len(parts) > 5 and parts[5] else None
        shots.append((name, lambda b=bearing, e=elevation, f=lens, t=target_z, d=distance:
                      place_perspective(scene, cam, lo, hi, b, e, f, t, d, args.size)))

    modes = [m.strip() for m in args.modes.split(",") if m.strip()]
    for mode in modes:
        if mode not in ("day", "night"):
            raise SystemExit(f"unknown mode {mode!r}; use day and/or night")
    for mode in modes:
        set_mode(scene, objs, mode)
        for name, place in shots:
            place()
            path = os.path.join(os.path.abspath(args.out), f"{name}_{mode}.png")
            scene.render.filepath = path
            bpy.ops.render.render(write_still=True)
            print(f"[render_views] {path}")


main()
