# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyproj", "requests", "scipy", "shapely", "pillow"]
# ///
"""Usage: build_flight_lights.py [<city>] [--half-km 360] [--refresh] [--dry]

The towns of the region at night, as lamp points for the flight (plan 03, F6.4, section 7.11 "Towns outside the
valley"). The valley itself is the drive's lamp product (public/data/<city>/lamps-drive.bin, scripts/pack_lamps.py:
the county, city, Henderson and Boulder City inventories with plan 02's rule fill), which the flight draws as it is;
this script makes only what lies outside it: Mesquite, St George, Pahrump, Kingman, Bullhead City and Laughlin,
Barstow, Cedar City, the casinos at Primm and the rest that the satellite sees lit within --half-km of the city.

1. Where there is light: NASA's Black Marble (VIIRS day/night band, 2016 annual composite, as GIBS serves it,
   layer VIIRS_Black_Marble), one picture over the region, sampled onto 500 m local cells. The picture is a display
   product (stretched, saturating in every town's core, blooming past its edges), so it says where, not how much:
   a cell is lit above lib.flight_lights.LIT_LEVEL. The plan's source, Black Marble VNP46A4 radiance, needs an
   Earthdata login this build does not have (scripts/build_nightlights.py reads it when one is given).
2. What the valley already has: cells within COVER_M of an inventory lamp are left to the inventory.
3. Towns: the lit cells left, grouped (8-neighbour); each group's people from OpenStreetMap's place nodes
   (city, town, village) within PLACE_M of it.
4. How much light: lumens per person, calibrated on the valley: the inventory's lumens over the people of the
   places inside it, from the same two sources. A town's lumens are its people times that. A group with no place
   (a casino strip, a prison, a mine) gets its lit area times the median lumens per lit km^2 of the towns that have
   people, halved (ASSUMED).
5. Where the lamps stand: plan 02's rule along the group's OpenStreetMap roads (motorway to residential), with the
   rule's spacing, lit share and wattage per road class as tuned on the Las Vegas inventories
   (data/derived/<city>/lights_report.json "rule") and its lamp-type mix; then thinned in a fixed order to the town's
   lumens, or brightened at most threefold where the rule placed too few. A group without roads gets points hashed
   into its lit cells.
6. The pack: the drive's lamp-pack layout (version 1, src/drive/lights/pack.js decodeLampPack reads it) with
   4,096 m cells and 1/16 m positions; within a cell the lamps are in hash order (the flight draws a thinned cell's
   first lamps).

Sources (each also in the output's `sources`, with the date it was read):
  - NASA Black Marble 2016 (VIIRS_Black_Marble) through NASA GIBS WMS, https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi
    NASA imagery, no copyright (NASA's media usage guidelines); credit "NASA Earth Observatory / GIBS, Black Marble".
  - OpenStreetMap roads and places through the Overpass API (https://overpass-api.de), ODbL 1.0,
    (c) OpenStreetMap contributors.
  - The valley's lamp inventory (public/data/<city>/lamps-drive.bin): Clark County Public Works, City of Las Vegas,
    City of Henderson, Boulder City; treated as public domain by the owner's decision of 10 November 2026.
Fetched 24 November 2026. Requests carry only the User-Agent "skyline-data/1.0" (lib.fetch), one at a time.
Raw answers are kept under data/raw/flight_lights/ (git-ignored; about 30 to 80 MB).

Output: public/data/<city>/lights-region.bin, lights-region.json
        data/raw/flight_lights/report-<city>.json   (every town with its places, the calibration, the lit mask's agreement;
                                                     not committed)
"""
import argparse
import hashlib
import io
import json
import math
import sys
from datetime import date
from pathlib import Path

import numpy as np
from pyproj import Transformer
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import fetch  # noqa: E402
from lib import flight_lights as F  # noqa: E402
from lib import lamps as L  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "flight_lights"
GIBS_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi"
LAYER = "VIIRS_Black_Marble"
DEG_PER_PX = 0.0045  # the layer's native 500 m
CELL_M = 500.0
COVER_M = 1500.0  # a lit cell this close to an inventory lamp is the inventory's
PLACE_M = 3000.0  # a place node this close to a group's cells is its
MIN_CELLS = 2  # a group smaller than 0.5 km^2 is left out (a ranch, a lit pad)
ROADS_FROM_CELLS = 20  # a group of this many cells (5 km^2), or with ROADS_FROM_PEOPLE, gets its roads fetched; others hashed points
ROADS_FROM_PEOPLE = 500
NO_PEOPLE_SHARE = 0.5  # ASSUMED: lumens per lit km^2 of a group without a place, as a share of the towns' median
PACK_CELL, PACK_Q = 4096, 16
BLOOM_CELLS = 3  # a group without people within this many cells of the inventory's is the satellite's bloom around the valley
ROAD_RANGE_M = 220_000.0  # beyond this a town is drawn as points hashed into its lit cells (2 x 2 cells each): its streets
#                          are far below a pixel from anywhere a flight goes, and its roads would be hundreds of megabytes
POINT_LM = 8000.0  # lumens a hashed point stands for, at most 4 (far) or 8 (near) points per block
SEED = "flight-lights-1"
PLACES = "city|town|village"
ROAD_HIGHWAYS = ("motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|"
                 "motorway_link|trunk_link|primary_link|secondary_link|tertiary_link")
CREDIT = ("Town lights: NASA Black Marble (GIBS) for where, OpenStreetMap contributors (ODbL) for roads and people, "
          "calibrated on the street lights of Clark County, the City of Las Vegas, the City of Henderson and Boulder City.")


def setup(city):
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    proj = json.loads((ROOT / "public" / "data" / city / "terrain.json").read_text())["projection"]
    return cfg, Transformer.from_crs(proj, "EPSG:4326", always_xy=True), Transformer.from_crs("EPSG:4326", proj, always_xy=True)


def bbox_of(g, to_ll, margin_m=0.0):
    xs = [g["x0"] - margin_m, g["x0"] + g["nx"] * g["cell"] + margin_m]
    ys = [g["y0"] - margin_m, g["y0"] + g["ny"] * g["cell"] + margin_m]
    pts = [to_ll.transform(x, y) for x in np.linspace(*xs, 9) for y in np.linspace(*ys, 9)]
    return min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)


def black_marble(bbox, refresh=False):
    """The picture (h, w, 3 uint8), its bbox and its URL."""
    from PIL import Image
    w0, s0, e0, n0 = bbox
    w = int(math.ceil((e0 - w0) / DEG_PER_PX))
    h = int(math.ceil((n0 - s0) / DEG_PER_PX))
    url = (f"{GIBS_WMS}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS={LAYER}&STYLES=&SRS=EPSG%3A4326&FORMAT=image%2Fpng"
           f"&BBOX={w0:.6f}%2C{s0:.6f}%2C{e0:.6f}%2C{n0:.6f}&WIDTH={w}&HEIGHT={h}")
    key = hashlib.sha1(url.encode()).hexdigest()[:10]
    ctype, body = fetch.cached_get(url, RAW / f"blackmarble-{key}.png", refresh=refresh)
    if "png" not in ctype:
        raise RuntimeError(f"GIBS answered {ctype}: {body[:300]!r}")
    rgb = np.asarray(Image.open(io.BytesIO(body)).convert("RGB"))
    return rgb, bbox, url, RAW / f"blackmarble-{key}.png"


def inventory_xy(meta, data):
    """Map positions of the drive's lamp product (the same pack layout)."""
    d = F.decode_pack(meta, data)
    return np.column_stack([d["x"], d["y"]])


def inventory(city):
    meta = json.loads((ROOT / "public" / "data" / city / "lamps-drive.json").read_text())
    data = (ROOT / "public" / "data" / city / meta["file"]).read_bytes()
    d = F.decode_pack(meta, data)
    return meta, np.column_stack([d["x"], d["y"]]), d["lumens"]


def overpass_places(bbox, refresh=False):
    w, s, e, n = bbox
    q = f'[out:json][timeout:300];node["place"~"^({PLACES})$"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});out body;'
    cache = RAW / f"places-{hashlib.sha1(q.encode()).hexdigest()[:10]}.json"
    if refresh and cache.exists():
        cache.unlink()
    return fetch.overpass(q, cache), cache


def overpass_roads(bbox, refresh=False):
    w, s, e, n = bbox
    q = f'[out:json][timeout:600];way["highway"~"^({ROAD_HIGHWAYS})$"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});out body geom;'
    cache = RAW / f"roads-{hashlib.sha1(q.encode()).hexdigest()[:10]}.json"
    if refresh and cache.exists():
        cache.unlink()
    return fetch.overpass(q, cache), cache


def population(tags):
    v = str(tags.get("population", "")).replace(",", "").replace(" ", "").split(";")[0]
    try:
        return float(v)
    except ValueError:
        return 0.0


def read_places(doc, to_local):
    out = []
    for el in doc.get("elements", []):
        if el.get("type") != "node":
            continue
        t = el.get("tags", {})
        p = population(t)
        x, y = to_local.transform(el["lon"], el["lat"])
        out.append({"name": t.get("name", "?"), "place": t.get("place"), "population": p, "x": float(x), "y": float(y),
                    "id": el["id"]})
    return out


def read_roads(doc, to_local):
    roads, seen = [], set()
    for el in doc.get("elements", []):
        if el.get("type") != "way" or el["id"] in seen or "geometry" not in el:
            continue
        seen.add(el["id"])
        tg = el.get("tags", {})
        cls = L.ROAD_CLASS.get(tg.get("highway"))
        if not cls or tg.get("area") == "yes":
            continue
        g = [p for p in el["geometry"] if p]
        if len(g) < 2:
            continue
        x, y = to_local.transform([p["lon"] for p in g], [p["lat"] for p in g])
        lit = tg.get("lit")
        roads.append({"id": el["id"], "xy": np.column_stack([x, y]), "cls": cls,
                      "lit": "yes" if lit in ("yes", "24/7", "automatic", "sunset-sunrise", "limited") else ("no" if lit == "no" else None)})
    return roads


def rule_params(city):
    rep = json.loads((ROOT / "data" / "derived" / city / "lights_report.json").read_text())["rule"]
    return rep["surface"], rep["freeway"], rep["mix"]


def place_town_lamps(roads, cell_ok, surface, freeway, mix, seed):
    """Rule lamps on the roads of one town (the parts of them inside its lit cells). Returns xy, type keys, watts,
    mount, ids (stable strings)."""
    if not roads:
        return np.zeros((0, 2)), [], [], np.zeros(0), []
    eligible = [bool(cell_ok(r["xy"][:, 0], r["xy"][:, 1]).any()) for r in roads]
    params = {**{c: dict(p) for c, p in surface.items()}, **{c: dict(p) for c, p in freeway.items()}}
    xy1, c1 = L.place_rule(roads, eligible, {c: p for c, p in params.items() if c in surface}, None, 0, seed)
    xy2, c2 = L.place_rule(roads, eligible, {c: p for c, p in params.items() if c in freeway}, None, 0, seed)
    xy = np.vstack([xy1, xy2]) if len(xy1) or len(xy2) else np.zeros((0, 2))
    cls = list(c1) + list(c2)
    inside = cell_ok(xy[:, 0], xy[:, 1]) if len(xy) else np.zeros(0, bool)
    xy = xy[inside]
    cls = [c for c, k in zip(cls, inside) if k]
    keys, probs = list(mix), np.cumsum(list(mix.values()))
    types, watts, mount, ids = [], [], [], []
    for p, c in zip(xy, cls):
        if c in freeway:
            t, w, m = freeway[c]["type"], freeway[c]["watts"], freeway[c]["mountM"]
        else:
            u = L.stable_hash(seed, "type", round(p[0], 1), round(p[1], 1))
            t = keys[int(np.searchsorted(probs, u, side="right"))] if u < probs[-1] else keys[-1]
            w = surface[c]["medianWatts"].get(t, L.TYPE_BY_KEY[t]["defaultWatts"])
            m = surface[c]["mountM"]
        types.append(t)
        watts.append(w)
        mount.append(m)
        ids.append(f"{round(p[0], 1)},{round(p[1], 1)}")
    return xy, types, watts, np.array(mount, float), ids




def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city", nargs="?", default="lv")
    ap.add_argument("--half-km", type=float, default=360.0)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--dry", action="store_true", help="list the lit groups and their people, fetch no roads, write nothing")
    a = ap.parse_args()
    city = a.city
    cfg, to_ll, to_local = setup(city)
    g = F.grid_spec(a.half_km * 1000, CELL_M)
    bbox = bbox_of(g, to_ll, margin_m=2000)
    today = date.today().isoformat()

    # 1. where the satellite sees light
    rgb, bm_bbox, bm_url, bm_path = black_marble(bbox, a.refresh)
    cx, cy = F.cell_centres(g)
    lon, lat = to_ll.transform(cx.ravel(), cy.ravel())
    level = F.light_level(F.sample_picture(rgb, bm_bbox, np.asarray(lon), np.asarray(lat))).reshape(cx.shape)
    lit = F.lit_mask(level)
    print(f"Black Marble {rgb.shape[1]} x {rgb.shape[0]}: {int(lit.sum())} lit cells of {lit.size}")

    # 2. what the valley's inventory already lights
    inv_meta, inv_xy, inv_lm = inventory(city)
    covered = F.covered_mask(g, inv_xy, COVER_M)
    lamp_cells = np.zeros(lit.shape, bool)
    ci = F.cell_index(g, inv_xy[:, 0], inv_xy[:, 1])
    lamp_cells.ravel()[ci[ci >= 0]] = True
    region = inv_meta["region"]
    in_region = (cx >= region[0]) & (cx < region[2]) & (cy >= region[1]) & (cy < region[3])
    agree = F.lit_mask_agreement(lit[in_region], lamp_cells[in_region])
    print(f"lit mask against the inventory's cells inside its region: recall {agree['recall']:.2f}, precision {agree['precision']:.2f}")

    # 3. towns
    fill = lit & ~covered
    groups = F.clusters(fill, min_cells=MIN_CELLS)
    print(f"{len(groups)} lit groups outside the inventory ({sum(len(c['cells']) for c in groups)} cells)")
    places_doc, places_path = overpass_places(bbox, a.refresh)
    places = [p for p in read_places(places_doc, to_local) if p["population"] > 0]
    pc = F.cell_index(g, [p["x"] for p in places], [p["y"] for p in places])
    valley_places = [p for p, c in zip(places, pc) if c >= 0 and covered.ravel()[c]]
    valley_people = sum(p["population"] for p in valley_places)
    k = F.lumens_per_person(float(inv_lm.sum()), valley_people)
    print(f"valley: {valley_people:,.0f} people in {len(valley_places)} places, {inv_lm.sum():.3e} lm: {k:,.0f} lm a person")

    surface, freeway, mix = rule_params(city)
    remaining = [p for p in places if p not in valley_places]
    near_valley = ndimage.binary_dilation(covered, iterations=BLOOM_CELLS)
    with_people, kept_groups, dropped_bloom = [], [], 0
    for grp in groups:
        rows, cols = grp["cells"][:, 0], grp["cells"][:, 1]
        cxy = np.column_stack([cx[rows, cols], cy[rows, cols]])
        people, taken = F.place_people(remaining, cxy, PLACE_M)
        if people == 0 and near_valley[rows, cols].any():
            dropped_bloom += 1  # the satellite's bloom around the valley, not a town: the inventory lights that ground
            continue
        remaining = [p for p in remaining if p not in taken]
        grp.update(cxy=cxy, people=people, taken=taken, level=level[rows, cols], dmin=float(np.hypot(cxy[:, 0], cxy[:, 1]).min()))
        kept_groups.append(grp)
        if people > 0:
            with_people.append(k * people / (len(cxy) * CELL_M * CELL_M / 1e6))
    groups = kept_groups
    print(f"{len(groups)} groups kept, {dropped_bloom} without people next to the valley dropped as bloom")
    lm_per_km2_fallback = NO_PEOPLE_SHARE * float(np.median(with_people)) if with_people else 0.0
    if a.dry:
        for grp in groups:
            nm = max(grp["taken"], key=lambda p: p["population"])["name"] if grp["taken"] else "-"
            roads = grp["dmin"] <= ROAD_RANGE_M and (grp["people"] >= ROADS_FROM_PEOPLE or len(grp["cxy"]) >= ROADS_FROM_CELLS)
            print(f"  {nm}: {len(grp['cxy'])} cells, {grp['people']:,.0f} people, {grp['dmin'] / 1000:.0f} km, {'roads' if roads else 'points'}")
        return

    xs, ys, mounts, types, rules, lums = [], [], [], [], [], []
    towns, road_files = [], []
    for n_, grp in enumerate(groups):
        cxy, people = grp["cxy"], grp["people"]
        r0, c0, r1, c1 = grp["bbox"]
        local = np.zeros((r1 - r0 + 3, c1 - c0 + 3), bool)
        local[grp["cells"][:, 0] - r0 + 1, grp["cells"][:, 1] - c0 + 1] = True
        local = ndimage.binary_dilation(local, structure=np.ones((3, 3), bool))  # a street on a lit cell's edge counts

        def cell_ok(x, y, m=local, r0=r0, c0=c0):
            c = np.floor((np.asarray(x) - g["x0"]) / CELL_M).astype(int) - c0 + 1
            r = np.floor((np.asarray(y) - g["y0"]) / CELL_M).astype(int) - r0 + 1
            ok = (r >= 0) & (c >= 0) & (r < m.shape[0]) & (c < m.shape[1])
            out = np.zeros(np.shape(x), bool)
            out[ok] = m[r[ok], c[ok]]
            return out

        area_km2 = len(cxy) * CELL_M * CELL_M / 1e6
        target = k * people if people > 0 else lm_per_km2_fallback * area_km2
        seed = f"{SEED}|{grp['bbox']}"
        xy, tkeys, watts, mount, ids = np.zeros((0, 2)), [], [], np.zeros(0), []
        method = "points"
        if grp["dmin"] <= ROAD_RANGE_M and (people >= ROADS_FROM_PEOPLE or len(cxy) >= ROADS_FROM_CELLS):
            gb = {"x0": g["x0"] + (c0 - 1) * CELL_M, "y0": g["y0"] + (r0 - 1) * CELL_M, "cell": CELL_M, "nx": c1 - c0 + 3, "ny": r1 - r0 + 3}
            try:
                doc, path = overpass_roads(bbox_of(gb, to_ll), a.refresh)
                road_files.append(path)
                xy, tkeys, watts, mount, ids = place_town_lamps(read_roads(doc, to_local), cell_ok, surface, freeway, mix, seed)
                method = "roads"
            except Exception as err:  # Overpass busy after its retries: the town is drawn as points this time
                print(f"  roads for group {n_ + 1} not fetched ({err}); points instead")
        rule_lm = np.array([L.lumens(t, w) for t, w in zip(tkeys, watts)], float)
        if len(xy):
            keep, scale = F.fit_to_target(rule_lm, target, ids, seed)
            lm_out = rule_lm[keep] * scale
        else:
            method = "points"
            far = grp["dmin"] > ROAD_RANGE_M
            xy, lm_out = F.cell_points(cxy, grp["level"], CELL_M, target, seed, block=2 if far else 1,
                                       lumens_each=POINT_LM, max_per_block=4 if far else 8)
            tkeys = [("hps" if F.stable_hash(seed, "t", i) < mix.get("hps", 0.5) else "led_street") for i in range(len(xy))]
            mount = np.full(len(xy), 9.14)
            rule_lm = lm_out
            keep, scale = np.ones(len(xy), bool), 1.0
        name = max(grp["taken"], key=lambda p: p["population"]) if grp["taken"] else None
        towns.append({
            "name": name["name"] if name else f"lit area {n_ + 1}", "people": people, "places": [p["name"] for p in grp["taken"]],
            "x": round(name["x"]) if name else round(float(cxy[:, 0].mean())),
            "y": round(name["y"]) if name else round(float(cxy[:, 1].mean())),
            "km": round(grp["dmin"] / 1000, 1), "cells": int(len(cxy)), "method": method, "lamps": int(len(lm_out)),
            "lumens": round(float(lm_out.sum())), "ruleLumens": round(float(rule_lm.sum())), "scale": round(scale, 3),
            "targetLumens": round(target),
        })
        xs.append(xy[keep, 0]); ys.append(xy[keep, 1]); mounts.append(np.asarray(mount)[keep])
        types.append(np.array([L.TYPE_BY_KEY[t]["id"] for t in tkeys], int)[keep]); rules.append(np.ones(int(keep.sum()), bool))
        lums.append(lm_out)
        if people > 20000 or n_ < 30:
            t = towns[-1]
            print(f"  {t['name']}: {t['km']} km, {t['cells']} cells, {people:,.0f} people, {method}, {t['lamps']} lamps, {t['lumens']:.3e} lm")

    cat = lambda a_: np.concatenate(a_) if a_ else np.zeros(0)
    x, y = cat(xs), cat(ys)
    data, meta, _ = F.encode_pack(x, y, cat(mounts), cat(types).astype(int), cat(rules).astype(bool), cat(lums),
                                  (g["x0"], g["y0"], g["x0"] + g["nx"] * CELL_M, g["y0"] + g["ny"] * CELL_M),
                                  cell=PACK_CELL, q=PACK_Q, file="lights-region.bin")
    meta.update({
        "lampTypes": inv_meta["lampTypes"],
        "frame": f"public/data/{city}/terrain.json",
        "note": "The drive's lamp-pack layout (src/drive/lights/pack.js decodeLampPack) with 4,096 m cells and 1/16 m positions; "
                "within a cell the lamps are in hash order. Every lamp is placed by rule (kind bit 'rule'). Built by scripts/build_flight_lights.py.",
        "coverRadiusM": COVER_M,
        "calibration": {"lumensPerPerson": round(k, 1), "valleyPeople": valley_people, "valleyLumens": float(inv_lm.sum()),
                        "valleyPlaces": [p["name"] for p in valley_places], "noPeopleLumensPerKm2": round(lm_per_km2_fallback)},
        "litMask": {"source": LAYER, "level": F.LIT_LEVEL, "backgroundRed": F.BACKGROUND_RED, "cellM": CELL_M, "agreementInValley": agree},
        # the towns of 1,000 people or 100 lamps (the rest, and each town's places, are in the build's report)
        "towns": [{k: v for k, v in t.items() if k != "places"} for t in towns if t["people"] >= 1000 or t["lamps"] >= 100],
        "townsInReport": len(towns),
        "sources": [
            {"name": "NASA Black Marble 2016 (VIIRS_Black_Marble), NASA GIBS WMS", "url": bm_url, "licence": "NASA imagery, no copyright; credit NASA Earth Observatory / GIBS",
             "retrieved": fetch.retrieved(bm_path)},
            {"name": "OpenStreetMap places (city, town, village with population)", "url": fetch.OVERPASS, "licence": "ODbL 1.0, (c) OpenStreetMap contributors",
             "retrieved": fetch.retrieved(places_path)},
            {"name": f"OpenStreetMap roads ({len(road_files)} Overpass extracts)", "url": fetch.OVERPASS, "licence": "ODbL 1.0, (c) OpenStreetMap contributors",
             "retrieved": min((fetch.retrieved(p) for p in road_files), default=today)},
            {"name": "The valley's lamp inventory (lamps-drive.bin)", "url": f"public/data/{city}/lamps-drive.json",
             "licence": "Treated as public domain by the owner's decision of 10 November 2026", "retrieved": today},
        ],
        "credit": CREDIT,
        "built": today,
    })
    out = ROOT / "public" / "data" / city
    (out / "lights-region.bin").write_bytes(data)
    (out / "lights-region.json").write_text(json.dumps(meta, indent=1))
    rep = RAW / f"report-{city}.json"
    rep.write_text(json.dumps({"built": today, "count": meta["count"], "bytes": len(data), "towns": towns,
                               "calibration": meta["calibration"], "litMask": meta["litMask"]}, indent=1))
    print(f"lights-region.bin: {meta['count']} lamps, {len(data):,} bytes")


if __name__ == "__main__":
    main()
