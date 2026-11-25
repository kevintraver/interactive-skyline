# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pyogrio"]
# ///
"""Usage: build_traffic.py <city> [route ...]

Turn public traffic counts into the flows the drive's traffic is built from (plan 02, D6.1;
sections 5.8, 6.5 and 7.10). For each configured route and both directions:

  1. FHWA TMAS 2025 continuous counts for the state: one record per station, direction, lane and
     day with 24 hourly counts. Keep the route's stations; drop station-days with a lane missing
     (or a lane zero all day) and report them.
  2. 168 hour-of-week means per station, direction and season.
  3. Levels between counters from NDOT TRINA's 2025 AADT at short-term mainline stations, shaped by
     the nearest permanent station; linear in chainage between stations.
  4. Lane shares from the per-lane counts; free-flow speed from the posted limit plus lane offsets,
     capacity 2,300 pc/h/lane (both assumed, section 7.10); truck share from NDOT's 2023
     classification figures (section 6.5).
  5. Write public/data/<city>/traffic/<route>.json with provenance per segment, and the report.

Data. FHWA's own download page (fhwa.dot.gov/policyinformation/tables/tmasdata) answers scripts
with 403, so the TMAS 2025 records are taken from the same data as published in the National
Transportation Atlas Database: BTS's "Travel Monitoring Analysis System Volume" and "... Stations
Table" file geodatabases on ArcGIS Online (fields identical to the TMAS pipe-delimited format).
The state's rows are extracted once into TMAS pipe-delimited text under data/raw/<city>/traffic/,
which is what the pipeline reads; official TMAS pipe files dropped there under the same names are
read the same way. Raw downloads are cached; a rerun does not touch the network.

Output: public/data/<city>/traffic/<route>.json, data/derived/<city>/traffic_report.json
Exits non-zero when an acceptance check fails (the outputs are still written, to look at).
"""
import datetime as dt
import json
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import traffic as T  # noqa: E402
from lib.frame import create_frame  # noqa: E402
from lib.roadnet import decode_roadnet  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
UA = "road-pipeline/0.1"
YEAR = 2025

NTAD = {
    "volume": {"item": "5a9462b519854ec6a2334b3c0bdfc3c1", "zip": "TMAS_Volume_Table.zip",
               "title": "Travel Monitoring Analysis System Volume, 2025 (FHWA TMAS via BTS NTAD)"},
    "stations": {"item": "ac3f8dd9c4454c20b8d3b7ac5247c8f4", "zip": "TMAS_Stations_Table.zip",
                 "title": "Travel Monitoring Analysis System Stations Table, 2025 (FHWA TMAS via BTS NTAD)"},
}
ITEM_URL = "https://www.arcgis.com/sharing/rest/content/items/{}/data"
ITEM_PAGE = "https://www.arcgis.com/home/item.html?id={}"
TRINA = "https://gis.dot.nv.gov/arcgis/rest/services/Applications/TRINA/MapServer/1"
NOT_MAINLINE = re.compile(r"ramp|fly ?over|hov|frontage|\bto\b|\bfrom\b|intch to|ir\d+ intch to", re.I)

# Per city: the state's TMAS code. Per route: the two directions, the TRINA route name, which
# stations may give lane shares, and truck shares by stretch (NDOT 2023 classification report,
# trucks / AADT). A stretch starts at an exit ref of the route ("" = the route's start) and runs to
# the next stretch. "trinaRoute" may be a list (a route on two road numbers); "offRoute" admits a
# permanent station beyond an end of the route (within OFF_ROUTE_M) as a shape station there, and
# "trinaMarginDeg" widens the TRINA request to reach it. "plan" (the pattern plan 02 quotes for a
# station) is checked where the plan quotes one.
CITIES = {"lv": {"state": "32"}}
ROUTES = {
    "i15n": {
        "with": {"road": "i15n.main", "tmasDir": 1},
        "against": {"road": "i15s.opp", "tmasDir": 5},
        "trinaRoute": "IR15",
        "laneShareStations": ["0035440", "0035360", "0035340", "0031230"],
        # directional levels not trusted (lanes reported unevenly, plan 6.5): two-way total only
        "totalsOnly": ["0031210"],
        # partial-year stations take their uncounted seasons from this station (urban for urban)
        "borrowFrom": {"0035340": "0031210"},
        "laneShareNote": "0031210 left out: its lanes are reported unevenly by direction (plan 6.5)",
        "trucks": [
            {"fromExit": "", "share": 0.187, "source": "NDOT 2023: 18.7% Jean-Primm; held to St. Rose Pkwy"},
            {"fromExit": "27", "share": 0.079, "source": "NDOT 2023: 7.9% St. Rose-Flamingo; held to the Spaghetti Bowl"},
        ],
        "plan": {"station": "0035440", "withRatio": 1.36, "withPeak": 15, "againstRatio": 1.41, "againstPeak": 11},
    },
    "i15s": {
        "with": {"road": "i15s.main", "tmasDir": 5},
        "against": {"road": "i15n.opp", "tmasDir": 1},
        "trinaRoute": "IR15",
        # plan 6.5: 0035350 (3.2 mi north of the US-93 junction, past the route's start) is the
        # primary rural shape; 0031120 (north of Exit 58) counted September-December only
        "offRoute": {"0035350": "start"},
        "trinaMarginDeg": 0.06,
        "laneShareStations": ["0035350", "0031120", "0031230"],
        "totalsOnly": ["0031210"],
        "borrowFrom": {"0031120": "0035350"},
        "laneShareNote": "0031210 left out: its lanes are reported unevenly by direction (plan 6.5)",
        "trucks": [
            {"fromExit": "", "share": 0.232, "source": "NDOT 2023: 23.2% Speedway-US-93; held from Apex to the Speedway"},
            {"fromExit": "54", "share": 0.079, "source": "NDOT 2023: 7.9% (St. Rose-Flamingo, the urban I-15 figure); assumed from the Speedway to Russell Road"},
        ],
    },
    "us93": {
        "with": {"road": "us93.main", "tmasDir": 1},
        "against": {"road": "us93s.opp", "tmasDir": 5},
        # the bypass and Henderson are IR11 in TRINA; the former I-515 is still IR515
        "trinaRoute": ["IR11", "IR515"],
        "laneShareStations": ["0035410"],
        "trucks": [
            {"fromExit": "", "share": 0.213, "source": "NDOT 2023: 21.3% on the I-11 bypass; held through Henderson to Exit 62"},
            {"fromExit": "62", "share": 0.047, "source": "NDOT 2023: 4.7% on the former I-515, from Exit 62 to the Spaghetti Bowl"},
        ],
    },
}
WITH_WEEKDAY, AGAINST_WEEKDAY = 4, 6  # Friday northbound, Sunday southbound (plan 6.5)
ON_ROUTE_M = 200.0  # a station counts as on the route within this distance of its centreline
OFF_ROUTE_M = 8000.0  # an "offRoute" station may lie this far beyond the route's end
EXIT_MERGE_M = 600.0  # an opposing exit this close to one of ours is the same interchange


# ---------------------------------------------------------------- fetching

def fetch(url, path, tries=4):
    """Download url to path unless it is already there; retries with backoff; atomic rename."""
    if path.exists() and path.stat().st_size > 0:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(path.suffix + ".part")
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r, open(part, "wb") as f:
                shutil.copyfileobj(r, f, 1 << 20)
            part.rename(path)
            return True
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                raise
            print(f"  retry {i + 1} for {url}: {e}")
            time.sleep(2 ** i * 3)
    return False


def tmas_text(raw, state):
    """The state's TMAS volume and station records as pipe-delimited text, extracted from NTAD's
    geodatabases on first use. Returns (volume_path, stations_path)."""
    vol_txt, st_txt = raw / f"{state}_{YEAR}_volume.txt", raw / f"{state}_{YEAR}_stations.txt"
    if vol_txt.exists() and st_txt.exists():
        return vol_txt, st_txt
    from pyogrio.raw import read  # only needed for the one-off extraction

    nt = raw / "ntad"
    for k, spec in NTAD.items():
        print(f"fetching {spec['zip']}")
        fetch(ITEM_URL.format(spec["item"]), nt / spec["zip"])
    for k, spec, out, fields in (("stations", NTAD["stations"], st_txt, T.STATION_FIELDS),
                                 ("volume", NTAD["volume"], vol_txt, T.VOLUME_FIELDS)):
        with zipfile.ZipFile(nt / spec["zip"]) as z:
            gdb = next(n for n in z.namelist() if n.endswith(".gdb/")).rstrip("/")
            if not (nt / gdb).exists():
                print(f"unzipping {gdb}")
                z.extractall(nt)
        meta, _, _, cols = read(str(nt / gdb), read_geometry=False, where=f"state_code = '{state}'")
        idx = {n: i for i, n in enumerate(meta["fields"])}
        with open(out.with_suffix(".part"), "w") as f:
            for i in range(len(cols[0])):
                row = []
                for n in fields:
                    v = cols[idx[n]][i]
                    v = "" if v is None or (isinstance(v, str) and v == "nan") else str(v).strip()
                    if n == "year_record" and len(v) == 4:
                        v = v[2:]
                    row.append(v)
                f.write("|".join(row) + "\n")
        out.with_suffix(".part").rename(out)
        shutil.rmtree(nt / gdb)  # 1.6 GB unpacked; the zip stays as the cache
        print(f"wrote {out.relative_to(ROOT)} ({len(cols[0])} records)")
    return vol_txt, st_txt


def trina_stations(raw, route_id, frame, line_xy, margin=0.01):
    """TRINA stations inside the route's bounding box, `margin` degrees around it (cached)."""
    path = raw / f"trina_{route_id}.json"
    if not path.exists():
        lat, lon = frame.to_geodetic(line_xy[:, 0], line_xy[:, 1])
        env = f"{lon.min() - margin},{lat.min() - margin},{lon.max() + margin},{lat.max() + margin}"
        feats, offset = [], 0
        while True:
            q = {"where": "1=1", "geometry": env, "geometryType": "esriGeometryEnvelope", "inSR": "4326",
                 "spatialRel": "esriSpatialRelIntersects", "returnGeometry": "false", "f": "json",
                 "outFields": f"Name,ROUTE_NAME,LOCATION_D,StationType,LAT_DECIMAL,LON_DECIMAL,AADT_{YEAR}",
                 "resultOffset": str(offset), "resultRecordCount": "1000", "orderByFields": "OBJECTID"}
            tmp = raw / f"trina_{route_id}_{offset}.json"
            fetch(f"{TRINA}/query?{urllib.parse.urlencode(q)}", tmp)
            d = json.loads(tmp.read_text())
            tmp.unlink()
            if "error" in d:
                raise RuntimeError(f"TRINA: {d['error']}")
            feats += d["features"]
            if not d.get("exceededTransferLimit"):
                break
            offset += len(d["features"])
        path.write_text(json.dumps({"retrieved": dt.date.today().isoformat(), "envelope": env, "features": feats}))
    return json.loads(path.read_text())


# ---------------------------------------------------------------- geometry

def nearest(xy, pts):
    """Index into xy of the nearest point to each of pts, and the distance."""
    idx, dist = [], []
    for p in np.atleast_2d(pts):
        d2 = (xy[:, 0] - p[0]) ** 2 + (xy[:, 1] - p[1]) ** 2
        i = int(np.argmin(d2))
        idx.append(i)
        dist.append(float(np.sqrt(d2[i])))
    return np.array(idx), np.array(dist)


def route_s_of(road_main, road, s_values):
    """Chainage along the route (road_main's s) of points given by s on another road."""
    xy_main = np.column_stack([road_main["x"], road_main["y"]])
    i = np.clip(np.round(np.asarray(s_values) / road["spacing"]).astype(int), 0, road["count"] - 1)
    j, _ = nearest(xy_main, np.column_stack([road["x"][i], road["y"][i]]))
    return j * road_main["spacing"]


def drive_lanes(section):
    return sum(1 for ln in section["lanes"] if ln["kind"] == "drive")


def make_lookups(road_main, road, length):
    """lanes_at(a, b) and speed_at(a, b) in route chainage, for `road` (either direction)."""
    if road is road_main:
        own = lambda a, b: (a, b)  # noqa: E731
    else:
        s_main = route_s_of(road_main, road, np.arange(road["count"]) * road["spacing"])
        s_own = np.arange(road["count"]) * road["spacing"]

        def own(a, b):
            sel = s_own[(s_main >= a) & (s_main <= b)]
            if len(sel) == 0:
                k = int(np.argmin(np.abs(s_main - (a + b) / 2)))
                return s_own[k], s_own[k]
            return float(sel.min()), float(sel.max())

    def lanes_at(a, b):
        p, q = own(a, b)
        n = [drive_lanes(sc) for sc in road["sections"] if sc["s0"] < q and sc["s1"] > p]
        return min(n) if n else drive_lanes(min(road["sections"], key=lambda sc: abs(sc["s0"] - p)))

    def speed_at(a, b):
        p, q = own(a, b)
        zones = road["speed"]
        mph = [z["mph"] for k, z in enumerate(zones)
               if z["s0"] < q and (k + 1 == len(zones) or zones[k + 1]["s0"] > p)]
        return min(mph)

    return lanes_at, speed_at


# ---------------------------------------------------------------- the build

def build_route(city, route_id, cfg, raw):
    ccfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    frame = create_frame(ccfg)
    data = ROOT / "public" / "data" / city
    route = next(r for r in json.loads((data / "routes.json").read_text())["routes"] if r["id"] == route_id)
    net = route.get("files", {}).get("roadnet", "roadnet.json")  # each route names its RoadNet
    doc = json.loads((data / net).read_text())
    roads = {r["id"]: r for r in decode_roadnet(doc, (data / (net[:-len(".json")] + ".bin")).read_bytes())}
    main = roads[cfg["with"]["road"]]
    opp = roads[cfg["against"]["road"]]
    length = float(route["length"])
    xy_main = np.column_stack([main["x"], main["y"]])

    # stage 0: the stations on the route, positioned from TRINA (TMAS coordinates are unreliable)
    trina = trina_stations(raw, route_id, frame, xy_main, cfg.get("trinaMarginDeg", 0.01))
    names = cfg["trinaRoute"] if isinstance(cfg["trinaRoute"], list) else [cfg["trinaRoute"]]
    off_route = cfg.get("offRoute", {})
    stations_on = []
    for f in trina["features"]:
        a = f["attributes"]
        if not any((a.get("ROUTE_NAME") or "").startswith(nm) for nm in names):
            continue
        if NOT_MAINLINE.search(a.get("LOCATION_D") or "") or a.get(f"AADT_{YEAR}") is None:
            continue
        x, y = frame.to_local(a["LAT_DECIMAL"], a["LON_DECIMAL"])
        (i,), (d,) = nearest(xy_main, [[float(x), float(y)]])
        s = i * main["spacing"]
        extra = {}
        if a["Name"] in off_route and d <= OFF_ROUTE_M:
            # beyond an end of the route: it shapes the flows from that end
            s = main["spacing"] if off_route[a["Name"]] == "start" else length - 2 * main["spacing"]
            extra = {"offRoute": off_route[a["Name"]], "beyondEndM": round(d)}
        elif d > ON_ROUTE_M or s <= 0 or s >= length - main["spacing"]:
            continue
        stations_on.append({"id": a["Name"], "s": float(s), "offset": round(d, 1), "type": a["StationType"],
                            "aadt2way": float(a[f"AADT_{YEAR}"]), "location": (a["LOCATION_D"] or "").strip(), **extra})
    stations_on.sort(key=lambda x: x["s"])
    permanent = [x for x in stations_on if x["type"] == "Permanent"]

    # stage 1: TMAS records
    state = CITIES[city]["state"]
    vol_txt, st_txt = tmas_text(raw, state)
    keep = {T.tmas_id(x["id"]) for x in permanent} | {T.tmas_id(s) for s in cfg["laneShareStations"]}
    tmas_st = T.parse_stations(st_txt.read_text().splitlines())
    with open(vol_txt) as fh:
        records = T.parse_volume(fh, keep)
    days, dropped = T.station_days(records, tmas_st)

    return run_pipeline(route_id, cfg, length, main, opp, roads, route, stations_on, records, days, dropped,
                        tmas_st, {"trina": trina["retrieved"]})


def run_pipeline(route_id, cfg, length, main, opp, roads, route, stations_on, records, days, dropped, tmas_st, retrieved):
    weights = T.season_weights(YEAR)
    # stage 2
    means = T.hour_of_week_means(days)
    dirs = {"with": cfg["with"]["tmasDir"], "against": cfg["against"]["tmasDir"]}
    # shape stations: permanent, on the route, counted in all four seasons in that direction
    shapes = {k: [{"key": (T.tmas_id(x["id"]), d), "s": x["s"]} for x in stations_on
                  if x["type"] == "Permanent" and (T.tmas_id(x["id"]), d) in means
                  and all(means[(T.tmas_id(x["id"]), d)]["counted"])] for k, d in dirs.items()}
    borrowed = {}
    for k, d in dirs.items():
        if not shapes[k]:
            raise SystemExit(f"{route_id} {k}: no station counted all year; cannot shape the flows")
        for x in stations_on:
            key = (T.tmas_id(x["id"]), d)
            if x["type"] == "Permanent" and key in means and not all(means[key]["counted"]):
                pref = cfg.get("borrowFrom", {}).get(x["id"])
                cand = [sh for sh in shapes[k] if pref and T.trina_id(sh["key"][0]) == pref] or shapes[k]
                ref = min(cand, key=lambda sh: abs(sh["s"] - x["s"]))
                got = T.borrow_seasons(means, key, ref["key"])
                borrowed[key] = {"from": T.trina_id(ref["key"][0]), "seasons": [T.SEASONS[s] for s in got]}
    # a station whose kept data covers no season at all in a direction is level-only there
    usable = {key for key, m in means.items() if all(m["covered"])}
    totals_only = {T.tmas_id(s) for s in cfg.get("totalsOnly", [])}
    split_ok = [x for x in stations_on if x["type"] == "Permanent" and T.tmas_id(x["id"]) not in totals_only
                and all((T.tmas_id(x["id"]), d) in usable for d in dirs.values())]

    # stage 3: anchors (levels) per direction
    anchors = {}
    for k, d in dirs.items():
        other = dirs["against" if k == "with" else "with"]
        out = []
        for x in stations_on:
            key, okey = (T.tmas_id(x["id"]), d), (T.tmas_id(x["id"]), other)
            if x["type"] == "Permanent" and key in usable and key[0] in totals_only and okey in usable:
                two_way = T.aadt_of(means[key]["flow"], weights) + T.aadt_of(means[okey]["flow"], weights)
                share = split_at(x["s"], split_ok, dirs, k, means, weights)
                out.append({"id": x["id"], "s": x["s"], "kind": "permanent-total", "key": key, "aadt": two_way * share,
                            "twoWay": two_way, "how": f"counted two-way total x directional split {share:.3f} of the nearest station counted reliably in both directions"})
                continue
            if x["type"] == "Permanent" and key in usable:
                out.append({"id": x["id"], "s": x["s"], "kind": "permanent", "key": key,
                            "aadt": T.aadt_of(means[key]["flow"], weights)})
                continue
            if okey in usable and okey[0] not in totals_only:  # the other direction is counted here: this one is the remainder
                aadt = x["aadt2way"] - T.aadt_of(means[okey]["flow"], weights)
                how = "TRINA two-way AADT less the counted opposite direction"
            else:
                share = split_at(x["s"], split_ok, dirs, k, means, weights)
                aadt, how = x["aadt2way"] * share, f"TRINA two-way AADT x directional split {share:.3f} of the nearest station counted reliably in both directions"
            out.append({"id": x["id"], "s": x["s"], "kind": "permanent-level" if x["type"] == "Permanent" else "short",
                        "key": None, "aadt": aadt, "how": how})
        anchors[k] = out

    # segment edges: our exits, opposing exits that are not the same interchange, station midpoints
    cuts = [ln["s"] for ln in main["links"]]
    opp_cuts = route_s_of(main, opp, [ln["s"] for ln in opp["links"]]) if opp["links"] else []
    cuts += [float(c) for c in opp_cuts if min(abs(c - m) for m in cuts) > EXIT_MERGE_M]
    edges = T.boundaries(length, cuts, anchors["with"] + anchors["against"])

    # stage 4: lanes, speed, trucks
    exit_s = {ln["ref"]: ln["s"] for ln in main["links"] if ln["ref"]}
    stretches = sorted(({"s0": 0.0 if not t["fromExit"] else exit_s[t["fromExit"]], **t} for t in cfg["trucks"]),
                       key=lambda t: t["s0"])

    def truck_at(s):
        return [t for t in stretches if t["s0"] <= s][-1]["share"]

    shares_by = T.lane_shares(records, days)
    directions, share_tables = {}, {}
    for k, d in dirs.items():
        table = {}
        for sid in cfg["laneShareStations"]:
            key = (T.tmas_id(sid), d)
            if key in shares_by:
                table.setdefault(len(shares_by[key]), []).append((T.trina_id(sid), shares_by[key]))
        share_tables[k] = {n: {"stations": [s for s, _ in v], "shares": list(np.mean([sh for _, sh in v], axis=0))}
                           for n, v in table.items()}

        def shares_for(n, s, tab=share_tables[k]):
            if n in tab:
                return tab[n]["shares"], f"lane shares: {n}-lane counts at {','.join(tab[n]['stations'])}"
            m = min(tab, key=lambda c: (abs(c - n), -c))
            return T.resample_shares(tab[m]["shares"], n), f"lane shares: {m}-lane counts at {','.join(tab[m]['stations'])} carried to {n} lanes"

        road = main if k == "with" else opp
        lanes_at, speed_at = make_lookups(main, road, length)
        directions[k] = {"road": road["id"], "segments": T.build_direction(
            edges, anchors[k], shapes[k], means, weights, lanes_at, speed_at, truck_at, shares_for)}

    # acceptance
    accept = {"stationFlows": {}}
    ok = True
    for k in dirs:
        res = T.check_station_flows(directions[k]["segments"], anchors[k], means)
        accept["stationFlows"][k] = res
        ok &= all(r["pass"] for r in res)
    # totals-only stations: the two-way daily total of the product equals the counted one
    accept["twoWayTotals"] = []
    for x in stations_on:
        aw = next((a for a in anchors["with"] if a["id"] == x["id"] and a["kind"] == "permanent-total"), None)
        if not aw:
            continue
        sw = T.segment_at(directions["with"]["segments"], x["s"])
        sa = T.segment_at(directions["against"]["segments"], x["s"])
        prod = T.aadt_of(np.array(sw["flow"]), weights) + T.aadt_of(np.array(sa["flow"]), weights)
        rel = abs(prod - aw["twoWay"]) / aw["twoWay"]
        accept["twoWayTotals"].append({"station": x["id"], "counted": round(aw["twoWay"]), "product": round(prod),
                                       "relError": rel, "pass": rel <= 0.01})
        ok &= rel <= 0.01
    plan = cfg.get("plan") or {"station": next((x["id"] for x in stations_on if x["type"] == "Permanent"), ""),
                               "withRatio": None, "withPeak": None, "againstRatio": None, "againstPeak": None}
    pid = T.tmas_id(plan["station"])
    pat = {}
    for k, wd, ratio, peak in (("with", WITH_WEEKDAY, plan["withRatio"], plan["withPeak"]),
                               ("against", AGAINST_WEEKDAY, plan["againstRatio"], plan["againstPeak"])):
        key = (pid, dirs[k])
        if key not in days:
            continue
        src = T.day_pattern(days[key], wd)
        seg = T.segment_at(directions[k]["segments"], next(a["s"] for a in anchors[k] if a.get("key") == key))
        prod = T.product_day_pattern(np.array(seg["flow"]), weights, wd)
        pat[k] = {"weekday": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][wd], "direction": T.DIR_NAMES[dirs[k]],
                  "source": src, "product": prod, "plan": {"ratio": ratio, "peakHour": peak},
                  "ratioWithinPlan": None if ratio is None else abs(src["ratio"] - ratio) <= 0.05,
                  "peakNearPlan": None if peak is None else abs(src["peakHour"] - peak) <= 1,
                  "productMatchesSource": abs(prod["ratio"] - src["ratio"]) <= 0.01 * src["ratio"]}
        ok &= abs(prod["ratio"] - src["ratio"]) <= 0.01 * src["ratio"]
    accept["planStation"] = {"station": plan["station"], **pat}
    accept["pass"] = bool(ok)

    report_extra = {
        "stations": stations_report(stations_on, dirs, days, dropped, means, borrowed, tmas_st, weights),
        "laneShareTables": {k: {str(n): v for n, v in sorted(t.items())} for k, t in share_tables.items()},
        "laneShareNote": cfg.get("laneShareNote", ""),
        "truckStretches": [{"s0": t["s0"], "share": t["share"], "source": t["source"]} for t in stretches],
        "edges": edges,
    }
    return directions, accept, report_extra


def split_at(s, split_ok, dirs, k, means, weights):
    """Share of the two-way volume in direction k at the nearest station counted reliably in both
    directions (seasons a partial-year station did not count are the borrowed ones)."""
    other = "against" if k == "with" else "with"
    if not split_ok:
        return 0.5
    x = min(split_ok, key=lambda x: abs(x["s"] - s))
    sid = T.tmas_id(x["id"])
    a = T.aadt_of(means[(sid, dirs[k])]["flow"], weights)
    b = T.aadt_of(means[(sid, dirs[other])]["flow"], weights)
    return a / (a + b)


def stations_report(stations_on, dirs, days, dropped, means, borrowed, tmas_st, weights):
    summ = T.summarise_dropped(dropped)
    out = []
    for x in stations_on:
        rec = {"id": x["id"], "type": x["type"], "s": round(x["s"], 1), "offsetM": x["offset"],
               "location": x["location"], "trinaAadt2way": x["aadt2way"],
               **{k: x[k] for k in ("offRoute", "beyondEndM") if k in x}}
        if x["type"] == "Permanent":
            per = {}
            for k, d in dirs.items():
                key = (T.tmas_id(x["id"]), d)
                drops = [y for y in dropped if (y["station"], y["dir"]) == key]
                m = means.get(key)
                per[T.DIR_NAMES[d]] = {
                    "lanesExpected": tmas_st.get(key, {}).get("lanes"),
                    "daysKept": len(days.get(key, {})),
                    "daysDropped": len(drops),
                    "dropReasons": summ.get(key, {}),
                    "droppedDates": [y["date"] for y in drops],
                    "seasonsCounted": [T.SEASONS[s] for s in range(4) if m and m["counted"][s]],
                    "borrowed": borrowed.get(key),
                    "tmasMeanDay": round(m["dailyMean"]) if m else None,
                    "productAadt": round(T.aadt_of(m["flow"], weights)) if m and all(m["covered"]) else None,
                }
            rec["tmas"] = per
            rec["tmasTwoWayMeanDay"] = sum(v["tmasMeanDay"] or 0 for v in per.values()) or None
        out.append(rec)
    return out


def segment_summary(directions):
    out = {}
    for k, dd in directions.items():
        out[k] = [{"s0": sg["s0"], "s1": sg["s1"], "lanes": sg["lanes"], "aadt": sg["aadt"],
                   "peakFlow": round(max(max(r) for r in sg["flow"])), "freeFlowMps": sg["freeFlowMps"],
                   "capacityVph": sg["capacityVph"], "truckShare": sg["truckShare"],
                   "shape": sg["provenance"]["shape"], "level": sg["provenance"]["level"]} for sg in dd["segments"]]
    return out


def product(route_id, tz, directions, sources):
    return {"version": 1, "route": route_id, "year": YEAR, "tz": tz,
            "hourOfWeek": "index = 24 * day + hour, day 0 = Monday, local time, hour = the hour that starts then",
            "seasons": T.SEASONS, "seasonOfMonth": T.SEASON_OF_MONTH,
            "directions": directions, "sources": sources}


def sources_list(retrieved):
    return [
        {"id": "tmas", "title": NTAD["volume"]["title"], "url": ITEM_PAGE.format(NTAD["volume"]["item"]), "retrieved": retrieved["tmas"]},
        {"id": "tmas-stations", "title": NTAD["stations"]["title"], "url": ITEM_PAGE.format(NTAD["stations"]["item"]), "retrieved": retrieved["tmas"]},
        {"id": "trina", "title": f"NDOT TRINA stations and AADT {YEAR}", "url": TRINA, "retrieved": retrieved["trina"]},
        {"id": "ndot-class", "title": "NDOT Vehicle Classification Distribution Report 2023 (truck shares, as quoted in plan 02 section 6.5)",
         "url": "https://dot.nv.gov/home/showpublisheddocument/22703/638560162620170000", "retrieved": "2026-11-10"},
        {"id": "hcm", "title": "Capacity 2,300 pc/h/lane and lane speed offsets: assumed (plan 02 section 7.10)", "url": "", "retrieved": ""},
    ]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    city = sys.argv[1]
    wanted = sys.argv[2:] or list(ROUTES)
    raw = ROOT / "data" / "raw" / city / "traffic"
    raw.mkdir(parents=True, exist_ok=True)
    tz = json.loads((ROOT / "data" / "cities.json").read_text())[city]["tz"]
    report = {"generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "year": YEAR,
              "dataNote": ("TMAS 2025 hourly volumes from BTS NTAD's TMAS Volume/Stations geodatabases (compiled "
                           "2025-12-31, published 2026-03-23), the same records as FHWA's pipe-delimited TMAS files, "
                           "whose download page refuses scripted requests (HTTP 403). Real counted data; not synthetic."),
              "routes": {}}
    rp = ROOT / "data" / "derived" / city / "traffic_report.json"
    if rp.exists():  # routes not rebuilt this time keep their entries
        report["routes"] = {k: v for k, v in json.loads(rp.read_text()).get("routes", {}).items() if k not in wanted}
    ok = True
    for rid in wanted:
        cfg = ROUTES[rid]
        directions, accept, extra = build_route(city, rid, cfg, raw)
        vol_txt = raw / f"{CITIES[city]['state']}_{YEAR}_volume.txt"
        retrieved = {"tmas": dt.date.fromtimestamp(vol_txt.stat().st_mtime).isoformat(),
                     "trina": json.loads((raw / f"trina_{rid}.json").read_text())["retrieved"]}
        out = ROOT / "public" / "data" / city / "traffic" / f"{rid}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(product(rid, tz, directions, sources_list(retrieved)), separators=(",", ":")))
        report["routes"][rid] = {"output": str(out.relative_to(ROOT)), "bytes": out.stat().st_size,
                                 "acceptance": accept, **extra, "segments": segment_summary(directions)}
        ok &= accept["pass"]
        print(f"{rid}: {len(directions['with']['segments'])} segments, {out.stat().st_size} bytes, "
              f"acceptance {'pass' if accept['pass'] else 'FAIL'}")
    report["routes"] = {k: report["routes"][k] for k in ROUTES if k in report["routes"]}
    rp.parent.mkdir(parents=True, exist_ok=True)
    rp.write_text(json.dumps(report, indent=1, default=float))
    print(f"wrote {rp.relative_to(ROOT)}")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
