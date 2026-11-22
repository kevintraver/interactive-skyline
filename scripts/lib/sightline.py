"""Where a road first sees a building: line of sight over the terrain, in the app's scene frame.

The app is planar with the earth's curvature baked into the terrain (scene Y = h - base -
curve_drop(x, y), refraction already in EARTH_R), so a sight line is a straight segment in scene
space. Buildings are placed without the curvature drop: a landmark model stands with its origin
at scene Y = ground - base (placeModel in customModels.js), an extruded building's volumes run
from b - base to t - base (extrude in main.js).

    target = building_top("lv", "w135457469")   # {"x", "y", "Y", "how"}: map metres, scene Y
    vis = visible(heights, eyes_x, eyes_y, eyes_Y, target)
"""
import json
import struct
from pathlib import Path

import numpy as np

from .frame import curve_drop

ROOT = Path(__file__).resolve().parents[2]


def _glb_points(path):
    """Every vertex position of a .glb in its scene's space (translation, rotation, scale applied)."""
    blob = Path(path).read_bytes()
    jlen = struct.unpack_from("<I", blob, 12)[0]
    gltf = json.loads(blob[20:20 + jlen])
    bin_start = 20 + jlen + 8
    out = []

    def accessor(i):
        a = gltf["accessors"][i]
        v = gltf["bufferViews"][a["bufferView"]]
        start = bin_start + v.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = v.get("byteStride", 12)
        raw = np.frombuffer(blob, dtype=np.uint8, count=stride * (a["count"] - 1) + 12, offset=start)
        idx = (np.arange(a["count"])[:, None] * stride + np.arange(12)[None, :])
        return raw[idx].copy().view("<f4").reshape(-1, 3).astype(np.float64)

    def matrix(node):
        if "matrix" in node:
            return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
        x, y, z, w = node.get("rotation", [0, 0, 0, 1])
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                      [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                      [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        m = np.eye(4)
        m[:3, :3] = r * np.array(node.get("scale", [1, 1, 1]))[None, :]
        m[:3, 3] = node.get("translation", [0, 0, 0])
        return m

    def visit(i, parent):
        node = gltf["nodes"][i]
        m = parent @ matrix(node)
        if "mesh" in node:
            for prim in gltf["meshes"][node["mesh"]]["primitives"]:
                p = accessor(prim["attributes"]["POSITION"])
                out.append(p @ m[:3, :3].T + m[:3, 3])
        for c in node.get("children", []):
            visit(c, m)

    for i in gltf["scenes"][gltf.get("scene", 0)]["nodes"]:
        visit(i, np.eye(4))
    return np.concatenate(out)


def building_top(city, building_id, root=ROOT):
    """The highest point the app draws for a building: map x, y and scene Y, plus how it was found."""
    root = Path(root)
    base = json.loads((root / "data" / "cities.json").read_text())[city]["base"]
    data = json.loads((root / "public" / "data" / city / "buildings.json").read_text())
    b = next(b for b in data["buildings"] if b["id"] == building_id)
    manifest = root / "public" / "models" / "models.json"
    spec = json.loads(manifest.read_text()).get(city, {}).get(building_id) if manifest.exists() else None
    if spec:
        pts = _glb_points(root / "public" / spec["url"].lstrip("/"))
        k = int(np.argmax(pts[:, 1]))
        ox, oy = spec.get("offset", [0, 0])
        # model axes: +x east, +y up, -z north; origin at the footprint centre plus offset, on the ground
        return {"x": b["c"][0] + ox + pts[k, 0], "y": b["c"][1] + oy - pts[k, 2],
                "Y": b["ground"] - base + pts[k, 1], "h": b["ground"] + pts[k, 1],
                "how": f"model {spec['url']}, top {pts[k, 1]:.1f} m above its origin at ground {b['ground']} m"}
    v = max(b["v"], key=lambda v: v["t"])
    ring = np.array(v.get("u") or v["o"], dtype=np.float64).reshape(-1, 2)
    cx, cy = ring.mean(axis=0)
    return {"x": cx, "y": cy, "Y": v["t"] - base, "h": v["t"], "how": f"extruded volume top {v['t']} m"}


def visible(ground_y, ex, ey, eY, target, step=10.0, skip=2.0, chunk=64):
    """For each eye (map ex, ey; scene eY), whether the straight segment to the target clears the
    terrain: ground_y(x, y) is the terrain's scene Y. Returns (visible, worst clearance in metres)."""
    ex, ey, eY = (np.asarray(a, dtype=np.float64) for a in (ex, ey, eY))
    tx, ty, tY = target["x"], target["y"], target["Y"]
    vis = np.zeros(len(ex), dtype=bool)
    worst = np.zeros(len(ex))
    for a in range(0, len(ex), chunk):
        sl = slice(a, a + chunk)
        dist = np.hypot(tx - ex[sl], ty - ey[sl])
        m = int(np.ceil(dist.max() / step))
        f = np.linspace(0, 1, m + 1)[None, :]
        keep = (f * dist[:, None] > skip) & (f < 1)
        px = ex[sl, None] + (tx - ex[sl, None]) * f
        py = ey[sl, None] + (ty - ey[sl, None]) * f
        pY = eY[sl, None] + (tY - eY[sl, None]) * f
        clear = np.where(keep, pY - ground_y(px, py), np.inf)
        worst[sl] = clear.min(axis=1)
        vis[sl] = worst[sl] > 0
    return vis, worst


def eye_scene_y(h, x, y, base, eye=1.2):
    """Scene Y of an eye `eye` metres above a road surface at height h (m above sea level)."""
    return h + eye - base - curve_drop(x, y)
