"""Polite, cached downloads for the data scripts: one request at a time, a pause after each, a generic
User-Agent and nothing that identifies the person running the build. Every response is kept under data/raw/."""
import json
import time
from datetime import date
from pathlib import Path

import requests

UA = {"User-Agent": "skyline-data/1.0"}
PAUSE_S = 1.0
OVERPASS = "https://overpass-api.de/api/interpreter"


def _get(url, params=None, data=None, timeout=300, tries=4):
    for attempt in range(tries):
        try:
            r = (requests.post(url, data=data, headers=UA, timeout=timeout) if data is not None
                 else requests.get(url, params=params, headers=UA, timeout=timeout))
            if r.status_code in (429, 502, 503, 504):
                raise requests.HTTPError(f"{r.status_code}")
            r.raise_for_status()
            return r
        except requests.RequestException as e:
            if attempt == tries - 1:
                raise
            wait = 30 * (attempt + 1)
            print(f"  {e.__class__.__name__} {e}; retrying in {wait} s")
            time.sleep(wait)
        finally:
            time.sleep(PAUSE_S)


def retrieved(path):
    return date.fromtimestamp(Path(path).stat().st_mtime).isoformat()


def arcgis_layer(url, cache: Path, where="1=1"):
    """Every feature of an ArcGIS FeatureServer layer as GeoJSON-like dicts in WGS84, cached as one JSON file.

    Returns {"meta": layer description, "features": [...], "url": url}."""
    if cache.exists():
        return json.loads(cache.read_text())
    cache.parent.mkdir(parents=True, exist_ok=True)
    meta = _get(url, params={"f": "json"}).json()
    oid = meta.get("objectIdField") or next(f["name"] for f in meta["fields"] if f["type"] == "esriFieldTypeOID")
    page = min(int(meta.get("maxRecordCount") or 1000), 2000)
    feats, offset = [], 0
    while True:
        d = _get(url + "/query", params={
            "where": where, "outFields": "*", "outSR": 4326, "f": "json", "orderByFields": oid,
            "resultOffset": offset, "resultRecordCount": page}).json()
        if "error" in d:
            raise RuntimeError(f"{url}: {d['error']}")
        got = d.get("features", [])
        feats += [{"a": f["attributes"], "lon": f["geometry"]["x"], "lat": f["geometry"]["y"]}
                  for f in got if f.get("geometry") and f["geometry"].get("x") is not None]
        offset += len(got)
        print(f"  {url.split('/services/')[1]}: {offset}")
        if not got or not d.get("exceededTransferLimit", len(got) == page):
            break
    keep = {k: meta.get(k) for k in ("name", "description", "copyrightText", "editingInfo", "fields")}
    out = {"url": url, "meta": keep, "features": feats, "skippedNoGeometry": offset - len(feats)}
    cache.write_text(json.dumps(out))
    return out


def overpass(query, cache: Path):
    if cache.exists():
        return json.loads(cache.read_text())
    cache.parent.mkdir(parents=True, exist_ok=True)
    r = _get(OVERPASS, data={"data": query}, timeout=900)
    cache.write_bytes(r.content)
    time.sleep(5)  # Overpass asks for restraint between heavy queries
    return r.json()


def cached_get(url, cache: Path, refresh=False):
    """GET `url` once and keep the response under `cache` (bytes, plus a .meta.json with the status and type).

    Returns (content_type, bytes). A cached copy is used unless `refresh`."""
    meta = cache.with_suffix(cache.suffix + ".meta.json")
    if cache.exists() and meta.exists() and not refresh:
        return json.loads(meta.read_text())["contentType"], cache.read_bytes()
    cache.parent.mkdir(parents=True, exist_ok=True)
    r = _get(url, timeout=120)
    cache.write_bytes(r.content)
    meta.write_text(json.dumps({"url": url, "status": r.status_code, "contentType": r.headers.get("content-type", "")}))
    return r.headers.get("content-type", ""), r.content
