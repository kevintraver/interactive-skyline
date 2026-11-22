# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "scipy"]
# ///
"""Usage: build_roadside.py <city>

The signs a driver expects on the freeway, by day: green guide signs at every exit (advance
signs, exit direction sign, gore sign), speed limits, route confirmation and mile markers, placed
by MUTCD rule along each route's road and lettered from OpenStreetMap's tags (plan 02, D3.7).

Inputs, all local (no network): public/data/<city>/roadnet.json and .bin and routes.json (from
build_roads.py), data/raw/<city>/osm-<ref>.json (from fetch_osm.py), the terrain grids, and the
deny-list data/sign_denylist.txt of trade names no legend may carry (assumption A5).

The script checks its acceptance numbers, writes them to the report and exits non-zero when one
is missed (the outputs are still written, to look at).

Output: public/data/<city>/signs.json, data/derived/<city>/roadside_report.json
"""
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
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

ROOT = Path(__file__).resolve().parent.parent
DENYLIST = ROOT / "data" / "sign_denylist.txt"
MAX_BYTES = 150_000
# a left-exit sign the median cannot hold: "drop" it (reported as overhead on the real road) or
# stand it on the "right" shoulder with its LEFT plaque
MEDIAN_FALLBACK = "drop"
# section 7.4 and the MUTCD, for the acceptance check: inches of capital letter height per kind
CAP_RANGE = {"advance": (16, 20), "exit": (16, 20), "sequence": (16, 20), "gore": (12, 16), "speed": (16, 24),
             "route": (12, 24), "mile": (6, 12)}
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


def build_route(rc, route, roads, osm, heights, deny, report):
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

    # a sign on the left needs a median wide enough to stand in, clear of the opposite pavement
    moved = []
    for c in cands:
        if c["side"] != "left":
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
    for c in placed:
        r = record(c, index, entries, road.get("ref", ""))
        if c.get("moved") is not None:
            r["moved"] = "median"
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
    for side in ("left", "right"):
        ss = sorted(r["s"] for r in records if r["side"] == side)
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
        if r["mount"] < MIN_MOUNT.get(r["kind"], 7 * 0.3048) - 1e-6:
            bad.append(f'{r["kind"]} at {r["s"]}: mounted {r["mount"]} m')
        if r["offset"] < MIN_OFFSET - 1e-6:
            bad.append(f'{r["kind"]} at {r["s"]}: offset {r["offset"]} m')
    checks["dimensions"] = {"problems": bad, "ok": not bad}

    lanes = lambda s: len(next(x for x in road["sections"] if x["s0"] <= s <= x["s1"])["lanes"])  # noqa: E731
    overhead = [{"kind": r["kind"], "s": r["s"], "exit": entries[r["exit"]]["number"] or entries[r["exit"]]["osm"],
                 "why": "left exit" if entries[r["exit"]]["side"] == "left" else f"{lanes(r['s'])} lanes"}
                for r in records if r["kind"] in ("advance", "exit", "sequence")
                and (entries[r["exit"]]["side"] == "left" or lanes(r["s"]) >= 4)]
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
        "ground_fixes": ground_fixes, "would_be_overhead": overhead,
        "left_offsets": [{"kind": r["kind"], "s": r["s"], "offset": r["offset"]} for r in records if r["side"] == "left"],
    }
    return {"id": road["id"], "route": rc["id"], "exits": entries, "signs": records}


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    city = sys.argv[1]
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    routes_cfg = cfg.get("routes") or sys.exit(f"{city} has no routes in data/cities.json")
    data = ROOT / "public" / "data" / city
    doc = json.loads((data / "roadnet.json").read_text())
    roads = {r["id"]: r for r in decode_roadnet(doc, (data / "roadnet.bin").read_bytes())}
    routes = {r["id"]: r for r in json.loads((data / "routes.json").read_text())["routes"]}
    heights = load_heights(city)
    deny = load_denylist(DENYLIST)
    report, out_roads, snapshots = {}, [], set()
    for rc in routes_cfg:
        path = ROOT / "data" / "raw" / city / f"osm-{rc['ref'].lower().replace(' ', '')}.json"
        if not path.exists():
            sys.exit(f"{path.relative_to(ROOT)} is missing: run  uv run scripts/fetch_osm.py {city}")
        osm = load_osm(json.loads(path.read_text()))
        snapshots.add(osm.timestamp)
        print(f"{rc['id']}: placing signs along {routes[rc['id']]['road']}")
        out_roads.append(build_route(rc, routes[rc["id"]], roads, osm, heights, deny, report))

    out = {"version": 1, "source": {
        "osm": " ".join(sorted(snapshots)), "osmLicence": "ODbL, (c) OpenStreetMap contributors",
        "method": "scripts/build_roadside.py", "positions": "rule (MUTCD 2B, 2D, 2E, 2H); no public sign inventory",
        "denylist": str(DENYLIST.relative_to(ROOT))}, "roads": out_roads}
    text = json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n"
    (data / "signs.json").write_text(text)
    size = len(text.encode())
    rep_dir = ROOT / "data" / "derived" / city
    rep_dir.mkdir(parents=True, exist_ok=True)
    report["files"] = {"signs.json": size, "limit": MAX_BYTES, "ok": size < MAX_BYTES}
    report["denylist"] = {"file": str(DENYLIST.relative_to(ROOT)), "terms": len(deny)}
    (rep_dir / "roadside_report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False) + "\n")

    failures = []
    for rid, rr in report.items():
        if rid in ("files", "denylist"):
            continue
        print(f"{rid}: {rr['counts']['total']} signs {rr['counts']['by_kind']}")
        for name, ch in rr["checks"].items():
            print(f"  {'ok  ' if ch['ok'] else 'MISS'} {name}")
            if not ch["ok"]:
                failures.append(f"{rid} {name}")
                print("       " + json.dumps({k: v for k, v in ch.items() if k != "ok"})[:600])
    print(f"  {'ok  ' if report['files']['ok'] else 'MISS'} signs.json: {size / 1000:.1f} kB")
    if not report["files"]["ok"]:
        failures.append("files")
    print(f"wrote {(data / 'signs.json').relative_to(ROOT)} and {(rep_dir / 'roadside_report.json').relative_to(ROOT)}")
    if failures:
        sys.exit(f"acceptance missed: {', '.join(failures)}")


if __name__ == "__main__":
    main()
