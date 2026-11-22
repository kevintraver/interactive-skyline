"""The rules of the corridor build (build_corridor.py): which buildings to keep, how high they are,
and how their footprints are tidied. Pure functions, so tests/data/test_corridor.py can hold them.

    t = building_type(tags, area)            # a TYPES code from lib.corridor_format
    h, rung = height_of(tags, area, overture_h)
    keep(dist, area, h, rules)               # the distance-band rule
    rings = tidy(poly)                       # simplified, oriented rings, small holes dropped
"""
import math

from .corridor_format import RUNG, TYPE
from .ladder import LEVEL_M, num

# The keep rule: every building this close to the route of at least `near_area`; out to `band`, those of
# `band_area` or `band_height`; anywhere in the drive region, every building of `tall` or more.
RULES = {"near": 400.0, "near_area": 30.0, "band": 1500.0, "band_area": 60.0, "band_height": 8.0, "tall": 20.0}

HOUSE = {"house", "detached", "semidetached_house", "terrace", "bungalow", "residential", "farm", "cabin", "static_caravan", "villa"}
APARTMENTS = {"apartments", "dormitory"}
RETAIL = {"retail", "commercial", "supermarket", "kiosk", "service"}
WAREHOUSE = {"warehouse", "industrial", "manufacture", "storage_tank", "hangar", "factory", "data_center", "transportation"}
HOTEL = {"hotel", "casino", "motel"}
OFFICE = {"office"}
CIVIC = {"school", "church", "civic", "public", "government", "hospital", "university", "college", "fire_station",
         "train_station", "sports_hall", "stadium", "religious", "mosque", "temple", "kindergarten", "police"}
CANOPY = {"roof", "carport"}
SHED = {"shed", "garage", "garages", "hut", "greenhouse", "barn", "stable", "container"}


def building_type(tags, area=0.0):
    b = (tags.get("building") or "yes").strip().lower()
    if tags.get("amenity") == "fuel" and b == "roof":
        return TYPE["canopy"]
    for names, code in ((HOUSE, "house"), (APARTMENTS, "apartments"), (RETAIL, "retail"), (WAREHOUSE, "warehouse"),
                        (HOTEL, "hotel"), (OFFICE, "office"), (CIVIC, "civic"), (CANOPY, "canopy"), (SHED, "shed")):
        if b in names:
            return TYPE[code]
    if tags.get("tourism") in ("hotel", "motel") or tags.get("amenity") == "casino":
        return TYPE["hotel"]
    if tags.get("shop") or tags.get("amenity") in ("restaurant", "fast_food", "cafe", "bank", "pharmacy"):
        return TYPE["retail"]
    return TYPE["other"]


def guess_height(t, area):
    """The last rung: a height from the type and the footprint's area alone."""
    if t == TYPE["house"]:
        return 4.5 if area < 350 else 6.5
    if t == TYPE["shed"]:
        return 3.0
    if t == TYPE["canopy"]:
        return 5.0
    if t == TYPE["apartments"]:
        return 9.0
    if t == TYPE["retail"]:
        return 5.5 if area < 1500 else 7.5 if area < 6000 else 9.5  # a shop, a strip, a big box
    if t == TYPE["warehouse"]:
        return 7.0 if area < 2000 else 11.0
    if t == TYPE["hotel"]:
        return 7.0 if area < 2500 else 12.0  # a motel, a low casino floor
    if t in (TYPE["office"], TYPE["civic"]):
        return 7.0 if area < 3000 else 10.0
    return 4.0 if area < 250 else 5.5 if area < 1500 else 8.0 if area < 8000 else 10.0


def overture_plausible(h, area):
    """Overture's height, unless it is missing or implausible: over 15 m on a footprint under 400 m2 is
    almost always a tree or a pole that the imagery model took for a building (clusters of 80 m2 "buildings"
    25 m tall in the south valley), so those fall through to the guess."""
    if h is None or not math.isfinite(h) or h <= 1.0:
        return False
    return not (area < 400 and h > 15)


def height_of(tags, area, overture=None):
    """(height above ground in metres, rung code). OSM `height`, then `building:levels`, then Overture's
    height, then the guess by type and area (the core's ladder without LiDAR, which stops at the core)."""
    h = num(tags.get("height"))
    if h and h > 0:
        return h, RUNG["osm-height"]
    lv = num(tags.get("building:levels"))
    if lv and lv > 0:
        return lv * LEVEL_M + (num(tags.get("roof:levels")) or 0) * LEVEL_M, RUNG["osm-levels"]
    if overture_plausible(overture, area):
        return float(overture), RUNG["overture"]
    return guess_height(building_type(tags, area), area), RUNG["guess"]


def keep(dist, area, height, rules=RULES):
    """The distance-band rule. `dist` is the footprint's distance from the route in metres (inf if far)."""
    if height >= rules["tall"]:
        return True
    if dist <= rules["near"]:
        return area >= rules["near_area"]
    if dist <= rules["band"]:
        return area >= rules["band_area"] or height >= rules["band_height"]
    return False


def tidy(poly, tol=1.0, min_hole=6.0):
    """Rings for the format: simplified to `tol` metres, the outer counter-clockwise, holes clockwise and
    those under `min_hole` m2 dropped, open (the first point not repeated). [] when nothing is left."""
    from shapely.geometry import Polygon  # here, so the rules above need no shapely
    from shapely.geometry.polygon import orient
    p = poly.simplify(tol, preserve_topology=True)
    if p.is_empty or not isinstance(p, Polygon) or p.area < 1:
        p = poly
    holes = [h for h in p.interiors if Polygon(h).area >= min_hole]
    p = orient(Polygon(p.exterior, holes), 1.0)
    rings = [list(p.exterior.coords)[:-1]] + [list(h.coords)[:-1] for h in p.interiors]
    if len(rings[0]) < 3:
        return []
    return [r for r in rings[:255] if len(r) >= 3]
