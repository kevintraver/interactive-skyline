# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Usage: make_beam.py [--check]

Headlamp candela maps for the drive (plan 02, D5.1 and section 7.7), for ONE lamp of a two-lamp system.

Writes public/data/drive/beam_low.bin, beam_high.bin (float16, little-endian, row-major; row 0 is the lowest
vertical angle, column 0 the leftmost horizontal angle) and public/data/drive/beam.json (grid, units, sources,
peaks, the regulation's test points and how the maps meet them).

Angles: h is horizontal, positive to the driver's RIGHT (the kerb side in right-hand traffic); v is vertical,
positive UP; both in degrees from the lamp's aimed H-V axis, as FMVSS 108 measures them. Grid: h -45..+45 by
0.5, v -15..+10 by 0.25.

Sources.
  [C6] FMVSS 108 (49 CFR 571.108), 2023 edition, read from the govinfo PDF on 2026-11-22: Table XIX-a,
       column "Lower beam #1V (LB1V)" (the visually/optically aimed lower beam of a two-lamp system; it is the
       table quoted in plan 02, section 7.7), and Table XVIII, column "Upper beam #2 (UB2)" (40,000-75,000 cd
       at H-V, as section 7.7 states).
  [G4] UMTRI-2004-23, market-weighted US low-beam patterns: COULD NOT BE FETCHED (the repository answers
       scripts with a browser challenge). So, as the plan allows, the maps are a smooth, physically shaped
       lobe fitted inside the regulation's limits instead of the survey's medians: the low beam has a hot
       spot below and right of the axis, a horizontal cutoff just under the horizon and a weak spill above it
       (which is what lights overhead signs); the high beam has a centred hot spot on a broad flood.
  Every lobe parameter below is ASSUMED (shaped by hand to sit inside [C6] with margin and to resemble
  typical published US low-beam isocandela plots); the test points are [C6].

The build fails (exit 1) when any test point is outside its limits after the clamp pass.
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "data" / "drive"

H0, H1, DH = -45.0, 45.0, 0.5
V0, V1, DV = -15.0, 10.0, 0.25
NH = int(round((H1 - H0) / DH)) + 1  # 181
NV = int(round((V1 - V0) / DV)) + 1  # 101
FLOAT16_MAX = 65504.0

# ---------------------------------------------------------------- FMVSS 108 test points [C6]
# (name, v range, h range, min cd, max cd). A range (lo, hi) means every angle in it; "1.5L to L" is h <= -1.5
# out to the map's edge, "10U to 90U" is v >= 10 (only v = 10 is inside the map). None: no limit.
L, R, U = -45.0, 45.0, 10.0
LOW_POINTS = [  # Table XIX-a, LB1V
    ("10U-90U, 90L-90R", (10, U), (L, R), None, 125),
    ("4U 8L", (4, 4), (-8, -8), 64, None),
    ("4U 8R", (4, 4), (8, 8), 64, None),
    ("2U 4L", (2, 2), (-4, -4), 135, None),
    ("1.5U 1R-3R", (1.5, 1.5), (1, 3), 200, None),
    ("1.5U 1R-R", (1.5, 1.5), (1, R), None, 1400),
    ("1U 1.5L-L", (1, 1), (L, -1.5), None, 700),
    ("0.5U 1.5L-L", (0.5, 0.5), (L, -1.5), None, 1000),
    ("0.5U 1R-3R", (0.5, 0.5), (1, 3), 500, 2700),
    ("H-V", (0, 0), (0, 0), None, 5000),
    ("H 4L", (0, 0), (-4, -4), 135, None),
    ("H 8L", (0, 0), (-8, -8), 64, None),
    ("0.6D 1.3R", (-0.6, -0.6), (1.3, 1.3), 10000, None),
    ("0.86D V", (-0.86, -0.86), (0, 0), 4500, None),
    ("0.86D 3.5L", (-0.86, -0.86), (-3.5, -3.5), 1800, 12000),
    ("1.5D 2R", (-1.5, -1.5), (2, 2), 15000, None),
    ("2D 9L", (-2, -2), (-9, -9), 1250, None),
    ("2D 9R", (-2, -2), (9, 9), 1250, None),
    ("2D 15L", (-2, -2), (-15, -15), 1000, None),
    ("2D 15R", (-2, -2), (15, 15), 1000, None),
    ("4D V", (-4, -4), (0, 0), None, 10000),
    ("4D 4R", (-4, -4), (4, 4), None, 12500),
    ("4D 20L", (-4, -4), (-20, -20), 300, None),
    ("4D 20R", (-4, -4), (20, 20), 300, None),
]
HIGH_POINTS = [  # Table XVIII, UB2
    ("2U V", (2, 2), (0, 0), 1500, None),
    ("1U 3L", (1, 1), (-3, -3), 5000, None),
    ("1U 3R", (1, 1), (3, 3), 5000, None),
    ("H-V", (0, 0), (0, 0), 40000, 75000),
    ("H 3L", (0, 0), (-3, -3), 15000, None),
    ("H 3R", (0, 0), (3, 3), 15000, None),
    ("H 6L", (0, 0), (-6, -6), 5000, None),
    ("H 6R", (0, 0), (6, 6), 5000, None),
    ("H 9L", (0, 0), (-9, -9), 3000, None),
    ("H 9R", (0, 0), (9, 9), 3000, None),
    ("H 12L", (0, 0), (-12, -12), 1500, None),
    ("H 12R", (0, 0), (12, 12), 1500, None),
    ("1.5D V", (-1.5, -1.5), (0, 0), 5000, None),
    ("1.5D 9L", (-1.5, -1.5), (-9, -9), 2000, None),
    ("1.5D 9R", (-1.5, -1.5), (9, 9), 2000, None),
    ("2.5D V", (-2.5, -2.5), (0, 0), 2500, None),
    ("2.5D 12L", (-2.5, -2.5), (-12, -12), 1000, None),
    ("2.5D 12R", (-2.5, -2.5), (12, 12), 1000, None),
    ("4D V", (-4, -4), (0, 0), None, 12000),
]


# ---------------------------------------------------------------- lobes (all parameters ASSUMED)
def gauss(x, mu, s):
    return np.exp(-(((x - mu) / s) ** 2))


def gauss2(x, mu, s_lo, s_hi):
    """A Gaussian with different widths below and above its centre."""
    return np.exp(-(((x - mu) / np.where(x < mu, s_lo, s_hi)) ** 2))


def low_beam(h, v):
    # cutoff: a logistic step in v, centred 0.2 deg below the horizon, 0.12 deg wide (a sharp US VOR cutoff)
    below = 1.0 / (1.0 + np.exp((v + 0.2) / 0.12))
    # hot spot below and right of the axis: kerb side lit further than the oncoming side
    hot = 16000.0 * gauss(h, 2.0, 4.0) * gauss2(v, -1.6, 1.6, 1.6)
    # broad flood that lights the foreground and the shoulders, wider below its centre
    wide = 6000.0 * gauss(h, 0.0, 14.0) * gauss2(v, -2.0, 5.0, 2.5)
    # spill above the cutoff (signs, the regulated glare zone): stronger to the right, falling with height
    g0 = 900.0 * gauss(h, 2.0, 6.0) + 250.0 * gauss(h, 0.0, 20.0)
    spill = g0 * np.exp(-np.maximum(v, 0.0) / 3.3)
    return (hot + wide) * below + spill


def high_beam(h, v):
    core = 45000.0 * gauss(h, 0.0, 2.5) * gauss(v, 0.0, 1.5)
    flood = 15000.0 * gauss(h, 0.0, 9.0) * gauss2(v, -0.3, 3.0, 2.5)
    # the foreground of the low beam's flood, at half strength (a high beam still lights the road ahead)
    fore = 3000.0 * gauss(h, 0.0, 14.0) * gauss2(v, -2.0, 5.0, 2.5)
    return core + flood + fore


def grid(fn):
    h = H0 + DH * np.arange(NH)
    v = V0 + DV * np.arange(NV)
    hh, vv = np.meshgrid(h, v)  # rows = v
    return fn(hh, vv).astype(np.float64)


# ---------------------------------------------------------------- sampling and checking (as beam.js does it)
def sample(g, h, v):
    """Bilinear, clamped at the edges; the same rule as candelaAt in src/drive/lights/beam.js."""
    x = min(max((h - H0) / DH, 0.0), NH - 1.0)
    y = min(max((v - V0) / DV, 0.0), NV - 1.0)
    x0, y0 = min(int(x), NH - 2), min(int(y), NV - 2)
    fx, fy = x - x0, y - y0
    a = g[y0, x0] * (1 - fx) + g[y0, x0 + 1] * fx
    b = g[y0 + 1, x0] * (1 - fx) + g[y0 + 1, x0 + 1] * fx
    return a * (1 - fy) + b * fy


def axis_values(lo, hi, step, a0, n):
    """Grid angles in [lo, hi] within the map, plus the ends themselves."""
    lo, hi = max(lo, a0), min(hi, a0 + step * (n - 1))
    if lo > hi:
        return []
    vals = {lo, hi}
    k0 = int(np.ceil((lo - a0) / step - 1e-9))
    k1 = int(np.floor((hi - a0) / step + 1e-9))
    vals.update(a0 + step * k for k in range(k0, k1 + 1))
    return sorted(vals)


def point_samples(g, vr, hr):
    out = []
    for v in axis_values(vr[0], vr[1], DV, V0, NV):
        for h in axis_values(hr[0], hr[1], DH, H0, NH):
            out.append((h, v, sample(g, h, v)))
    return out


def check(g, points):
    """[(name, worst min-side value, worst max-side value, ok)]"""
    rows = []
    for name, vr, hr, mn, mx in points:
        s = point_samples(g, vr, hr)
        if not s:
            continue
        lo = min(c for _, _, c in s)
        hi = max(c for _, _, c in s)
        ok = (mn is None or lo >= mn) and (mx is None or hi <= mx)
        rows.append({"point": name, "min": mn, "max": mx, "sampledLow": round(lo, 1), "sampledHigh": round(hi, 1), "ok": bool(ok)})
    return rows


def clamp(g, points):
    """Pull grid nodes inside each test point's limits (2% margin). Returns how many nodes changed."""
    changed = 0
    for name, vr, hr, mn, mx in points:
        for h, v, c in point_samples(g, vr, hr):
            if (mx is None or c <= mx) and (mn is None or c >= mn):
                continue
            target = mx * 0.98 if (mx is not None and c > mx) else mn * 1.02
            x = min(max((h - H0) / DH, 0.0), NH - 1.0)
            y = min(max((v - V0) / DV, 0.0), NV - 1.0)
            x0, y0 = min(int(x), NH - 2), min(int(y), NV - 2)
            # scale the (up to four) nodes that the bilinear sample reads
            g[y0:y0 + 2, x0:x0 + 2] *= target / c
            changed += 1
    return changed


def build(fn, points, label):
    g = grid(fn)
    changed = 0
    for _ in range(4):
        n = clamp(g, points)
        changed += n
        if n == 0:
            break
    g = np.minimum(g, FLOAT16_MAX)
    g16 = g.astype("<f2")
    rows = check(g16.astype(np.float64), points)
    bad = [r for r in rows if not r["ok"]]
    peak = float(g16.max())
    iy, ix = np.unravel_index(int(np.argmax(g16)), g16.shape)
    return g16, {"peakCd": peak, "peakAt": {"hDeg": H0 + DH * ix, "vDeg": V0 + DV * iy},
                 "clampedNodes": changed, "testPoints": rows, "failures": [r["point"] for r in bad], "label": label}


def main(argv):
    low, low_info = build(low_beam, LOW_POINTS, "FMVSS 108 Table XIX-a, Lower beam #1V (LB1V)")
    high, high_info = build(high_beam, HIGH_POINTS, "FMVSS 108 Table XVIII, Upper beam #2 (UB2)")
    for info, name in ((low_info, "low"), (high_info, "high")):
        print(f"{name}: peak {info['peakCd']:.0f} cd at {info['peakAt']}, clamped nodes {info['clampedNodes']}, "
              f"failures {info['failures'] or 'none'}")
    if "--check" in argv:
        return 1 if (low_info["failures"] or high_info["failures"]) else 0
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "beam_low.bin").write_bytes(low.tobytes())
    (OUT / "beam_high.bin").write_bytes(high.tobytes())
    meta = {
        "format": "float16 little-endian, row-major, rows from vMin up, columns from hMin rightwards",
        "units": "candela, one lamp of a two-lamp system",
        "angles": "h: degrees, positive to the driver's right; v: degrees, positive up; from the lamp's aimed H-V axis",
        "grid": {"hMin": H0, "hMax": H1, "dh": DH, "nh": NH, "vMin": V0, "vMax": V1, "dv": DV, "nv": NV},
        "files": {"low": "beam_low.bin", "high": "beam_high.bin"},
        "low": {k: low_info[k] for k in ("peakCd", "peakAt", "clampedNodes", "label", "testPoints")},
        "high": {k: high_info[k] for k in ("peakCd", "peakAt", "clampedNodes", "label", "testPoints")},
        "sources": {
            "testPoints": "FMVSS 108 (49 CFR 571.108), 2023 ed., Tables XIX-a (LB1V) and XVIII (UB2): "
                          "https://www.govinfo.gov/content/pkg/CFR-2023-title49-vol6/pdf/CFR-2023-title49-vol6-sec571-108.pdf (plan 02, C6)",
            "shape": "ASSUMED smooth lobes (scripts/make_beam.py). The UMTRI-2004-23 survey medians (plan 02, G4, "
                     "https://hdl.handle.net/2027.42/55198) could not be fetched: the repository serves a browser "
                     "challenge to scripts. Replace the lobes with the survey table when it can be read.",
        },
        "builtBy": "scripts/make_beam.py",
    }
    (OUT / "beam.json").write_text(json.dumps(meta, indent=1) + "\n")
    return 1 if (low_info["failures"] or high_info["failures"]) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
