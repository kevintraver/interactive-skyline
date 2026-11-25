"""readsb trace_full files from the adsb.lol archive: reading them, and finding them in a day's tar stream.

The layout is readsb's (README-json.md, "trace jsons", https://github.com/wiedehopf/readsb/blob/dev/README-json.md,
read 2026-11-23): a header {icao, r, t, desc, dbFlags, timestamp, trace} and per point
  [seconds after timestamp, lat, lon, altitude ft | "ground" | null, ground speed kt, track deg (true heading on
   the ground), flags, vertical rate fpm, aircraft object | null, source, geometric altitude ft,
   geometric vertical rate fpm, indicated airspeed kt, roll deg]
the last five only in files written from 2022. Flags: 1 stale position, 2 start of a new leg, 4 vertical rate is
geometric, 8 altitude is geometric. Geometric altitude is above the WGS-84 ellipsoid.

An archive day (adsb.lol globe_history, one GitHub release per UTC day split into `.tar.aa`, `.tar.ab`) holds one
gzip-compressed member per aircraft, `traces/<last two hex>/trace_full_<hex>.json`. `ChainedStream` reads the parts
as one stream, resuming a dropped connection at the same byte; `iter_trace_members` yields the trace members from a
tar read in streaming mode, so a day is never stored.
"""
import gzip
import json
import math
import re
import tarfile
import time
import zlib
from dataclasses import dataclass, fields

import numpy as np

FT = 0.3048
KT = 1852 / 3600
FPM = FT / 60
# The aircraft's own ADS-B position: received directly, or rebroadcast by an FAA ground station (ADS-R). MLAT,
# TIS-B (radar) and Mode S are not positions the aircraft reported, and are dropped.
ADSB_SOURCES = ("adsb_icao", "adsr_icao")
_MEMBER = re.compile(r"(?:^|/)traces/[0-9a-f]{2}/trace_full_(~?[0-9a-f]{6})\.json$")


@dataclass
class Points:
    """One aircraft's points as parallel numpy arrays (absolute epoch seconds in `t`)."""
    t: np.ndarray
    lat: np.ndarray
    lon: np.ndarray
    alt_baro_ft: np.ndarray   # NaN on the ground or when absent
    ground: np.ndarray        # bool
    gs_kt: np.ndarray
    track: np.ndarray         # true track in the air, true heading on the ground
    flags: np.ndarray         # int
    vrate_fpm: np.ndarray
    src: np.ndarray           # str ("" before 2022)
    alt_geom_ft: np.ndarray
    geom_rate_fpm: np.ndarray
    ias_kt: np.ndarray
    roll: np.ndarray
    has_state: np.ndarray     # bool: the point carries the aircraft object
    state: list               # the aircraft objects (None where absent)

    def __len__(self):
        return len(self.t)

    @property
    def stale(self):
        return (self.flags & 1) > 0

    @property
    def new_leg(self):
        return (self.flags & 2) > 0

    @property
    def vrate_is_geom(self):
        return (self.flags & 4) > 0

    @property
    def alt_is_geom(self):
        return (self.flags & 8) > 0

    def take(self, idx):
        """A subset (index array or boolean mask), keeping the order given."""
        idx = np.asarray(idx)
        if idx.dtype == bool:
            idx = np.flatnonzero(idx)
        kw = {f.name: getattr(self, f.name)[idx] for f in fields(self) if f.name != "state"}
        return Points(**kw, state=[self.state[i] for i in idx])


def _num(v):
    return np.nan if v is None or isinstance(v, str) else float(v)


def points(trace):
    """The points of one parsed trace_full dict."""
    t0 = float(trace["timestamp"])
    rows = trace.get("trace") or []
    n = len(rows)
    col = lambda i: [r[i] if len(r) > i else None for r in rows]  # noqa: E731
    alt = col(3)
    ground = np.array([a == "ground" for a in alt], dtype=bool)
    state = col(8)
    return Points(
        t=t0 + np.array([float(r[0]) for r in rows], dtype=np.float64),
        lat=np.array([float(r[1]) for r in rows]),
        lon=np.array([float(r[2]) for r in rows]),
        alt_baro_ft=np.array([_num(a) for a in alt]),
        ground=ground,
        gs_kt=np.array([_num(v) for v in col(4)]),
        track=np.array([_num(v) for v in col(5)]),
        flags=np.array([int(v or 0) for v in col(6)], dtype=np.int64),
        vrate_fpm=np.array([_num(v) for v in col(7)]),
        src=np.array([v or "" for v in col(9)], dtype=object) if n else np.array([], dtype=object),
        alt_geom_ft=np.array([_num(v) for v in col(10)]),
        geom_rate_fpm=np.array([_num(v) for v in col(11)]),
        ias_kt=np.array([_num(v) for v in col(12)]),
        roll=np.array([_num(v) for v in col(13)]),
        has_state=np.array([isinstance(s, dict) for s in state], dtype=bool),
        state=state,
    )


def stitch(*parts):
    """Join the points of consecutive files of one aircraft (any order), dropping repeated instants."""
    parts = [p for p in parts if len(p)]
    if not parts:
        raise ValueError("nothing to stitch")
    kw = {}
    for f in fields(Points):
        if f.name == "state":
            kw["state"] = [s for p in parts for s in p.state]
        else:
            kw[f.name] = np.concatenate([getattr(p, f.name) for p in parts])
    allp = Points(**kw)
    order = np.argsort(allp.t, kind="stable")
    allp = allp.take(order)
    keep = np.concatenate([[True], np.diff(allp.t) > 1e-3])
    return allp.take(keep)


def adsb_share(p):
    """The share of points positioned by the aircraft's own ADS-B."""
    return float(np.isin(p.src, ADSB_SOURCES).mean()) if len(p) else 0.0


def filter_sources(p):
    """Step 2 of 7.2: keep ADS-B positions, drop stale points, MLAT, TIS-B and the rest."""
    return p.take(np.isin(p.src, ADSB_SOURCES) & ~p.stale)


def load(blob_or_path):
    """A trace_full dict from archive bytes (gzip or plain JSON) or a path to such a file."""
    if not isinstance(blob_or_path, (bytes, bytearray)):
        with open(blob_or_path, "rb") as fh:
            blob_or_path = fh.read()
    data = bytes(blob_or_path)
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return json.loads(data)


_HEAD_KEYS = re.compile(rb'"(icao|r|t|desc)"\s*:\s*"([^"]*)"')


def peek_header(blob, nbytes=4096):
    """The header fields (icao, r, t, desc) from the start of a gzip member, decompressing only its first bytes."""
    if blob[:2] == b"\x1f\x8b":
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        head = d.decompress(blob[:nbytes], 2048)
    else:
        head = blob[:2048]
    cut = head.find(b'"trace"')
    if cut >= 0:
        head = head[:cut]
    found = {k.decode(): v.decode() for k, v in _HEAD_KEYS.findall(head)}
    return {k: found.get(k) for k in ("icao", "r", "t", "desc")}


@dataclass
class Near:
    """A disc around a reference point; `below_ft` limits the airborne points that count (ground always counts)."""
    lat: float
    lon: float
    radius_m: float
    below_ft: float = 20000.0


def _dist_m(lat0, lon0, lat, lon):
    k = math.pi / 180
    dx = (lon - lon0) * k * 6371000 * math.cos(lat0 * k)
    dy = (lat - lat0) * k * 6371000
    return np.hypot(dx, dy)


def is_near(p, near):
    if not len(p):
        return False
    low = p.ground | (np.nan_to_num(p.alt_baro_ft, nan=1e9) < near.below_ft)
    return bool(np.any(low & (_dist_m(near.lat, near.lon, p.lat, p.lon) < near.radius_m)))


def first_filter(blob, types, near):
    """The cheap test applied to every member of a day: a listed type, then a point inside the disc."""
    head = peek_header(blob)
    if head["t"] not in types:
        return False
    try:
        return is_near(points(load(blob)), near)
    except (ValueError, KeyError, OSError, EOFError, zlib.error):
        return False


class ChainedStream:
    """The archive's parts read as one file object, reopening at the same byte when a connection drops.

    `openers[i](offset)` returns a file-like object positioned at `offset` within part i; `sizes[i]` is its length.
    `progress(position, total)` is called every `report_every` bytes."""

    def __init__(self, openers, sizes, retries=8, wait_s=20, progress=None, report_every=64 << 20):
        self.openers, self.sizes = list(openers), list(sizes)
        self.total = sum(self.sizes)
        self.retries, self.wait_s = retries, wait_s
        self.progress, self.report_every = progress, report_every
        self.part, self.offset, self.position = 0, 0, 0
        self._fh, self._next_report = None, report_every

    def readable(self):
        return True

    def _open(self):
        self._fh = self.openers[self.part](self.offset)

    def read(self, n=-1):
        if n is None or n < 0:
            n = 1 << 20
        out = bytearray()
        while len(out) < n and self.part < len(self.openers):
            if self.offset >= self.sizes[self.part]:
                self._close()
                self.part, self.offset = self.part + 1, 0
                continue
            for attempt in range(self.retries + 1):
                try:
                    if self._fh is None:
                        self._open()
                    chunk = self._fh.read(min(n - len(out), self.sizes[self.part] - self.offset))
                    break
                except (OSError, ConnectionError, Exception) as e:  # requests' errors are not all OSErrors
                    self._close()
                    if attempt == self.retries:
                        raise
                    print(f"  stream: {e.__class__.__name__} at part {self.part} byte {self.offset}; reopening",
                          flush=True)
                    time.sleep(self.wait_s * (attempt + 1))
            if not chunk:
                if self.offset < self.sizes[self.part]:
                    # the server ended early: reopen at this byte
                    self._close()
                    continue
            out += chunk
            self.offset += len(chunk)
            self.position += len(chunk)
            if self.progress and self.position >= self._next_report:
                self._next_report += self.report_every
                self.progress(self.position, self.total)
        return bytes(out)

    def _close(self):
        if self._fh is not None:
            try:
                self._fh.close()
            except Exception:
                pass
        self._fh = None


def iter_trace_members(fileobj):
    """(hex, bytes) for every trace_full member of a tar read as a stream; other members are skipped."""
    with tarfile.open(fileobj=fileobj, mode="r|") as tf:
        for m in tf:
            if not m.isfile():
                continue
            hit = _MEMBER.search(m.name)
            if not hit:
                continue
            fh = tf.extractfile(m)
            yield hit.group(1), fh.read()


# --- arrivals --------------------------------------------------------------------------------------------------

def _end_axes(end):
    hdg = math.radians(end["gridHeading"])
    u = np.array([math.sin(hdg), math.cos(hdg)])
    return np.array(end["threshold"][:2], dtype=float), u, np.array([u[1], -u[0]])


def runway_coords(end, x, n):
    """Along (m past the landing threshold, in the landing direction) and lateral (m right of the centre line)."""
    thr, u, right = _end_axes(end)
    dx, dn = np.asarray(x) - thr[0], np.asarray(n) - thr[1]
    return dx * u[0] + dn * u[1], dx * right[0] + dn * right[1]


def _angle_diff(a, b):
    return (np.asarray(a) - b + 180.0) % 360.0 - 180.0


def classify_runway(airport, x, n, grid_track, max_lateral=120.0, max_heading=25.0, before_m=3500.0):
    """The runway end a final was flown to, from points of the last couple of kilometres before touchdown and the
    first of the rollout: the end whose centre line the points sit closest to, aligned with its direction.
    Returns (end id or None, median lateral offset in m)."""
    best, best_off = None, None
    for eid, end in airport["ends"].items():
        along, lat = runway_coords(end, x, n)
        length = next(r["surveyedLength"] for r in airport["runways"] if eid in r["ends"])
        sel = (along > -before_m) & (along < length) & (np.abs(_angle_diff(grid_track, end["gridHeading"])) < max_heading)
        if sel.sum() < 3:
            continue
        off = float(np.median(lat[sel]))
        if abs(off) < max_lateral and (best_off is None or abs(off) < abs(best_off)):
            best, best_off = eid, off
    return best, best_off


def refine_touchdown(p, i, end, x, n, level_fpm=-64.0, min_slowdown_kt=15.0):
    """The touchdown of a landing whose first surface position is point i.

    Some transponders report the surface format only below a ground speed (about 100 kt on the 737-800 selected for
    lv-19-day, 16 s and 1 km after the wheels touched), and keep sending airborne positions while they roll. Such a
    rollout shows in the airborne points before the flag: past the threshold, on the centre line, a vertical rate
    that has come up to level and stays there while the ground speed falls. The touchdown is then where the
    vertical rate rises through `level_fpm` (one step of its 64 fpm resolution below level).
    Returns (time, source, index of the first rolling point or None)."""
    t_flag = float(p.t[i])
    along, lat = runway_coords(end, x, n)
    w = np.flatnonzero((p.t >= t_flag - 60) & (p.t < t_flag) & ~p.ground & np.isfinite(p.vrate_fpm)
                       & (along > -50) & (np.abs(lat) < 40))
    if len(w) < 2:
        return t_flag, "surface flag", None
    vr = p.vrate_fpm[w]
    below = np.flatnonzero(vr < level_fpm)
    if not len(below) or below[-1] == len(w) - 1:
        return t_flag, "surface flag", None
    k = below[-1] + 1                       # the first point of the final levelled run
    j0, jp = w[k], w[k - 1]
    slowed = np.nan_to_num(p.gs_kt[j0]) - np.nan_to_num(p.gs_kt[i]) >= min_slowdown_kt
    if not (slowed and along[j0] >= 0 and t_flag - p.t[j0] >= 3):
        return t_flag, "surface flag", None
    f = (level_fpm - p.vrate_fpm[jp]) / (p.vrate_fpm[j0] - p.vrate_fpm[jp])
    return float(p.t[jp] + f * (p.t[j0] - p.t[jp])), "levelled before the surface flag", int(j0)


def find_landings(p, airport, frame, look_back_s=1800.0):
    """Every landing at the airport in a trace: air-to-ground transitions on a runway, each with its runway end,
    whether a go-around came first, and the index and time of the first surface position."""
    if len(p) < 5:
        return []
    x, n = frame.to_local(p.lat, p.lon)
    x, n = np.asarray(x), np.asarray(n)
    north = np.degrees(np.arctan2(*(np.subtract(frame.to_local(p.lat + 1e-4, p.lon), (x, n)))))
    grid_trk = (p.track + north) % 360
    field = airport["arp"]["elevation"]
    out = []
    g = p.ground
    for i in np.flatnonzero(~g[:-1] & g[1:]) + 1:
        # the ground segment must last (not one stray flag) and the aircraft must have flown before it
        j = i
        while j < len(p) and g[j]:
            j += 1
        if p.t[min(j, len(p) - 1)] - p.t[i] < 8 and j - i < 3:
            continue
        w = (p.t >= p.t[i] - 90) & (p.t <= p.t[i] + 15) & np.isfinite(grid_trk)
        w &= np.hypot(x - x[i], n - n[i]) < 6000
        rwy, off = classify_runway(airport, x[w], n[w], grid_trk[w])
        if rwy is None:
            continue
        # where the previous leg ended: the last surface position before this flight
        prev = np.flatnonzero(g[:i - 1] & (p.t[:i - 1] < p.t[i] - 60))
        start = max(p.t[i] - look_back_s, p.t[prev[-1]] if len(prev) else -np.inf)
        alt = np.where(np.isfinite(p.alt_baro_ft), p.alt_baro_ft * FT, p.alt_geom_ft * FT) - field
        near = np.hypot(x - airport["arp"]["x"], n - airport["arp"]["y"]) < 9000
        seg = (p.t > start) & (p.t < p.t[i] - 5) & ~g & np.isfinite(alt)
        go_around = False
        lows = np.flatnonzero(seg & near & (alt < 250))
        if len(lows):
            after = seg & (p.t > p.t[lows[0]]) & (alt > 450)
            go_around = bool(after.any())
        t_td, source, j0 = refine_touchdown(p, i, airport["ends"][rwy], x, n)
        out.append({"index": int(i), "t": t_td, "tFlag": float(p.t[i]), "touchdownSource": source,
                    "rollIndex": j0, "runway": rwy, "lateral": round(off, 1),
                    "goAround": go_around, "x": float(x[j0 if j0 is not None else i]),
                    "n": float(n[j0 if j0 is not None else i]), "surface": True})

    # Arrivals whose surface positions were never received (common at Las Vegas: coverage ends 20 to 60 s before
    # touchdown): a descent below 250 m over the field on a runway's final, not followed by a climb. The touchdown
    # time is estimated from the last point's ground speed, 450 m past the threshold.
    alt = np.where(np.isfinite(p.alt_baro_ft), p.alt_baro_ft * FT, p.alt_geom_ft * FT) - field
    near = np.hypot(x - airport["arp"]["x"], n - airport["arp"]["y"]) < 9000
    low = ~g & np.isfinite(alt) & (alt < 250) & near & (np.nan_to_num(p.vrate_fpm) <= 0)
    idx = np.flatnonzero(low)
    if len(idx):
        for ep in np.split(idx, np.flatnonzero(np.diff(p.t[idx]) > 600) + 1):
            k = int(ep[-1])
            if any(p.t[k] - 30 <= l["t"] <= p.t[k] + 300 for l in out):
                continue
            later = (p.t > p.t[k]) & (p.t < p.t[k] + 600)
            if np.any(later & ~g & (alt > 450) & near):
                continue          # climbed away: a go-around (or a low pass), not a landing
            if np.any(later & g):
                continue
            w = (p.t >= p.t[k] - 120) & (p.t <= p.t[k]) & np.isfinite(grid_trk)
            rwy, off = classify_runway(airport, x[w], n[w], grid_trk[w], before_m=6000.0)
            if rwy is None:
                continue
            along, _ = runway_coords(airport["ends"][rwy], x[k], n[k])
            gs = p.gs_kt[k] * KT if np.isfinite(p.gs_kt[k]) and p.gs_kt[k] > 50 else 70.0
            t_td = float(p.t[k] + max(0.0, 450.0 - float(along)) / gs)
            start = p.t[k] - look_back_s
            seg = (p.t > start) & (p.t < p.t[ep[0]] - 60) & ~g & np.isfinite(alt)
            lows = np.flatnonzero(seg & near & (alt < 250))
            go_around = bool(len(lows) and np.any(seg & (p.t > p.t[lows[0]]) & (alt > 450)))
            end = airport["ends"][rwy]
            thr, u, _ = _end_axes(end)
            px, pn = thr + 450.0 * u
            out.append({"index": k, "t": t_td, "runway": rwy, "lateral": round(off, 1), "goAround": go_around,
                        "x": float(px), "n": float(pn), "surface": False})
    out.sort(key=lambda l: l["t"])
    return out
