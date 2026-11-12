"""Read building geometry from CityJSON / CityGML city models (directly, or out of a 3DCityDB). Pure Python.

    python citymodel.py list    FILE [--name TEXT] [--near X,Y] [--limit 20]
    python citymodel.py extract FILE --id ID --out footprint.json [--lod 2.2] [--origin X,Y]
    python citymodel.py from-3dcitydb --out buildings.city.json [--filter "con:height > 100"] [--sql-filter SQL]
                                      [--host H --db NAME --user U --password P --schema citydb]

FILE is CityJSON (.city.json), CityJSONSeq (.jsonl, one feature per line) or an OGC API response made of
CityJSONFeatures (e.g. the 3D BAG API). CityGML (.gml) is not read directly: load it into a 3DCityDB with
citydb-tool and export CityJSON (`from-3dcitydb`), or convert it with citygml-tools.

`extract` writes the same footprint.json frame as skyline_tool.py footprint (meters east/north of the
building's center, heights above its ground), plus `surfaces`: the chosen LOD's polygons with their semantic
type (RoofSurface, WallSurface, GroundSurface...), so a build script can use the real roof shape:

    fp = kit.load_footprint("footprint.json")
    b.surfaces(fp["surfaces"], {"RoofSurface": "Roof", "WallSurface": "Wall"}, default="Wall")

Coordinates must be in a projected CRS in meters (most city models are); geographic (lat/lon) data is refused.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import subprocess
import sys

HEIGHT_KEYS = ("measuredHeight", "height", "b3_h_dak_max")  # first one present wins (CityJSON / 3D BAG names)
GROUND_KEYS = ("b3_h_maaiveld",)


# ------------------------------------------------------------------- reading
def load(path: str) -> dict:
    """Normalize CityJSON, CityJSONSeq and CityJSONFeature collections into {crs, objects{id: obj}}, with each
    object's geometry already in real coordinates (`coords`)."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    stripped = text.lstrip()
    if stripped.startswith("<"):
        raise SystemExit(f"{path} is XML (CityGML); import it into a 3DCityDB and export CityJSON, or convert it first")
    docs = []
    if path.endswith(".jsonl") or (stripped.startswith("{") and "\n{" in stripped.strip() and not stripped.startswith("{\n")):
        try:
            docs = [json.loads(line) for line in text.splitlines() if line.strip()]
        except json.JSONDecodeError:
            docs = [json.loads(text)]
    else:
        docs = [json.loads(text)]
    head = docs[0]
    meta = head.get("metadata", {})
    if head.get("type") != "CityJSON" and isinstance(meta, dict) and meta.get("type") == "CityJSON":
        head = meta                                # OGC API: transform lives in the response's metadata
    transform = head.get("transform") or {"scale": [1, 1, 1], "translate": [0, 0, 0]}
    crs = (head.get("metadata") or {}).get("referenceSystem", "")
    if any(tag in str(crs) for tag in ("4326", "4979", "CRS84")):
        raise SystemExit(f"{path} is in a geographic CRS ({crs}); reproject it to a metric CRS first")
    features = []
    for d in docs:
        if d.get("type") == "CityJSON" and d.get("CityObjects"):
            features.append(d)
        elif d.get("type") == "CityJSONFeature":
            features.append(d)
        for f in d.get("features", []) or []:
            features.append(f)
    objects: dict[str, dict] = {}
    sx, sy, sz = transform["scale"]
    tx, ty, tz = transform["translate"]
    for f in features:
        verts = [(v[0] * sx + tx, v[1] * sy + ty, v[2] * sz + tz) for v in f.get("vertices", [])]
        for oid, obj in f.get("CityObjects", {}).items():
            obj = dict(obj)
            obj["coords"] = verts
            objects[oid] = obj
    if not objects:
        raise SystemExit(f"{path}: no CityObjects found")
    return {"crs": crs, "objects": objects, "path": path}


def surfaces_of(geom: dict, coords: list) -> list[dict]:
    """Every polygon of one geometry, as {semantic, ring: [(x,y,z)...], holes: n}."""
    kind, b = geom.get("type"), geom.get("boundaries", [])
    sem = geom.get("semantics") or {}
    sem_types = [s.get("type") for s in sem.get("surfaces", [])]
    values = sem.get("values")
    polys = []  # (surface rings, semantic index)
    if kind in ("MultiSurface", "CompositeSurface"):
        for i, surface in enumerate(b):
            polys.append((surface, values[i] if isinstance(values, list) and i < len(values) else None))
    elif kind == "Solid":
        for s, shell in enumerate(b):
            for i, surface in enumerate(shell):
                v = values[s][i] if isinstance(values, list) and s < len(values) and isinstance(values[s], list) else None
                polys.append((surface, v))
    elif kind in ("MultiSolid", "CompositeSolid"):
        for k, solid in enumerate(b):
            for s, shell in enumerate(solid):
                for i, surface in enumerate(shell):
                    try:
                        v = values[k][s][i]
                    except (TypeError, IndexError):
                        v = None
                    polys.append((surface, v))
    out = []
    for rings, v in polys:
        if not rings:
            continue
        ring = [coords[i] for i in rings[0]]
        out.append({"semantic": sem_types[v] if isinstance(v, int) and v < len(sem_types) else None,
                    "ring": ring, "holes": len(rings) - 1})
    return out


def family(model: dict, oid: str) -> list[dict]:
    """The object and its children (BuildingParts), which often carry the real geometry."""
    objs = model["objects"]
    out = [objs[oid]]
    for child in objs[oid].get("children", []) or []:
        if child in objs:
            out += family(model, child)
    return out


def lods(model: dict, oid: str) -> list[str]:
    return sorted({str(g.get("lod")) for o in family(model, oid) for g in o.get("geometry", [])})


def height_of(model: dict, oid: str, zs: list[float]) -> tuple[float | None, str]:
    attrs = model["objects"][oid].get("attributes", {}) or {}
    for key in HEIGHT_KEYS:
        if isinstance(attrs.get(key), (int, float)):
            ground = next((attrs[g] for g in GROUND_KEYS if isinstance(attrs.get(g), (int, float))), None)
            value = attrs[key] - ground if key == "b3_h_dak_max" and ground is not None else attrs[key]
            return round(float(value), 2), f"attribute {key}"
    return (round(max(zs) - min(zs), 2), "geometry extent") if zs else (None, "unknown")


def all_points(model: dict, oid: str) -> list[tuple]:
    return [p for o in family(model, oid) for g in o.get("geometry", []) for s in surfaces_of(g, o["coords"]) for p in s["ring"]]


# ------------------------------------------------------------------ commands
def cmd_list(path: str, name: str | None, near: str | None, limit: int) -> int:
    model = load(path)
    rows = []
    for oid, obj in model["objects"].items():
        if not obj.get("type", "").startswith("Building") or obj.get("parents"):
            continue
        attrs = obj.get("attributes", {}) or {}
        label = " ".join(str(attrs.get(k, "")) for k in ("name", "function", "address") if attrs.get(k))
        if name and name.lower() not in (oid + " " + label).lower():
            continue
        pts = all_points(model, oid)
        if not pts:
            continue
        xs, ys, zs = zip(*pts)
        h, src = height_of(model, oid, list(zs))
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        dist = math.hypot(cx - float(near.split(",")[0]), cy - float(near.split(",")[1])) if near else 0
        rows.append((dist, -(h or 0), oid, h, src, cx, cy, lods(model, oid), label))
    rows.sort()
    print(f"{path}: CRS {model['crs'] or 'unknown'}, {len(rows)} buildings" + (f" near {near}" if near else ""))
    for _, _, oid, h, src, cx, cy, lod, label in rows[:limit]:
        print(f"  {oid}  height {h} m ({src})  center ({cx:.1f}, {cy:.1f})  LODs {','.join(lod)}  {label}"[:220])
    return 0


def outline_from(surfs: list[dict]) -> list[list[float]]:
    """A 2D outline: the largest ground/footprint polygon, else the convex hull of everything."""
    ground = [s for s in surfs if s["semantic"] in (None, "GroundSurface") and len(s["ring"]) >= 3]
    def area(ring):
        return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1]))) / 2
    flat = [s for s in ground if max(p[2] for p in s["ring"]) - min(p[2] for p in s["ring"]) < 0.5]
    if flat:
        return [[p[0], p[1]] for p in max(flat, key=lambda s: area(s["ring"]))["ring"]]
    pts = sorted({(round(p[0], 3), round(p[1], 3)) for s in surfs for p in s["ring"]})
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return [list(p) for p in lower[:-1] + upper[:-1]]


def cmd_extract(path: str, oid: str, out: str, lod: str | None, origin: str | None) -> int:
    model = load(path)
    if oid not in model["objects"]:
        raise SystemExit(f"{oid} not in {path}; use `list` to find ids")
    fam = family(model, oid)
    available = lods(model, oid)
    footprint_surfs, body_surfs, chosen = [], [], None
    want = lod or max((l for l in available if l not in ("0", "None")), default=None, key=lambda s: float(s))
    for o in fam:
        for g in o.get("geometry", []):
            surfs = surfaces_of(g, o["coords"])
            if str(g.get("lod")) == "0":
                footprint_surfs += surfs
            elif want is not None and str(g.get("lod")) == str(want):
                body_surfs += surfs
                chosen = str(g.get("lod"))
    if not body_surfs and not footprint_surfs:
        raise SystemExit(f"{oid}: no geometry at LOD {want}; available LODs {available}")
    pts = [p for s in body_surfs + footprint_surfs for p in s["ring"]]
    xs, ys, zs = zip(*pts)
    ground = min(p[2] for s in (body_surfs or footprint_surfs) for p in s["ring"])
    attrs = model["objects"][oid].get("attributes", {}) or {}
    if isinstance(attrs.get("b3_h_maaiveld"), (int, float)):
        ground = attrs["b3_h_maaiveld"]
    height, hsrc = height_of(model, oid, [ground, max(zs)])
    cx, cy = ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2) if not origin else map(float, origin.split(","))
    def local(p):
        return [round(p[0] - cx, 3), round(p[1] - cy, 3), round(p[2] - ground, 3)]
    outline = outline_from(footprint_surfs or body_surfs)
    doc = {
        "id": oid, "source": os.path.abspath(path), "crs": model["crs"], "center": [round(cx, 3), round(cy, 3)],
        "ground": round(ground, 3), "height": height, "height_source": hsrc, "lod": chosen, "lods_available": available,
        "frame": "meters east and north of `center` (in the source CRS), heights above `ground`",
        "volumes": [{"bottom": 0.0, "top": height or round(max(zs) - ground, 2),
                     "outline": [[round(x - cx, 3), round(y - cy, 3)] for x, y in outline], "holes": []}],
        "surfaces": [{"semantic": s["semantic"], "ring": [local(p) for p in s["ring"]]} for s in body_surfs],
        "skipped_holes": sum(s["holes"] for s in body_surfs),
    }
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1)
    kinds: dict[str, int] = {}
    for s in body_surfs:
        kinds[s["semantic"] or "unlabelled"] = kinds.get(s["semantic"] or "unlabelled", 0) + 1
    print(f"{out}: {oid}, height {height} m ({hsrc}), LOD {chosen} of {available}, {len(body_surfs)} surfaces {kinds}, "
          f"outline {len(outline)} points" + (f", {doc['skipped_holes']} holes ignored" if doc["skipped_holes"] else ""))
    return 0


def cmd_from_3dcitydb(args: argparse.Namespace) -> int:
    """Export buildings from a running 3DCityDB v5 as CityJSON with citydb-tool's Docker image."""
    docker = shutil.which("docker")
    if not docker:
        raise SystemExit("Docker is not installed; install citydb-tool (https://github.com/3dcitydb/citydb-tool) "
                         "and run: citydb export cityjson --type-name=bldg:Building -o <file> plus connection options")
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cmd = [docker, "run", "--rm", "-v", f"{os.path.dirname(out)}:/data", "3dcitydb/citydb-tool",
           "export", "cityjson", "--type-name=bldg:Building", "-o", f"/data/{os.path.basename(out)}"]
    for flag, value in (("-H", args.host), ("-P", args.port), ("-d", args.db), ("-S", args.schema),
                        ("-u", args.user), ("-p", args.password)):
        if value:
            cmd += [flag, str(value)]
    if args.filter:
        cmd.append(f"--filter={args.filter}")
    if args.sql_filter:
        cmd.append(f"--sql-filter={args.sql_filter}")
    shown = [c if not (i > 0 and cmd[i - 1] == "-p") else "***" for i, c in enumerate(cmd)]
    print("running:", " ".join(shown))
    return subprocess.run(cmd).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list"); p.add_argument("file"); p.add_argument("--name")
    p.add_argument("--near", help="X,Y in the file's CRS: list the closest buildings first"); p.add_argument("--limit", type=int, default=20)
    p = sub.add_parser("extract"); p.add_argument("file"); p.add_argument("--id", required=True); p.add_argument("--out", required=True)
    p.add_argument("--lod", help="LOD to take surfaces from (default: the highest available)")
    p.add_argument("--origin", help="X,Y in the file's CRS to use as the model origin (default: bounding-box center)")
    p = sub.add_parser("from-3dcitydb"); p.add_argument("--out", required=True)
    p.add_argument("--host", default=os.environ.get("CITYDB_HOST")); p.add_argument("--port", default=os.environ.get("CITYDB_PORT"))
    p.add_argument("--db", default=os.environ.get("CITYDB_NAME")); p.add_argument("--schema", default=os.environ.get("CITYDB_SCHEMA"))
    p.add_argument("--user", default=os.environ.get("CITYDB_USERNAME")); p.add_argument("--password", default=os.environ.get("CITYDB_PASSWORD"))
    p.add_argument("--filter", help='CQL2 filter, e.g. "con:height > 100"'); p.add_argument("--sql-filter", help="SELECT id FROM feature WHERE ...")
    args = parser.parse_args()
    if args.cmd == "list":
        return cmd_list(args.file, args.name, args.near, args.limit)
    if args.cmd == "extract":
        return cmd_extract(args.file, args.id, args.out, args.lod, args.origin)
    return cmd_from_3dcitydb(args)


if __name__ == "__main__":
    sys.exit(main())
