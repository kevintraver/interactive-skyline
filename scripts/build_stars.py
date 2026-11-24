# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "requests"]
# ///
"""Usage: build_stars.py

The naked-eye star field from the Yale Bright Star Catalogue, 5th revised edition
(Hoffleit and Warren 1991, CDS catalogue V/50).

Output: public/data/sky/stars.bin   12 bytes per star, brightest first:
            int16 x3  J2000 unit vector (equatorial, x to 0h, z to the north pole) x 32767
            int16     V magnitude in millimagnitudes
            uint8 x3  colour, linear sRGB scaled so the largest channel is 255
            uint8     flags (FLAGS below)
        public/data/sky/stars.json  layout, counts, provenance, and the index of named stars
"""
import gzip
import json
import math
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "stars"
OUT = ROOT / "public" / "data" / "sky"
UA = {"User-Agent": "interactive-skyline-data/1.0"}
# CDS first; the CfA VizieR mirror carries the same files and answers when Strasbourg does not.
MIRRORS = ["https://cdsarc.cds.unistra.fr/ftp/V/50/", "https://vizier.cfa.harvard.edu/ftp/cats/V/50/"]

FLAGS = {"variable": 1, "multiple": 2, "colourFromSpectralType": 4, "colourDefault": 8}
RECORD = 12

# Harvard Revised number -> proper name, for the stars a test or a label may want to find.
NAMES = {
    2491: "Sirius", 2326: "Canopus", 5340: "Arcturus", 5459: "Rigil Kentaurus", 7001: "Vega",
    1708: "Capella", 1713: "Rigel", 2943: "Procyon", 472: "Achernar", 2061: "Betelgeuse",
    5267: "Hadar", 7557: "Altair", 4730: "Acrux", 1457: "Aldebaran", 5056: "Spica",
    6134: "Antares", 2990: "Pollux", 8728: "Fomalhaut", 7924: "Deneb", 4853: "Mimosa",
    3982: "Regulus", 2618: "Adhara", 2891: "Castor", 1790: "Bellatrix", 1791: "Elnath",
    1903: "Alnilam", 1948: "Alnitak", 1852: "Mintaka", 2004: "Saiph", 424: "Polaris",
    4905: "Alioth", 4301: "Dubhe", 5191: "Alkaid", 4554: "Phecda", 4295: "Merak",
    4660: "Megrez", 5054: "Mizar", 168: "Schedar", 21: "Caph", 6879: "Kaus Australis",
    7121: "Nunki", 6527: "Shaula", 5953: "Dschubba", 15: "Alpheratz", 8781: "Markab",
    617: "Hamal", 936: "Algol", 1017: "Mirfak", 4534: "Denebola", 6556: "Rasalhague",
    7790: "Peacock", 3685: "Miaplacidus", 3634: "Alsuhail", 8162: "Alderamin",
}


def fetch(name):
    p = RAW / name
    if p.exists():
        return p, None
    import requests
    RAW.mkdir(parents=True, exist_ok=True)
    for base in MIRRORS:
        try:
            r = requests.get(base + name, headers=UA, timeout=30)
            r.raise_for_status()
        except requests.RequestException as e:
            print(f"  {base}: {e.__class__.__name__}", file=sys.stderr)
            continue
        p.write_bytes(r.content)
        time.sleep(1)
        return p, base + name
    raise SystemExit(f"could not fetch {name} from any mirror")


def ballesteros_kelvin(bv):
    """Black-body temperature from B-V (Ballesteros 2012, EPL 97, 34008, eq. 14)."""
    return 4600.0 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))


def planck_xy(t):
    """CIE 1931 chromaticity of a black body, Kim et al. (2002) cubic fit, 1667-25000 K."""
    t = min(max(t, 1667.0), 25000.0)
    if t <= 4000:
        x = -0.2661239e9 / t**3 - 0.2343589e6 / t**2 + 0.8776956e3 / t + 0.179910
    else:
        x = -3.0258469e9 / t**3 + 2.1070379e6 / t**2 + 0.2226347e3 / t + 0.240390
    if t <= 2222:
        y = -1.1063814 * x**3 - 1.34811020 * x**2 + 2.18555832 * x - 0.20219683
    elif t <= 4000:
        y = -0.9549476 * x**3 - 1.37418593 * x**2 + 2.09137015 * x - 0.16748867
    else:
        y = 3.0817580 * x**3 - 5.87338670 * x**2 + 3.75112997 * x - 0.37001483
    return x, y


XYZ_TO_LINEAR_SRGB = np.array([[3.2404542, -1.5371385, -0.4985314],
                               [-0.9692660, 1.8760108, 0.0415560],
                               [0.0556434, -0.2040259, 1.0572252]])


def kelvin_rgb(t):
    """Linear sRGB of a black body at t kelvin, largest channel 1."""
    x, y = planck_xy(t)
    rgb = XYZ_TO_LINEAR_SRGB @ np.array([x / y, 1.0, (1 - x - y) / y])
    rgb = np.clip(rgb, 0, None)
    return rgb / rgb.max()


SPECTRAL_BV = {"O": -0.30, "B": -0.15, "A": 0.10, "F": 0.45, "G": 0.70, "K": 1.15, "M": 1.60,
               "C": 2.50, "N": 2.50, "R": 2.00, "S": 1.70, "W": -0.25}


def parse(lines):
    """Rows of the catalogue with a position, as dicts. Novae and galaxies (no J2000 position) are dropped."""
    stars, dropped = [], []
    for raw in lines:
        l = raw.ljust(197)
        hr = int(l[0:4])
        if not l[75:77].strip():
            dropped.append(hr)
            continue
        ra = (int(l[75:77]) + int(l[77:79]) / 60 + float(l[79:83]) / 3600) * 15
        de = int(l[84:86]) + int(l[86:88]) / 60 + int(l[88:90]) / 3600
        if l[83] == "-":
            de = -de
        bv = float(l[109:114]) if l[109:114].strip() else None
        stars.append({"hr": hr, "name": l[4:14].strip(), "ra": ra, "dec": de, "v": float(l[102:107]),
                      "bv": bv, "sp": l[127:147].strip(), "var": bool(l[51:60].strip()),
                      "mult": bool(l[43].strip() or l[44:49].strip())})
    return stars, dropped


def unit_vector(ra_deg, dec_deg):
    a, d = math.radians(ra_deg), math.radians(dec_deg)
    return (math.cos(d) * math.cos(a), math.cos(d) * math.sin(a), math.sin(d))


def encode(stars):
    """Pack stars (already sorted) into the 12-byte records. Returns (bytes, colour source counts)."""
    rec = np.zeros(len(stars), dtype=[("v", "<i2", 3), ("mag", "<i2"), ("rgb", "u1", 3), ("flags", "u1")])
    for i, s in enumerate(stars):
        flags = (FLAGS["variable"] if s["var"] else 0) | (FLAGS["multiple"] if s["mult"] else 0)
        bv = s["bv"]
        if bv is None:
            bv = SPECTRAL_BV.get(s["sp"][:1])
            flags |= FLAGS["colourFromSpectralType"] if bv is not None else FLAGS["colourDefault"]
            bv = 0.6 if bv is None else bv
        rec["v"][i] = np.round(np.array(unit_vector(s["ra"], s["dec"])) * 32767)
        rec["mag"][i] = round(s["v"] * 1000)
        rec["rgb"][i] = np.round(kelvin_rgb(ballesteros_kelvin(bv)) * 255)
        rec["flags"][i] = flags
    return rec.tobytes()


def main():
    cat, cat_url = fetch("catalog.gz")
    _, readme_url = fetch("ReadMe")
    lines = gzip.decompress(cat.read_bytes()).decode("latin-1").splitlines()
    stars, dropped = parse(lines)
    stars.sort(key=lambda s: (s["v"], s["hr"]))
    blob = encode(stars)
    assert len(blob) == RECORD * len(stars)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "stars.bin").write_bytes(blob)
    index = {NAMES[s["hr"]]: i for i, s in enumerate(stars) if s["hr"] in NAMES}
    missing = sorted(set(NAMES.values()) - set(index))
    assert not missing, missing
    no_bv = sum(1 for s in stars if s["bv"] is None)
    meta = {
        "file": "stars.bin", "count": len(stars), "recordBytes": RECORD, "order": "V magnitude, brightest first",
        "layout": [
            {"name": "direction", "type": "int16", "count": 3, "scale": 1 / 32767,
             "note": "J2000 equatorial unit vector at epoch 2000.0: x toward RA 0h, y toward RA 6h, z toward the north celestial pole"},
            {"name": "vmag", "type": "int16", "count": 1, "scale": 0.001, "note": "Johnson V"},
            {"name": "color", "type": "uint8", "count": 3, "scale": 1 / 255,
             "note": "linear sRGB, largest channel 255: black body at Ballesteros' temperature for B-V (EPL 97, 34008, eq. 14), CIE xy from Kim et al. 2002"},
            {"name": "flags", "type": "uint8", "count": 1, "bits": FLAGS},
        ],
        "properMotion": "not applied; the largest in the catalogue moves a star about 0.1 degree in 50 years",
        "names": index,
        "source": {
            "catalogue": "Yale Bright Star Catalogue, 5th Revised Ed. (Preliminary Version), CDS V/50",
            "citation": "Hoffleit D., Warren Jr W.H. 1991, The Bright Star Catalogue, 5th Revised Ed., Astronomical Data Center, NSSDC/ADC (CDS V/50)",
            "url": cat_url or MIRRORS[0] + "catalog.gz",
            "readme": readme_url or MIRRORS[0] + "ReadMe",
            "mirrors": MIRRORS,
            "retrieved": date.fromtimestamp(cat.stat().st_mtime).isoformat(),
            "licence": "No licence or restriction stated in the catalogue's ReadMe",
            "records": len(lines),
        },
        "dropped": {"count": len(dropped), "hr": dropped, "why": "no J2000 position: novae and extragalactic objects kept only to preserve the numbering"},
        "colour": {"fromBV": len(stars) - no_bv,
                   "fromSpectralType": sum(1 for s in stars if s["bv"] is None and s["sp"][:1] in SPECTRAL_BV),
                   "default": sum(1 for s in stars if s["bv"] is None and s["sp"][:1] not in SPECTRAL_BV)},
    }
    (OUT / "stars.json").write_text(json.dumps(meta, indent=1))
    print(f"{len(stars)} stars ({len(dropped)} dropped), {len(blob):,} bytes")
    print("colour:", meta["colour"])
    for s in stars[:10]:
        print(f"  {s['v']:6.2f}  HR {s['hr']:4d}  {NAMES.get(s['hr'], s['name'])}")


if __name__ == "__main__":
    main()
