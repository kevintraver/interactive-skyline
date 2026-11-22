"""OpenStreetMap route relations for the road pipeline: read an Overpass answer, pick the
directional relations of a road by their tags, and stitch their ways into one line in the
direction of travel.

    from lib.osm import load_osm, route_relations, stitch
    osm = load_osm(doc)                       # doc: Overpass JSON (dict)
    rels = route_relations(osm, "I 15", "north")
    chain = stitch(osm, rels, start_xy, to_local)
"""
from dataclasses import dataclass, field

import numpy as np

NETWORKS = {"I": "US:I", "US": "US:US"}

# tags the pipeline reads from ways and junction nodes
WAY_TAGS = ("lanes", "maxspeed", "oneway", "bridge", "layer", "ref", "name", "placement", "turn:lanes",
            "shoulder", "shoulder:left", "shoulder:right", "surface", "destination", "junction:ref")
NODE_TAGS = ("highway", "ref", "name", "destination", "junction:ref", "noref")


@dataclass
class Osm:
    nodes: dict  # id -> (lat, lon, tags)
    ways: dict  # id -> {"nodes": [...], "tags": {...}}
    relations: dict  # id -> {"members": [...], "tags": {...}}
    timestamp: str = ""

    def latlon(self, ids):
        a = np.array([self.nodes[i][:2] for i in ids], dtype=np.float64)
        return a[:, 0], a[:, 1]


def load_osm(doc):
    nodes, ways, rels = {}, {}, {}
    for el in doc["elements"]:
        t = el["type"]
        if t == "node":
            # a node may come twice (with tags, then as a bare skeleton): keep its tags
            tags = el.get("tags") or (nodes[el["id"]][2] if el["id"] in nodes else {})
            nodes[el["id"]] = (el["lat"], el["lon"], tags)
        elif t == "way":
            ways[el["id"]] = {"nodes": el["nodes"], "tags": el.get("tags", {})}
        elif t == "relation":
            rels[el["id"]] = {"members": el["members"], "tags": el.get("tags", {})}
    return Osm(nodes, ways, rels, doc.get("osm3s", {}).get("timestamp_osm_base", ""))


def route_relations(osm, ref, direction):
    """Ids of the route relations for `ref` ("I 15") running `direction` ("north"), by tags only."""
    prefix, num = ref.split()
    out = []
    for rid, r in osm.relations.items():
        t = r["tags"]
        if t.get("type") != "route" or t.get("route") != "road":
            continue
        if t.get("network") != NETWORKS[prefix] or t.get("ref") != num:
            continue
        d = t.get("direction", "")
        if not d:  # some relations name their direction only in the description
            desc = (t.get("description", "") + " " + t.get("name", "")).lower()
            d = next((w for w in ("north", "south", "east", "west") if w in desc), "")
        if d == direction:
            out.append(rid)
    return sorted(out)


@dataclass
class Chain:
    """Stitched line: node ids in order of travel, the way each segment belongs to, and notes."""
    node_ids: list
    seg_way: list  # seg_way[k] is the way of the segment node_ids[k] -> node_ids[k+1]
    gaps: list = field(default_factory=list)  # {"after_way", "way", "metres"}
    reversed_ways: list = field(default_factory=list)
    against_oneway: list = field(default_factory=list)
    ways: list = field(default_factory=list)


def _oriented(osm, wid, role=""):
    """The way's nodes in its direction of travel as tagged (oneway=-1 or role backward reverse it)."""
    w = osm.ways[wid]
    ns = list(w["nodes"])
    flip = (w["tags"].get("oneway") == "-1") != (role == "backward")
    return ns[::-1] if flip else ns


def stitch(osm, relation_ids, start_xy, to_local, max_gap=100.0, stop_xy=None, stop_margin=1000.0):
    """Join the member ways of the relations into one line in the direction of travel.

    Starts at the member way nearest `start_xy` (map metres) and follows connections: the next
    member in relation order when it connects, else any unused member that shares the current
    end node (either way round; a way joined against its stored order is listed in
    reversed_ways, and against_oneway if it is tagged oneway=yes). Where nothing connects, the
    unused member whose start lies within `max_gap` metres of the end is joined with a straight
    segment and recorded as a gap. Stops when nothing is left to join, or once the line has
    passed within reach of `stop_xy` by `stop_margin` metres.
    """
    members = []
    for rid in relation_ids:
        for m in osm.relations[rid]["members"]:
            if m["type"] == "way" and m["ref"] in osm.ways and m["ref"] not in {x[0] for x in members}:
                members.append((m["ref"], m.get("role", "")))
    if not members:
        raise ValueError("no member ways to stitch")
    oriented = {wid: _oriented(osm, wid, role) for wid, role in members}
    order = [wid for wid, _ in members]

    def xy(nid):
        lat, lon, _ = osm.nodes[nid]
        x, y = to_local(lat, lon)
        return float(x), float(y)

    # first way: the one with a node nearest the start
    sx, sy = start_xy
    best, first = np.inf, None
    for wid in order:
        for nid in oriented[wid]:
            x, y = xy(nid)
            dd = (x - sx) ** 2 + (y - sy) ** 2
            if dd < best:
                best, first = dd, wid
    chain = Chain(node_ids=list(oriented[first]), seg_way=[first] * (len(oriented[first]) - 1), ways=[first])
    used = {first}
    passed_stop = False
    while True:
        end = chain.node_ids[-1]
        if stop_xy is not None:
            ex, ey = xy(end)
            d_stop = np.hypot(ex - stop_xy[0], ey - stop_xy[1])
            if d_stop < stop_margin:
                passed_stop = True
            elif passed_stop:
                break
        nxt, flip = None, False
        idx = order.index(chain.ways[-1])
        candidates = order[idx + 1:] + order[:idx]
        for wid in candidates:
            if wid in used:
                continue
            ns = oriented[wid]
            if ns[0] == end:
                nxt = wid
                break
            if ns[-1] == end:
                nxt, flip = wid, True
                break
        gap = None
        if nxt is None:
            ex, ey = xy(end)
            best = (max_gap, None)
            for wid in candidates:
                if wid in used:
                    continue
                x, y = xy(oriented[wid][0])
                d = np.hypot(x - ex, y - ey)
                if d < best[0]:
                    best = (d, wid)
            if best[1] is None:
                break
            nxt, gap = best[1], best[0]
        ns = oriented[nxt][::-1] if flip else oriented[nxt]
        if flip:
            chain.reversed_ways.append(nxt)
            if osm.ways[nxt]["tags"].get("oneway") in ("yes", "1", "true"):
                chain.against_oneway.append(nxt)
        if gap is None:
            chain.seg_way += [nxt] * (len(ns) - 1)
            chain.node_ids += ns[1:]
        else:
            chain.gaps.append({"after_way": chain.ways[-1], "way": nxt, "metres": round(float(gap), 2)})
            chain.seg_way += [nxt] * len(ns)  # the joining segment counts as the new way's
            chain.node_ids += ns
        chain.ways.append(nxt)
        used.add(nxt)
    return chain


def junctions(osm, node_ids):
    """Motorway junction nodes on the line, in order, once each: [(index in node_ids, node id)]."""
    out, seen = [], set()
    for k, nid in enumerate(node_ids):
        tags = osm.nodes[nid][2]
        if tags.get("highway") == "motorway_junction" and nid not in seen:
            seen.add(nid)
            out.append((k, nid))
    return out


def exit_links(osm, junction_id, mainline_ways):
    """Link ways that leave a junction node (start there and are not part of the mainline)."""
    return [wid for wid, w in osm.ways.items()
            if wid not in mainline_ways and w["tags"].get("highway") == "motorway_link"
            and _oriented(osm, wid)[0] == junction_id]


def mph(maxspeed):
    """'70 mph' -> 70; a bare number is km/h (OSM's default unit), converted; None if unreadable."""
    if not maxspeed:
        return None
    v = maxspeed.strip().lower()
    try:
        if v.endswith("mph"):
            return float(v[:-3])
        return round(float(v) / 1.609344)
    except ValueError:
        return None


def ramps(osm, node_ids, mainline_ways):
    """Link ways that leave (an exit, starting at a node of the line) or join (an entrance, ending
    at one): [(index in node_ids, "exit" | "entrance", way id)], in order along the line."""
    where = {nid: k for k, nid in enumerate(node_ids)}
    out = []
    for wid, w in osm.ways.items():
        if wid in mainline_ways or w["tags"].get("highway") != "motorway_link":
            continue
        ns = _oriented(osm, wid)
        if ns[0] in where:
            out.append((where[ns[0]], "exit", wid))
        if ns[-1] in where:
            out.append((where[ns[-1]], "entrance", wid))
    return sorted(out)
