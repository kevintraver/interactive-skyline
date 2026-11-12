"""Check an exported .glb without Blender: triangles, size, materials, and the night-glow attribute.

    python check_glb.py MODEL.glb [--max-tris N] [--height M] [--tolerance 0.02] [--compare OTHER.glb] [--json]

Fails (exit 1) on what breaks a three.js loader or the conventions this skill relies on: a primitive
without POSITION/NORMAL, non-triangle primitives, a COLOR_0 attribute (viewers multiply it into the base
color, so baked glow would tint the model by day), or a size/budget the caller asked to enforce.
Missing `_GLOW` is a warning: the model works, it is just dark at night.

Sizes are reported in the model's own frame: east (+X), north (-Z in glTF), up (+Y).
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys

COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
FORMATS = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}


def read_glb(path: str) -> tuple[dict, bytes]:
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 20 or data[:4] != b"glTF":
        raise SystemExit(f"{path}: not a binary glTF (.glb) file")
    _, version, _ = struct.unpack_from("<4sII", data, 0)
    if version != 2:
        raise SystemExit(f"{path}: glTF version {version}, expected 2")
    offset, doc, blob = 12, None, b""
    while offset + 8 <= len(data):
        length, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8: offset + 8 + length]
        if kind == 0x4E4F534A:    # JSON
            doc = json.loads(chunk.decode("utf-8"))
        elif kind == 0x004E4942:  # BIN
            blob = chunk
        offset += 8 + length
    if doc is None:
        raise SystemExit(f"{path}: no JSON chunk")
    return doc, blob


def accessor_values(doc: dict, blob: bytes, index: int) -> list[tuple[float, ...]]:
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    n = COMPONENTS[acc["type"]]
    fmt = FORMATS[acc["componentType"]]
    size = struct.calcsize(fmt)
    stride = view.get("byteStride") or size * n
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    out = []
    for i in range(acc["count"]):
        vals = struct.unpack_from("<" + fmt * n, blob, base + i * stride)
        if acc.get("normalized"):
            vals = tuple(v / float(2 ** (8 * size - (1 if fmt.islower() else 0)) - 1) for v in vals)
        out.append(vals)
    return out


def linear_to_hex(rgb: list[float]) -> str:
    def channel(c: float) -> int:
        c = max(0.0, min(1.0, c))
        s = c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055
        return round(s * 255)
    return "".join(f"{channel(c):02X}" for c in rgb[:3])


Matrix = tuple[tuple[float, ...], ...]
IDENTITY: Matrix = ((1.0, 0.0, 0.0, 0.0), (0.0, 1.0, 0.0, 0.0), (0.0, 0.0, 1.0, 0.0), (0.0, 0.0, 0.0, 1.0))


def matmul(a: Matrix, b: Matrix) -> Matrix:
    return tuple(tuple(sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)) for i in range(4))


def local_matrix(node: dict) -> Matrix:
    """A node's transform as a row-major 4x4 (glTF stores `matrix` column-major, or T * R * S)."""
    if "matrix" in node:
        m = node["matrix"]
        return tuple(tuple(m[col * 4 + row] for col in range(4)) for row in range(4))
    tx, ty, tz = node.get("translation", (0.0, 0.0, 0.0))
    x, y, z, w = node.get("rotation", (0.0, 0.0, 0.0, 1.0))
    sx, sy, sz = node.get("scale", (1.0, 1.0, 1.0))
    r = ((1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
         (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
         (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)))
    s = (sx, sy, sz)
    t = (tx, ty, tz)
    return tuple(tuple(r[i][j] * s[j] for j in range(3)) + (t[i],) for i in range(3)) + ((0.0, 0.0, 0.0, 1.0),)


def mesh_instances(doc: dict) -> dict[int, list[Matrix]]:
    """World matrices of every node that draws each mesh, walking the default scene's hierarchy (models split
    into parented parts, e.g. a wheel's rotor and cabins, would otherwise be measured at their local origins).
    A mesh no node uses counts once, untransformed."""
    nodes = doc.get("nodes", [])
    scenes = doc.get("scenes", [])
    roots = scenes[doc.get("scene", 0)].get("nodes", []) if scenes else []
    if not roots:
        children = {c for n in nodes for c in n.get("children", [])}
        roots = [i for i in range(len(nodes)) if i not in children]
    found: dict[int, list[Matrix]] = {}

    def walk(index: int, parent: Matrix, depth: int) -> None:
        if depth > 64:
            raise SystemExit("node hierarchy deeper than 64 levels (a cycle?)")
        node = nodes[index]
        world = matmul(parent, local_matrix(node))
        if "mesh" in node:
            found.setdefault(node["mesh"], []).append(world)
        for child in node.get("children", []):
            walk(child, world, depth + 1)
    for root in roots:
        walk(root, IDENTITY, 0)
    for m in range(len(doc.get("meshes", []))):
        found.setdefault(m, [IDENTITY])
    return found


def transformed_corners(lo: list[float], hi: list[float], m: Matrix) -> list[tuple[float, float, float]]:
    out = []
    for x in (lo[0], hi[0]):
        for y in (lo[1], hi[1]):
            for z in (lo[2], hi[2]):
                out.append(tuple(m[i][0] * x + m[i][1] * y + m[i][2] * z + m[i][3] for i in range(3)))
    return out


def summarize(path: str) -> dict:
    doc, blob = read_glb(path)
    materials = doc.get("materials", [])
    instances = mesh_instances(doc)
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    tris, verts, prims, errors, warnings = 0, 0, [], [], []
    for mesh_index, mesh in enumerate(doc.get("meshes", [])):
        uses = instances[mesh_index]
        for p in mesh["primitives"]:
            attrs = p.get("attributes", {})
            mat = materials[p["material"]] if "material" in p else {}
            name = mat.get("name", "(default)")
            mode = p.get("mode", 4)
            if mode != 4:
                errors.append(f"{name}: primitive mode {mode} is not TRIANGLES")
            for required in ("POSITION", "NORMAL"):
                if required not in attrs:
                    errors.append(f"{name}: no {required}")
            if "COLOR_0" in attrs:
                errors.append(f"{name}: has COLOR_0; three.js multiplies it into the base color")
            count = (doc["accessors"][attrs["POSITION"]]["count"] if "POSITION" in attrs else 0) * len(uses)
            ptris = (doc["accessors"][p["indices"]]["count"] if "indices" in p else count // len(uses)) // 3 * len(uses)
            acc = doc["accessors"][attrs["POSITION"]] if "POSITION" in attrs else {}
            if "min" in acc and "max" in acc:
                for m in uses:
                    for corner in transformed_corners(acc["min"], acc["max"], m):
                        for k in range(3):
                            lo[k], hi[k] = min(lo[k], corner[k]), max(hi[k], corner[k])
            glow_max = None
            if "_GLOW" in attrs:
                values = accessor_values(doc, blob, attrs["_GLOW"])
                glow_max = round(max((max(v[:3]) for v in values), default=0.0), 3)
            pbr = mat.get("pbrMetallicRoughness", {})
            prims.append({"material": name, "base_color": linear_to_hex(pbr.get("baseColorFactor", [1, 1, 1, 1])),
                          "tris": ptris, "verts": count, "attributes": sorted(attrs), "glow_max": glow_max})
            tris += ptris
            verts += count
    if not prims:
        errors.append("no mesh primitives")
    missing_glow = [p["material"] for p in prims if p["glow_max"] is None]
    if missing_glow:
        warnings.append(f"no _GLOW on: {', '.join(missing_glow)} (dark at night)")
    size = {"east": hi[0] - lo[0], "north": hi[2] - lo[2], "up": hi[1] - lo[1]} if prims else {}
    return {
        "file": path, "primitives": len(prims), "tris": tris, "verts": verts,
        "bbox_min": {"east": lo[0], "north": -hi[2], "up": lo[1]} if prims else {},
        "bbox_max": {"east": hi[0], "north": -lo[2], "up": hi[1]} if prims else {},
        "size": {k: round(v, 3) for k, v in size.items()},
        "materials": prims, "errors": errors, "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("glb")
    parser.add_argument("--max-tris", type=int, help="fail above this many triangles")
    parser.add_argument("--height", type=float, help="expected top height in meters (up axis)")
    parser.add_argument("--tolerance", type=float, default=0.02, help="relative tolerance for --height (default 2%%)")
    parser.add_argument("--compare", help="another .glb to compare counts and size against")
    parser.add_argument("--json", action="store_true", help="print the full report as JSON")
    args = parser.parse_args()

    report = summarize(args.glb)
    if args.max_tris and report["tris"] > args.max_tris:
        report["errors"].append(f"{report['tris']} triangles is over the budget of {args.max_tris}")
    if args.height is not None and report["bbox_max"]:
        top = report["bbox_max"]["up"]
        if abs(top - args.height) > args.tolerance * args.height:
            report["errors"].append(f"top is at {top:.2f} m, expected {args.height:.2f} m")
    if args.compare:
        other = summarize(args.compare)
        report["compare"] = {"file": args.compare, "tris": other["tris"], "verts": other["verts"],
                             "primitives": other["primitives"], "size": other["size"]}
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(f"{report['file']}: {report['primitives']} primitives, {report['tris']} tris, {report['verts']} verts")
        if report["size"]:
            s, lo, hi = report["size"], report["bbox_min"], report["bbox_max"]
            print(f"  size: {s['east']:.2f} m east-west, {s['north']:.2f} m north-south, {s['up']:.2f} m tall "
                  f"(up {lo['up']:.2f}..{hi['up']:.2f})")
        for p in report["materials"]:
            glow = "no _GLOW" if p["glow_max"] is None else f"glow max {p['glow_max']}"
            print(f"  {p['material']:<16} #{p['base_color']}  {p['tris']:>6} tris  {glow}")
        if "compare" in report:
            c = report["compare"]
            print(f"  compared with {c['file']}: {c['primitives']} primitives, {c['tris']} tris, size {c['size']}")
        for w in report["warnings"]:
            print(f"  warning: {w}")
        for e in report["errors"]:
            print(f"  ERROR: {e}")
    return 1 if report["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
