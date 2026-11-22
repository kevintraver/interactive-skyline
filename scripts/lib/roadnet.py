"""RoadNet v1 writer and reader, the Python twin of src/drive/roadnet/format.js.

The specification is the comment at the top of format.js. encode_roadnet() must give the same
bytes as encodeRoadNet() for the same input, and the same JSON document; tests/data and
tests/unit/roadnet-parity.test.js hold the two together.

    doc, blob = encode_roadnet({"source": {...}, "roads": [road, ...]})
    # road: its JSON fields plus x, y, h, heading, curvature, crossfall (SI, one per station)
"""
import math

import numpy as np

RECORD_INTS = 7
RECORD_BYTES = RECORD_INTS * 4
DEFAULT_SPACING = 4
SCALE = (1e3, 1e3, 1e3, 1e3, 1e6, 1e9, 1e6)  # integer units per SI unit, per field
FIELDS = ("s", "x", "y", "h", "heading", "curvature", "crossfall")
RUNTIME_KEYS = {"spacing", "count", "length", "x", "y", "h", "heading", "curvature", "crossfall", "s"}


class RoadNetError(ValueError):
    pass


def round_away(v):
    """Round half away from zero, as the specification asks (same as JS roundAway)."""
    return int(math.copysign(math.floor(abs(v) + 0.5), v))


def wrap_angle(a):
    """Into (-pi, pi], the same float operations as wrapAngle in format.js (JS % is fmod)."""
    t = 2 * math.pi
    a = math.fmod(math.fmod(a + math.pi, t) + t, t) - math.pi
    return math.pi if a == -math.pi else a


def encode_roadnet(roadnet):
    """Returns (doc, blob): roadnet.json as a dict and roadnet.bin as bytes, as encodeRoadNet does."""
    roads = roadnet.get("roads")
    if not roads:
        raise RoadNetError("no roads to encode")
    out = bytearray()
    offset = 0
    out_roads = []
    for r in roads:
        count = len(r["x"])
        if count < 2:
            raise RoadNetError(f"road {r.get('id')} needs at least two stations")
        spacing = r.get("spacing", (r.get("stations") or {}).get("spacing", DEFAULT_SPACING))
        spacing_mm = round_away(spacing * 1000)
        cols = [r[k] for k in FIELDS[1:]]
        for k, c in enumerate(cols, 1):
            if len(c) != count:
                raise RoadNetError(f"road {r.get('id')} field {k} has the wrong length")
        ints = np.empty((count, RECORD_INTS), dtype="<i4")
        for i in range(count):
            ints[i, 0] = i * spacing_mm
            for k in range(1, RECORD_INTS):
                v = float(cols[k - 1][i])
                if k == 4:
                    v = wrap_angle(v)
                if not math.isfinite(v):
                    raise RoadNetError(f"road {r.get('id')} station {i} field {k} is not a finite number")
                ints[i, k] = round_away(v * SCALE[k])
        out += ints.tobytes()
        doc = {k: v for k, v in r.items() if k not in RUNTIME_KEYS}
        doc["stations"] = {**(r.get("stations") or {}), "offset": offset, "count": count, "spacing": spacing}
        offset += count
        out_roads.append(doc)
    doc = {**roadnet, "version": 1, "source": roadnet.get("source", {}), "roads": out_roads}
    return doc, bytes(out)


def decode_roadnet(doc, blob):
    """Station arrays of every road, with the checks of decodeRoadNet that concern the bin.
    Returns a list of dicts: the road's JSON plus spacing, count, length and float arrays."""
    if doc.get("version") != 1:
        raise RoadNetError(f"version {doc.get('version')} is not supported")
    if len(blob) % RECORD_BYTES:
        raise RoadNetError("bin length is not a multiple of 28")
    allints = np.frombuffer(blob, dtype="<i4").reshape(-1, RECORD_INTS)
    roads = []
    for r in doc["roads"]:
        st = r["stations"]
        off, count, spacing = st["offset"], st["count"], st.get("spacing", DEFAULT_SPACING)
        if off + count > len(allints):
            raise RoadNetError(f"road {r['id']} runs past the end of the bin")
        ints = allints[off:off + count].astype(np.int64)
        if not np.array_equal(ints[:, 0], np.arange(count) * round_away(spacing * 1000)):
            raise RoadNetError(f"road {r['id']} stations are not uniform")
        f = {name: ints[:, k] / SCALE[k] for k, name in enumerate(FIELDS)}
        chord = np.hypot(np.diff(f["x"]), np.diff(f["y"]))
        if np.any(np.abs(chord - spacing) > 0.005 * spacing + 0.002):
            raise RoadNetError(f"road {r['id']} has stations not {spacing} m apart in plan")
        roads.append({**r, **f, "spacing": spacing, "count": count, "length": (count - 1) * spacing})
    return roads
