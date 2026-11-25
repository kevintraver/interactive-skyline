"""Cut the offline fixtures for tests/python/flight/test_airport_*.py from the cached raw answers."""
import json, sys
from pathlib import Path
ROOT = Path(sys.argv[1]); sys.path.insert(0, str(ROOT / "scripts"))
from lib.frame import create_frame
fr = create_frame(json.loads((ROOT / "data/cities.json").read_text())["lv"])
RAW = ROOT / "data/raw/airport/LAS"
FX = ROOT / "tests/python/flight/fixtures"
BOXES = [(2700, -4700, 4700, -3000), (0, -4600, 600, -4000)]

def inside(lonlats):
    for lon, lat in lonlats:
        x, y = fr.to_local(lat, lon)
        if any(a <= x <= c and b <= y <= d for a, b, c, d in BOXES):
            return True
    return False

out = FX / "faa_las"; out.mkdir(exist_ok=True)
for name in ["AM_Runway", "AM_Taxiway", "AM_Apron", "AM_Building", "AM_Beacon", "Digital_Obstacle_File"]:
    d = json.loads((RAW / f"faa-{name}.json").read_text())
    def pts(f):
        g = f["geometry"]
        return [p for r in g["rings"] for p in r] if "rings" in g else [(g["x"], g["y"])]
    keep = d["features"] if name == "AM_Runway" else [f for f in d["features"] if inside(pts(f))]
    d["features"] = keep
    d["meta"]["description"] = (d["meta"].get("description") or "")[:400]
    (out / f"faa-{name}.json").write_text(json.dumps(d, separators=(",", ":")))
    print(name, len(keep))
o = json.loads((RAW / "osm-aeroways.json").read_text())
def epts(e):
    if "geometry" in e: return [(p["lon"], p["lat"]) for p in e["geometry"] if p]
    if "lat" in e: return [(e["lon"], e["lat"])]
    if "members" in e: return [(p["lon"], p["lat"]) for m in e["members"] for p in m.get("geometry", [])]
    return []
o["elements"] = [e for e in o["elements"] if e.get("tags", {}).get("aeroway") not in ("aerodrome", "helipad", "apron_entrance_marking") and inside(epts(e)) or e.get("tags", {}).get("aeroway") == "runway"]
outo = FX / "osm_las"; outo.mkdir(exist_ok=True)
(outo / "osm-aeroways.json").write_text(json.dumps(o, separators=(",", ":")))
import collections
print(collections.Counter(e.get("tags", {}).get("navigationaid") or e.get("tags", {}).get("aeroway") for e in o["elements"]))
