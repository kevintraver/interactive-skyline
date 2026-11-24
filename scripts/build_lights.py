# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyproj", "requests", "scipy", "shapely"]
# ///
"""Usage: build_lights.py <city>

Every street lamp we can know about, and their light per 500 m cell (plan 02, D5.3; plan 01, T4.0).

1. Collect the public street-light inventories (section 6.6 of plan 02; treated as public domain by the
   owner's decision of 10 November 2026, plan 01 section 2.3) and OpenStreetMap's highway=street_lamp.
   De-duplicate across sources within 5 m, the inventories outranking OSM.
2. Assign each lamp a type from its own fields (data/lamp_types.json), hence flux and colour class.
3. Fill gaps by rule along roads: in built-up areas that no inventory covers (North Las Vegas; all of Salt
   Lake City, which publishes none), on freeways and ramps (NDOT publishes no inventory), and high masts at
   system interchanges. Spacing and the share of lit road per road class are measured on the inventories,
   and checked by hiding one inventory (Henderson) and placing it by rule (the hold-out).
4. Write the `lamps` layer and a report; then lumens per cell by class (sodium, LED, other) on the
   night-lights metro grid (cities.json `nightlights.metro`) in the LampCells layout of plan 01, 11.7.

The VIIRS fit of plan 02 (D7.1) is not part of this script.

Output: data/derived/<city>/lamps.bin, lamps.json        the lamps layer, 16 bytes per lamp
        data/derived/<city>/lights_report.json           counts, provenance, tuning, hold-out
        public/data/<city>/lamp-cells.bin, lamp-cells.json
"""
import json
import math
import sys
from collections import Counter
from datetime import date
from pathlib import Path

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely import contains_xy
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import linemerge, polygonize, unary_union

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import fetch  # noqa: E402
from lib import lamps as L  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FT = 0.3048

INVENTORIES = {
    "lv": [
        {"id": "clark_county", "name": "Clark County Public Works, LIGHT FIXTURES",
         "url": "https://services2.arcgis.com/MLoS3Qx4BXmDoTIY/arcgis/rest/services/Fixtures_View/FeatureServer/0",
         "supports": "https://services2.arcgis.com/MLoS3Qx4BXmDoTIY/arcgis/rest/services/Streetlight_Supports_View/FeatureServer/0",
         "jurisdiction": "unincorporated Clark County (the Strip included)"},
        {"id": "las_vegas", "name": "City of Las Vegas, stlights",
         "url": "https://services1.arcgis.com/F1v0ufATbBQScMtY/arcgis/rest/services/stlights/FeatureServer/0",
         "jurisdiction": "Las Vegas"},
        {"id": "henderson", "name": "Henderson street lights (contractor's public layer, HendersonPublish/125)",
         "url": "https://services6.arcgis.com/clPWQMwZfdWn4MQZ/arcgis/rest/services/HendersonPublish/FeatureServer/125",
         "jurisdiction": "Henderson"},
        {"id": "boulder_city", "name": "Boulder City, Dark Skies Light Replacement (city-owned and not city-owned layers)",
         "url": "https://services6.arcgis.com/ENlYDFfLXlpg7FOQ/arcgis/rest/services/Dark_Skies_Light_Replacement_view/FeatureServer/0",
         "url2": "https://services6.arcgis.com/ENlYDFfLXlpg7FOQ/arcgis/rest/services/Dark_Skies_Light_Replacement_view/FeatureServer/1",
         "jurisdiction": "Boulder City"},
    ],
    "slc": [],
}
SOURCE_IDS = {"osm": 0, "clark_county": 1, "las_vegas": 2, "henderson": 3, "boulder_city": 4, "rule": 7}
CREDIT = {
    "lv": "Street lights: Clark County Public Works, City of Las Vegas, City of Henderson (via its lighting contractor's public layer), Boulder City; OpenStreetMap contributors (ODbL).",
    "slc": "Street lights: OpenStreetMap contributors (ODbL) and a rule along roads; Salt Lake City publishes no street-light inventory that was found.",
}
# Built-up areas no inventory covers: the rule lights their roads. A city with no inventory is all gap.
GAP_JURISDICTIONS = {"lv": ["North Las Vegas"], "slc": None}
TUNE_SOURCES = {"lv": ["clark_county", "las_vegas"]}
HOLDOUT = {"lv": ("henderson", "Henderson")}
# Rule lamp types where nothing is known: North Las Vegas is mid-way through a sodium-to-LED retrofit funded
# to 2029 (plan 02, 6.6): half and half, assumed. Salt Lake City: the same assumption, flagged.
RULE_MIX = {"lv": {"hps": 0.5, "led_street": 0.5}, "slc": {"hps": 0.5, "led_street": 0.5}}
# Freeways and ramps: NDOT publishes no inventory. Spacing and mount height assumed (typical US interstate
# lighting); NDOT's 2016 I-15 retrofit (plan 02, L5) makes them LED.
FREEWAY_RULE = {"freeway": {"spacing": 60.0, "litFraction": 1.0, "offset": 0.0, "stagger": False, "mountM": 12.2,
                            "type": "led_street", "watts": 210},
                "ramp": {"spacing": 45.0, "litFraction": 1.0, "offset": 5.0, "stagger": False, "mountM": 12.2,
                         "type": "led_street", "watts": 160}}
SURFACE_GEOMETRY = {"local": {"offset": 7.0, "stagger": False, "mountM": 9.14},
                    "collector": {"offset": 10.0, "stagger": True, "mountM": 9.14},
                    "major": {"offset": 15.0, "stagger": True, "mountM": 10.7}}
URBAN_KM_PER_KM2 = 6.0  # street density that marks a built-up 500 m cell (3 x 3 mean)
ASSIGN_M = 30.0  # an inventory lamp belongs to the nearest road within this distance
LIT_M = 40.0  # a road point with an inventory lamp this close is lit
AVOID_M = {"surface": 25.0, "freeway": 40.0}
HIGHMAST = {"perInterchange": 4, "radiusM": 150.0, "skipIfMastWithinM": 600.0, "watts": 302, "mountM": 30.5}
ROAD_HIGHWAYS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"


# ---------------------------------------------------------------- inputs
def setup(city):
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    proj = json.loads((ROOT / "public" / "data" / city / "terrain.json").read_text())["projection"]
    g = dict(cfg["nightlights"]["metro"])
    g["nx"] = round((g["x1"] - g["x0"]) / g["cell"])
    g["ny"] = round((g["y1"] - g["y0"]) / g["cell"])
    return cfg, proj, g


def bbox_ll(proj, g, margin=2000):
    to_ll = Transformer.from_crs(proj, "EPSG:4326", always_xy=True)
    pts = [to_ll.transform(x, y) for x in (g["x0"] - margin, g["x1"] + margin) for y in (g["y0"] - margin, g["y1"] + margin)]
    return min(p[1] for p in pts), min(p[0] for p in pts), max(p[1] for p in pts), max(p[0] for p in pts)


def osm_roads(city, bb):
    s, w, n, e = bb
    out = []
    for i in range(2):
        for j in range(2):
            b = (s + (n - s) * i / 2, w + (e - w) * j / 2, s + (n - s) * (i + 1) / 2, w + (e - w) * (j + 1) / 2)
            q = f'[out:json][timeout:600];way["highway"~"^({ROAD_HIGHWAYS})$"]({b[0]:.5f},{b[1]:.5f},{b[2]:.5f},{b[3]:.5f});out body geom;'
            d = fetch.overpass(q, ROOT / "data" / "raw" / city / f"osm-roads-{i}{j}.json")
            out.append(d)
    return out


def osm_lamps(city, bb):
    q = f'[out:json][timeout:300];node["highway"="street_lamp"]({bb[0]:.5f},{bb[1]:.5f},{bb[2]:.5f},{bb[3]:.5f});out body;'
    return fetch.overpass(q, ROOT / "data" / "raw" / city / "osm-street-lamps.json")


def osm_boundaries(city, bb):
    q = f'[out:json][timeout:300];relation["boundary"="administrative"]["admin_level"="8"]({bb[0]:.5f},{bb[1]:.5f},{bb[2]:.5f},{bb[3]:.5f});out body geom;'
    return fetch.overpass(q, ROOT / "data" / "raw" / city / "osm-boundaries-admin8.json")


def boundary_polygons(data, to_local):
    """name -> shapely (Multi)Polygon in local metres, from admin_level 8 relations."""
    out = {}
    for el in data["elements"]:
        if el["type"] != "relation":
            continue
        name = el.get("tags", {}).get("name")
        lines = {"outer": [], "inner": []}
        for m in el.get("members", []):
            if m["type"] == "way" and "geometry" in m and m.get("role") in ("outer", "inner", ""):
                xs, ys = to_local.transform([p["lon"] for p in m["geometry"]], [p["lat"] for p in m["geometry"]])
                lines["inner" if m.get("role") == "inner" else "outer"].append(list(zip(xs, ys)))
        outer = list(polygonize(linemerge(lines["outer"]))) if lines["outer"] else []
        inner = list(polygonize(linemerge(lines["inner"]))) if lines["inner"] else []
        if not outer:
            continue
        poly = unary_union(outer)
        if inner:
            poly = poly.difference(unary_union(inner))
        out[name] = poly if name not in out else unary_union([out[name], poly])
    return out


# ---------------------------------------------------------------- inventories -> lamp rows
def project(feats, to_local):
    if not feats:
        return np.zeros((0, 2))
    x, y = to_local.transform([f["lon"] for f in feats], [f["lat"] for f in feats])
    return np.column_stack([x, y])


def read_inventory(src, city, to_local):
    raw = ROOT / "data" / "raw" / city / "lamps"
    layer = fetch.arcgis_layer(src["url"], raw / f"{src['id']}.json")
    feats = list(layer["features"])
    layers = [layer]
    if src.get("url2"):
        layer2 = fetch.arcgis_layer(src["url2"], raw / f"{src['id']}-2.json")
        feats += layer2["features"]
        layers.append(layer2)
    xy = project(feats, to_local)
    types, watts, mount, aim, enclosed = [], [], [], [], []
    for f in feats:
        a = f["a"]
        if src["id"] == "clark_county":
            t, w = L.county_type(a.get("FIXTURE"), a.get("LAMP"), a.get("SUPP_TYPE"))
            aim.append(math.nan)
            enclosed.append(L.county_enclosed(a.get("SUPP_TYPE"), a.get("COMMENTS")))
        elif src["id"] == "las_vegas":
            t, w = L.clv_type(a.get("TYPE"), a.get("WATT"))
            r = a.get("ROT_ANG")
            aim.append(float(r) if r is not None else math.nan)
        elif src["id"] == "henderson":
            t, w = L.henderson_type(a.get("FIXTURE_TYPE"), a.get("WATTAGE"))
            aim.append(math.nan)
        else:
            t, w = L.boulder_type(a.get("LAMP_TYPE"), a.get("WATTAGE"))
            aim.append(math.nan)
        types.append(t)
        watts.append(w)
        mount.append(L.TYPE_BY_KEY[t].get("mountM", L.TYPES["mountDefaultM"]))
    mount = np.array(mount, dtype=float)
    support_match = None
    if src.get("supports"):
        sup = fetch.arcgis_layer(src["supports"], raw / f"{src['id']}-supports.json")
        layers.append(sup)
        sxy = project(sup["features"], to_local)
        h = np.array([L.feet(f["a"].get("POLE_HEIGHT")) or np.nan for f in sup["features"]])
        d, j = cKDTree(sxy).query(xy, k=1, distance_upper_bound=3.0)
        ok = np.isfinite(d)
        ok[ok] &= np.isfinite(h[j[ok]])
        mount[ok] = h[j[ok]]
        support_match = int(ok.sum())
    prov = [{"name": src["name"], "url": ly["url"], "records": len(ly["features"]) + ly.get("skippedNoGeometry", 0),
             "withGeometry": len(ly["features"]),
             "lastEdit": (ly["meta"].get("editingInfo") or {}).get("lastEditDate"),
             "copyrightText": ly["meta"].get("copyrightText") or "",
             "retrieved": fetch.retrieved(raw / (f"{src['id']}.json" if k == 0 else (f"{src['id']}-2.json" if ly["url"] == src.get("url2") else f"{src['id']}-supports.json")))}
            for k, ly in enumerate(layers)]
    for p in prov:
        if p["lastEdit"]:
            p["lastEdit"] = date.fromtimestamp(p["lastEdit"] / 1000).isoformat()
    enclosed = np.array(enclosed if enclosed else [False] * len(feats), dtype=bool)
    return {"id": src["id"], "xy": xy, "type": np.array(types, dtype=object), "watts": np.array(watts, dtype=object),
            "mount": mount, "aim": np.array(aim, dtype=float), "enclosed": enclosed, "prov": prov, "supportMatched": support_match,
            "jurisdiction": src["jurisdiction"]}


def read_osm_lamps(data, to_local):
    nodes = [e for e in data["elements"] if e["type"] == "node"]
    xy = project(nodes, to_local) if nodes else np.zeros((0, 2))
    types, watts, mount = [], [], []
    for e in nodes:
        tg = e.get("tags", {})
        t, w = L.osm_type(tg)
        types.append(t)
        watts.append(w)
        h = L.watts_of(tg.get("height"))  # a plain number of metres
        mount.append(h if h and 2 < h < 60 else L.TYPE_BY_KEY[t].get("mountM", L.TYPES["mountDefaultM"]))
    return {"id": "osm", "xy": xy, "type": np.array(types, dtype=object), "watts": np.array(watts, dtype=object),
            "mount": np.array(mount, dtype=float), "aim": np.full(len(nodes), math.nan), "jurisdiction": "any",
            "enclosed": np.array([e.get("tags", {}).get("tunnel") == "yes" or e.get("tags", {}).get("covered") == "yes" for e in nodes], dtype=bool),
            "tagged": {"lamp_type": sum(1 for e in nodes if e.get("tags", {}).get("lamp_type")),
                       "lamp_mount": sum(1 for e in nodes if e.get("tags", {}).get("lamp_mount"))}}


def read_roads(chunks, to_local):
    seen, roads, nodes_of = set(), [], []
    for d in chunks:
        for el in d["elements"]:
            if el["type"] != "way" or el["id"] in seen or "geometry" not in el:
                continue
            seen.add(el["id"])
            tg = el.get("tags", {})
            cls = L.ROAD_CLASS.get(tg.get("highway"))
            if not cls or tg.get("area") == "yes":
                continue
            g = [p for p in el["geometry"] if p]
            x, y = to_local.transform([p["lon"] for p in g], [p["lat"] for p in g])
            lit = tg.get("lit")
            roads.append({"id": el["id"], "xy": np.column_stack([x, y]), "cls": cls, "ref": tg.get("ref"),
                          "lit": "yes" if lit in ("yes", "24/7", "automatic", "sunset-sunrise", "limited") else ("no" if lit == "no" else None),
                          "nodes": el.get("nodes", [])})
    return roads


# ---------------------------------------------------------------- the rule
def system_interchanges(roads):
    """Centres of interchanges where chains of ramps join two different freeways (by `ref`)."""
    ref_of_node = {}
    for r in roads:
        if r["cls"] == "freeway" and r["ref"]:
            for n in r["nodes"]:
                ref_of_node.setdefault(n, set()).update(x.strip() for x in r["ref"].split(";"))
    links = [r for r in roads if r["cls"] == "ramp" and r["nodes"]]
    parent = list(range(len(links)))

    def root(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    first = {}
    for k, r in enumerate(links):  # ramps that share a node form one chain
        for n in (r["nodes"][0], r["nodes"][-1]):
            if n in first:
                parent[root(k)] = root(first[n])
            else:
                first[n] = k
    chains = {}
    for k, r in enumerate(links):
        c = chains.setdefault(root(k), {"refs": set(), "xy": []})
        for n in (r["nodes"][0], r["nodes"][-1]):
            c["refs"] |= ref_of_node.get(n, set())
        c["xy"].append(r["xy"].mean(axis=0))
    ramps = [np.mean(c["xy"], axis=0) for c in chains.values() if len(c["refs"]) >= 2]
    if not ramps:
        return np.zeros((0, 2))
    ramps = np.array(ramps)
    # cluster ramp centres within 1.5 km
    label = -np.ones(len(ramps), dtype=int)
    tree = cKDTree(ramps)
    k = 0
    for i in range(len(ramps)):
        if label[i] >= 0:
            continue
        stack = [i]
        label[i] = k
        while stack:
            j = stack.pop()
            for m in tree.query_ball_point(ramps[j], 1500):
                if label[m] < 0:
                    label[m] = k
                    stack.append(m)
        k += 1
    return np.array([ramps[label == c].mean(axis=0) for c in range(k)])


def tune(roads, samples, inv, tune_ids, tune_area, urban_at):
    """Measure, per surface road class, lamps per km of lit road and the share of road that is lit, on the
    inventories in `tune_ids` inside `tune_area` (a mask over road sample points) and in built-up cells."""
    pts, ridx, wts = samples
    cls = np.array([roads[k]["cls"] for k in ridx], dtype=object)
    lamps_xy = np.vstack([inv[s]["xy"] for s in tune_ids])
    lamps_type = np.concatenate([inv[s]["type"] for s in tune_ids])
    lamps_w = np.concatenate([inv[s]["watts"] for s in tune_ids])
    area = tune_area & urban_at
    tree_pts = cKDTree(pts[area])
    d, j = tree_pts.query(lamps_xy, k=1, distance_upper_bound=ASSIGN_M)
    ok = np.isfinite(d)
    lamp_cls = np.full(len(lamps_xy), None, dtype=object)
    lamp_cls[ok] = cls[area][j[ok]]
    dl, _ = cKDTree(lamps_xy).query(pts, k=1, distance_upper_bound=LIT_M)
    lit_pt = np.isfinite(dl)
    out = {}
    for c in SURFACE_GEOMETRY:
        sel = area & (cls == c)
        total = float(wts[sel].sum())
        lit = float(wts[sel & lit_pt].sum())
        n = int((lamp_cls == c).sum())
        watts = {}
        for t in ("hps", "led_street"):
            ws = [float(w) for w, tt, cc in zip(lamps_w, lamps_type, lamp_cls) if cc == c and tt == t and w]
            watts[t] = float(np.median(ws)) if ws else L.TYPE_BY_KEY[t]["defaultWatts"]
        out[c] = {"spacing": lit / n if n else 0.0, "litFraction": lit / total if total else 0.0,
                  "lamps": n, "litKm": lit / 1000, "totalKm": total / 1000, "medianWatts": watts,
                  **SURFACE_GEOMETRY[c]}
    return out


def self_consistent(roads, road_mask, params, truth_xy, seed, rounds=3):
    """Correct the measured spacing and share of lit road so that the rule, run over the tuning area itself,
    reproduces that inventory's lamp count and pole spacing. The hold-out then tests the result elsewhere."""
    params = {c: dict(p) for c, p in params.items()}
    truth_n, truth_nn = len(truth_xy), L.median_nn(L.merge_heads(truth_xy))
    log = []
    for _ in range(rounds):
        xy, _ = rule_lamps(roads, road_mask, params, None, seed + "-tune")
        n, nn = len(xy), L.median_nn(xy)
        log.append({"ruleLamps": n, "inventoryLamps": truth_n, "ruleSpacingM": nn, "inventorySpacingM": truth_nn})
        f_nn, f_n = truth_nn / nn, truth_n / max(n, 1)
        for p in params.values():
            p["spacing"] *= f_nn
            p["litFraction"] = min(1.0, p["litFraction"] * f_n * f_nn)
    xy, _ = rule_lamps(roads, road_mask, params, None, seed + "-tune")
    log.append({"ruleLamps": len(xy), "inventoryLamps": truth_n, "ruleSpacingM": L.median_nn(xy), "inventorySpacingM": truth_nn})
    return params, log


def rule_lamps(roads, eligible, params, avoid_xy, seed):
    surface = {c: p for c, p in params.items() if c in SURFACE_GEOMETRY}
    fw = {c: p for c, p in params.items() if c in FREEWAY_RULE}
    xy1, c1 = L.place_rule(roads, eligible, surface, avoid_xy, AVOID_M["surface"], seed) if surface else (np.zeros((0, 2)), np.array([], dtype=object))
    xy2, c2 = L.place_rule(roads, eligible, fw, avoid_xy, AVOID_M["freeway"], seed) if fw else (np.zeros((0, 2)), np.array([], dtype=object))
    return np.vstack([xy1, xy2]), np.concatenate([c1, c2])


def rule_attributes(xy, cls, params, mix, seed):
    types, watts, mount = [], [], []
    keys, probs = list(mix), np.cumsum(list(mix.values()))
    for i, (p, c) in enumerate(zip(xy, cls)):
        if c in FREEWAY_RULE:
            t, w, m = FREEWAY_RULE[c]["type"], FREEWAY_RULE[c]["watts"], FREEWAY_RULE[c]["mountM"]
        else:
            u = L.stable_hash(seed, "type", round(p[0], 1), round(p[1], 1))
            t = keys[int(np.searchsorted(probs, u, side="right"))] if u < probs[-1] else keys[-1]
            w = params[c]["medianWatts"].get(t, L.TYPE_BY_KEY[t]["defaultWatts"])
            m = SURFACE_GEOMETRY[c]["mountM"]
        types.append(t)
        watts.append(w)
        mount.append(m)
    return np.array(types, dtype=object), np.array(watts, dtype=object), np.array(mount, dtype=float)


# ---------------------------------------------------------------- main
def main(city):
    cfg, proj, grid = setup(city)
    to_local = Transformer.from_crs("EPSG:4326", proj, always_xy=True)
    bb = bbox_ll(proj, grid)
    out_derived = ROOT / "data" / "derived" / city
    out_public = ROOT / "public" / "data" / city
    out_derived.mkdir(parents=True, exist_ok=True)

    print("inventories")
    inv = {s["id"]: read_inventory(s, city, to_local) for s in INVENTORIES[city]}
    print("OpenStreetMap: lamps, roads, boundaries")
    osm_raw = osm_lamps(city, bb)
    inv["osm"] = read_osm_lamps(osm_raw, to_local)
    roads = read_roads(osm_roads(city, bb), to_local)
    bounds_raw = osm_boundaries(city, bb)
    bounds = boundary_polygons(bounds_raw, to_local)
    print(f"  {len(roads):,} road ways; boundaries: {sorted(bounds)}")

    # road samples and the built-up area
    samples = L.sample_roads(roads, 10.0)
    pts, ridx, wts = samples
    cls_pt = np.array([roads[k]["cls"] for k in ridx], dtype=object)
    urban = L.urban_mask(pts, wts, cls_pt, grid, URBAN_KM_PER_KM2)
    c, r = L.grid_index(pts, grid)
    urban_pt = np.zeros(len(pts), dtype=bool)
    urban_pt[c >= 0] = urban[r[c >= 0], c[c >= 0]]
    mid = np.array([rd["xy"][len(rd["xy"]) // 2] for rd in roads])
    cm, rm = L.grid_index(mid, grid)
    urban_road = np.zeros(len(roads), dtype=bool)
    urban_road[cm >= 0] = urban[rm[cm >= 0], cm[cm >= 0]]

    def inside(name, xy):
        if name not in bounds:
            raise SystemExit(f"boundary {name!r} not found in OSM; have {sorted(bounds)}")
        return contains_xy(bounds[name], xy[:, 0], xy[:, 1])

    report = {"city": city, "built": date.today().isoformat(), "credit": CREDIT[city],
              "licence": "Inventories treated as public domain by the owner's decision of 10 November 2026 (plan 01, 2.3; plan 02, decisions after planning); none of the layers names a licence. OpenStreetMap data: ODbL 1.0, (c) OpenStreetMap contributors.",
              "grid": {k: grid[k] for k in ("x0", "y0", "x1", "y1", "cell", "nx", "ny")},
              "builtUpCells": int(urban.sum()), "builtUpThresholdKmPerKm2": URBAN_KM_PER_KM2}

    # ---- tuning and hold-out (Las Vegas: the inventories themselves; elsewhere: Las Vegas's numbers)
    tuned_from = city
    if city in TUNE_SOURCES:
        incorporated = np.zeros(len(pts), dtype=bool)
        for name in bounds:
            incorporated |= inside(name, pts)
        tune_area = inside("Las Vegas", pts) | ~incorporated  # the city and the unincorporated county
        params = tune(roads, samples, inv, TUNE_SOURCES[city], tune_area, urban_pt)
        tune_road = (inside("Las Vegas", mid) | ~np.any([inside(n, mid) for n in bounds], axis=0)) & urban_road
        truth = np.vstack([inv[k]["xy"] for k in TUNE_SOURCES[city]])
        cu, ru = L.grid_index(truth, grid)
        in_area = inside("Las Vegas", truth) | ~np.any([inside(n, truth) for n in bounds], axis=0)
        in_area &= cu >= 0
        in_area[in_area] &= urban[ru[in_area], cu[in_area]]
        params, consistency = self_consistent(roads, tune_road, params, truth[in_area], city)
        report["ruleSelfConsistency"] = consistency
    else:
        lv = json.loads((ROOT / "data" / "derived" / "lv" / "lights_report.json").read_text())
        params = {c: {k: v for k, v in p.items()} for c, p in lv["rule"]["surface"].items()}
        tuned_from = "lv"
    params_all = {**params, **{c: dict(p) for c, p in FREEWAY_RULE.items()}}
    seed = city

    holdout = None
    if city in HOLDOUT:
        hid, hname = HOLDOUT[city]
        in_h_road = inside(hname, mid) & urban_road
        others = np.vstack([inv[k]["xy"] for k in inv if k != hid])
        hxy, hcls = rule_lamps(roads, in_h_road, params, others, seed + "-holdout")
        truth = inv[hid]["xy"]
        truth_in = truth[inside(hname, truth)]
        holdout = {"inventory": hid, "jurisdiction": hname, "inventoryLamps": int(len(truth_in)),
                   "ruleLamps": int(len(hxy)), "countRatio": len(hxy) / max(1, len(truth_in)),
                   "inventoryMedianSpacingM": L.median_nn(L.merge_heads(truth_in)), "ruleMedianSpacingM": L.median_nn(hxy),
                   "spacingMetric": "median distance from each pole to its nearest neighbour; lamps within 5 m of each other (heads on one pole) counted as one pole"}
        holdout["spacingRatio"] = holdout["ruleMedianSpacingM"] / holdout["inventoryMedianSpacingM"]
        holdout["pass"] = bool(abs(holdout["countRatio"] - 1) <= 0.20 and abs(holdout["spacingRatio"] - 1) <= 0.15)
        holdout["acceptance"] = "count within 20 % and median nearest-neighbour spacing within 15 % (plan 02, D5.3)"
        print(f"hold-out {hname}: rule {len(hxy):,} vs inventory {len(truth_in):,} lamps "
              f"({holdout['countRatio']:.2f}); median spacing {holdout['ruleMedianSpacingM']:.1f} vs "
              f"{holdout['inventoryMedianSpacingM']:.1f} m ({holdout['spacingRatio']:.2f}) -> {'pass' if holdout['pass'] else 'FAIL'}")

    # ---- merge sources: inventories first, OSM last; 5 m de-duplication across sources
    order = [s["id"] for s in INVENTORIES[city]] + ["osm"]
    masks, drops = L.dedupe([(k, inv[k]["xy"]) for k in order], 5.0)
    kept = {k: m for k, m in zip(order, masks)}
    known_xy = np.vstack([inv[k]["xy"][kept[k]] for k in order])

    # ---- the rule where nothing is known
    gaps = GAP_JURISDICTIONS[city]
    if gaps is None:
        gap_road = urban_road.copy()
    else:
        gap_road = np.zeros(len(roads), dtype=bool)
        for name in gaps:
            gap_road |= inside(name, mid)
        gap_road &= urban_road
    is_fw = np.array([rd["cls"] in FREEWAY_RULE for rd in roads])
    eligible = np.where(is_fw, urban_road, gap_road)
    rxy, rcls = rule_lamps(roads, eligible, params_all, known_xy, seed)
    # high masts at system interchanges without one
    centres = system_interchanges(roads)
    mast_types = {"led_highmast"}
    known_masts = np.vstack([inv[k]["xy"][kept[k]][np.isin(inv[k]["type"][kept[k]], list(mast_types))] for k in order])
    mxy = []
    for cc in centres:
        if len(known_masts) and np.min(np.hypot(*(known_masts - cc).T)) < HIGHMAST["skipIfMastWithinM"]:
            continue
        for a in range(HIGHMAST["perInterchange"]):
            ang = 2 * math.pi * a / HIGHMAST["perInterchange"] + math.pi / 4
            mxy.append(cc + HIGHMAST["radiusM"] * np.array([math.cos(ang), math.sin(ang)]))
    mxy = np.array(mxy).reshape(-1, 2)
    mxy = mxy[(L.grid_index(mxy, grid)[0] >= 0)] if len(mxy) else mxy
    rtype, rwatts, rmount = rule_attributes(rxy, rcls, params_all, RULE_MIX[city], seed)
    if len(mxy):
        rxy = np.vstack([rxy, mxy])
        rcls = np.concatenate([rcls, np.array(["highmast"] * len(mxy), dtype=object)])
        rtype = np.concatenate([rtype, np.array(["led_highmast"] * len(mxy), dtype=object)])
        rwatts = np.concatenate([rwatts, np.array([HIGHMAST["watts"]] * len(mxy), dtype=object)])
        rmount = np.concatenate([rmount, np.full(len(mxy), HIGHMAST["mountM"])])
    print(f"rule: {len(rxy):,} lamps ({Counter(rcls)}), {len(mxy)} high masts at {len(centres)} system interchanges")

    # ---- assemble the layer
    xs, types, watts, mount, aim, src, encl = [], [], [], [], [], [], []
    for k in order:
        m = kept[k]
        xs.append(inv[k]["xy"][m]); types += list(inv[k]["type"][m]); watts += list(inv[k]["watts"][m])
        mount.append(inv[k]["mount"][m]); aim.append(inv[k]["aim"][m]); src += [k] * int(m.sum())
        encl.append(inv[k]["enclosed"][m])
    encl.append(np.zeros(len(rxy), dtype=bool))
    encl = np.concatenate(encl)
    xs.append(rxy); types += list(rtype); watts += list(rwatts); mount.append(rmount)
    aim.append(np.full(len(rxy), math.nan)); src += ["rule"] * len(rxy)
    xy = np.vstack(xs)
    mount = np.concatenate(mount)
    aim = np.concatenate(aim)
    flux = np.array([L.lumens(t, w) for t, w in zip(types, watts)])
    type_id = np.array([L.TYPE_BY_KEY[t]["id"] for t in types], dtype=np.uint8)
    flags = np.array([(L.FLAG_RULE if s == "rule" else 0) | (SOURCE_IDS[s] << 1) | (L.FLAG_ENCLOSED if e else 0)
                      for s, e in zip(src, encl)], dtype=np.uint8)
    rec = L.encode_lamps(xy, mount, type_id, flags, flux, aim)
    rec.tofile(out_derived / "lamps.bin")
    flux_q = rec["flux_10lm"].astype(np.float64) * 10  # what the layer stores; the cells sum exactly this
    lcls = np.array([L.lamp_class(t) for t in types], dtype=object)

    # ---- cells
    sky = ~encl  # tunnel and under-bridge lights send nothing up
    cells, outside_lm = L.cell_sums(xy[sky], flux_q[sky], lcls[sky], grid)
    planes = np.stack([cells[k] for k in L.CLASSES]).astype("<f4")
    planes.tofile(out_public / "lamp-cells.bin")
    cell_meta = {
        "file": "lamp-cells.bin", "layout": "LampCells (plan 01, 11.7): three float32 little-endian planes, sodiumLm, ledLm, otherLm, each ny rows of nx cells, row 0 = south, column 0 = west",
        "units": "initial lamp lumens per cell", "order": L.CLASSES,
        "x0": grid["x0"], "y0": grid["y0"], "z0": -grid["y0"], "step": grid["cell"], "nx": grid["nx"], "ny": grid["ny"], "nz": grid["ny"],
        "frame": "local metres of public/data/" + city + "/terrain.json (x east, y north); world z = -y, so row j spans world z from z0 - j*step to z0 - (j+1)*step",
        "projection": proj,
        "totalsLm": {k: float(cells[k].sum()) for k in L.CLASSES}, "lampsInGrid": int((L.grid_index(xy[sky], grid)[0] >= 0).sum()),
        "excluded": {"enclosedLamps": int(encl.sum()), "enclosedLm": float(flux_q[encl].sum()), "why": "under bridges (Clark County SUPP_TYPE UBL) or tunnel luminaires: they light the road and send nothing to the sky"},
        "lampsOutsideGrid": int((L.grid_index(xy, grid)[0] < 0).sum()), "lumensOutsideGrid": outside_lm,
        "source": "scripts/build_lights.py; lamps from data/derived/" + city + "/lamps.bin; see data/derived/" + city + "/lights_report.json",
        "credit": CREDIT[city],
    }
    (out_public / "lamp-cells.json").write_text(json.dumps(cell_meta, indent=1))

    layer_meta = {
        "file": "lamps.bin", "count": int(len(rec)), "recordBytes": L.LAMP_DTYPE.itemsize,
        "layout": [{"name": n, "type": str(L.LAMP_DTYPE[n])} for n in L.LAMP_DTYPE.names],
        "fields": {"x_mm, y_mm": "local metres x 1000, x east, y north, in the frame of public/data/" + city + "/terrain.json",
                   "mount_dm": "mounting height in decimetres", "type": "id in data/lamp_types.json",
                   "flags": "bit 0: placed by rule; bits 1-3: source id (sourceIds); bit 4: enclosed (under a bridge or in a tunnel; left out of lamp-cells)",
                   "flux_10lm": "initial lumens / 10", "aim_cdeg": "arm direction in hundredths of a degree as the source gives it (City of Las Vegas ROT_ANG); 65535 = unknown"},
        "sourceIds": SOURCE_IDS, "projection": proj,
        "note": "The drive plan's tile pyramid (plan 02, 6.9) is deferred, so the layer is one file per city, to be cut into lamps/{L}/{x}/{y}.bin tiles when the pyramid exists.",
    }
    (out_derived / "lamps.json").write_text(json.dumps(layer_meta, indent=1))

    # ---- report
    src_arr = np.array(src, dtype=object)
    by = lambda keys: dict(sorted(Counter(keys).items(), key=lambda kv: -kv[1]))  # noqa: E731
    report.update({
        "lamps": int(len(rec)),
        "bySource": by(src),
        "byType": by(types),
        "byClass": by(lcls),
        "lumensByClass": {k: float(flux_q[lcls == k].sum()) for k in L.CLASSES},
        "bySourceAndClass": {s: by(lcls[src_arr == s]) for s in order + ["rule"]},
        "ruleShare": len(rxy) / max(1, len(rec)),
        "enclosed": {"lamps": int(encl.sum()), "lumens": float(flux_q[encl].sum())},
        "ruleByRoadClass": by(rcls),
        "dedupe": {"radiusM": 5.0, "droppedBySource": drops, "note": "across sources only; inventories outrank OSM in the order " + ", ".join(order),
                   "sameSourcePairsWithin5m": {k: L.near_pairs_within(inv[k]["xy"]) for k in order}},
        "sources": {k: {"jurisdiction": inv[k]["jurisdiction"], "lamps": int(len(inv[k]["xy"])), "kept": int(kept[k].sum()),
                        "byType": by(inv[k]["type"]), "provenance": inv[k].get("prov"),
                        **({"mountFromSupports": inv[k]["supportMatched"]} if inv[k].get("supportMatched") is not None else {}),
                        **({"tagged": inv[k]["tagged"]} if "tagged" in inv[k] else {})} for k in order},
        "osm": {"timestampRoads": None, "roadWays": len(roads), "timestamp": osm_raw.get("osm3s", {}).get("timestamp_osm_base"),
                "endpoint": fetch.OVERPASS, "retrieved": fetch.retrieved(ROOT / "data" / "raw" / city / "osm-street-lamps.json"),
                "boundaries": sorted(bounds)},
        "rule": {"tunedFrom": tuned_from, "surface": params, "freeway": FREEWAY_RULE, "mix": RULE_MIX[city],
                 "gapJurisdictions": gaps if gaps is not None else "all built-up roads (no inventory)",
                 "highMasts": {**HIGHMAST, "systemInterchanges": int(len(centres)), "placed": int(len(mxy))},
                 "assignM": ASSIGN_M, "litM": LIT_M, "avoidM": AVOID_M,
                 "assumed": ["freeway and ramp spacing, mount height and wattage", "the sodium/LED mix of rule lamps",
                             "high masts: four per system interchange that has none in an inventory",
                             *(["Salt Lake City's spacing and share of lit road are Las Vegas's"] if tuned_from != city else [])]},
        "holdout": holdout,
        "assumptions": [
            "City of Las Vegas TYPE is used as recorded (34,454 sodium against 17,094 LED), although a 2011-2013 programme reported converting most of the city's lights to LED (plan 02, 6.6); to be checked against night photographs (plan 02, 8.1)",
            "City of Las Vegas STATUS codes (X, N, OUT, D, AR) are undocumented; every record is kept",
            "Henderson's decorative fixture styles (ANTHEM, INSPIRADA, SEVEN HILLS, LANDWELL, WATER STREET) are taken as LED",
            "Boulder City records with a blank LAMP_TYPE are taken as LED (the layer is the city's dark-sky LED replacement)",
            "two lamps from the same inventory within 5 m are kept: they are usually two heads on one pole",
        ],
    })
    (out_derived / "lights_report.json").write_text(json.dumps(report, indent=1, default=float))

    print(f"{len(rec):,} lamps: {report['bySource']}")
    print(f"by class: {report['byClass']}; lumens: " + ", ".join(f"{k} {v / 1e6:.1f} Mlm" for k, v in report["lumensByClass"].items()))
    print(f"rule share {report['ruleShare']:.1%}; lamp-cells {grid['nx']}x{grid['ny']}, outside grid {cell_meta['lampsOutsideGrid']:,} lamps")
    if holdout and not holdout["pass"]:
        print("hold-out acceptance missed (plan 02, D5.3)")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
