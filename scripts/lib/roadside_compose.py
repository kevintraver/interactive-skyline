"""Turn placed sign candidates into the records of signs.json: panel sizes, letter heights,
colours, lateral offsets and mounting heights (MUTCD and plan 02 section 7.4), and the exit
table their legends come from.
"""
from .roadside_legend import denied, expand, parse_ref
from .roadside_rules import action_text, miles_text
from .roadside_panels import (CAP_INTERMEDIATE, CAP_MAJOR, GORE_CAP, MILE_NUM, ROUTE_SIZE, SPEED_NUM, SPEED_SIZE,
                              gore_size, guide_size, metres, mile_size, tab_size)

FT = 0.3048
# lateral clearance from the outer shoulder edge to the panel's near edge, metres (section 7.4:
# at least 6 ft outside the shoulder, 30 ft or more preferred for large signs where there is room)
OFFSET = {"advance": 6.0, "exit": 6.0, "sequence": 6.0, "gore": 3.0, "speed": 3.0, "route": 3.0, "mile": 2.0}
MIN_OFFSET = 6 * FT
# bottom of the panel above the pavement edge, metres (at least 7 ft for ground-mounted signs; MUTCD
# 2H.10 lets reference location signs stand lower, at least 4 ft)
MOUNT = {"advance": 2.2, "exit": 2.2, "sequence": 2.2, "gore": 2.2, "speed": 2.2, "route": 2.2, "mile": 1.4}
MIN_MOUNT = {"mile": 4 * FT}
COLOURS = {"advance": ("green", "white"), "exit": ("green", "white"), "sequence": ("green", "white"),
           "gore": ("green", "white"), "mile": ("green", "white"), "speed": ("white", "black"),
           "route": ("white", "black")}
GUIDE = ("advance", "exit", "sequence", "gore")


def exit_entry(e):
    """The exit table entry: legend, exit number plaque and provenance, shared by its signs."""
    leg = e["legend"]
    tab = None
    number = leg["exit"]
    left = e["side"] == "left"
    if number or left:
        text = f"EXIT {number}" if number else "EXIT"
        w, h = tab_size(text, left)
        tab = {"text": text, "left": left, "w": metres(w), "h": metres(h)}
    return {
        "osm": e["osm"], "s": e["s"], "side": e["side"], "number": number, "lines": leg["lines"],
        "shields": leg["shields"], "major": e["major"], "tab": tab, "src": leg["src"],
        **({"truncated": leg["truncated"]} if leg["truncated"] else {}),
    }


def size_of(c, entry):
    """(w, h, cap) in metres for a candidate."""
    k = c["kind"]
    if k in ("advance", "exit", "sequence"):
        cap = CAP_MAJOR if entry["major"] else CAP_INTERMEDIATE
        sign = {"lines": entry["lines"], "shields": entry["shields"]}
        if k == "advance":
            sign["action"] = c["action"]
        elif k == "exit":
            sign["arrow"] = True
        else:
            cap = CAP_INTERMEDIATE
            sign = {"rows": c["rows"]}
        w, h = guide_size(sign, cap)
        return metres(w), metres(h), metres(cap)
    if k == "gore":
        w, h = gore_size(entry["number"])
        return metres(w), metres(h), metres(GORE_CAP)
    if k == "speed":
        return metres(SPEED_SIZE[0]), metres(SPEED_SIZE[1]), metres(SPEED_NUM)
    if k == "route":
        return metres(ROUTE_SIZE[0]), metres(ROUTE_SIZE[1]), metres(ROUTE_SIZE[0] * 0.5)
    w, h = mile_size(c["mile"])
    return metres(w), metres(h), metres(MILE_NUM)


def record(c, exits_index, entries, route_ref):
    """One signs.json record for a placed candidate."""
    k = c["kind"]
    xi = exits_index.get(c.get("exit_osm"))
    entry = entries[xi] if xi is not None else None
    if k == "advance":
        c = {**c, "action": action_text(c["miles"])}
    if k == "sequence":  # distances from where the sign ended up
        c = {**c, "rows": [{"exit": x["exit"], "text": x["text"], "dist": miles_text(x["s_exit"] - c["s"])} for x in c["rows"]]}
    w, h, cap = size_of(c, entry)
    bg, fg = COLOURS[k]
    r = {"kind": k, "s": c["s"], "side": c["side"], "offset": OFFSET[k], "mount": MOUNT[k],
         "w": w, "h": h, "cap": cap, "bg": bg, "fg": fg}
    if k in GUIDE:
        r["exit"] = xi
        r["prov"] = "osm"
        if k == "advance":
            r["action"] = c["action"]
        if k in ("exit", "gore"):
            r["arrow"] = c["side"]
        if k == "sequence":
            r["rows"] = c["rows"]
    elif k == "speed":
        r["mph"] = c["mph"]
        r["prov"] = "osm"  # the number is OSM's maxspeed; the position is a rule
    elif k == "route":
        ref = parse_ref(route_ref) or {"net": "", "num": route_ref}
        r["route"] = {"net": ref["net"], "num": ref["num"]}
        r["dir"] = c["direction"].upper()
        r["prov"] = "osm"
    else:
        r["mile"] = c["mile"]
        r["prov"] = "rule"
    return r


def legend_texts(r, entries):
    """Every piece of text a record puts on its face, for the deny-list scan."""
    out = []
    if r.get("exit") is not None:
        e = entries[r["exit"]]
        out += e["lines"] + [f'{s["net"]} {s["num"]} {s["dir"]}' for s in e["shields"]]
        if e["tab"]:
            out.append(e["tab"]["text"])
    out += [x["text"] for x in r.get("rows", [])]
    out += [r[k] for k in ("action", "dir") if r.get(k)]
    return out


def check_legend(entry, link_tags, node_tags, deny):
    """Problems with an exit's legend against its OSM tags (empty when it equals them)."""
    tags = {}
    for t in link_tags:
        for k, v in t.items():
            tags.setdefault(k, v)
    bad = []
    dests = [d.strip() for d in (tags.get("destination") or "").split(";") if d.strip()]
    clean = [d for d in dests if not denied(d, deny)]
    if entry["src"].get("lines") == "osm:destination":
        street = tags.get("destination:street")
        allowed = clean + ([street] if street and len(clean) < len(dests) else [])
        want = allowed[:len(entry["lines"])]
        if [expand(x) for x in entry["lines"]] != want:
            bad.append(f"lines {entry['lines']} != destination {want}")
    refs = [parse_ref(x) for x in (tags.get("destination:ref") or "").split(";") if x.strip()]
    if [s for s in entry["shields"]] != [r for r in refs if r][:len(entry["shields"])]:
        bad.append(f"shields {entry['shields']} != destination:ref {tags.get('destination:ref')}")
    number = node_tags.get("ref") or tags.get("junction:ref") or ""
    if number and entry["number"] != number:
        bad.append(f"exit number {entry['number']} != {number}")
    return bad
