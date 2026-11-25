"""The FAA's Coded Instrument Flight Procedures (CIFP), an ARINC 424-18 file, read for one airport's runways and
instrument approaches (plan 03, F2.6): each approach's final approach course, glide path angle and threshold crossing
height, for the procedure check of the baked flights.

Fixed-column records (1-based columns as in ARINC 424):
  airport records   cols 7-10 airport, 13 subsection: G runway, F approach, P path point (SBAS FAS data block),
                    C terminal waypoint
  runway (G)        14-18 runway id, 28-31 magnetic bearing (tenths), 33-41 / 42-51 threshold latitude/longitude,
                    67-71 landing threshold elevation (ft), 72-75 displaced threshold (ft), 76-77 crossing height (ft)
  approach (F)      14-19 procedure id, 20 route type, 27-29 sequence, 30-34 fix, 40-43 description code (4th
                    character F: final approach fix; 1st G: runway fix), 48-49 path and terminator, 85-89 altitude
                    (ft; at the runway fix the threshold crossing altitude), 103-106 vertical angle (hundredths of
                    a degree, negative descending)
  path point (P)    14-19 procedure id, 20-24 runway, 25-27 record number (001 primary), 61-66 landing threshold
                    ellipsoid height (tenths of a metre), 67-70 glide path angle (hundredths), 105-108 crossing
                    height (tenths) and 109 its unit (F or M)
  waypoint (C, EA)  14-18 ident, 33-41 / 42-51 latitude/longitude

  Source  https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/ (public domain), the
          cycle's zip with FAACIFP18 inside.
"""
import math

ROUTE_TYPES = {"H": "RNAV (RNP)", "R": "RNAV (GPS)", "I": "ILS", "L": "LOC", "S": "VOR", "X": "LDA", "N": "NDB",
               "P": "GPS", "U": "SDF", "Q": "NDB/DME", "V": "VOR", "D": "VOR/DME"}


def _latlon(s):
    """'N36055177' / 'W115092719' (degrees, minutes, seconds and hundredths) to decimal degrees."""
    hemi, body = s[0], s[1:]
    if len(body) == 8:          # latitude ddmmsscc
        d, m, sec = int(body[:2]), int(body[2:4]), int(body[4:]) / 100
    else:                       # longitude dddmmsscc
        d, m, sec = int(body[:3]), int(body[3:5]), int(body[5:]) / 100
    v = d + m / 60 + sec / 3600
    return -v if hemi in "SW" else v


def _num(s, scale=1.0):
    s = s.strip()
    if not s:
        return None
    try:
        return int(s) * scale
    except ValueError:
        return None


def airport_lines(lines, icao):
    """The airport's own records, and every terminal or enroute waypoint record (for fixes used by its procedures)."""
    own, fixes = [], []
    for ln in lines:
        if len(ln) < 50 or ln[0] != "S":
            continue
        if ln[4] == "P" and ln[6:10] == icao:
            own.append(ln)
        elif (ln[4] == "P" and ln[12] == "C") or (ln[4:6] == "EA"):
            fixes.append(ln)
    return own, fixes


def runways(own):
    out = {}
    for ln in own:
        if ln[12] != "G" or ln[13:15] != "RW":
            continue
        rid = ln[15:18].strip()
        out[rid] = {"lat": _latlon(ln[32:41]), "lon": _latlon(ln[41:51]),
                    "magneticBearing": _num(ln[27:31], 0.1), "thresholdElevationFt": _num(ln[66:71]),
                    "displacedFt": _num(ln[71:75]), "crossingHeightFt": _num(ln[75:77])}
    return out


def waypoints(lines):
    out = {}
    for ln in lines:
        ident = ln[13:18].strip()
        try:
            out.setdefault(ident, (_latlon(ln[32:41]), _latlon(ln[41:51])))
        except (ValueError, IndexError):
            continue
    return out


def path_points(own):
    """SBAS final approach segment data blocks: {procedure id: {angle, tchFt, ltpEllipsoidM}}."""
    out = {}
    for ln in own:
        if ln[12] != "P" or ln[24:27] != "001":       # the primary record (002 is its continuation)
            continue
        proc = ln[13:19].strip()
        try:
            ltp = int(ln[60:66]) / 10
            angle = int(ln[66:70]) / 100
            tch = int(ln[104:108]) / 10
        except ValueError:
            continue
        unit = ln[108]
        out[proc] = {"angle": angle, "tchFt": tch if unit == "F" else round(tch / 0.3048, 1), "ltpEllipsoidM": ltp,
                     "runway": ln[21:24].strip()}
    return out


def bearing_deg(lat1, lon1, lat2, lon2):
    """Initial true bearing from point 1 to point 2 on the sphere (degrees)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360


def approaches(own, fixes):
    """Each instrument approach with its runway, type, final approach fix, the fix before the runway, vertical angle,
    crossing height (the runway fix's altitude minus the threshold elevation, or the FAS block's) and the final
    approach course (true bearing from the fix before the runway to the threshold)."""
    rwys = runways(own)
    wps = waypoints([ln for ln in own if ln[12] == "C"] + fixes)   # the airport's own terminal fixes first
    fas = path_points(own)
    legs = {}
    for ln in own:
        if ln[12] != "F":
            continue
        proc, route = ln[13:19].strip(), ln[19]
        if route != proc[0]:          # transitions ('A') are not the final approach
            continue
        if ln[38] not in ("0", "1"):  # continuation records
            continue
        legs.setdefault(proc, []).append(ln)
    out = {}
    for proc, ls in sorted(legs.items()):
        ls.sort(key=lambda ln: ln[26:29])
        rw_i = next((i for i, ln in enumerate(ls) if ln[29:31] == "RW"), None)
        if rw_i is None:
            continue
        rwy = ls[rw_i][31:34].strip()
        if rwy not in rwys:
            continue
        r = rwys[rwy]
        faf = next((ln[29:34].strip() for ln in ls if ln[42] == "F"), None)
        prev = next((ls[i][29:34].strip() for i in range(rw_i - 1, -1, -1) if ls[i][29:34].strip()), None)
        va = _num(ls[rw_i][102:106], 0.01)
        alt = _num(ls[rw_i][84:89])
        tch = None if alt is None or r["thresholdElevationFt"] is None else alt - r["thresholdElevationFt"]
        course = None
        if prev in wps:
            la, lo = wps[prev]
            course = round(bearing_deg(la, lo, r["lat"], r["lon"]), 2)
        entry = {"runway": rwy, "type": ROUTE_TYPES.get(proc[0], proc[0]), "faf": faf, "lastFix": prev,
                 "glidePathDeg": None if va is None else round(abs(va), 2), "crossingHeightFt": tch,
                 "finalCourseTrue": course}
        if proc in fas:
            entry["fas"] = fas[proc]
            entry["glidePathDeg"] = entry["glidePathDeg"] or fas[proc]["angle"]
        out[proc] = entry
    # an approach whose missed approach point is not the runway (an LNAV/VNAV line to a fix): its FAS data block
    # still names the runway, the angle and the crossing height
    for proc, f in fas.items():
        if proc in out or f["runway"] not in rwys:
            continue
        r = rwys[f["runway"]]
        ls = legs.get(proc, [])
        faf = next((ln[29:34].strip() for ln in ls if ln[42] == "F"), None)
        course = None
        if faf in wps:
            course = round(bearing_deg(*wps[faf], r["lat"], r["lon"]), 2)
        out[proc] = {"runway": f["runway"], "type": ROUTE_TYPES.get(proc[0], proc[0]), "faf": faf, "lastFix": faf,
                     "glidePathDeg": f["angle"], "crossingHeightFt": f["tchFt"], "finalCourseTrue": course, "fas": f}
    return dict(sorted(out.items())), rwys
