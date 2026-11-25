"""The airport's surfaces, lines, stands, lights and buildings in the app frame, for build_airport.py (plan 03, F4.1).

Pure functions over the answers lib/airport_fetch.py caches: the FAA's airport-mapping layers (esri JSON, WGS-84),
its Digital Obstacle File, and OpenStreetMap's aeroways (Overpass JSON with inline geometry). Nothing here names an
airport; everything is found by tag, layer and geometry.

    from lib import airport_layers as al
    pav = al.faa_pavement(layers, frame)       # {"runway": [...], "taxiway": [...], "apron": [...]}
    osm = al.osm_aeroways(doc, frame)          # taxiways, stands, gates, jetBridges, holdingPositions, lights, ...
    blds = al.merge_buildings(al.faa_buildings(layers["AM_Building"], frame), osm["buildings"])
    tw = al.tower(layers["Digital_Obstacle_File"], blds, frame); bc = al.beacon(layers["AM_Beacon"], tw, frame)

Compact form: a polygon is {"ring": [x0, y0, x1, y1, ...]} (metres east and north of the city origin, rounded to
0.1 m, counter-clockwise, the first point not repeated) with "holes" (clockwise rings) only when it has any; a line is
a flat [x0, y0, x1, y1, ...]. Directions are degrees clockwise from grid north of the app frame.
"""
import math
from collections import defaultdict

import numpy as np
from shapely import make_valid
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

FT = 0.3048
NOT_A_NAME = {"", "UNK", "UNKNOWN", "NONE"}
GATE_M = 80.0  # a gate of the stand's ref tells the stop end only when it is this near the stand


# ------------------------------------------------------------------ geometry
def signed_area(flat):
    """Shoelace area of a flat ring: positive when counter-clockwise (x east, y north)."""
    a = np.asarray(flat, dtype=np.float64).reshape(-1, 2)
    x, y = a[:, 0], a[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def _flat_ring(coords):
    c = list(coords)
    if len(c) > 1 and c[0] == c[-1]:
        c = c[:-1]
    out, last = [], None
    for x, y in c:
        p = (round(float(x), 1), round(float(y), 1))
        if p != last:
            out += p
            last = p
    if len(out) > 2 and out[:2] == out[-2:]:
        out = out[:-2]
    return out


def flat_polygon(poly):
    """A shapely polygon in the compact form: counter-clockwise outer ring, clockwise holes, rounded to 0.1 m."""
    p = orient(poly, 1.0)
    out = {"ring": _flat_ring(p.exterior.coords)}
    holes = [_flat_ring(h.coords) for h in p.interiors]
    if holes:
        out["holes"] = holes
    return out


def to_polygon(item):
    """The compact form back to a shapely polygon."""
    def pts(flat):
        return list(zip(flat[0::2], flat[1::2]))
    return Polygon(pts(item["ring"]), [pts(h) for h in item.get("holes", [])])


def flat_line(xy):
    out = []
    for x, y in xy:
        p = [round(float(x), 1), round(float(y), 1)]
        if out[-2:] != p:
            out += p
    return out


def _local(frame, lonlat):
    a = np.asarray(lonlat, dtype=np.float64).reshape(-1, 2)
    x, y = frame.to_local(a[:, 1], a[:, 0])
    return np.column_stack([np.atleast_1d(x), np.atleast_1d(y)])


def _valid(poly):
    """Polygons of a possibly invalid one: make_valid's polygonal parts, tiny slivers dropped."""
    if poly.is_valid:
        return [poly]
    g = make_valid(poly)
    parts = g.geoms if hasattr(g, "geoms") else [g]
    out = []
    for q in parts:
        if isinstance(q, Polygon):
            out.append(q)
        elif isinstance(q, MultiPolygon):
            out += list(q.geoms)
    return [q for q in out if q.area > 1.0]


def esri_polygons(feature, frame):
    """An esri polygon feature (rings in WGS-84, outer rings clockwise, holes counter-clockwise as esri writes them)
    as valid shapely polygons in the app frame."""
    rings = [_local(frame, r) for r in feature["geometry"]["rings"]]
    outers, holes = [], []
    for r in rings:
        # esri: clockwise = outer. In x east, y north a clockwise ring has negative shoelace area.
        (outers if signed_area(r.ravel()) < 0 else holes).append(r)
    polys = []
    for o in outers:
        op = Polygon(o)
        mine = [h for h in holes if op.contains(Point(h[0]))]
        polys += _valid(Polygon(o, mine))
    return polys


def _rounded_valid(poly):
    """Round to the compact form and back; repair what rounding broke."""
    out = []
    for q in _valid(to_polygon(flat_polygon(poly))):
        f = flat_polygon(q)
        if to_polygon(f).is_valid and len(f["ring"]) >= 6:
            out.append(f)
    return out


def grid_bearing(frame, lat, lon, true_deg):
    """A true bearing at (lat, lon) as a bearing from grid north of the app frame."""
    d = 1e-4  # about 11 m north
    x0, y0 = frame.to_local(lat, lon)
    x1, y1 = frame.to_local(lat + d, lon)
    conv = math.degrees(math.atan2(float(x1 - x0), float(y1 - y0)))  # grid bearing of true north
    return (true_deg + conv) % 360


def _bearing(dx, dy):
    return math.degrees(math.atan2(dx, dy)) % 360


def _name(v):
    v = (v or "").strip()
    return None if v.upper() in NOT_A_NAME else v


# ------------------------------------------------------------------ FAA layers
def faa_pavement(layers, frame):
    """Runway, taxiway and apron polygons from AM_Runway, AM_Taxiway and AM_Apron."""
    out = {"runway": [], "taxiway": [], "apron": []}
    for kind, layer in (("runway", "AM_Runway"), ("taxiway", "AM_Taxiway"), ("apron", "AM_Apron")):
        for f in sorted(layers[layer]["features"], key=lambda f: f["attributes"]["OBJECTID"]):
            a = f["attributes"]
            for p in esri_polygons(f, frame):
                for item in _rounded_valid(p):
                    if kind == "runway":
                        item = {"id": (a.get("RWY_ID") or "").strip(), **item}
                    else:
                        item = {"name": _name(a.get("DESIGNATOR")), **item}
                    out[kind].append(item)
    out["runway"].sort(key=lambda r: r["id"])
    return out


def _building_kind(name):
    n = (name or "").upper()
    if n in ("TWR", "ATCT", "TOWER", "CONTROL TOWER"):
        return "tower"
    if "GATE" in n or "TERMINAL" in n or "CONCOURSE" in n:
        return "terminal"
    if "FUEL" in n:
        return "fuel-tank"
    if "FIRE" in n:
        return "fire-station"
    if "HANGAR" in n:
        return "hangar"
    if n == "FBO":
        return "fbo"
    return "building"


def faa_buildings(layer, frame):
    """AM_Building as [{name, kind, source: "faa", faaId, ring}]."""
    out = []
    for f in sorted(layer["features"], key=lambda f: f["attributes"]["OBJECTID"]):
        name = _name(f["attributes"].get("DESIGNATOR"))
        for p in esri_polygons(f, frame):
            for item in _rounded_valid(p):
                out.append({"name": name, "kind": _building_kind(name), "source": "faa",
                            "faaId": f["attributes"]["OBJECTID"], **item})
    return out


def merge_buildings(faa, osm_buildings):
    """FAA buildings, each given the name, ref and height tags of the OpenStreetMap terminal or hangar that is the same
    building (the two overlap by half the smaller), then the OSM ones that match none, as their own buildings."""
    out = [dict(b) for b in faa]
    polys = [to_polygon(b) for b in out]
    for ob in osm_buildings:
        op = to_polygon(ob)
        best, share = None, 0.0
        for i, p in enumerate(polys):
            if not p.intersects(op):
                continue
            s = p.intersection(op).area / min(p.area, op.area)
            if s > share:
                best, share = i, s
        if best is not None and share >= 0.5:
            b = out[best]
            if "osmId" not in b:  # the first OSM match names it
                b.update({"osmId": ob["osmId"], "osmName": ob.get("name"), "ref": ob.get("ref"),
                          "osmHeight": ob.get("height"), "osmLevels": ob.get("levels")})
                if b["kind"] == "building":
                    b["kind"] = ob["aeroway"]
                if not b.get("name"):
                    b["name"] = ob.get("name")
            continue
        out.append({"name": ob.get("name"), "kind": ob["aeroway"], "source": "osm", "osmId": ob["osmId"],
                    "ref": ob.get("ref"), "osmHeight": ob.get("height"), "osmLevels": ob.get("levels"),
                    "ring": ob["ring"], **({"holes": ob["holes"]} if "holes" in ob else {})})
    return out


def _num(v):
    try:
        return float(str(v).split()[0])
    except (TypeError, ValueError, IndexError):
        return None


def tower(dof, buildings, frame):
    """The control tower: the Digital Obstacle File's control tower nearest the building drawn as the tower (or the
    tallest control tower if no building is), with its height above ground and top above sea level."""
    rows = []
    for f in dof["features"]:
        a = f["attributes"]
        if (a.get("Type_Code") or "").strip() not in ("CTRL TWR", "CTRL TOWER"):
            continue
        lat, lon = float(a["Lat_DD"]), float(a["Long_DD"])
        x, y = frame.to_local(lat, lon)
        rows.append((float(x), float(y), a))
    if not rows:
        return None
    drawn = [to_polygon(b) for b in buildings if b["kind"] == "tower"]
    if drawn:
        x, y, a = min(rows, key=lambda r: min(p.distance(Point(r[0], r[1])) for p in drawn))
    else:
        x, y, a = max(rows, key=lambda r: r[2]["AGL"])
    agl, amsl = a["AGL"] * FT, a["AMSL"] * FT
    return {"x": round(x, 1), "y": round(y, 1), "heightAgl": round(agl, 1), "topAmsl": round(amsl, 1),
            "groundAmsl": round(amsl - agl, 1), "lighting": (a.get("Lighting") or "").strip() or None,
            "source": f"FAA Digital Obstacle File {a['OAS_Number'].strip()} ({a['Type_Code'].strip()}, "
                      f"{a['AGL']} ft AGL, {a['AMSL']} ft AMSL)"}


def beacon(layer, tower_info, frame, on_tower_m=15.0):
    """The rotating beacon's position from AM_Beacon; its height is the tower's top when it stands on the tower."""
    feats = layer["features"]
    if not feats:
        return None
    g, a = feats[0]["geometry"], feats[0]["attributes"]
    x, y = (float(v) for v in frame.to_local(g["y"], g["x"]))
    on = bool(tower_info and math.hypot(x - tower_info["x"], y - tower_info["y"]) < on_tower_m)
    return {"x": round(x, 1), "y": round(y, 1), "z": tower_info["topAmsl"] if on else None, "onTower": on,
            "faaType": (a.get("BCN_TYPE") or "").strip() or None}


def city_cover(poly, city_polys):
    """The share of `poly`'s area that the city's building footprints cover."""
    near = [c for c in city_polys if c.intersects(poly)]
    if not near:
        return 0.0
    return float(poly.intersection(unary_union(near)).area / poly.area)


# ------------------------------------------------------------------ OpenStreetMap
LIGHT_KINDS = {"rwe": "runway edge", "rwt": "runway threshold", "rwc": "runway centre line",
               "rwz": "runway touchdown zone", "txe": "taxiway edge", "txc": "taxiway centre line",
               "als": "approach light", "papi": "PAPI unit", "vasi": "VASI unit", "stopbar": "stop bar",
               "rel": "runway entrance light", "thl": "take-off hold light", "rgl": "runway guard light"}


def _xy_of(frame, el):
    if "geometry" in el:
        pts = [(p["lon"], p["lat"]) for p in el["geometry"] if p]
    elif "lat" in el:
        pts = [(el["lon"], el["lat"])]
    else:
        return None
    return _local(frame, pts)


def _closed_polygon(xy):
    if len(xy) < 4 or not np.allclose(xy[0], xy[-1]):
        return None
    ps = _valid(Polygon(xy))
    return max(ps, key=lambda p: p.area) if ps else None


def osm_aeroways(doc, frame):
    """Everything build_airport.py takes from OpenStreetMap, in the app frame."""
    taxiways, gates, bridges, holds, buildings, windsocks, stands_raw = [], [], [], [], [], [], []
    lights = defaultdict(list)
    vertex = {}  # (lat, lon) of a taxiway vertex -> (line index, vertex index)
    for el in doc["elements"]:
        t = el.get("tags", {})
        aw = t.get("aeroway")
        xy = _xy_of(frame, el)
        if xy is None:
            continue
        oid = f"{el['type'][0]}{el['id']}"
        if aw in ("taxiway", "taxilane") and el["type"] == "way":
            for k, p in enumerate(el["geometry"]):
                vertex.setdefault((p["lat"], p["lon"]), (len(taxiways), k))
            taxiways.append({"ref": t.get("ref") or t.get("name") or None, "kind": aw, "line": flat_line(xy),
                             "_xy": xy})
        elif aw == "parking_position":
            stands_raw.append((t, xy, oid))
        elif aw == "gate" and el["type"] == "node":
            gates.append({"ref": t.get("ref"), "x": round(float(xy[0, 0]), 1), "y": round(float(xy[0, 1]), 1),
                          "level": t.get("level")})
        elif aw == "jet_bridge" and el["type"] == "way":
            bridges.append({"ref": t.get("ref"), "line": flat_line(xy)})
        elif aw == "holding_position" and el["type"] == "node":
            holds.append({"ref": t.get("ref"), "type": t.get("holding_position:type"), "x": round(float(xy[0, 0]), 1),
                          "y": round(float(xy[0, 1]), 1), "_ll": (el["lat"], el["lon"])})
        elif aw == "navigationaid" and el["type"] == "node" and t.get("navigationaid") in LIGHT_KINDS:
            colour = t.get("light:colour") or t.get("colour")
            d = _num(t.get("light:direction") or t.get("direction"))
            if d is not None:
                d = round(grid_bearing(frame, el["lat"], el["lon"], d), 1)
            lights[(t["navigationaid"], colour, d)] += [round(float(xy[0, 0]), 1), round(float(xy[0, 1]), 1)]
        elif aw in ("terminal", "hangar") and el["type"] == "way":
            p = _closed_polygon(xy)
            if p is not None:
                for item in _rounded_valid(p):
                    buildings.append({"aeroway": aw, "osmId": oid, "name": t.get("name"), "ref": t.get("ref"),
                                      "height": _num(t.get("height")), "levels": _num(t.get("building:levels")),
                                      **item})
        elif aw == "windsock" and el["type"] == "node":
            windsocks.append([round(float(xy[0, 0]), 1), round(float(xy[0, 1]), 1)])

    for h in holds:
        hit = vertex.get(h.pop("_ll"))
        h["dir"] = None
        if hit:
            line, k = taxiways[hit[0]]["_xy"], hit[1]
            a, b = line[max(k - 1, 0)], line[min(k + 1, len(line) - 1)]
            h["dir"] = round(_bearing(*(b - a)), 1) % 180
    stands = _stands(stands_raw, gates, buildings, bridges, taxiways)
    for t in taxiways:
        del t["_xy"]
    light_groups = [{"kind": k, "colour": c, "dir": d, "xy": xy}
                    for (k, c, d), xy in sorted(lights.items(), key=lambda kv: (kv[0][0], kv[0][1] or "", kv[0][2] or -1))]
    return {"taxiways": taxiways, "stands": stands, "gates": gates, "jetBridges": bridges, "holdingPositions": holds,
            "lights": light_groups, "buildings": buildings, "windsocks": windsocks}


def _stands(raw, gates, buildings, bridges, taxiways):
    """Parking positions with the end where the aircraft stops and the heading it stops on.

    OpenStreetMap draws a parking position as its lead-in line, in either direction. The stop end is the one nearer:
    the gate with the stand's ref, when that gate is within GATE_M of the stand; else the nearest terminal, hangar or jet bridge (when one end is clearly nearer);
    else the end farther from the nearest taxiway centre line; else the way's last node. `stopBy` says which."""
    gate_at = {g["ref"]: np.array([g["x"], g["y"]]) for g in gates if g["ref"]}
    structures = [to_polygon(b) for b in buildings] + [LineString(np.array(j["line"]).reshape(-1, 2))
                                                       for j in bridges if len(j["line"]) >= 4]
    lines = [LineString(t["_xy"]) for t in taxiways if len(t["_xy"]) >= 2]
    out = []
    for t, xy, oid in raw:
        if len(xy) < 2:
            continue
        if _closed_polygon(xy) is not None and len(xy) > 4:
            continue  # an area, not a lead-in line
        a, b = xy[0], xy[-1]
        ref = t.get("ref")
        flip, by = False, "drawn"
        g = gate_at.get(ref)
        if g is not None and min(np.hypot(*(a - g)), np.hypot(*(b - g))) < GATE_M:
            flip, by = np.hypot(*(a - g)) < np.hypot(*(b - g)), "gate"
        else:
            da = min((s.distance(Point(a)) for s in structures), default=math.inf)
            db = min((s.distance(Point(b)) for s in structures), default=math.inf)
            if abs(da - db) > 5 and min(da, db) < 60:
                flip, by = da < db, "building"
            elif lines:
                ta = min(ln.distance(Point(a)) for ln in lines)
                tb = min(ln.distance(Point(b)) for ln in lines)
                if abs(ta - tb) > 5:
                    flip, by = ta > tb, "taxiway"
        if flip:
            xy = xy[::-1]
        lead = flat_line(xy)
        lx = np.array(lead).reshape(-1, 2)
        if len(lx) < 2:
            continue
        out.append({"ref": ref, "x": lead[-2], "y": lead[-1], "heading": round(_bearing(*(lx[-1] - lx[-2])), 1),
                    "lead": lead, "stopBy": by, "osmId": oid})
    return out
