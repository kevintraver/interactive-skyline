"""Hand corrections to corridor building heights (data/corridor_overrides.json), for build_corridor.py.

Several resort complexes along the routes are one OSM outline with no height, so the ladder gives
their towers the height of a casino floor. An override names a building by its OSM id ("w123",
"r456") or by a point inside it ([lat, lon]), gives a height in metres and where it came from, and
where one outline covers a low podium and a tower, says where the tower stands:

    {"osm": "w501940847", "height": 119, "source": "...",
     "tower": {"polygon": [[lat, lon], ...]},      # the tower's footprint, clipped to the outline
     "podium": 14}                                 # the rest of the outline (default: as the ladder has it)
    {"point": [35.61, -115.39], "height": 40, "source": "estimated",
     "tower": {"fraction": 0.3, "at": [lat, lon]}} # the outline shrunk to 30 % of its area about `at`

Without `tower` the whole outline takes the height. Pure functions over shapely geometry in local
metres; `to_local(lat_array, lon_array) -> (x, y)` is the build's frame.
"""
import math

from shapely import affinity
from shapely.geometry import MultiPolygon, Point, Polygon


class OverrideError(ValueError):
    pass


def load(doc, to_local):
    """The overrides of a parsed data/corridor_overrides.json, checked, with points and polygons in local metres."""
    out = []
    for i, o in enumerate(doc.get("buildings", [])):
        where = f"corridor override {i}"
        if ("osm" in o) == ("point" in o):
            raise OverrideError(f"{where}: give exactly one of 'osm' and 'point'")
        h = o.get("height")
        if not isinstance(h, (int, float)) or not 0 < h < 1000:
            raise OverrideError(f"{where}: 'height' must be metres above ground")
        if not o.get("source"):
            raise OverrideError(f"{where}: 'source' is required (a reference, or \"estimated\")")
        r = {"osm": o.get("osm"), "height": float(h), "source": o["source"], "podium": o.get("podium"), "note": o.get("note", "")}
        if "point" in o:
            x, y = to_local([o["point"][0]], [o["point"][1]])
            r["point"] = Point(float(x[0]), float(y[0]))
        t = o.get("tower")
        if t is not None:
            if "polygon" in t:
                lat, lon = zip(*t["polygon"])
                x, y = to_local(list(lat), list(lon))
                poly = Polygon(list(zip(map(float, x), map(float, y))))
                if not poly.is_valid or poly.area < 10:
                    raise OverrideError(f"{where}: the tower polygon is not a valid footprint")
                r["tower"] = {"polygon": poly}
            elif "fraction" in t:
                f = t["fraction"]
                if not 0 < f < 1:
                    raise OverrideError(f"{where}: tower 'fraction' must be between 0 and 1")
                at = None
                if "at" in t:
                    x, y = to_local([t["at"][0]], [t["at"][1]])
                    at = Point(float(x[0]), float(y[0]))
                r["tower"] = {"fraction": float(f), "at": at}
            else:
                raise OverrideError(f"{where}: 'tower' needs 'polygon' or 'fraction'")
        out.append(r)
    return out


def find(overrides, key, poly):
    """The override for building `key` with footprint `poly` (local metres), or None. An id wins over a point."""
    for o in overrides:
        if o["osm"] and o["osm"] == key:
            return o
    for o in overrides:
        if "point" in o and poly.contains(o["point"]):
            return o
    return None


def _largest(g):
    if isinstance(g, Polygon):
        return g
    if isinstance(g, MultiPolygon):
        return max(g.geoms, key=lambda q: q.area)
    polys = [q for q in getattr(g, "geoms", []) if isinstance(q, Polygon)]
    return max(polys, key=lambda q: q.area) if polys else None


def tower_of(o, poly):
    """The tower's footprint inside `poly`, or None when the override has none (or it misses the outline)."""
    t = o.get("tower")
    if not t:
        return None
    if "polygon" in t:
        g = poly.intersection(t["polygon"])
    else:
        at = t["at"] or poly.representative_point()
        s = math.sqrt(t["fraction"])
        g = poly.intersection(affinity.scale(poly, s, s, origin=at))
    g = _largest(g.buffer(0)) if not g.is_empty else None
    return g if g is not None and g.area >= 10 else None


def apply(o, key, poly, height, rung, override_rung):
    """The pieces of one building under override `o`: [(id, polygon, height, rung)]. With a tower, the
    podium is the outline less the tower (kept whole under the tower too would draw it twice) at the
    override's `podium` height or the ladder's, and the tower is a building of its own, `<id>:tower`."""
    tower = tower_of(o, poly)
    if o.get("tower") and tower is None:
        raise OverrideError(f"corridor override for {key}: the tower misses the outline")
    if tower is None:
        return [(key, poly, o["height"], override_rung)]
    podium_h, podium_rung = (float(o["podium"]), override_rung) if o.get("podium") else (height, rung)
    rest = poly.difference(tower).buffer(0)
    pieces = sorted([q for q in (rest.geoms if hasattr(rest, "geoms") else [rest]) if isinstance(q, Polygon) and q.area >= 10],
                    key=lambda q: -q.area)
    out = [(key if k == 0 else f"{key}:{k + 1}", q, min(podium_h, o["height"]), podium_rung) for k, q in enumerate(pieces)]
    out.append((f"{key}:tower", tower, o["height"], override_rung))
    return out
