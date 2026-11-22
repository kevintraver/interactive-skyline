# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "requests"]
# ///
"""Usage: fetch_osm.py <city> [--refresh]

Fetch from OpenStreetMap, through the public Overpass API, the directional route relations of
every road named in the city's "routes" (data/cities.json), with their member ways and nodes
inside the city's drive region (the wide terrain grid). The relations are selected by tags
(network, ref), never by id; both directions come back, since the opposite carriageway is
scenery. Junction nodes (highway=motorway_junction) are among the member ways' nodes; the
link ways that meet them come too, for their destination tags, as do the other motorways
within 2 km of each route end.

One request per road reference. The answer is cached under data/raw/<city>/ with Overpass's
snapshot timestamp inside, and a rerun with a warm cache makes no request (--refresh forces one).

A second request per road fetches what the interchanges are built from (plan 02, D3.4): every
motorway or motorway_link way within 800 m of the road's nodes, and every road way (motorway
down to service, with their links) tagged `bridge` within 300 m, with the ways two hops along
from it, so that the bridges that cross the road come with their approaches and their `bridge`
and `layer` tags, and the streets within 800 m (to tell where a ramp meets one). It is cached apart, so the
main line keeps being built from the first answer's snapshot.

A third request per road fetches the roadside barriers (plan 02, D3.6): every way tagged
`barrier` as guardrail, concrete barrier, cable barrier, wall, retaining wall or fence within
barrier_m of the road's nodes and of its links' nodes, with their nodes. Cached apart as well.

Output: data/raw/<city>/osm-<ref>.json     the Overpass JSON as received
        data/raw/<city>/osm-<ref>-x.json   the interchange extract
        data/raw/<city>/osm-<ref>-barriers.json   the barrier extract
"""
import json
import sys
import time
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.frame import create_frame  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ENDPOINT = "https://overpass-api.de/api/interpreter"
HEADERS = {"User-Agent": "road-pipeline/0.1"}

# OSM's tags for a route reference as written in cities.json ("I 15" -> network US:I, ref 15)
NETWORKS = {"I": "US:I", "US": "US:US"}


def ref_slug(ref):
    return ref.lower().replace(" ", "")


def cache_path(city, ref, root=ROOT, extract=""):
    return Path(root) / "data" / "raw" / city / f"osm-{ref_slug(ref)}{'-' + extract if extract else ''}.json"


def region_bbox(cfg, margin=0.02):
    """(south, west, north, east) in degrees around the city's widest terrain grid."""
    frame = create_frame(cfg)
    g = cfg["terrain"].get("wide") or cfg["terrain"]["far"]
    xs = np.array([g["x0"], g["x1"], g["x0"], g["x1"]], dtype=np.float64)
    ys = np.array([g["y0"], g["y0"], g["y1"], g["y1"]], dtype=np.float64)
    lat, lon = frame.to_geodetic(xs, ys)
    return (float(lat.min()) - margin, float(lon.min()) - margin, float(lat.max()) + margin, float(lon.max()) + margin)


def query(ref, bbox, ends=()):
    """Overpass QL: the route relations, their ways and nodes in the bbox; the link ways at
    their junction nodes (destination tags, and which side an exit leaves on); and every other
    motorway way near each route end (the crossing roads there), with their nodes."""
    prefix, num = ref.split()
    s, w, n, e = (f"{v:.5f}" for v in bbox)
    near = "".join(f'way["highway"="motorway"](around:2000,{p["lat"]},{p["lon"]});' for p in ends)
    return f"""[out:json][timeout:300];
rel["type"="route"]["route"="road"]["network"="{NETWORKS[prefix]}"]["ref"="{num}"]({s},{w},{n},{e})->.r;
way(r.r)({s},{w},{n},{e})->.w;
node(w.w)->.n;
node.n["highway"="motorway_junction"]->.j;
way(bn.j)["highway"="motorway_link"]->.l;
({near})->.x;
(.x; - .w;)->.x;
(node(w.x); node(w.l);)->.xn;
.r out body;
.w out body;
.n out body;
.l out body;
.x out body;
.xn out skel;
"""


ROAD_CLASSES = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|" \
               "motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"


STREET_CLASSES = "trunk|primary|secondary|tertiary|unclassified|residential|trunk_link|primary_link|secondary_link|tertiary_link"


def interchange_query(ref, bbox, links_m=800, bridges_m=300):
    """Overpass QL for the interchange extract: the road's ways (by their route relations, as
    in query()), then every motorway and link way within links_m of their nodes, every road
    way with a `bridge` tag within bridges_m, the road ways two hops along from each bridge (its
    approaches), and the streets within links_m (where a ramp ends), all with their nodes. Tags only, never ids. (around.w on this
    set answers nothing on the public instance, so distances are measured from the nodes.)"""
    prefix, num = ref.split()
    s, w, n, e = (f"{v:.5f}" for v in bbox)
    hw = f'["highway"~"^({ROAD_CLASSES})$"]'
    return f"""[out:json][timeout:600];
rel["type"="route"]["route"="road"]["network"="{NETWORKS[prefix]}"]["ref"="{num}"]({s},{w},{n},{e})->.r;
way(r.r)({s},{w},{n},{e})->.w;
node(w.w)->.n;
way(around.n:{links_m})["highway"~"^(motorway|motorway_link)$"]->.l;
way(around.n:{bridges_m}){hw}["bridge"]["bridge"!="no"]->.b;
node(w.b)->.bn;
way(bn.bn){hw}->.b1;
node(w.b1)->.b1n;
way(bn.b1n){hw}->.b2;
way(around.n:{links_m})["highway"~"^({STREET_CLASSES})$"]->.s;
(.l; .b; .b1; .b2; .s;)->.a;
node(w.a)->.an;
.a out body;
.an out skel;
"""


BARRIER_KINDS = "guard_rail|jersey_barrier|cable_barrier|wall|retaining_wall|fence|city_wall|concrete_block"


def barrier_query(ref, bbox, barrier_m=120):
    """Overpass QL for the barrier extract: the road's ways (by their route relations, as in
    query()), the motorway links at their junctions, and every `barrier` way of BARRIER_KINDS
    within barrier_m of either's nodes, with its nodes. Tags only, never ids."""
    prefix, num = ref.split()
    s, w, n, e = (f"{v:.5f}" for v in bbox)
    return f"""[out:json][timeout:600];
rel["type"="route"]["route"="road"]["network"="{NETWORKS[prefix]}"]["ref"="{num}"]({s},{w},{n},{e})->.r;
way(r.r)({s},{w},{n},{e})->.w;
node(w.w)->.n;
way(around.n:300)["highway"="motorway_link"]->.l;
node(w.l)->.ln;
(.n; .ln;)->.all;
way(around.all:{barrier_m})["barrier"~"^({BARRIER_KINDS})$"]->.b;
node(w.b)->.bn;
.b out body;
.bn out skel;
"""


def overpass(q, tries=6):
    """POST one query, retrying with exponential backoff on rate limits, timeouts and server errors."""
    wait = 15
    for attempt in range(1, tries + 1):
        try:
            r = requests.post(ENDPOINT, data={"data": q}, headers=HEADERS, timeout=400)
            if r.status_code == 200:
                doc = r.json()
                if "remark" in doc and not doc.get("elements"):
                    raise RuntimeError(f"Overpass remark: {doc['remark']}")
                return doc
            err = f"HTTP {r.status_code}"
        except (requests.RequestException, ValueError, RuntimeError) as ex:
            err = str(ex)
        if attempt == tries:
            sys.exit(f"Overpass failed after {tries} tries: {err}")
        print(f"  {err}; retrying in {wait} s", file=sys.stderr)
        time.sleep(wait)
        wait *= 2


def fetch(city, ref, cfg, refresh=False, root=ROOT):
    path = cache_path(city, ref, root)
    if path.exists() and not refresh:
        doc = json.loads(path.read_text())
        print(f"{ref}: cached, snapshot {doc['osm3s']['timestamp_osm_base']} ({path.relative_to(root)})")
        return doc
    path.parent.mkdir(parents=True, exist_ok=True)
    bbox = region_bbox(cfg)
    print(f"{ref}: querying Overpass for bbox {bbox}")
    ends = [r[k] for r in cfg.get("routes", []) if r["ref"] == ref for k in ("start", "end")]
    doc = overpass(query(ref, bbox, ends))
    doc["query"] = {"ref": ref, "bbox": bbox}
    path.write_text(json.dumps(doc))
    kinds = {}
    for el in doc["elements"]:
        kinds[el["type"]] = kinds.get(el["type"], 0) + 1
    print(f"{ref}: snapshot {doc['osm3s']['timestamp_osm_base']}, {kinds}, {path.stat().st_size / 1e6:.1f} MB")
    return doc


def fetch_interchanges(city, ref, cfg, refresh=False, root=ROOT):
    path = cache_path(city, ref, root, "x")
    if path.exists() and not refresh:
        doc = json.loads(path.read_text())
        print(f"{ref} interchanges: cached, snapshot {doc['osm3s']['timestamp_osm_base']} ({path.relative_to(root)})")
        return doc
    path.parent.mkdir(parents=True, exist_ok=True)
    bbox = region_bbox(cfg)
    print(f"{ref} interchanges: querying Overpass")
    doc = overpass(interchange_query(ref, bbox))
    if not any(el["type"] == "way" for el in doc["elements"]):
        sys.exit(f"{ref} interchanges: the answer has no ways; not cached")
    doc["query"] = {"ref": ref, "bbox": bbox, "extract": "interchanges"}
    path.write_text(json.dumps(doc))
    print(f"{ref} interchanges: snapshot {doc['osm3s']['timestamp_osm_base']}, {len(doc['elements'])} elements, "
          f"{path.stat().st_size / 1e6:.1f} MB")
    return doc


def fetch_barriers(city, ref, cfg, refresh=False, root=ROOT):
    path = cache_path(city, ref, root, "barriers")
    if path.exists() and not refresh:
        doc = json.loads(path.read_text())
        print(f"{ref} barriers: cached, snapshot {doc['osm3s']['timestamp_osm_base']} ({path.relative_to(root)})")
        return doc
    path.parent.mkdir(parents=True, exist_ok=True)
    bbox = region_bbox(cfg)
    print(f"{ref} barriers: querying Overpass")
    doc = overpass(barrier_query(ref, bbox))
    doc["query"] = {"ref": ref, "bbox": bbox, "extract": "barriers"}
    path.write_text(json.dumps(doc))
    print(f"{ref} barriers: snapshot {doc['osm3s']['timestamp_osm_base']}, {len(doc['elements'])} elements, "
          f"{path.stat().st_size / 1e6:.1f} MB")
    return doc


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        sys.exit(__doc__)
    city = args[0]
    cfg = json.loads((ROOT / "data" / "cities.json").read_text())[city]
    refs = sorted({r["ref"] for r in cfg.get("routes", [])}) or sys.exit(f"{city} has no routes in data/cities.json")
    for ref in refs:
        fetch(city, ref, cfg, refresh="--refresh" in sys.argv)
        fetch_interchanges(city, ref, cfg, refresh="--refresh" in sys.argv)
        fetch_barriers(city, ref, cfg, refresh="--refresh" in sys.argv)


if __name__ == "__main__":
    main()
