"""Barriers v1 writer, the Python twin of src/drive/roadside/barrierFormat.js.

The specification is the comment at the top of barrierFormat.js. encode_barriers() must give the
same text as encodeBarriers() for the same input; tests/data/test_barriers.py and
tests/unit/roadside/barrierFormat.test.js hold the two together through a shared fixture.

    text = encode_barriers({"source": {...}, "roads": [{"id": ..., "runs": [run, ...], "delineators": [...]}]})
    # run: {"s0", "s1", "side", "type", "o0", "o1", "prov", "open0", "open1"} (+ "h", "z0", "z1" for walls)
    # delineator: {"side", "colour", "o", "s": [...]}
"""
import json
import math

TYPES = ("concrete", "guardrail", "wall", "cable")
SIDES = ("left", "right")
PROVENANCE = ("mapped", "rule")
COLOURS = ("white", "yellow")


def num(v, k):
    """Round half away from zero to k decimals, as num() in barrierFormat.js; integral values as int."""
    f = 10 ** k
    r = math.copysign(math.floor(abs(v) * f + 0.5), v) / f
    if r == 0:
        return 0
    return int(r) if r == int(r) else r


def encode_barriers(data):
    types = list(data.get("types") or TYPES)
    roads = []
    for r in data["roads"]:
        runs = []
        for x in r.get("runs", []):
            a = [num(x["s0"], 1), num(x["s1"], 1), SIDES.index(x["side"]), types.index(x["type"]), num(x["o0"], 2),
                 num(x["o1"], 2), PROVENANCE.index(x["prov"]), (1 if x.get("open0") else 0) | (2 if x.get("open1") else 0)]
            if x["type"] == "wall":
                a += [num(x["h"], 1), num(x["z0"], 2), num(x["z1"], 2)]
            runs.append(a)
        dels = [[SIDES.index(d["side"]), COLOURS.index(d["colour"]), num(d["o"], 2), [num(v, 1) for v in d["s"]]]
                for d in r.get("delineators", [])]
        out = {"id": r["id"]}
        out.update({k: v for k, v in r.items() if k not in ("id", "runs", "delineators")})
        out["runs"] = runs
        out["delineators"] = dels
        roads.append(out)
    doc = {"version": 1, "source": data.get("source", {}), "types": types}
    doc.update({k: v for k, v in data.items() if k not in ("version", "source", "types", "roads")})
    doc["roads"] = roads
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False) + "\n"


def decode_barriers(text_or_doc):
    """The file back as the dicts encode_barriers takes (for tests and the report)."""
    doc = json.loads(text_or_doc) if isinstance(text_or_doc, str) else text_or_doc
    if doc.get("version") != 1:
        raise ValueError(f"barriers: version {doc.get('version')} is not supported")
    types = doc["types"]
    roads = []
    for r in doc["roads"]:
        runs = []
        for a in r.get("runs", []):
            x = {"s0": a[0], "s1": a[1], "side": SIDES[a[2]], "type": types[a[3]], "o0": a[4], "o1": a[5],
                 "prov": PROVENANCE[a[6]], "open0": bool(a[7] & 1), "open1": bool(a[7] & 2)}
            if len(a) == 11:
                x.update({"h": a[8], "z0": a[9], "z1": a[10]})
            runs.append(x)
        dels = [{"side": SIDES[d[0]], "colour": COLOURS[d[1]], "o": d[2], "s": list(d[3])} for d in r.get("delineators", [])]
        rest = {k: v for k, v in r.items() if k not in ("id", "runs", "delineators")}
        roads.append({"id": r["id"], **rest, "runs": runs, "delineators": dels})
    rest = {k: v for k, v in doc.items() if k not in ("version", "source", "types", "roads")}
    return {"version": 1, "source": doc.get("source", {}), "types": types, **rest, "roads": roads}
