#!/usr/bin/env python3
"""Pack the street-lamp inventory into the drive's served lamp product (plan 02, D5.4).

Input (build inputs, not served):
  data/derived/<city>/lamps.bin   16-byte records (layout in lamps.json beside it; D5.3 / plan 01 T4.0)
  data/lamp_types.json            the lamp types, embedded in the output JSON
  public/data/<city>/terrain.json the drive region: the wide grid's extent (lamps outside it have no ground)

Output (served):
  public/data/<city>/lamps-drive.bin   arrays below, little-endian, each starting on a 4-byte boundary
  public/data/<city>/lamps-drive.json  where each array sits, the cell grid, the quantisation and the types

Layout. Lamps are sorted into square cells of CELL metres (row-major from the south-west corner of the
grid), and within a cell by y then x. The arrays are stored one after another (structure of arrays: it
compresses better than records):
  cellStart  uint32[nx * ny + 1]  lamps of cell c are cellStart[c] .. cellStart[c + 1] - 1
  qx, qy     uint16[n]            position in the cell, metres x Q (x east, y north, from the cell's corner)
  mount      uint8[n]             mounting height, metres x MOUNT_Q
  kind       uint8[n]             bits 0-2 type id, bit 3 enclosed (under a bridge or in a tunnel: pools only,
                                  no sprite), bit 4 placed by rule, bit 5 aim known
  flux       uint16[n]            initial lumens / 10 (as the inventory)
  aim        uint8[n]             arm direction, degrees counter-clockwise from +x, x 256 / 360 (when known)
  lift       uint8[n]             height of the structure the pole stands on above the ground, metres x MOUNT_Q
                                  (a crossing road's deck; 0 on the ground). mount is above that structure.

Off the pavement. Inventory points for median and bridge-mounted lamps fall on the modelled pavement, and the
drive's poles (src/drive/lights/poles.js) stood in the carriageway there. So before packing, every lamp whose pole
(the head an arm's length back against the aim, as poles.js draws it) stands on any modelled road's pavement
(lanes and shoulders, all routes' RoadNets) is moved: the pole goes to the nearest pavement edge plus CLEAR_M,
on the median or the outside, whichever is nearer (and the other side if that is pavement too), and the arm turns
to reach toward where the head was, so the light stays aimed where it was. A pole on a crossing road's deck goes to
the deck's edge (its parapet) and takes the deck's height: `lift`. Enclosed lamps (pools only, no pole) stay.

Run: python3 scripts/pack_lamps.py [--city lv] [--no-clear]   (the clearing needs numpy and scipy; a given
     --inventory is packed as it is, stdlib only)
"""
from __future__ import annotations

import argparse
import gzip
import json
import struct
import sys
from array import array
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION = 1
CELL = 1024  # metres: about 1 km, and a power of two so cell-local positions quantise exactly
Q = 64  # positions in 1/64 m inside a cell (uint16 covers 1024 m)
MOUNT_Q = 8  # mounting height in 1/8 m (uint8 covers 31.9 m; the tallest masts are 30.5 m)
ENCLOSED, RULE, AIM_KNOWN = 1 << 3, 1 << 4, 1 << 5
ARM_M, MAST_ARM_M = 2.4, 0.6  # as poles.js: the arm, and a high mast's short bracket
HIGHMAST_TYPE_KEY = "led_highmast"
CLEAR_M = 1.0  # a moved pole stands this far off the pavement edge
PARAPET_M = 0.2  # a pole on a deck stands this far out from the deck's pavement edge, on its parapet
NEAR_M = 45.0  # farther than this from every reference line, a point is on no pavement (the widest half is ~35 m)
POLE_ROAD_M = 300.0  # poles.js: no pole beyond this from a road (and an unknown aim points at the nearest one)
RECORD = struct.Struct("<iiHBBHH")


def read_inventory(path: Path):
    """The inventory's records as tuples (x_m, y_m, mount_m, type, flags, lumens, aim_deg or None)."""
    b = path.read_bytes()
    if len(b) % RECORD.size:
        raise ValueError(f"{path}: {len(b)} bytes is not a whole number of {RECORD.size}-byte records")
    out = []
    for x, y, mount, t, flags, flux, aim in RECORD.iter_unpack(b):
        out.append((x / 1000, y / 1000, mount / 10, t, flags, flux * 10, None if aim == 0xFFFF else aim / 100))
    return out


def region_of(terrain_json: dict):
    """[x0, y0, x1, y1] of the coarsest grid: the ground the drive draws."""
    grids = terrain_json["grids"]
    g = grids.get("wide") or grids["far"]
    return g["x0"], g["y0"], g["x0"] + (g["nx"] - 1) * g["step"], g["y0"] + (g["ny"] - 1) * g["step"]


def pack(lamps, region, types_json):
    """Encode lamps (tuples as read_inventory gives) inside region. Returns (bin bytes, meta dict)."""
    rx0, ry0, rx1, ry1 = region
    gx0 = (rx0 // CELL) * CELL
    gy0 = (ry0 // CELL) * CELL
    nx = int(-(-(rx1 - gx0) // CELL))
    ny = int(-(-(ry1 - gy0) // CELL))
    kept = []
    for lamp in lamps:
        x, y = lamp[0], lamp[1]
        if not (rx0 <= x < rx1 and ry0 <= y < ry1):
            continue
        cx, cy = int((x - gx0) // CELL), int((y - gy0) // CELL)
        qx = min(CELL * Q - 1, round((x - gx0 - cx * CELL) * Q))
        qy = min(CELL * Q - 1, round((y - gy0 - cy * CELL) * Q))
        kept.append((cy * nx + cx, qy, qx, lamp))
    kept.sort(key=lambda k: (k[0], k[1], k[2]))

    n = len(kept)
    start = array("I", [0]) * (nx * ny + 1)
    qx_a, qy_a = array("H"), array("H")
    mount_a, kind_a, aim_a = array("B"), array("B"), array("B")
    flux_a = array("H")
    lift_a = array("B")
    for cell, qy, qx, lamp in kept:
        x, y, mount, t, flags, lumens, aim = lamp[:7]
        lift = lamp[7] if len(lamp) > 7 else 0.0
        lift_a.append(max(0, min(255, round(lift * MOUNT_Q))))
        start[cell + 1] += 1
        qx_a.append(qx)
        qy_a.append(qy)
        mount_a.append(max(1, min(255, round(mount * MOUNT_Q))))
        kind = (t & 7) | (ENCLOSED if flags & 0x10 else 0) | (RULE if flags & 1 else 0) | (AIM_KNOWN if aim is not None else 0)
        kind_a.append(kind)
        flux_a.append(max(0, min(0xFFFF, round(lumens / 10))))
        aim_a.append(0 if aim is None else round((aim % 360) * 256 / 360) % 256)
    for c in range(nx * ny):
        start[c + 1] += start[c]

    parts, arrays, offset = [], [], 0
    for name, arr, kind in (("cellStart", start, "uint32"), ("qx", qx_a, "uint16"), ("qy", qy_a, "uint16"),
                            ("mount", mount_a, "uint8"), ("kind", kind_a, "uint8"), ("flux", flux_a, "uint16"),
                            ("aim", aim_a, "uint8"), ("lift", lift_a, "uint8")):
        if sys.byteorder != "little":
            arr = array(arr.typecode, arr)
            arr.byteswap()
        b = arr.tobytes()
        pad = (-len(b)) % 4
        arrays.append({"name": name, "type": kind, "offset": offset, "length": len(arr)})
        parts.append(b + b"\0" * pad)
        offset += len(b) + pad
    meta = {
        "version": VERSION,
        "file": "lamps-drive.bin",
        "count": n,
        "enclosed": sum(1 for k in kind_a if k & ENCLOSED),
        "cell": CELL,
        "x0": gx0, "y0": gy0, "nx": nx, "ny": ny,
        "region": [rx0, ry0, rx1, ry1],
        "q": Q, "mountQ": MOUNT_Q,
        "bits": {"type": 7, "enclosed": ENCLOSED, "rule": RULE, "aimKnown": AIM_KNOWN},
        "arrays": arrays,
        "bytes": offset,
        "note": "Positions are local metres (x east, y north) of public/data/<city>/terrain.json's frame: "
                "x = x0 + (c % nx) * cell + qx / q, y = y0 + floor(c / nx) * cell + qy / q. Built by scripts/pack_lamps.py.",
        "lampTypes": types_json,
    }
    return b"".join(parts), meta


def decode(bin_bytes: bytes, meta: dict):
    """The inverse of pack(), for tests: tuples (x, y, mount, type, kind, lumens, aim_deg or None)."""
    arrs = {}
    for a in meta["arrays"]:
        code = {"uint32": "I", "uint16": "H", "uint8": "B"}[a["type"]]
        arr = array(code)
        size = arr.itemsize * a["length"]
        arr.frombytes(bin_bytes[a["offset"]:a["offset"] + size])
        if sys.byteorder != "little":
            arr.byteswap()
        arrs[a["name"]] = arr
    out = []
    nx, cell, q = meta["nx"], meta["cell"], meta["q"]
    start = arrs["cellStart"]
    for c in range(len(start) - 1):
        ox, oy = meta["x0"] + (c % nx) * cell, meta["y0"] + (c // nx) * cell
        for i in range(start[c], start[c + 1]):
            k = arrs["kind"][i]
            out.append((ox + arrs["qx"][i] / q, oy + arrs["qy"][i] / q, arrs["mount"][i] / meta["mountQ"], k & 7, k,
                        arrs["flux"][i] * 10, arrs["aim"][i] * 360 / 256 if k & AIM_KNOWN else None,
                        arrs["lift"][i] / meta["mountQ"] if "lift" in arrs else 0.0))
    return out


def pavement_model(roads):
    """Every station of every road (decoded RoadNet roads, lib.roadnet) with its pavement edges, for clear_pavement."""
    import numpy as np
    from scipy.spatial import cKDTree
    from lib.crosssection import normalise_sections, pavement_edges
    cols = {k: [] for k in ("x", "y", "heading", "left", "right", "h", "crossfall", "deck", "road", "spacing")}
    for k, r in enumerate(roads):
        s = np.asarray(r["s"], dtype=float)
        left, right = pavement_edges(normalise_sections(r["sections"]), s)
        deck = np.zeros(len(s), dtype=bool)
        for b in r.get("bridges", []):
            if b.get("deck"):
                deck |= (s >= b["s0"]) & (s <= b["s1"])
        for name, v in (("x", r["x"]), ("y", r["y"]), ("heading", r["heading"]), ("left", left), ("right", right),
                        ("h", r["h"]), ("crossfall", r["crossfall"]), ("deck", deck)):
            cols[name].append(np.asarray(v))
        cols["road"].append(np.full(len(s), k))
        cols["spacing"].append(np.full(len(s), r["spacing"]))
    m = {k: np.concatenate(v) for k, v in cols.items()}
    m["tree"] = cKDTree(np.c_[m["x"], m["y"]])
    return m


def on_pavement(model, x, y, decks=None, radius=60.0):
    """Where (x, y) lies on a road's pavement: [(station, along, lateral)] nearest station per road, for the roads
    whose pavement holds it. decks: None any, True only deck spans, False only the rest."""
    import math
    out, seen = [], set()
    for i in sorted(model["tree"].query_ball_point((x, y), radius), key=lambda i: (model["x"][i] - x) ** 2 + (model["y"][i] - y) ** 2):
        road = int(model["road"][i])
        if road in seen:
            continue
        seen.add(road)
        if decks is not None and bool(model["deck"][i]) != decks:
            continue
        c, sn = math.cos(model["heading"][i]), math.sin(model["heading"][i])
        dx, dy = x - model["x"][i], y - model["y"][i]
        along, lat = dx * c + dy * sn, -dx * sn + dy * c
        if abs(along) > 0.75 * model["spacing"][i]:
            continue  # past the road's end
        if model["right"][i] - 1e-6 <= lat <= model["left"][i] + 1e-6:
            out.append((i, along, lat))
    return out


def _at(model, i, along, lat):
    import math
    c, sn = math.cos(model["heading"][i]), math.sin(model["heading"][i])
    return model["x"][i] + along * c - lat * sn, model["y"][i] + along * sn + lat * c


def pole_foot(lamp, model, mast_type=None):
    """Where poles.js stands lamp's pole (map metres), and the arm's length; None when it draws no pole."""
    import math
    x, y, mount, t, flags, lumens, aim = lamp[:7]
    if flags & 0x10:
        return None  # enclosed: pools only
    arm = MAST_ARM_M if t == mast_type else ARM_M
    if aim is not None:
        a = math.radians(aim)
    else:
        d, i = model["tree"].query((x, y), distance_upper_bound=POLE_ROAD_M)
        if not math.isfinite(d):
            return None
        a = math.atan2(model["y"][i] - y, model["x"][i] - x)
    return x - arm * math.cos(a), y - arm * math.sin(a), arm


def clear_pavement(lamps, model, ground=None, mast_type=None):
    """The lamps with every pole off the pavement (see the header). ground(x, y): terrain height, for a deck's lift.
    Returns (lamps, report) where report counts the moved and those put on decks."""
    import math
    out, moved, decked, examples = [], 0, 0, []
    for lamp in lamps:
        foot = pole_foot(lamp, model, mast_type)
        if foot is None:
            out.append(lamp)
            continue
        fx, fy, arm = foot
        if model["tree"].query((fx, fy))[0] > NEAR_M:
            out.append(lamp)  # nowhere near a modelled road
            continue
        hx, hy = lamp[0], lamp[1]
        lift = 0.0
        hits = on_pavement(model, fx, fy, decks=True) or None
        if hits:
            # on a crossing road's deck: to its nearer edge, on the parapet, at the deck's height
            i, along, lat = hits[0]
            d = model["left"][i] + PARAPET_M if model["left"][i] - lat < lat - model["right"][i] else model["right"][i] - PARAPET_M
            nx, ny = _at(model, i, along, d)
            deck_h = model["h"][i] + model["crossfall"][i] * d
            if ground is not None:
                lift = max(0.0, float(deck_h - ground(nx, ny)))
            decked += 1
        else:
            hits = on_pavement(model, fx, fy, decks=False)
            if not hits:
                out.append(lamp)
                continue
            nx, ny = fx, fy
            for _ in range(4):  # off this road's pavement; if that lands on another's, off that one too
                i, along, lat = hits[0]
                l, r = model["left"][i] + CLEAR_M, model["right"][i] - CLEAR_M
                best = None
                for d in sorted((l, r), key=lambda d: abs(d - lat)):
                    px, py = _at(model, i, along, d)
                    if not on_pavement(model, px, py, decks=False):
                        best = (px, py)
                        break
                if best is None:
                    d = min((l, r), key=lambda d: abs(d - lat))
                    nx, ny = _at(model, i, along, d)
                    hits = on_pavement(model, nx, ny, decks=False)
                    if not hits:
                        break
                else:
                    nx, ny = best
                    break
        moved += 1
        # the arm reaches toward where the head was, so the light stays aimed where it was
        a = math.atan2(hy - ny, hx - nx) if math.hypot(hy - ny, hx - nx) > 0.3 else (math.radians(lamp[6]) if lamp[6] is not None else 0.0)
        head = (nx + arm * math.cos(a), ny + arm * math.sin(a))
        new = (round(float(head[0]), 3), round(float(head[1]), 3), lamp[2], lamp[3], lamp[4], lamp[5], round(math.degrees(a) % 360, 2), round(lift, 3))
        if len(examples) < 5:
            examples.append({"from": [round(float(hx), 1), round(float(hy), 1)], "to": [round(float(head[0]), 1), round(float(head[1]), 1)], "lift": round(lift, 2)})
        out.append(new)
    return out, {"moved": moved, "onDecks": decked, "examples": examples}


def load_roads(city, root=ROOT):
    """Every road of every route's RoadNet (routes.json), each network once."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from lib.roadnet import decode_roadnet
    folder = root / "public" / "data" / city
    nets = {r.get("files", {}).get("roadnet", "roadnet.json") for r in json.loads((folder / "routes.json").read_text())["routes"]}
    roads = []
    for net in sorted(nets):
        roads += decode_roadnet(json.loads((folder / net).read_text()), (folder / (net[:-len(".json")] + ".bin")).read_bytes())
    return roads


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--city", default="lv")
    ap.add_argument("--inventory", type=Path)
    ap.add_argument("--types", type=Path, default=ROOT / "data" / "lamp_types.json")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--no-clear", action="store_true", help="pack the inventory as it is, poles on the pavement and all")
    args = ap.parse_args(argv)
    inv = args.inventory or ROOT / "data" / "derived" / args.city / "lamps.bin"
    out = args.out or ROOT / "public" / "data" / args.city
    terrain = json.loads((ROOT / "public" / "data" / args.city / "terrain.json").read_text())
    types_json = json.loads(args.types.read_text())
    lamps = read_inventory(inv)
    report = None
    if not args.no_clear and not args.inventory:  # another inventory is not this city's: pack it as it is
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from lib.heights import ground_of, load_heights
        heights = load_heights(args.city)
        mast = next((t["id"] for t in types_json.get("types", []) if t.get("key") == HIGHMAST_TYPE_KEY), None)
        lamps, report = clear_pavement(lamps, pavement_model(load_roads(args.city)), ground_of(heights), mast)
    data, meta = pack(lamps, region_of(terrain), types_json)
    if report:
        meta["cleared"] = {"moved": report["moved"], "onDecks": report["onDecks"], "clearM": CLEAR_M}
    out.mkdir(parents=True, exist_ok=True)
    (out / "lamps-drive.bin").write_bytes(data)
    (out / "lamps-drive.json").write_text(json.dumps(meta, separators=(",", ":")) + "\n")
    gz = len(gzip.compress(data, 9))
    print(f"lamps-drive: {meta['count']} of {len(lamps)} lamps in the drive region ({meta['enclosed']} enclosed), "
          f"{meta['nx']}x{meta['ny']} cells of {CELL} m; {len(data)} bytes, {gz} gzipped")
    if report:
        print(f"  off the pavement: {report['moved']} poles moved ({report['onDecks']} onto a deck's edge); e.g. {report['examples'][:3]}")
    return meta


if __name__ == "__main__":
    main()
