"""Downloads for build_airport.py beyond NASR: the FAA's airport-mapping layers on its public ArcGIS service, the
FAA's Digital Obstacle File (same service) and OpenStreetMap's aeroways through Overpass. Each answer is kept as
received under data/raw/airport/<faa>/ with the date it was fetched, and a warm cache makes no request.

Polite: lib.fetch's generic User-Agent, one request at a time with a pause, nothing about the person running it.

    from lib.airport_fetch import faa_layer, faa_obstacles, osm_aeroways
    faa_layer("AM_Taxiway", faa_id, cache_dir)      # {"url", "fetched", "meta", "features": [esri features]}
    faa_obstacles((s, w, n, e), cache_dir)            # obstacles inside a lat/lon box
    osm_aeroways((s, w, n, e), cache_dir)             # Overpass JSON with "fetched"
"""
import json
from datetime import date
from pathlib import Path

ARCGIS = "https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services"
LAYERS = ("AM_Runway", "AM_Taxiway", "AM_Apron", "AM_Building", "AM_Beacon")
META_KEYS = ("name", "description", "copyrightText", "geometryType", "editingInfo")


def _get(url, params):
    from .fetch import _get as get  # requests only when downloading
    return get(url, params=params).json()


def _query(layer, params, cache: Path):
    if cache.exists():
        return json.loads(cache.read_text())
    cache.parent.mkdir(parents=True, exist_ok=True)
    url = f"{ARCGIS}/{layer}/FeatureServer/0"
    meta = _get(url, {"f": "json"})
    feats, offset = [], 0
    while True:
        d = _get(url + "/query", {**params, "outFields": "*", "outSR": 4326, "f": "json",
                                   "orderByFields": "OBJECTID", "resultOffset": offset, "resultRecordCount": 1000})
        if "error" in d:
            raise RuntimeError(f"{url}: {d['error']}")
        got = d.get("features", [])
        feats += got
        offset += len(got)
        if not got or not d.get("exceededTransferLimit"):
            break
    out = {"url": url, "query": params, "fetched": date.today().isoformat(),
           "meta": {k: meta.get(k) for k in META_KEYS}, "features": feats}
    cache.write_text(json.dumps(out))
    print(f"  {layer}: {len(feats)} features")
    return out


def faa_layer(layer, faa, cache_dir: Path):
    """Every feature of one airport-mapping layer for the airport `faa` (its FAA id), geometry in WGS-84."""
    return _query(layer, {"where": f"FAA_ID='{faa}'"}, Path(cache_dir) / f"faa-{layer}.json")


def faa_obstacles(box, cache_dir: Path):
    """Digital Obstacle File points inside the lat/lon box (south, west, north, east)."""
    s, w, n, e = box
    return _query("Digital_Obstacle_File", {
        "where": "1=1", "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
        "spatialRel": "esriSpatialRelIntersects"}, Path(cache_dir) / "faa-Digital_Obstacle_File.json")


def overpass_query(box):
    """Every aeroway element in the lat/lon box (south, west, north, east), with way geometry inline."""
    s, w, n, e = box
    bb = f"{s:.6f},{w:.6f},{n:.6f},{e:.6f}"
    return f"[out:json][timeout:180];\nnwr[aeroway]({bb});\nout tags geom;"


def osm_aeroways(box, cache_dir: Path):
    """The Overpass answer for overpass_query(box), cached; "fetched" is added to it."""
    cache = Path(cache_dir) / "osm-aeroways.json"
    if cache.exists():
        return json.loads(cache.read_text())
    from .fetch import overpass
    doc = overpass(overpass_query(box), cache)
    doc["fetched"] = date.today().isoformat()
    cache.write_text(json.dumps(doc))
    return doc
