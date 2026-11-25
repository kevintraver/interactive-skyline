"""Corridor cell writer and reader, the Python twin of src/drive/corridor/format.js.

The specification is the comment at the top of format.js. encode_cell() gives the bytes that
decodeCell() reads, and decode_cell() reads what encodeCell() writes; tests/python/test_corridor.py
and tests/unit/corridor/format.test.js hold the two to one fixture (tests/fixtures/corridor/).

    blob = encode_cell({"origin": (x, y), "wide": False, "buildings": [b, ...]})
    # b: {"rings": [outer, hole, ...] (each a list of (x, y) map metres, open), "height": m,
    #     "type": code, "rung": code}
    cell = decode_cell(blob)   # the same shape back, coordinates rounded to the format's unit
"""
import struct

import numpy as np

MAGIC = b"CRD1"
VERSION = 1
HEADER_BYTES = 32
FLAG_WIDE = 1  # points are int32 centimetres (else int16 decimetres)

# building types: the `building` tag sorted into what the mesher and the height guess need
TYPES = ("other", "house", "apartments", "retail", "warehouse", "hotel", "office", "civic", "canopy", "shed")
TYPE = {name: i for i, name in enumerate(TYPES)}
# where a height came from, in order of trust
RUNGS = ("osm-height", "osm-levels", "overture", "guess")
RUNG = {name: i for i, name in enumerate(RUNGS)}


class CorridorFormatError(ValueError):
    pass


def _pad4(out):
    out += b"\0" * (-len(out) % 4)


def round_away(v):
    """Half away from zero, as Math.sign(v) * Math.floor(Math.abs(v) + 0.5) in format.js."""
    a = np.floor(np.abs(v) + 0.5)
    return np.where(v < 0, -a, a)


def encode_cell(cell):
    """Bytes of one cell. Rings are written as given; the writer orients them beforehand."""
    ox, oy = (int(v) for v in cell["origin"])
    wide = bool(cell.get("wide"))
    unit = 100.0 if wide else 10.0
    lim = 2**31 - 1 if wide else 32767
    bs = cell["buildings"]
    ring_points, ring_count, pts = [], [], []
    for b in bs:
        if not 1 <= len(b["rings"]) <= 255:
            raise CorridorFormatError(f"a building needs 1 to 255 rings, not {len(b['rings'])}")
        ring_count.append(len(b["rings"]))
        for r in b["rings"]:
            if not 3 <= len(r) <= 65535:
                raise CorridorFormatError(f"a ring needs 3 to 65535 points, not {len(r)}")
            ring_points.append(len(r))
            pts.extend(r)
    p = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    q = round_away((p - (ox, oy)) * unit)
    if q.size and np.abs(q).max() > lim:
        raise CorridorFormatError(f"a point is {np.abs(q).max() / unit:.0f} m from the cell origin, more than the format holds")
    h = round_away(np.asarray([b["height"] for b in bs], dtype=np.float64) * 10)
    if h.size and (h.min() < 0 or h.max() > 65535):
        raise CorridorFormatError("a height is outside 0..6553.5 m")
    out = bytearray(struct.pack("<4sHHiiIIII", MAGIC, VERSION, FLAG_WIDE if wide else 0, ox, oy,
                                len(bs), len(ring_points), len(p), 0))
    out += q.astype("<i4" if wide else "<i2").tobytes(); _pad4(out)
    out += np.asarray(ring_points, dtype="<u2").tobytes(); _pad4(out)
    out += h.astype("<u2").tobytes(); _pad4(out)
    out += np.asarray(ring_count, dtype="u1").tobytes()
    out += np.asarray([b["type"] for b in bs], dtype="u1").tobytes()
    out += np.asarray([b["rung"] for b in bs], dtype="u1").tobytes(); _pad4(out)
    return bytes(out)


def decode_cell(blob):
    if len(blob) < HEADER_BYTES or blob[:4] != MAGIC:
        raise CorridorFormatError("not a corridor cell")
    _, version, flags, ox, oy, nb, nr, npts, _ = struct.unpack_from("<4sHHiiIIII", blob)
    if version != VERSION:
        raise CorridorFormatError(f"version {version} is not supported")
    wide = bool(flags & FLAG_WIDE)
    unit = 100.0 if wide else 10.0
    p4 = lambda n: n + (-n % 4)  # noqa: E731
    if HEADER_BYTES + p4(2 * npts * (4 if wide else 2)) + p4(2 * nr) + p4(2 * nb) + p4(3 * nb) != len(blob):
        raise CorridorFormatError("the counts do not match the length")
    off = HEADER_BYTES

    def take(dtype, n):
        nonlocal off
        a = np.frombuffer(blob, dtype=dtype, count=n, offset=off)
        off += a.nbytes
        off += -off % 4 if dtype != "u1" else 0
        return a

    pts = take("<i4" if wide else "<i2", 2 * npts).reshape(-1, 2) / unit + (ox, oy)
    ring_points = take("<u2", nr)
    heights = take("<u2", nb) / 10
    ring_count = np.frombuffer(blob, dtype="u1", count=nb, offset=off); off += nb
    types = np.frombuffer(blob, dtype="u1", count=nb, offset=off); off += nb
    rungs = np.frombuffer(blob, dtype="u1", count=nb, offset=off); off += nb
    if off + (-off % 4) != len(blob) or ring_count.sum() != nr or ring_points.sum() != npts:
        raise CorridorFormatError("the counts do not match the length")
    bs, ri, pi = [], 0, 0
    for k in range(nb):
        rings = []
        for _ in range(ring_count[k]):
            n = int(ring_points[ri]); ri += 1
            rings.append([tuple(v) for v in pts[pi:pi + n].tolist()]); pi += n
        bs.append({"rings": rings, "height": float(heights[k]), "type": int(types[k]), "rung": int(rungs[k])})
    return {"origin": (ox, oy), "wide": wide, "buildings": bs}
