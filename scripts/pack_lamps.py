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

Run: python3 scripts/pack_lamps.py [--city lv]   (stdlib only)
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
    for cell, qy, qx, (x, y, mount, t, flags, lumens, aim) in kept:
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
                            ("aim", aim_a, "uint8")):
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
                        arrs["flux"][i] * 10, arrs["aim"][i] * 360 / 256 if k & AIM_KNOWN else None))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--city", default="lv")
    ap.add_argument("--inventory", type=Path)
    ap.add_argument("--types", type=Path, default=ROOT / "data" / "lamp_types.json")
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    inv = args.inventory or ROOT / "data" / "derived" / args.city / "lamps.bin"
    out = args.out or ROOT / "public" / "data" / args.city
    terrain = json.loads((ROOT / "public" / "data" / args.city / "terrain.json").read_text())
    types_json = json.loads(args.types.read_text())
    lamps = read_inventory(inv)
    data, meta = pack(lamps, region_of(terrain), types_json)
    out.mkdir(parents=True, exist_ok=True)
    (out / "lamps-drive.bin").write_bytes(data)
    (out / "lamps-drive.json").write_text(json.dumps(meta, separators=(",", ":")) + "\n")
    gz = len(gzip.compress(data, 9))
    print(f"lamps-drive: {meta['count']} of {len(lamps)} lamps in the drive region ({meta['enclosed']} enclosed), "
          f"{meta['nx']}x{meta['ny']} cells of {CELL} m; {len(data)} bytes, {gz} gzipped")
    return meta


if __name__ == "__main__":
    main()
