# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "requests", "shapely", "laspy[lazrs]"]
# ///
"""Usage: build_airport.py <city> [--faa ID] [--cycle YYYY-MM-DD]

The city's airport for the flight (plan 03, F1.1 and F4.1), in one file: the runways from the FAA's NASR record, the
pavement, buildings and beacon from the FAA's airport-mapping layers, the tower from the FAA's obstacle file, the
taxiway centre lines, stands, gates, jet bridges, holding positions and individually mapped lights from OpenStreetMap,
and the buildings' heights from the USGS LiDAR survey. No airport is named here: the airport is data/cities.json's
`airport` block (its `faa` id and its `box`, map metres [x0, y0, x1, y1] around everything taken).

  Sources  FAA NASR 28-day subscription, airport CSV bundle for the cycle in effect (or --cycle):
           https://nfdc.faa.gov/webContent/28DaySub/extra/<DD_Mon_YYYY>_APT_CSV.zip (US government work);
           cached under data/raw/nasr/.
           FAA airport-mapping layers AM_Runway, AM_Taxiway, AM_Apron, AM_Building, AM_Beacon and the Digital Obstacle
           File on the FAA's public ArcGIS service (lib/airport_fetch.py; "for public use"), one query each;
           OpenStreetMap, one Overpass request for nwr[aeroway] in the box (ODbL 1.0);
           cached under data/raw/airport/<faa>/ with the date fetched.
           USGS 3DEP LiDAR (the city's `lidar` dataset), read from its public Entwine copy over boxes around the
           buildings and the runway ends only, rasterised to the city's 1.5 m grid (lib/airport_lidar.py); the grid
           is cached as data/raw/airport/<faa>/lidar.npz. Public domain.
           public/data/<city>/buildings.json, to mark the airport buildings the city's set already has.
  Frame    scripts/lib/frame.py (the transverse Mercator of src/world/frame.js). NASR positions are NAD 83, about
           a metre from WGS-84 here; the difference is ignored.
  Output   public/data/<city>/airport.json, under 500 KB.

THE FILE (format "skyline-airport/1"). Positions are metres east (x) and north (y) of the city origin, rounded to
0.1 m; elevations are metres above sea level (NAVD 88, as NASR gives them); directions are degrees clockwise from grid
north of the app frame unless named true. A polygon is {"ring": [x0, y0, x1, y1, ...]} counter-clockwise with the
first point not repeated, plus "holes": [[...], ...] (clockwise) only when it has any. A line is [x0, y0, x1, y1, ...].

  format, city, faa, icao, name
  arp                {lat, lon, x, y, elevation}  airport reference point
  magneticVariation  degrees, east positive
  lightingSchedule   NASR's airport lighting schedule ("SS-SR": sunset to sunrise)
  towerType          NASR's tower type ("ATCT": an operating control tower)
  windIndicator      {code, lighted} or null
  runways[]          one per runway, sorted by id:
      id "01L/19R", ends [first end, second end] (the first is the low-numbered end), length (published, m),
      surveyedLength (between the surveyed ends, m), width (m), surface, treatment (NASR codes: CONC, GRVD),
      edgeLights (NASR code: HIGH, MED, ...) and edgeLightIntensity (high, medium, ...), condition, pavementType
      (rigid, flexible), direction [ux, uy] unit vector from the first end to the second, profile [[s, z], ...]:
      metres along from the first end and elevation, linear between (through any displaced thresholds).
  ends{}             by end name ("1L", "19R"): id, nasrId, runway, lat, lon, end [x, y, z] (pavement end),
      thresholdLat, thresholdLon, threshold [x, y, z] (where landing starts; the end unless displaced), displacedM,
      trueHeading and gridHeading (landing direction), tdzElevation, thresholdCrossingHeightFt, papi ({type,
      lights, side, angle, crossingHeightFt, code} or null), approachLights (NASR code or null) and
      approachLightSystem ({code, system, lengthFt, flashers, rail} or null), ils, marking (NASR code: PIR, NPI, ...),
      markingKind (precision, non-precision, basic, ...), markingCondition, endIdentifierLights, centerlineLights,
      tdzLights (booleans), rightHandTraffic, landingDistanceFt.
  pavement           the FAA's surveyed polygons: runway[] {id, ring}, taxiway[] {name, ring}, apron[] {name, ring}.
      name is the FAA designator (a taxiway's letter; an apron's use, e.g. "AIR CARGO") or null. Taxiway pieces
      overlap each other and the aprons where they meet; draw them as one surface.
  taxiways[]         OpenStreetMap centre lines: {ref (the taxiway's name, or null), kind: taxiway | taxilane, line}
  stands[]           OpenStreetMap parking positions: {ref, x, y, heading, lead, stopBy, gate, jetBridge, onApron,
      osmId}. (x, y) is where the nose wheel stops, heading the direction the aircraft faces there (along the last
      leg of the lead-in line); lead is the lead-in line, ending at the stop. stopBy says how the stop end was told:
      gate (nearer the gate of the same ref, when that gate is within 80 m), building (nearer a terminal, hangar or
      jet bridge), taxiway (farther from the taxiway centre lines) or drawn (as the way is drawn). Refs repeat
      across ramps. Without a gate the stop end is a guess from the surroundings; stopBy says how good. gate: the ref of the gate of the same ref, or
      null; jetBridge: the ref of a jet bridge (true if it has none) whose line comes within 20 m of the stop, or
      null; onApron: the stop is on (or within 3 m of) an FAA apron polygon.
  standsOffApron[]   refs of the stands whose stop no FAA apron reaches
  gates[]            {ref, x, y, level}
  jetBridges[]       {ref, line}  from the terminal end, as drawn
  holdingPositions[] {ref, type (runway, intermediate, ...), x, y, dir}: dir is the axis of the taxiway centre line
      through the point, in [0, 180) (the bar runs across it), or null when it is on none
  lights[]           OpenStreetMap's individually mapped lights, grouped: {kind, colour, dir, xy}. kind is OSM's
      navigationaid value (lightKinds says what each is), colour its light:colour where tagged (null where not:
      lightKinds gives the colour the kind has by definition), dir the grid direction it shines toward where tagged
      (light:direction, true in OSM, turned to grid here) or null, xy a flat list of positions.
  lightKinds{}       {kind: {label, colour}}
  buildings[]        {name, kind, source, ring, h, hMax, hSource, ground, cityCover, inCity, cityIds, ...}: the FAA's
      building polygons (source "faa", faaId), with the name, ref and tagged height of the OpenStreetMap terminal or
      hangar that is the same building (osmId, osmName, osmHeight, osmLevels), then the OSM terminals and hangars that
      match none (source "osm"). kind: terminal, tower, hangar, fuel-tank, fire-station, fbo or building. h is the
      height above the ground (m) and hMax its highest point; hSource says where h is from: lidar, dof (the obstacle
      file, for the tower), osm-height, osm-levels or guess. ground is the ground's elevation (the LiDAR's, shifted
      onto NASR's heights by sources.lidar.datumOffset). cityCover is the share of the footprint that
      public/data/<city>/buildings.json already has; inCity is cityCover >= 0.5 (draw it only when false), cityIds
      the ids of the city's buildings it overlaps.
  tower              {x, y, heightAgl, topAmsl, groundAmsl, lighting, source}: the control tower from the obstacle file
  beacon             {colors, schedule (NASR codes, as v0), colours [...], flashesPerMinute [low, high], x, y,
      z (its height: the tower's top when it stands on the tower, else null), onTower, faaType}
  windsocks[]        [x, y]
  about              this description, short
  sources{}          nasr, faaAirportMapping, faaObstacles, osm, lidar, cityBuildings: what, url, date fetched or
      cycle, licence and the credit line each needs
  source             v0's NASR record of where the runways came from (kept as it was)
"""
import argparse
import json
import math
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import nasr  # noqa: E402
from lib.frame import create_frame  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FT = 0.3048


def _r(v, nd=2):
    return None if v is None else round(float(v), nd)


def _xy(frame, lat, lon):
    x, y = frame.to_local(lat, lon)
    return float(x), float(y)


def runway_elevation(rwy, s):
    """Elevation (m) at `s` metres along a runway from its first end, by its linear profile."""
    prof = rwy["profile"]
    if s <= prof[0][0]:
        return prof[0][1]
    for (s0, z0), (s1, z1) in zip(prof, prof[1:]):
        if s <= s1:
            return z0 + (z1 - z0) * (s - s0) / (s1 - s0) if s1 > s0 else z1
    return prof[-1][1]


def _wind_indicator(code):
    """NASR's wind indicator flag: 'N' none, 'Y' unlighted, 'Y-L' lighted."""
    code = (code or "").strip().upper()
    return None if code in ("", "N") else {"code": code, "lighted": code.endswith("-L")}


def build_runways(rows, faa, frame):
    """The airport dict (without the build metadata) from NASR rows of one airport."""
    base = next(r for r in rows["APT_BASE"] if r["ARPT_ID"] == faa)
    rwys = [r for r in rows["APT_RWY"] if r["ARPT_ID"] == faa]
    ends_rows = [r for r in rows["APT_RWY_END"] if r["ARPT_ID"] == faa]
    lat, lon = float(base["LAT_DECIMAL"]), float(base["LONG_DECIMAL"])
    ax, ay = _xy(frame, lat, lon)
    ends = {}
    for e in ends_rows:
        name = nasr.end_name(e["RWY_END_ID"])
        elat, elon = float(e["LAT_DECIMAL"]), float(e["LONG_DECIMAL"])
        ex, ey = _xy(frame, elat, elon)
        z = nasr.num(e["RWY_END_ELEV"]) * FT
        disp_len = nasr.num(e["DISPLACED_THR_LEN"])
        if e["LAT_DISPLACED_THR_DECIMAL"].strip() and disp_len:
            tlat, tlon = float(e["LAT_DISPLACED_THR_DECIMAL"]), float(e["LONG_DISPLACED_THR_DECIMAL"])
            tx, ty = _xy(frame, tlat, tlon)
            tz = (nasr.num(e["DISPLACED_THR_ELEV"]) or nasr.num(e["RWY_END_ELEV"])) * FT
        else:
            tlat, tlon, tx, ty, tz = elat, elon, ex, ey, z
        papi = nasr.vgsi(e["VGSI_CODE"])
        if papi is not None:
            papi = {**papi, "angle": nasr.num(e["VISUAL_GLIDE_PATH_ANGLE"]),
                    "crossingHeightFt": int(nasr.num(e["THR_CROSSING_HGT"]) or 0) or None,
                    "code": e["VGSI_CODE"].strip()}
        tdz = nasr.num(e["TDZ_ELEV"])
        ends[name] = {
            "id": name, "nasrId": e["RWY_END_ID"].strip(), "runway": e["RWY_ID"].strip(),
            "lat": elat, "lon": elon, "end": [_r(ex), _r(ey), _r(z)],
            "thresholdLat": tlat, "thresholdLon": tlon, "threshold": [_r(tx), _r(ty), _r(tz)],
            "displacedM": _r((disp_len or 0) * FT),
            "trueHeading": nasr.num(e["TRUE_ALIGNMENT"]),
            "tdzElevation": _r(tdz * FT if tdz else None),
            "thresholdCrossingHeightFt": nasr.num(e["THR_CROSSING_HGT"]),
            "papi": papi,
            "approachLights": e["APCH_LGT_SYSTEM_CODE"].strip() or None,
            "ils": e["ILS_TYPE"].strip() or None,
            "marking": e["RWY_MARKING_TYPE_CODE"].strip() or None,
            "endIdentifierLights": nasr.flag(e["RWY_END_LGTS_FLAG"]),
            "centerlineLights": nasr.flag(e["CNTRLN_LGTS_AVBL_FLAG"]),
            "tdzLights": nasr.flag(e["TDZ_LGT_AVBL_FLAG"]),
            "landingDistanceFt": nasr.num(e["LNDG_DIST_AVBL"]),
            # F4.1: the codes above, decoded
            "markingKind": nasr.marking_kind(e["RWY_MARKING_TYPE_CODE"]),
            "markingCondition": e["RWY_MARKING_COND"].strip() or None,
            "approachLightSystem": nasr.approach_lights(e["APCH_LGT_SYSTEM_CODE"]),
            "rightHandTraffic": nasr.flag(e["RIGHT_HAND_TRAFFIC_PAT_FLAG"]),
        }
    runways = []
    for r in rwys:
        a, b = (nasr.end_name(p) for p in r["RWY_ID"].split("/"))
        ea, eb = ends[a], ends[b]
        dx, dy = eb["end"][0] - ea["end"][0], eb["end"][1] - ea["end"][1]
        length = math.hypot(dx, dy)
        ux, uy = dx / length, dy / length
        ea["gridHeading"] = _r(math.degrees(math.atan2(ux, uy)) % 360, 3)
        eb["gridHeading"] = _r(math.degrees(math.atan2(-ux, -uy)) % 360, 3)
        along = lambda p: (p[0] - ea["end"][0]) * ux + (p[1] - ea["end"][1]) * uy  # noqa: E731
        prof = {0.0: ea["end"][2], round(length, 2): eb["end"][2]}
        for e in (ea, eb):
            if e["displacedM"]:
                prof[round(along(e["threshold"]), 2)] = e["threshold"][2]
        runways.append({
            "id": r["RWY_ID"].strip(), "ends": [a, b],
            "length": _r((nasr.num(r["RWY_LEN"]) or 0) * FT), "surveyedLength": _r(length),
            "width": _r((nasr.num(r["RWY_WIDTH"]) or 0) * FT),
            "surface": r["SURFACE_TYPE_CODE"].strip(), "treatment": r["TREATMENT_CODE"].strip() or None,
            "edgeLights": r["RWY_LGT_CODE"].strip() or None,
            "edgeLightIntensity": nasr.light_intensity(r["RWY_LGT_CODE"]),
            "condition": r["COND"].strip() or None,
            "pavementType": nasr.PAVEMENT.get(r["PAVEMENT_TYPE_CODE"].strip()),
            "direction": [_r(ux, 6), _r(uy, 6)],
            "profile": [[_r(s), _r(z)] for s, z in sorted(prof.items())],
        })
    runways.sort(key=lambda r: r["id"])
    return {
        "faa": faa, "icao": base["ICAO_ID"].strip() or None, "name": base["ARPT_NAME"].strip(),
        "arp": {"lat": lat, "lon": lon, "x": _r(ax), "y": _r(ay), "elevation": _r(nasr.num(base["ELEV"]) * FT)},
        "magneticVariation": (nasr.num(base["MAG_VARN"]) or 0) * (1 if base["MAG_HEMIS"].strip() == "E" else -1),
        "beacon": {"colors": base["BCN_LENS_COLOR"].strip() or None, "schedule": base["BCN_LGT_SKED"].strip() or None,
                   "colours": nasr.beacon_colours(base["BCN_LENS_COLOR"]),
                   "flashesPerMinute": nasr.beacon_rate(base["BCN_LENS_COLOR"])},
        "lightingSchedule": base["LGT_SKED"].strip() or None,
        "towerType": base["TWR_TYPE_CODE"].strip() or None,
        "windIndicator": _wind_indicator(base["WIND_INDCR_FLAG"]),
        "runways": runways,
        "ends": dict(sorted(ends.items())),
    }


ABOUT = (
    "The airport for the flight, built by scripts/build_airport.py, whose header is the full schema. Positions are "
    "metres east (x) and north (y) of the city origin, rounded to 0.1 m; elevations metres above sea level; directions "
    "degrees clockwise from grid north of the app frame unless named true. A polygon is {ring: [x0, y0, x1, y1, ...]}, "
    "counter-clockwise, first point not repeated, with clockwise holes only when present; a line is [x, y, ...]. "
    "runways and ends: FAA NASR (ends, thresholds, elevation profile, width, surface, marking and lighting codes, "
    "PAPI). pavement: the FAA's surveyed runway, taxiway and apron polygons (pieces overlap: draw them as one "
    "surface). taxiways: OpenStreetMap centre lines with names. stands: where the nose wheel stops and the heading "
    "there, with the lead-in line. gates, jetBridges, holdingPositions (dir: the taxiway's axis there, 0 to 180). "
    "lights: OpenStreetMap's mapped lights grouped by kind, colour where tagged and grid direction where tagged; "
    "lightKinds gives each kind's meaning and its colour by definition. buildings: the FAA's building polygons plus "
    "the OpenStreetMap terminals and hangars it lacks; h above the ground from LiDAR (the tower's from the obstacle "
    "file); inCity when the city's buildings.json already has it (do not draw those twice). tower and beacon from the "
    "FAA. sources: each source, its date, licence and credit line.")

LIGHT_COLOURS = {"rwe": "white", "rwt": "green", "rwc": "white", "rwz": "white", "txe": "blue", "txc": "green",
                 "als": "white", "papi": "red/white", "vasi": "red/white", "stopbar": "red", "rel": "red",
                 "thl": "red", "rgl": "yellow"}
JET_BRIDGE_M = 20.0  # a jet bridge serves a stand when its line comes this near the stop
ON_APRON_M = 3.0


def city_polys(path, box):
    """(id, footprint) of every volume outline of the city's buildings near the box."""
    from shapely.geometry import Polygon
    if not path.exists():
        return []
    x0, y0, x1, y1 = box
    out = []
    for b in json.loads(path.read_text())["buildings"]:
        cx, cy = b["c"]
        if x0 - 500 <= cx <= x1 + 500 and y0 - 500 <= cy <= y1 + 500:
            for v in b["v"]:
                p = Polygon(list(zip(v["o"][0::2], v["o"][1::2])))
                if p.is_valid and p.area > 1:
                    out.append((b["id"], p))
    return out


def effective(meta):
    """A FAA layer's "Current Effective Date" as its description gives it."""
    import re
    text = " ".join(re.sub("<[^>]+>", " ", (meta or {}).get("description") or "").split())
    m = re.search(r"Current Effective Date:\s*(.+?\d{4})\s+to\s+(.+?\d{4})", text)
    return f"{m.group(1)} to {m.group(2)}" if m else None


def building_heights(blds, raster, frame, offset, tower):
    """Give each building h, hMax, hSource and ground: LiDAR first (as the city's), the tower from the obstacle file,
    then OpenStreetMap's height or levels, then a guess."""
    from lib import airport_layers as al
    from lib import airport_lidar as lid
    from lib.ladder import GUESS_M, LEVEL_M

    for b in blds:
        p = al.to_polygon(b)
        s = lid.sample(raster, p, frame) if raster is not None else None
        h, hmax = lid.building_height(s, p.area)
        b["ground"] = round(s[2] + offset, 1) if s else None
        if b["kind"] == "tower" and tower:
            b.update(h=tower["heightAgl"], hSource="dof", lidarH=round(h, 1) if h else None)
            b["hMax"] = tower["heightAgl"]
            b["ground"] = b["ground"] or tower["groundAmsl"]
            continue
        if h is not None and h >= 2.5:
            b.update(h=round(h, 1), hMax=round(max(hmax, h), 1), hSource="lidar")
        elif b.get("osmHeight"):
            b.update(h=b["osmHeight"], hMax=b["osmHeight"], hSource="osm-height")
        elif b.get("osmLevels"):
            b.update(h=round(b["osmLevels"] * LEVEL_M, 1), hMax=round(b["osmLevels"] * LEVEL_M, 1), hSource="osm-levels")
        else:
            b.update(h=GUESS_M, hMax=GUESS_M, hSource="guess")


def assemble(runways_part, layers, osm_doc, frame, raster=None, city=(), lidar_offset=0.0):
    """The airport (without the build metadata) from the parsed sources. `raster` is the LiDAR grid
    (lib.airport_lidar.Raster) or None; `city` the (id, footprint) list of city_polys()."""
    from shapely.geometry import LineString, Point
    from shapely.ops import unary_union

    from lib import airport_layers as al

    pav = al.faa_pavement(layers, frame)
    osm = al.osm_aeroways(osm_doc, frame)
    blds = al.merge_buildings(al.faa_buildings(layers["AM_Building"], frame), osm["buildings"])
    tower = al.tower(layers["Digital_Obstacle_File"], blds, frame)
    beacon = al.beacon(layers["AM_Beacon"], tower, frame)
    building_heights(blds, raster, frame, lidar_offset, tower)
    for b in blds:
        p = al.to_polygon(b)
        cover = al.city_cover(p, [q for _, q in city])
        b["cityCover"] = round(cover, 2)
        b["inCity"] = cover >= 0.5
        b["cityIds"] = sorted({i for i, q in city if q.intersects(p) and q.intersection(p).area > 1})

    aprons = unary_union([al.to_polygon(a) for a in pav["apron"]]).buffer(ON_APRON_M)
    gate_refs = {g["ref"] for g in osm["gates"] if g["ref"]}
    bridges = [(j["ref"], LineString(list(zip(j["line"][0::2], j["line"][1::2])))) for j in osm["jetBridges"]
               if len(j["line"]) >= 4]
    for s in osm["stands"]:
        stop = Point(s["x"], s["y"])
        s["gate"] = s["ref"] if s["ref"] in gate_refs else None
        near = min(bridges, key=lambda rb: rb[1].distance(stop), default=None)
        s["jetBridge"] = (near[0] or True) if near and near[1].distance(stop) < JET_BRIDGE_M else None
        s["onApron"] = bool(aprons.contains(stop))
    keep = ("name", "kind", "source", "faaId", "osmId", "ref", "osmName", "osmHeight", "osmLevels", "ring", "holes",
            "h", "hMax", "hSource", "lidarH", "ground", "cityCover", "inCity", "cityIds")
    stand_keys = ("ref", "x", "y", "heading", "lead", "stopBy", "gate", "jetBridge", "onApron", "osmId")
    used = {g["kind"] for g in osm["lights"]}
    return {
        **runways_part,
        "beacon": {**runways_part["beacon"], **(beacon or {})},
        "pavement": pav,
        "taxiways": osm["taxiways"],
        "stands": [{k: s[k] for k in stand_keys} for s in osm["stands"]],
        "standsOffApron": [s["ref"] for s in osm["stands"] if not s["onApron"]],
        "gates": osm["gates"],
        "jetBridges": osm["jetBridges"],
        "holdingPositions": osm["holdingPositions"],
        "lights": osm["lights"],
        "lightKinds": {k: {"label": al.LIGHT_KINDS[k], "colour": LIGHT_COLOURS.get(k)} for k in sorted(used)},
        "buildings": [{k: b[k] for k in keep if b.get(k) is not None} | {"inCity": b["inCity"]} for b in blds],
        "tower": tower,
        "windsocks": osm["windsocks"],
    }


def _dump(out):
    """One top-level key a line, everything else compact."""
    return "{\n" + ",\n".join(f"{json.dumps(k)}:{json.dumps(v, separators=(',', ':'))}" for k, v in out.items()) + "\n}\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city")
    ap.add_argument("--faa")
    ap.add_argument("--cycle")
    a = ap.parse_args()
    city = json.loads((ROOT / "data" / "cities.json").read_text())[a.city]
    block = city.get("airport") or {}
    faa = block.get("faa") or a.faa
    if not faa:
        raise SystemExit("no airport: add an airport block to cities.json or pass --faa")
    if not block.get("box"):
        raise SystemExit("the airport block needs a box (map metres [x0, y0, x1, y1])")
    import numpy as np
    from shapely.geometry import Polygon

    from lib import airport_fetch as af
    from lib import airport_lidar as lid
    from lib.fetch import OVERPASS, cached_get

    frame = create_frame(city)
    cycle = date.fromisoformat(a.cycle) if a.cycle else nasr.cycle_for(date.today())
    url = nasr.zip_url(cycle)
    zpath = ROOT / "data" / "raw" / "nasr" / url.rsplit("/", 1)[-1]
    cached_get(url, zpath)
    rows = nasr.read_zip(zpath, faa)
    if not rows["APT_BASE"]:
        raise SystemExit(f"{faa} is not in {url}")
    runways_part = build_runways(rows, faa, frame)

    x0, y0, x1, y1 = block["box"]
    lat, lon = frame.to_geodetic(np.array([x0, x1, x0, x1], float), np.array([y0, y0, y1, y1], float))
    llbox = (float(lat.min()), float(lon.min()), float(lat.max()), float(lon.max()))
    raw = ROOT / "data" / "raw" / "airport" / faa
    layers = {name: af.faa_layer(name, faa, raw) for name in af.LAYERS}
    layers["Digital_Obstacle_File"] = af.faa_obstacles(llbox, raw)
    osm_doc = af.osm_aeroways(llbox, raw)

    # LiDAR over the buildings and the runway ends
    from lib import airport_layers as al
    blds_pre = al.merge_buildings(al.faa_buildings(layers["AM_Building"], frame),
                                  al.osm_aeroways(osm_doc, frame)["buildings"])
    ends = [e["end"] for e in runways_part["ends"].values()]
    squares = [Polygon([(x - 30, y - 30), (x + 30, y - 30), (x + 30, y + 30), (x - 30, y + 30)]) for x, y, _ in ends]
    lcfg = city["lidar"]
    raster = lid.fetch_raster(lid.boxes_for([al.to_polygon(b) for b in blds_pre] + squares, frame),
                              lcfg["dataset"], lcfg["maxDepth"], raw / "lidar.npz", lcfg["cell"], float(lat.mean()))
    offset = lid.datum_offset(raster, frame, np.array(ends))
    print(f"NASR runway-end elevations minus LiDAR ground: median {offset:+.2f} m")

    cpath = ROOT / "public" / "data" / a.city / "buildings.json"
    body = assemble(runways_part, layers, osm_doc, frame, raster, city_polys(cpath, block["box"]), offset or 0.0)
    fmeta = layers["AM_Runway"]
    out = {"format": "skyline-airport/1", "city": a.city, **body, "about": ABOUT, "sources": {
        "nasr": {"what": "runways and runway ends, their marking and lighting codes, the beacon", "url": url,
                 "cycle": cycle.isoformat(), "licence": "US government work",
                 "credit": "FAA National Airspace System Resource (NASR) 28-day subscription"},
        "faaAirportMapping": {"what": "runway, taxiway and apron polygons, airport buildings, the beacon's position",
                              "url": af.ARCGIS, "layers": list(af.LAYERS), "fetched": fmeta["fetched"],
                              "effective": effective(fmeta["meta"]),
                              "licence": "FAA: \"The data provided is for public use\"",
                              "credit": "Federal Aviation Administration, Aeronautical Information Services: airport "
                                        "mapping data"},
        "faaObstacles": {"what": "the control tower's position and height", "url": af.ARCGIS + "/Digital_Obstacle_File",
                         "fetched": layers["Digital_Obstacle_File"]["fetched"], "licence": "US government work",
                         "credit": "FAA Digital Obstacle File"},
        "osm": {"what": "taxiway centre lines and names, stands, gates, jet bridges, holding positions, mapped lights, "
                        "terminal and hangar names", "url": OVERPASS, "query": af.overpass_query(llbox),
                "snapshot": osm_doc.get("osm3s", {}).get("timestamp_osm_base"), "fetched": osm_doc.get("fetched"),
                "licence": "ODbL 1.0 (this file is a derived database under the same licence)",
                "credit": "© OpenStreetMap contributors"},
        "lidar": {"what": "building heights and the ground under them", "dataset": lcfg["dataset"],
                  "year": lcfg.get("year"), "url": lid.EPT.format(dataset=lcfg["dataset"]),
                  "fetched": af_date(raw / "lidar.npz"), "depth": lcfg["maxDepth"], "cellM": lcfg["cell"],
                  "datumOffset": round(offset, 2) if offset is not None else None,
                  "datumNote": "NASR runway-end elevations minus the LiDAR ground at the 8 ends (median); added to "
                               "the LiDAR ground to give buildings[].ground",
                  "licence": "Public domain", "credit": "U.S. Geological Survey, 3D Elevation Program (3DEP) LiDAR"},
        "cityBuildings": {"what": "which airport buildings the city's set already has",
                          "file": f"public/data/{a.city}/buildings.json", "fetched": af_date(cpath),
                          "licence": "ODbL 1.0", "credit": "© OpenStreetMap contributors; USGS 3DEP"},
    }, "source": {"nasr": url, "cycle": cycle.isoformat(), "licence": "US government work (FAA)",
                  "frame": "scripts/lib/frame.py", "datum": "NAD 83 taken as WGS-84; heights above sea level"}}
    dest = ROOT / "public" / "data" / a.city / "airport.json"
    dest.write_text(_dump(out))
    n_lights = sum(len(g["xy"]) // 2 for g in out["lights"])
    print(f"{dest}: {len(out['runways'])} runways, {len(out['pavement']['taxiway'])} taxiway polygons, "
          f"{len(out['pavement']['apron'])} aprons, {len(out['taxiways'])} centre lines, {len(out['stands'])} stands "
          f"({len(out['standsOffApron'])} off the aprons), {n_lights} lights, {len(out['buildings'])} buildings "
          f"({dest.stat().st_size:,} bytes)")


def af_date(path):
    """The date a cached file was written."""
    return date.fromtimestamp(path.stat().st_mtime).isoformat() if path.exists() else None


if __name__ == "__main__":
    main()
