"""Where the Strip is seen from the cabin on a baked flight (plan 03 section 6.2's `stripSide` badge, and `stripView`).

For each second of the last three minutes before touchdown and each of the Strip's towers (data/flights/<city>/
strip.json), the direction from the aircraft is taken into body axes with the flight's heading, pitch and roll. A
tower is in view of a side's windows when it lies within WINDOW_CONE_DEG of that side's window normal (the lateral
axis); otherwise it is ahead or behind. The shares are of (seconds x towers).

  stripSide  "right" or "left": the side whose windows see the Strip more (the app seats the passenger there)
  stripView  how it is seen (STRIP_VIEWS):
             "right" / "left"              beside the aircraft for most of the last three minutes
             "passes-right" / "passes-left" ahead at first, then along that side for most of the last minute, coming
                                           abeam (the mean tower's bearing past 90 deg) before touchdown
             "ahead-right" / "ahead-left"   mostly ahead, to that side of the nose: in that side's windows only looking
                                           forward, never abeam
             "ahead"                        ahead and on neither side
             "none"                         behind or out of view
"""
import json
import math

import numpy as np

WINDOW_CONE_DEG = 55.0     # estimate: half the 69 deg of the 26 mm view plus head movement at the window (4.5, 7.4)
LAST_S = 180
LAST_MINUTE_S = 60
STRIP_VIEWS = ("right", "left", "passes-right", "passes-left", "ahead-right", "ahead-left", "ahead", "none")


def load_strip(path):
    """The Strip's towers as an (n, 3) array: x east, n north (m from the city origin), top (m above sea level)."""
    d = json.loads(open(path).read())
    return np.array([[t["x"], t["n"], t["top"]] for t in d["towers"]], dtype=float)


def _axes(hdg, pitch, roll):
    h, p, r = (np.radians(np.asarray(a, dtype=float)) for a in (hdg, pitch, roll))
    fwd = np.stack([np.sin(h) * np.cos(p), np.cos(h) * np.cos(p), np.sin(p)], axis=-1)
    right0 = np.stack([np.cos(h), -np.sin(h), np.zeros_like(h)], axis=-1)
    up0 = np.cross(right0, fwd)
    right = np.cos(r)[:, None] * right0 - np.sin(r)[:, None] * up0     # right wing down for positive roll
    return fwd, right


def strip_view(ch, towers, td, last_s=LAST_S, cone=WINDOW_CONE_DEG):
    """Shares of the Strip in view of each side over the last `last_s` seconds before sample `td`, and the badges."""
    k = np.arange(max(0, td - last_s), td)
    pos = np.stack([np.asarray(ch["x"])[k], np.asarray(ch["n"])[k], np.asarray(ch["h"])[k]], axis=-1)
    fwd, right = _axes(np.asarray(ch["hdg"])[k], np.asarray(ch["pitch"])[k], np.asarray(ch["roll"])[k])
    d = towers[None, :, :] - pos[:, None, :]
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    lat = np.einsum("tpc,tc->tp", d, right)
    ahead = np.einsum("tpc,tc->tp", d, fwd)
    cos_cone = math.cos(math.radians(cone))
    r_in, l_in = lat >= cos_cone, -lat >= cos_cone
    a_in = ~r_in & ~l_in & (ahead > 0)
    last = k >= td - LAST_MINUTE_S
    share = lambda m, sel=slice(None): float(m[sel].mean()) if m[sel].size else 0.0  # noqa: E731
    out = {"rightShare": share(r_in), "leftShare": share(l_in), "aheadShare": share(a_in),
           "rightShareLastMinute": share(r_in, last), "leftShareLastMinute": share(l_in, last),
           # the mean tower's bearing from the nose, positive right
           "meanRelativeBearingDeg": float(np.degrees(np.arctan2(lat.mean(), ahead.mean())))}
    mean_brg = np.degrees(np.arctan2(lat.mean(axis=1), ahead.mean(axis=1)))
    out["maxAbsBearingLastMinuteDeg"] = float(np.abs(mean_brg[last]).max()) if last.any() else 0.0
    side = "right" if out["rightShare"] >= out["leftShare"] else "left"
    if out["rightShare"] == 0 and out["leftShare"] == 0:
        side = "right" if out["meanRelativeBearingDeg"] >= 0 else "left"
    out["stripSide"] = side
    side_share, side_last = out[side + "Share"], out[side + "ShareLastMinute"]
    if side_share >= 0.5:
        view = side
    elif out["aheadShare"] >= 0.5 and side_last >= 0.5 and out["maxAbsBearingLastMinuteDeg"] >= 90:
        view = "passes-" + side
    elif out["aheadShare"] >= 0.5:
        view = "ahead-" + side if side_share > 0.05 else "ahead"
    else:
        view = "none"
    out["stripView"] = view
    return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in out.items()}
