# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Usage: build_roadside.py <city> [route]     (route defaults to i15n)

The roadside a driver expects on the freeway, by day (plan 02, D3.6 and D3.7): green guide signs
at every exit (advance signs, exit direction sign, gore sign), overhead on truss structures where
the road has four or more lanes or the exit leaves on the left, speed limits, route confirmation
and mile markers, placed by MUTCD rule along the route's road and lettered from OpenStreetMap's
tags; barriers (concrete median barrier, guardrail, walls) from OSM's `barrier` ways where they
are mapped and fitted rules elsewhere; delineators at MUTCD spacing.

Files by route: route i15n reads roadnet.json and .bin and writes signs.json and barriers.json;
any other route R reads roadnet-R.json and roadnet-R.bin and writes signs-R.json, barriers-R.json
(and its report as roadside_report-R.json). routes.json, or routes-R.json where it exists, gives
the route's road.

Inputs, all local (no network): those roadnet files (from build_roads.py),
data/raw/<city>/osm-<ref>.json and osm-<ref>-barriers.json (from fetch_osm.py), the terrain
grids, and the deny-list data/sign_denylist.txt of trade names no legend may carry (A5).

The script checks its acceptance numbers, writes them to the report and exits non-zero when one
is missed (the outputs are still written, to look at).

Output: public/data/<city>/signs[-R].json, barriers[-R].json, data/derived/<city>/roadside_report[-R].json
"""
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.atomic import write_files  # noqa: E402
from lib.frame import create_frame  # noqa: E402
from lib.heights import load_heights  # noqa: E402
from lib.osm import load_osm  # noqa: E402
from lib.refline import Refline  # noqa: E402
from lib.roadnet import decode_roadnet  # noqa: E402
from lib.roadside_compose import (GUIDE, MIN_MOUNT, MIN_OFFSET, check_legend, exit_entry, legend_texts,  # noqa: E402
                                  record)
from lib.roadside_legend import denied, exit_legend, load_denylist  # noqa: E402
from lib.roadside_place import Median, panel_ground  # noqa: E402
from lib.roadside_rules import (SPACING, exit_candidates, mile_candidates, route_candidates, solve,  # noqa: E402
                                speed_candidates)
from lib import roadside_barriers as barriers  # noqa: E402
from lib.roadside_barrier_format import encode_barriers  # noqa: E402
from lib.roadside_overhead import MIN_CLEAR, MOUNT as OVER_MOUNT, clearance, is_overhead, lanes_at, overhead_place  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DENYLIST = ROOT / "data" / "sign_denylist.txt"
MAX_BYTES = 150_000
MAX_BARRIER_BYTES = 100_000
DEFAULT_ROUTE = "i15n"
# a left-exit sign the median cannot hold: "drop" it (reported as overhead on the real road) or
# stand it on the "right" shoulder with its LEFT plaque
MEDIAN_FALLBACK = "drop"
# section 7.4 and the MUTCD, for the acceptance check: inches of capital letter height per kind
CAP_RANGE = {"advance": (16, 20), "exit": (16, 20), "sequence": (16, 20), "gore": (12, 16), "speed": (16, 24),
             "route": (12, 24), "mile": (6, 12)}
# the sheeting of each face, background then legend, for the night work (ASTM D4956 colours)
SHEETING = {"green": "green", "white": "white", "black": "none", "yellow": "yellow"}
COLOUR_OK = {"advance": ("green", "white"), "exit": ("green", "white"), "sequence": ("green", "white"),
             "gore": ("green", "white"), "mile": ("green", "white"), "speed": ("white", "black"),
             "route": ("white", "black")}


def ramp_tags(osm, nid):
    """Tags of the motorway_link ways that start at a junction node."""
    out = []
    for w in osm.ways.values():
        if w["tags"].get("highway") != "motorway_link":
            continue
        ns = w["nodes"][::-1] if w["tags"].get("oneway") == "-1" else w["nodes"]
        if ns[0] == nid:
            out.append(w["tags"])
    return out


def build_route(rc, route, roads, osm, heights, deny, report, bctx=None):
    road = roads[route["road"]]
    opp = roads.get(route.get("opposite") or "")
    line = Refline(road)
    median = Median(road, line, opp, Refline(opp) if opp else None)
    length = road["length"]
    exits, entries, index, deny_changes, legend_bad = [], [], {}, [], []
    for link in road.get("links", []):
        if link.get("kind") != "exit":
            continue
        nid = int(link["osm"][1:])
        node_tags = osm.nodes[nid][2] if nid in osm.nodes else {}
        tags = ramp_tags(osm, nid)
        leg = exit_legend(link, node_tags, tags, deny)
        major = bool(leg) and any(s["net"] in ("I", "US") for s in leg["shields"])
        e = {"s": link["s"], "side": link["side"], "osm": link["osm"], "legend": leg, "major": major}
        exits.append(e)
        if not leg:
            continue
        for ch in leg["replaced"] + leg["dropped"]:
            deny_changes.append({"exit": leg["exit"] or link["osm"], **ch})
        index[link["osm"]] = len(entries)
        entries.append(exit_entry(e))
        legend_bad += [f'{link["osm"]}: {b}' for b in check_legend(entries[-1], tags, node_tags, deny)]

    ex_c, notes = exit_candidates(exits, length)
    speed = road.get("speed", [])
    cands = ex_c + speed_candidates(speed, exits, length) + route_candidates(exits, length, road.get("dir", "north")) \
        + mile_candidates(length)

    # overhead where the real road has them: four or more lanes, or a left exit (MUTCD 2E.24)
    for c in cands:
        if is_overhead(c["kind"], c["side"], lanes_at(road, c["s_nom"])):
            c["over"] = True
            c["row"] = "over"
    # a sign on the left needs a median wide enough to stand in, clear of the opposite pavement
    moved = []
    for c in cands:
        if c["side"] != "left" or c.get("over"):
            continue
        probe = record({**c, "s": c["s_nom"]}, index, entries, road.get("ref", ""))
        clear = median.clear(c["s_nom"])
        if clear < probe["w"] + 2 * MIN_OFFSET:
            # On the real road these are overhead. A gore sign across the road would point the wrong
            # way, so it is always dropped; the others follow MEDIAN_FALLBACK.
            drop = MEDIAN_FALLBACK == "drop" or c["kind"] == "gore"
            if drop:
                c["drop"] = True
                note = next(n for n in notes if n["osm"] == c["exit_osm"])
                note["omitted"].append({c["kind"]: c.get("miles", True), "why": "median too narrow; overhead on the real road"})
                if c["kind"] == "advance":
                    note["kinds"].remove(f"advance {c['miles']} mi")
                else:
                    note["kinds"].remove("exit direction" if c["kind"] == "exit" else c["kind"])
            else:
                c["side"], c["moved"] = "right", True
            moved.append({"kind": c["kind"], "s": round(c["s_nom"], 1), "exit": c.get("exit_ref") or c.get("exit_osm"),
                          "median_clear_m": round(clear, 1), "needs_m": round(probe["w"] + 2 * MIN_OFFSET, 1),
                          "action": "dropped" if drop else "moved to the right"})

    placed, dropped = solve([c for c in cands if not c.get("drop")])
    records = []
    ground_fixes = []
    structures = []
    for c in placed:
        r = record(c, index, entries, road.get("ref", ""))
        r["sheeting"] = [SHEETING[r["bg"]], SHEETING[r["fg"]]]
        if c.get("moved") is not None:
            r["moved"] = "median"
        if c.get("over") and bctx is not None:
            r["over"] = True
            r["mount"] = OVER_MOUNT
            r["offset"] = 0.0
            r["d"], st = overhead_place(road, bctx["geom"], r, bctx["pavements"],
                                        barriers.median_offset_fn(bctx), barriers.clear_fn(bctx))
            st["signs"] = [len(records)]
            r["structure"] = len(structures)
            structures.append(st)
            records.append(r)
            continue
        if r["side"] == "left":
            clear = median.clear(r["s"])
            r["offset"] = round(max(MIN_OFFSET, min(r["offset"], (clear - r["w"]) / 2)), 2)
        h_edge, g_max = panel_ground(road, line, heights, r["s"], r["side"], r["offset"], r["w"])
        if g_max > h_edge + r["mount"] - 0.3:  # rising ground beside the road: come in, then stand taller
            r["offset"] = round(MIN_OFFSET, 2)
            h_edge, g_max = panel_ground(road, line, heights, r["s"], r["side"], r["offset"], r["w"])
            need = g_max - h_edge + 0.3
            if need > r["mount"]:
                r["mount"] = round(need, 2)
            ground_fixes.append({"kind": r["kind"], "s": r["s"], "offset": r["offset"], "mount": r["mount"]})
        records.append(r)

    # ---- acceptance
    checks = {}
    guide_by_exit = Counter()
    for r in records:
        if r["kind"] in GUIDE:
            guide_by_exit[r["exit"]] += 1
        for row in r.get("rows", []):  # a sequence sign also announces the exits it lists
            for xi, e in enumerate(entries):
                if row["exit"] and e["number"] == row["exit"] and xi != r["exit"]:
                    guide_by_exit[xi] += 1
    numbered = [i for i, e in enumerate(entries) if e["number"]]
    unsigned_numbered = [k["ref"] for k in road.get("links", []) if k.get("ref") and k["osm"] not in index]
    fewer = [{"exit": entries[i]["number"] or entries[i]["osm"], "signs": guide_by_exit[i],
              "why": next((n["omitted"] for n in notes if n["s"] == entries[i]["s"]), [])}
             for i in range(len(entries)) if guide_by_exit[i] < 3]
    checks["exits"] = {"numbered": len(numbered), "with_guide_signs": sum(1 for i in numbered if guide_by_exit[i]),
                       "numbered_without_legend": unsigned_numbered, "fewer_than_three": fewer,
                       "ok": all(guide_by_exit[i] for i in numbered) and not unsigned_numbered}
    texts = [t for r in records for t in legend_texts(r, entries)]
    hits = sorted({f"{t!r}: {h}" for t in texts for h in denied(t, deny)})
    checks["legends"] = {"mismatches": legend_bad, "denylist_hits": hits, "ok": not legend_bad and not hits}
    close = []
    for side in ("left", "right", "over"):
        ss = sorted(r["s"] for r in records if ("over" if r.get("over") else r["side"]) == side)
        close += [(side, a, b) for a, b in zip(ss, ss[1:]) if b - a < SPACING]
    checks["spacing"] = {"min_m": SPACING, "violations": close, "ok": not close}
    bad = []
    for r in records:
        cap_in = r["cap"] / 0.0254
        lo, hi = CAP_RANGE[r["kind"]]
        if not lo - 0.05 <= cap_in <= hi + 0.05:
            bad.append(f'{r["kind"]} at {r["s"]}: letters {cap_in:.1f} in')
        if (r["bg"], r["fg"]) != COLOUR_OK[r["kind"]]:
            bad.append(f'{r["kind"]} at {r["s"]}: colours {r["bg"]}/{r["fg"]}')
        if r.get("over"):
            clr = clearance(road, line, r)
            if clr < MIN_CLEAR - 1e-6:
                bad.append(f'{r["kind"]} at {r["s"]}: overhead clearance {clr:.2f} m')
            continue
        if r["mount"] < MIN_MOUNT.get(r["kind"], 7 * 0.3048) - 1e-6:
            bad.append(f'{r["kind"]} at {r["s"]}: mounted {r["mount"]} m')
        if r["offset"] < MIN_OFFSET - 1e-6:
            bad.append(f'{r["kind"]} at {r["s"]}: offset {r["offset"]} m')
    checks["dimensions"] = {"problems": bad, "ok": not bad}

    overhead = [{"kind": r["kind"], "s": r["s"], "exit": entries[r["exit"]]["number"] or entries[r["exit"]]["osm"],
                 "why": "left exit" if entries[r["exit"]]["side"] == "left" else f"{lanes_at(road, r['s'])} lanes",
                 "structure": structures[r["structure"]]["kind"], "d": r["d"],
                 "clearance_m": round(clearance(road, line, r), 2)}
                for r in records if r.get("over")]
    corridor = [n for n in notes if any("closely" in o.get("why", "") for o in n["omitted"])]
    report[rc["id"]] = {
        "road": road["id"], "length_m": length, "checks": checks,
        "counts": {"by_kind": dict(Counter(r["kind"] for r in records)),
                   "by_provenance": dict(Counter(r["prov"] for r in records)), "total": len(records)},
        "exits": notes,
        "unsigned_exits": [{"osm": e["osm"], "s": e["s"], "why": "no ramp destination, exit number or label in OSM"}
                           for e in exits if not e["legend"]],
        "closely_spaced": [{"exit": n["exit"], "s": n["s"], "kinds": n["kinds"], "omitted": n["omitted"]} for n in corridor],
        "denylist_changes": deny_changes, "median_too_narrow": moved, "dropped_by_spacing": [
            {"kind": d["kind"], "s_nominal": round(d["s_nom"], 1), "side": d["side"]} for d in dropped],
        "ground_fixes": ground_fixes, "overhead": overhead,
        "structures": {"cantilever": sum(1 for s in structures if s["kind"] == "cantilever"),
                       "span": sum(1 for s in structures if s["kind"] == "span")},
        "left_offsets": [{"kind": r["kind"], "s": r["s"], "offset": r["offset"]} for r in records if r["side"] == "left"],
    }
    return {"id": road["id"], "route": rc["id"], "exits": entries, "signs": records, "structures": structures}


def suffix_of(route_id):
    """'' for the default route, '-<route>' for any other (file names)."""
    return "" if route_id == DEFAULT_ROUTE else f"-{route_id}"


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) not in (1, 2):
        sys.exit(__doc__)
    city = args[0]
    route_id = args[1] if len(args) == 2 else DEFAULT_ROUTE
    sfx = suffix_of(route_id)
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    routes_cfg = cfg.get("routes") or sys.exit(f"{city} has no routes in data/cities.json")
    rc = next((r for r in routes_cfg if r["id"] == route_id), None) or sys.exit(f"{city} has no route {route_id} in data/cities.json")
    data = ROOT / "public" / "data" / city
    rn_json, rn_bin = data / f"roadnet{sfx}.json", data / f"roadnet{sfx}.bin"
    for f in (rn_json, rn_bin):
        if not f.exists():
            sys.exit(f"{f.relative_to(ROOT)} is missing: run  uv run scripts/build_roads.py {city} first")
    doc = json.loads(rn_json.read_text())
    roads = {r["id"]: r for r in decode_roadnet(doc, rn_bin.read_bytes())}
    routes_path = data / f"routes{sfx}.json"
    if not routes_path.exists():
        routes_path = data / "routes.json"
    routes = {r["id"]: r for r in json.loads(routes_path.read_text())["routes"]}
    if route_id not in routes:
        sys.exit(f"{routes_path.relative_to(ROOT)} has no route {route_id}")
    route = routes[route_id]
    heights = load_heights(city)
    deny = load_denylist(DENYLIST)
    report = {}
    slug = rc["ref"].lower().replace(" ", "")
    path = ROOT / "data" / "raw" / city / f"osm-{slug}.json"
    bpath = ROOT / "data" / "raw" / city / f"osm-{slug}-barriers.json"
    for f in (path, bpath):
        if not f.exists():
            sys.exit(f"{f.relative_to(ROOT)} is missing: run  uv run scripts/fetch_osm.py {city}")
    osm = load_osm(json.loads(path.read_text()))
    bosm = load_osm(json.loads(bpath.read_text()))

    opp = route.get("opposite") or next((r["id"] for r in roads.values() if r["id"] != route["road"]
                                         and (r.get("role") or "main") == "main" and r.get("ref") == roads[route["road"]].get("ref")), None)
    print(f"{route_id}: barriers along {route['road']} (opposite {opp}) and its ramps")
    b_roads, b_report, bctx = barriers.build(roads, doc.get("junctions", []), [dict(s) for s in doc.get("structures", [])],
                                             route["road"], opp, bosm, create_frame(cfg), heights)
    print(f"{route_id}: placing signs along {route['road']}")
    out_road = build_route(rc, route, roads, osm, heights, deny, report, bctx)

    src = {"osm": osm.timestamp, "osmLicence": "ODbL, (c) OpenStreetMap contributors",
           "method": "scripts/build_roadside.py", "positions": "rule (MUTCD 2B, 2D, 2E, 2H); no public sign inventory",
           "denylist": str(DENYLIST.relative_to(ROOT)),
           "sheeting": "each sign's [background, legend] sheeting in `sheeting`: white, yellow, green, red or none (ASTM D4956)"}
    out = {"version": 1, "source": src, "roads": [out_road]}
    text = json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n"
    signs_path = data / f"signs{sfx}.json"
    size = len(text.encode())
    btext = encode_barriers({"source": {"osm": bosm.timestamp, "osmLicence": "ODbL, (c) OpenStreetMap contributors",
                                        "method": "scripts/build_roadside.py (scripts/lib/roadside_barriers.py)",
                                        "route": route_id},
                             "roads": b_roads})
    barriers_path = data / f"barriers{sfx}.json"
    write_files({signs_path: text, barriers_path: btext})
    bsize = len(btext.encode())
    rep_dir = ROOT / "data" / "derived" / city
    rep_dir.mkdir(parents=True, exist_ok=True)
    report["barriers"] = b_report
    report["files"] = {signs_path.name: size, "limit": MAX_BYTES, barriers_path.name: bsize, "barrier_limit": MAX_BARRIER_BYTES,
                       "ok": size < MAX_BYTES and bsize < MAX_BARRIER_BYTES}
    report["denylist"] = {"file": str(DENYLIST.relative_to(ROOT)), "terms": len(deny)}
    report["sheeting"] = {
        "signs": "signs.json: each record's `sheeting` is [background, legend]; the runtime puts it on the face mesh as vertex "
                 "attributes `retro` (background) and `retroLegend` (legend), codes in src/drive/roadside/sheeting.js",
        "barriers": "road chunks carry a `retro` vertex attribute: reflectors on guardrail and concrete barrier are white (right) or "
                    "yellow (left); everything else 0",
        "delineators": "one InstancedMesh per reflector colour, material names 'delineator white' and 'delineator yellow', each "
                       "with a `retro` instance attribute"}
    rep_path = rep_dir / f"roadside_report{sfx}.json"
    write_files({rep_path: json.dumps(report, indent=1, ensure_ascii=False) + "\n"})

    failures = []
    rr = report[rc["id"]]
    print(f"{route_id}: {rr['counts']['total']} signs {rr['counts']['by_kind']}, structures {rr['structures']}")
    for name, ch in rr["checks"].items():
        print(f"  {'ok  ' if ch['ok'] else 'MISS'} {name}")
        if not ch["ok"]:
            failures.append(f"{route_id} {name}")
            print("       " + json.dumps({k: v for k, v in ch.items() if k != "ok"})[:600])
    print(f"  barriers: {b_report['placed_m']}")
    print(f"  fit: median {b_report['fit']['median'].get('threshold')} m, fill {b_report['fit']['fill'].get('threshold')} m")
    print(f"  {'ok  ' if report['files']['ok'] else 'MISS'} {signs_path.name}: {size / 1000:.1f} kB, {barriers_path.name}: {bsize / 1000:.1f} kB")
    if not report["files"]["ok"]:
        failures.append("files")
    print(f"wrote {signs_path.relative_to(ROOT)}, {barriers_path.relative_to(ROOT)} and {rep_path.relative_to(ROOT)}")
    if failures:
        sys.exit(f"acceptance missed: {', '.join(failures)}")


if __name__ == "__main__":
    main()
