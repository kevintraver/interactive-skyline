"""Counted traffic to the drive's flows: the stages of build_traffic.py, as pure functions.

Each stage takes plain Python data and returns plain Python data, so tests can run the whole
pipeline on a small fixture without the network, the geodatabase or a road network.

    stations = parse_stations(lines)                  # TMAS station records (pipe-delimited)
    records  = parse_volume(lines, keep)              # TMAS volume records, one per station/dir/lane/day
    days, dropped = station_days(records, stations)   # whole-carriageway daily vectors, lane-complete days only
    means    = hour_of_week_means(days)               # 168 means per station, direction, season
    shares   = lane_shares(records, days)             # per-lane share of the counted volume
    segments = build_segments(...)                    # levels between counters, lanes, speed, capacity

Conventions. TMAS travel direction 1 = north, 5 = south (3 = east, 7 = west). TMAS lane 1 is
the outside (rightmost) lane, numbering towards the median; the product lists lanes left to
right. Hour of week = 24 * day + hour with day 0 = Monday, local time, the hour that starts
then. Seasons are meteorological: Dec-Feb winter, Mar-May spring, Jun-Aug summer, Sep-Nov
autumn. TMAS station ids are TRINA's without the leading zero ("035440" and "0035440").
"""
import datetime as dt
import math

import numpy as np

SEASONS = ["winter", "spring", "summer", "autumn"]
SEASON_OF_MONTH = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0]
DIR_NAMES = {1: "north", 3: "east", 5: "south", 7: "west"}
HOURS = 168
MPH = 0.44704
CAPACITY_PCPHPL = 2300  # Highway Capacity Manual's basic-freeway capacity (plan, section 7.10: assumed)
TRUCK_PCE = 2.0  # passenger-car equivalent of a truck on level terrain (HCM), to turn pc/h into veh/h
LANE_OFFSET_MPH = (0.0, 3.0, 6.0)  # right to left; lanes further left keep the last value
MIN_DAYS_PER_WEEKDAY = 2  # a season is counted at a station when every weekday has this many days

VOLUME_FIELDS = ["record_type", "state_code", "f_system", "station_id", "travel_dir", "travel_lane",
                 "year_record", "month_record", "day_record", "day_of_week", "restrictions"] + \
                [f"hour_{h:02d}" for h in range(24)]
STATION_FIELDS = ["record_type", "state_code", "station_id", "travel_dir", "travel_lane", "year_record",
                  "f_system", "number_lanes_in_direction", "latitude", "longitude", "station_location"]


def tmas_id(station):
    """'0035440' or '035440' -> '035440' (TMAS form)."""
    s = str(station).strip()
    return s[1:] if len(s) == 7 and s.startswith("0") else s.zfill(6)


def trina_id(station):
    """'035440' -> '0035440' (TRINA form, used in the product)."""
    return "0" + tmas_id(station)


def season_of(date):
    return SEASON_OF_MONTH[date.month - 1]


def how_index(date, hour):
    """Hour-of-week index of `hour` on `date`: Monday 00:00 is 0."""
    return 24 * date.weekday() + hour


# ---------------------------------------------------------------- stage 1: read and clean

def parse_stations(lines):
    """TMAS station records -> {(station, dir): {"lanes": n, "lat", "lon", "location", "f_system"}}.

    One line per station, direction and lane, pipe-delimited in STATION_FIELDS order."""
    out = {}
    for line in lines:
        line = line.rstrip("\n")
        if not line.strip():
            continue
        v = dict(zip(STATION_FIELDS, line.split("|")))
        key = (tmas_id(v["station_id"]), int(v["travel_dir"]))
        lanes = int(v["number_lanes_in_direction"])
        rec = out.setdefault(key, {"lanes": lanes, "lat": _float(v["latitude"]), "lon": _float(v["longitude"]),
                                   "location": v["station_location"].strip(), "f_system": v["f_system"].strip(),
                                   "laneRecords": set()})
        rec["lanes"] = max(rec["lanes"], lanes)
        rec["laneRecords"].add(int(v["travel_lane"]))
    return out


def _float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def parse_volume(lines, keep=None):
    """TMAS volume records -> list of dicts (station, dir, lane, date, counts[24]).

    `keep` is an optional set of TMAS station ids. Two-digit years are taken as 20xx. Records
    whose stated day of week disagrees with the calendar are kept and counted in `mismatch`."""
    out = []
    for line in lines:
        line = line.rstrip("\n")
        if not line.strip():
            continue
        f = line.split("|")
        if len(f) < len(VOLUME_FIELDS):
            continue
        v = dict(zip(VOLUME_FIELDS, f))
        sid = tmas_id(v["station_id"])
        if keep is not None and sid not in keep:
            continue
        year = int(v["year_record"])
        year = year + 2000 if year < 100 else year
        date = dt.date(year, int(v["month_record"]), int(v["day_record"]))
        counts = [int(float(v[f"hour_{h:02d}"])) for h in range(24)]
        out.append({"station": sid, "dir": int(v["travel_dir"]), "lane": int(v["travel_lane"]),
                    "date": date, "dow": int(v["day_of_week"]), "counts": counts})
    return out


def station_days(records, stations):
    """Sum lanes to whole-carriageway days, keeping only days on which every lane reported.

    The expected lanes of a station and direction are 1..n with n from the station file. A day
    is dropped when a lane is missing, when a lane reported zero for the whole day, or when a
    count is negative. Returns (days, dropped):
      days[(station, dir)] = {date: np.array(24)}
      dropped = [{"station", "dir", "date", "reason"}]
    """
    by_day = {}
    for r in records:
        by_day.setdefault((r["station"], r["dir"], r["date"]), {})[r["lane"]] = r["counts"]
    days, dropped = {}, []
    for (sid, d, date), lanes in sorted(by_day.items()):
        st = stations.get((sid, d))
        n = st["lanes"] if st else max(lanes)
        expected = set(range(1, n + 1))
        missing = sorted(expected - set(lanes))
        reason = None
        if missing:
            reason = f"lane {','.join(map(str, missing))} missing"
        elif any(min(c) < 0 for c in lanes.values()):
            reason = "negative count"
        elif any(sum(lanes[k]) == 0 for k in expected):
            reason = f"lane {','.join(str(k) for k in sorted(expected) if sum(lanes[k]) == 0)} zero all day"
        if reason:
            dropped.append({"station": sid, "dir": d, "date": date.isoformat(), "reason": reason})
            continue
        total = np.sum([lanes[k] for k in expected], axis=0).astype(float)
        days.setdefault((sid, d), {})[date] = total
    return days, dropped


def summarise_dropped(dropped):
    """{(station, dir): {reason: count}} for the report."""
    out = {}
    for x in dropped:
        out.setdefault((x["station"], x["dir"]), {}).setdefault(x["reason"], 0)
        out[(x["station"], x["dir"])][x["reason"]] += 1
    return out


# ---------------------------------------------------------------- stage 2: hour-of-week means

def hour_of_week_means(days, min_days=MIN_DAYS_PER_WEEKDAY):
    """168 means per station, direction and season.

    Returns {(station, dir): {"flow": np.array(4, 168) (NaN where uncounted), "days": np.array(4, 7)
    of day counts, "covered": [bool]*4, "dailyMean": mean daily total over all kept days}}."""
    out = {}
    for key, dd in days.items():
        acc = np.zeros((4, 7, 24))
        cnt = np.zeros((4, 7))
        for date, v in dd.items():
            s, w = season_of(date), date.weekday()
            acc[s, w] += v
            cnt[s, w] += 1
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = acc / cnt[:, :, None]
        covered = [bool(np.all(cnt[s] >= min_days)) for s in range(4)]
        flow = mean.reshape(4, HOURS)
        for s in range(4):
            if not covered[s]:
                flow[s] = np.nan
        totals = np.array([v.sum() for v in dd.values()])
        out[key] = {"flow": flow, "days": cnt, "covered": covered, "counted": list(covered),
                    "dailyMean": float(totals.mean()) if len(totals) else float("nan"), "nDays": len(totals)}
    return out


def borrow_seasons(means, key, ref_key):
    """Fill the uncounted seasons of `key` with the reference station's flow in those seasons,
    scaled by the ratio of the two stations' volumes over the seasons both counted. Returns the
    list of borrowed season indices (empty when nothing was needed or possible)."""
    m, ref = means[key], means.get(ref_key)
    missing = [s for s in range(4) if not m["covered"][s]]
    if not missing or ref is None:
        return []
    both = [s for s in range(4) if m["counted"][s] and ref["counted"][s]]
    if not both:
        return []
    k = np.nansum(m["flow"][both]) / np.nansum(ref["flow"][both])
    done = []
    for s in missing:
        if ref["covered"][s]:
            m["flow"][s] = ref["flow"][s] * k
            m["covered"][s] = True
            done.append(s)
    return done


def season_weights(year):
    """Share of the year's days in each season."""
    w = np.zeros(4)
    d = dt.date(year, 1, 1)
    while d.year == year:
        w[season_of(d)] += 1
        d += dt.timedelta(days=1)
    return w / w.sum()


def aadt_of(flow, weights):
    """Annual average daily traffic of a (4, 168) flow table: the season-weighted mean day."""
    return float(np.sum(weights * flow.sum(axis=1) / 7.0))


# ---------------------------------------------------------------- acceptance figures

def day_pattern(days, weekday):
    """From kept source days: (mean total on `weekday` / mean day, hour of the peak of the mean
    `weekday` profile, that peak flow, mean `weekday` total, mean day)."""
    vals = list(days.values())
    mean_day = float(np.mean([v.sum() for v in vals]))
    sel = [v for d, v in days.items() if d.weekday() == weekday]
    prof = np.mean(sel, axis=0)
    return {"ratio": float(prof.sum() / mean_day), "peakHour": int(np.argmax(prof)), "peakFlow": float(prof.max()),
            "meanWeekday": float(prof.sum()), "meanDay": mean_day, "days": len(sel)}


def product_day_pattern(flow, weights, weekday):
    """The same figures from a product flow table (season-weighted)."""
    w = weights[:, None]
    week = np.sum(w * flow, axis=0)  # 168, season-weighted
    prof = week[24 * weekday:24 * weekday + 24]
    mean_day = week.sum() / 7.0
    return {"ratio": float(prof.sum() / mean_day), "peakHour": int(np.argmax(prof)), "peakFlow": float(prof.max()),
            "meanWeekday": float(prof.sum()), "meanDay": float(mean_day)}


# ---------------------------------------------------------------- stage 4: lanes

def lane_shares(records, days):
    """Per-lane share of the volume over the kept days of each station and direction, listed
    left to right. {(station, dir): [share, ...]}."""
    acc = {}
    for r in records:
        key = (r["station"], r["dir"])
        if key not in days or r["date"] not in days[key]:
            continue
        acc.setdefault(key, {}).setdefault(r["lane"], 0.0)
        acc[key][r["lane"]] += sum(r["counts"])
    out = {}
    for key, lanes in acc.items():
        n = max(lanes)
        v = np.array([lanes.get(k, 0.0) for k in range(n, 0, -1)])  # lane n (median side) first
        out[key] = list(v / v.sum())
    return out


def resample_shares(shares, n):
    """Lane shares observed on len(shares) lanes, carried to n lanes through the cumulative share
    across the carriageway's width (piecewise linear)."""
    m = len(shares)
    if m == n:
        return list(shares)
    x = np.linspace(0, 1, m + 1)
    cum = np.concatenate([[0], np.cumsum(shares)])
    cum_n = np.interp(np.linspace(0, 1, n + 1), x, cum)
    out = np.diff(cum_n)
    return list(out / out.sum())


def lane_offsets_mps(n):
    """Free-flow speed offset of each lane, left to right (plan 7.10: 0, +3, +6 mph from the right)."""
    right_to_left = [LANE_OFFSET_MPH[min(i, len(LANE_OFFSET_MPH) - 1)] * MPH for i in range(n)]
    return [round(v, 3) for v in reversed(right_to_left)]


def capacity_vph(lanes, truck_share):
    """Carriageway capacity in vehicles per hour: 2,300 pc/h/lane through the HCM heavy-vehicle factor."""
    f_hv = 1.0 / (1.0 + truck_share * (TRUCK_PCE - 1.0))
    return CAPACITY_PCPHPL * lanes * f_hv


# ---------------------------------------------------------------- stage 3 and 5: segments

def boundaries(length, cuts, anchors, merge=1.0):
    """Segment edges on [0, length]: the cut points (interchanges), plus a midpoint between any two
    anchors (count stations) that would otherwise share a segment. Returns sorted edges."""
    edges = sorted({0.0, float(length), *[float(c) for c in cuts if 0 < c < length]})
    edges = [e for i, e in enumerate(edges) if i == 0 or e - edges[i - 1] > merge or e == length]
    if edges[-2] >= length - merge and len(edges) > 2:
        edges.pop(-2)
    points = sorted({round(float(x["s"]), 3) for x in anchors})
    extra = []
    for a, b in zip(edges, edges[1:]):
        inside = [p for p in points if a <= p < b]
        extra += [(p + q) / 2 for p, q in zip(inside, inside[1:])]
    return sorted(set(edges) | set(extra))


def pick_anchor(anchors, a, b):
    """The anchor that sets a segment's level: a station with its own data for the direction
    first, then any other station inside [a, b)."""
    inside = [x for x in anchors if a <= x["s"] < b]
    inside.sort(key=lambda x: (x["kind"] != "permanent", abs(x["s"] - (a + b) / 2)))
    return inside[0] if inside else None


def build_direction(edges, anchors, shapes, means, weights, lanes_at, speed_at, truck_at, shares_for):
    """Segments of one direction.

    anchors: [{"id", "s", "kind": "permanent"|"short", "aadt" (this direction), "key" (TMAS key or None)}]
             a permanent anchor with a key carries its own flow; others carry a level only.
    shapes:  [{"key", "s"}] stations whose (4, 168) flow may shape a segment.
    means:   hour_of_week_means output (with borrowed seasons filled).
    lanes_at(a, b) -> int, speed_at(a, b) -> mph, truck_at(mid) -> share, shares_for(n, s) -> (list, note).
    """
    by_s = sorted(anchors, key=lambda x: x["s"])
    segs = []
    for a, b in zip(edges, edges[1:]):
        mid = (a + b) / 2
        anchor = pick_anchor(by_s, a, b)
        notes = []
        if anchor and anchor["kind"] in ("permanent", "permanent-total") and anchor.get("key") in means:
            own = means[anchor["key"]]["flow"]
            level_id = trina_id(anchor["key"][0])
            if anchor["kind"] == "permanent":
                flow = own.copy()
                notes.append(f"counted at {level_id}")
            else:
                flow = own * (anchor["aadt"] / aadt_of(own, weights))
                notes.append(f"shape counted at {level_id}; level {anchor['how']}")
            shape_id = level_id
            aadt = aadt_of(flow, weights)
        else:
            if anchor:
                target = anchor["aadt"]
                level_id = anchor["id"]
                notes.append(f"level: {anchor['how']} at {anchor['id']}")
            else:
                target, how = interpolate_level(by_s, mid)
                level_id = "interpolated"
                notes.append(how)
            flow, shape_id, how = shape_flow(shapes, means, weights, mid, target)
            notes.append(how)
            aadt = target
        n = lanes_at(a, b)
        truck = truck_at(mid)
        shares, share_note = shares_for(n, mid)
        notes.append(share_note)
        segs.append({
            "s0": round(a, 1), "s1": round(b, 1), "lanes": n,
            "freeFlowMps": round(speed_at(a, b) * MPH, 3),
            "capacityVph": round(capacity_vph(n, truck)),
            "laneSpeedOffsetsMps": lane_offsets_mps(n),
            "laneShares": [round(x, 4) for x in shares],
            "truckShare": truck, "aadt": round(aadt),
            "flow": [[round(float(x), 1) for x in row] for row in flow],
            "provenance": {"shape": shape_id, "level": level_id, "lanes": "osm", "notes": "; ".join(notes)},
        })
    # make the shares sum exactly to 1 after rounding
    for sgm in segs:
        sh = sgm["laneShares"]
        sh[int(np.argmax(sh))] = round(sh[int(np.argmax(sh))] + 1 - sum(sh), 4)
    return segs


def shape_flow(shapes, means, weights, s, target):
    """Flow with AADT `target` at chainage s, shaped by the counted stations either side.

    Between two shape stations, the traffic both share (up to the smaller station's AADT) keeps the
    smaller station's pattern, and the rest, the traffic that joins between them, takes the larger
    station's pattern: through traffic from the rural counter, local traffic from the urban one.
    Beyond the outermost shape station, or between two of similar size, the nearest one shapes it.
    Returns (flow (4, 168), shape id, note)."""
    left = [x for x in shapes if x["s"] <= s]
    right = [x for x in shapes if x["s"] > s]
    if not left or not right:
        x = min(shapes, key=lambda x: abs(x["s"] - s))
        f = means[x["key"]]["flow"]
        return f * (target / aadt_of(f, weights)), trina_id(x["key"][0]), f"shape: {trina_id(x['key'][0])}"
    p, q = left[-1], right[0]
    fp, fq = means[p["key"]]["flow"], means[q["key"]]["flow"]
    ap, aq = aadt_of(fp, weights), aadt_of(fq, weights)
    small, big = ((p, fp, ap), (q, fq, aq)) if ap <= aq else ((q, fq, aq), (p, fp, ap))
    if big[2] < 1.25 * small[2]:
        x, f, ax = (p, fp, ap) if s - p["s"] <= q["s"] - s else (q, fq, aq)
        return f * (target / ax), trina_id(x["key"][0]), f"shape: {trina_id(x['key'][0])}"
    through = min(target, small[2])
    flow = small[1] * (through / small[2]) + big[1] * ((target - through) / big[2])
    sid = f"{trina_id(small[0]['key'][0])}+{trina_id(big[0]['key'][0])}"
    return flow, sid, (f"shape: {through:.0f}/day through with {trina_id(small[0]['key'][0])}'s pattern, "
                       f"{target - through:.0f}/day local with {trina_id(big[0]['key'][0])}'s")


def interpolate_level(anchors, s):
    """AADT at s, linear in chainage between the nearest anchors either side; held beyond the ends."""
    left = [x for x in anchors if x["s"] <= s]
    right = [x for x in anchors if x["s"] > s]
    if left and right:
        p, q = left[-1], right[0]
        t = (s - p["s"]) / (q["s"] - p["s"])
        return p["aadt"] + t * (q["aadt"] - p["aadt"]), f"level interpolated between {p['id']} and {q['id']}"
    x = left[-1] if left else right[0]
    return x["aadt"], f"level held from {x['id']}"


def check_station_flows(segments, anchors, means, tol=0.01):
    """Acceptance: at every permanent station with its own data, the product's flow in each
    counted (not borrowed) season equals the source mean within `tol`. For a station whose
    directional levels are not trusted (kind "permanent-total"), its hourly pattern must be kept
    within `tol` (the level is checked on the two-way total by the caller). Per-station results."""
    out = []
    for x in anchors:
        if x["kind"] not in ("permanent", "permanent-total") or x.get("key") not in means:
            continue
        seg = segment_at(segments, x["s"])
        m = means[x["key"]]
        k = 1.0
        if x["kind"] == "permanent-total":
            cs = [s for s in range(4) if m["counted"][s]]
            k = float(np.sum(np.array(seg["flow"])[cs]) / np.sum(m["flow"][cs]))
        worst = 0.0
        for s in range(4):
            if not m["counted"][s]:
                continue
            src = m["flow"][s] * k
            prod = np.array(seg["flow"][s])
            rel = np.abs(prod - src) / np.maximum(src, 1.0)
            worst = max(worst, float(rel.max()))
        out.append({"station": trina_id(x["key"][0]), "dir": DIR_NAMES[x["key"][1]], "s": round(x["s"], 1),
                    "check": "flow" if k == 1.0 else "pattern (directional level from the two-way total)",
                    "levelScale": round(k, 4),
                    "seasonsCounted": [SEASONS[s] for s in range(4) if m["counted"][s]],
                    "maxRelError": worst, "pass": worst <= tol})
    return out


def segment_at(segments, s):
    for sg in segments:
        if sg["s0"] <= s < sg["s1"]:
            return sg
    return segments[-1] if s >= segments[-1]["s0"] else segments[0]


def is_finite_table(flow):
    return all(math.isfinite(v) for row in flow for v in row)
