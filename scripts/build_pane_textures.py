# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy", "pillow"]
# ///
"""Usage: build_pane_textures.py [--out public/textures/pane] [--check] [--sheet <png>]

The cabin window's textures (plan 03, sections 6.6 and 7.7; F5.1), generated from fixed seeds, so they are
reproducible and carry no third-party rights. Each covers the window opening (0.29 x 0.38 m, about 0.57 mm a texel)
at 512 x 704; image rows run top to bottom (v = +0.19 m at row 0), columns forward to aft on the right side.

  pane-surface.png   R, G  the scratches' direction as a doubled angle, premultiplied by their density:
                           0.5 + 0.5 cos(2a) d, 0.5 + 0.5 sin(2a) d (so mip averaging keeps a weighted direction)
                     B     scratch density d (fine wipe marks on the inner pane: cleaning swirls, fine arcs, three
                           short faint straight wipes, and the outer pane's pitting; sparse)
                     A     dirt and smears (low-frequency blotches, finger smudges near the lower edge)
  pane-frost.png     R, G, B, A  four frost growth maps (seeded variants) of fine fern frost (see "Fern frost" below):
                           for every texel its arrival a = t + K_WIDTH d, t when the growth front passed the nearest
                           fern line (0..1), d the distance from it; never frozen: 1. The run-time test
                           ice = smoothstep(a - w, a, cover) grows the ferns from their seeds as `cover` rises.
                     Seeds: round the breather hole (low on the centre line) first, the lower corners soon after, a few
                           on the lower edge and on scratches last. Fully grown, about a tenth of the pane.
  pane-facets.png    R, G, B, A  each variant's fern id (0..255), for per-crystal glints (High and Ultra)

Plan 6.6 asks for 16-bit arrival values; these are 8-bit (one channel per variant, four variants in one texture),
which leaves 256 growth steps, finer than the run-time smoothstep's width (0.035).

  --check   build in memory and compare with the files on disk byte for byte (exit 1 if they differ)
  --sheet   also write a contact sheet of the maps (for review; keep it outside the repository)
"""
import argparse
import hashlib
import io
import math
import os
import sys

import numpy as np
from PIL import Image

W, H = 512, 704
PANE_W, PANE_H = 0.29, 0.38           # metres the texture spans (the inner pane's opening)
HOLE_V = -0.15                        # the breather hole, metres below the centre (plan 7.7: "low centre"), ESTIMATED
SEED = 20261124


def rng(*k):
    return np.random.default_rng(abs(hash_int(SEED, *k)))


def hash_int(*k):
    return int.from_bytes(hashlib.sha256(repr(k).encode()).digest()[:8], "little")


def px(u, v):
    """Pane metres (u aft, v up) to pixel (x, y)."""
    return (u / PANE_W + 0.5) * W, (0.5 - v / PANE_H) * H


# ------------------------------------------------------------------------------------------------ scratches and dirt
def smooth_noise(r, shape, cell):
    """Value noise: random values on a grid every `cell` pixels, bicubic-upsampled."""
    gh, gw = shape[0] // cell + 3, shape[1] // cell + 3
    g = r.random((gh, gw)).astype(np.float32)
    img = Image.fromarray(g, mode="F").resize((gw * cell, gh * cell), Image.BICUBIC)
    a = np.asarray(img)[cell:cell + shape[0], cell:cell + shape[1]]
    return a


def surface():
    r = rng("surface")
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    acc_c = np.zeros((H, W), np.float32)  # sum of w cos 2a
    acc_s = np.zeros((H, W), np.float32)
    dens = np.zeros((H, W), np.float32)

    def stroke_arc(cx, cy, rad, a0, a1, width, strength):
        pad = width * 4
        x0, x1 = int(max(0, cx - rad - pad)), int(min(W, cx + rad + pad + 1))
        y0, y1 = int(max(0, cy - rad - pad)), int(min(H, cy + rad + pad + 1))
        if x0 >= x1 or y0 >= y1:
            return
        X, Y = xx[y0:y1, x0:x1] - cx, yy[y0:y1, x0:x1] - cy
        d = np.hypot(X, Y)
        ang = np.arctan2(Y, X)
        span = (ang - a0) % (2 * math.pi)
        inside = span <= ((a1 - a0) % (2 * math.pi))
        w = np.exp(-((d - rad) / width) ** 2) * inside * strength
        tang = ang + math.pi / 2
        acc_c[y0:y1, x0:x1] += w * np.cos(2 * tang)
        acc_s[y0:y1, x0:x1] += w * np.sin(2 * tang)
        dens[y0:y1, x0:x1] += w

    def stroke_line(x0_, y0_, x1_, y1_, width, strength):
        dx, dy = x1_ - x0_, y1_ - y0_
        L = math.hypot(dx, dy) or 1
        tx, ty = dx / L, dy / L
        X, Y = xx - x0_, yy - y0_
        along = X * tx + Y * ty
        across = X * -ty + Y * tx
        w = np.exp(-(across / width) ** 2) * ((along >= 0) & (along <= L)) * strength
        a = math.atan2(ty, tx)
        acc_c[:] += w * math.cos(2 * a)
        acc_s[:] += w * math.sin(2 * a)
        dens[:] += w

    # Reworked 24 Nov 2026: ten long straight fore-and-aft wipes made a band that flared over the winglet in low sun.
    # Scratches on a cabin window's inner pane are mostly fine arcs from cleaning cloths, and sparse.
    # cleaning swirls: groups of nearly concentric arcs (a cloth's circular wipe), radii 2 to 12 cm
    for g in range(6):
        cx, cy = r.uniform(-0.1, 1.1) * W, r.uniform(-0.1, 1.1) * H
        base = r.uniform(0.02, 0.12) / PANE_W * W
        for k in range(int(r.integers(4, 10))):
            rad = base * r.uniform(0.85, 1.25)
            a0 = r.uniform(0, 2 * math.pi)
            stroke_arc(cx + r.normal(0, 4), cy + r.normal(0, 4), rad, a0, a0 + r.uniform(0.5, 2.0), r.uniform(0.35, 0.6), r.uniform(0.15, 0.45))
    # a few short straight wipes, at any angle and faint
    for k in range(3):
        y = r.uniform(0, H)
        ang = r.uniform(0, math.pi)
        L = r.uniform(0.1, 0.35) * W
        x = r.uniform(0.1, 0.9) * W
        stroke_line(x, y, x + L * math.cos(ang), y + L * math.sin(ang), 0.35, r.uniform(0.1, 0.25))
    # fine scratches here and there: short arcs of large radius
    for k in range(90):
        x, y = r.uniform(0, W), r.uniform(0, H)
        rad = r.uniform(30, 200)
        a0 = r.uniform(0, 2 * math.pi)
        span = r.uniform(4, 30) / rad
        stroke_arc(x - rad * math.cos(a0), y - rad * math.sin(a0), rad, a0, a0 + span, 0.4, r.uniform(0.1, 0.35))

    d = np.clip(dens, 0, 1)
    norm = np.maximum(dens, 1e-6)
    c2, s2 = acc_c / norm, acc_s / norm
    # the outer pane's pitting: sparse specks that scatter in every direction (no direction)
    pits = (r.random((H, W)) > 0.9985).astype(np.float32) * r.uniform(0.3, 1.0, (H, W)).astype(np.float32)
    d_all = np.clip(d + pits * 0.6, 0, 1)
    R = 0.5 + 0.5 * c2 * d
    G = 0.5 + 0.5 * s2 * d

    # dirt: low-frequency blotches, thicker toward the lower edge, and a few finger smudges near it
    blot = smooth_noise(r, (H, W), 64) * 0.6 + smooth_noise(r, (H, W), 16) * 0.4
    low = np.clip((yy / H - 0.45) / 0.55, 0, 1)
    dirt = np.clip((blot - 0.45) * 1.6, 0, 1) * (0.25 + 0.75 * low)
    for k in range(4):
        cx, cy = r.uniform(0.15, 0.85) * W, r.uniform(0.72, 0.97) * H
        rx, ry = r.uniform(18, 30), r.uniform(26, 40)
        ang = r.uniform(-0.6, 0.6)
        X, Y = xx - cx, yy - cy
        Xr, Yr = X * math.cos(ang) + Y * math.sin(ang), -X * math.sin(ang) + Y * math.cos(ang)
        e = (Xr / rx) ** 2 + (Yr / ry) ** 2
        ridges = 0.6 + 0.4 * np.sin(np.sqrt(e) * 26)
        dirt += np.exp(-e * 2.2) * ridges * r.uniform(0.35, 0.6)
    dirt = np.clip(dirt * 0.8, 0, 1)

    rgba = np.stack([R, G, d_all, dirt], -1)
    return (np.clip(rgba, 0, 1) * 255 + 0.5).astype(np.uint8), d


# ------------------------------------------------------------------------------------------------ frost
# Fern frost (reworked 24 Nov 2026). The first maps grew Reiter's hexagonal automaton [R4] from seeds: filled six-armed
# stars and dendrites over the lower third, which read as snowflakes. Frost on an airliner's cabin window is sparse,
# fine and fern-like: thin feathery lines that start at the breather hole and in the lower corners (the coldest parts,
# where vapour reaches first) and are often absent. So each fern is grown as a path: a slightly curving stem with side
# branches at about 60 degrees on alternate sides, shorter toward the tip, the branches feathered once more.
# Every texel stores its arrival  a = t + K_WIDTH * d  where t is when the growth front passed the nearest point of a
# fern (0 at the first seed, 1 when the whole pattern has grown) and d its distance from that line in texels, out to
# R_LINE texels (beyond: 1, never frozen). At run time ice = smoothstep(a - w, a, cover): the line's tip advances with
# the cover and older parts thicken a little, and a defocused read (a mip) smears the lines into a faint haze instead
# of erasing them.
K_WIDTH = 0.08       # arrival per texel off the line: a line is about 2 texels (1.1 mm) wide 0.08 of cover after it passed
R_LINE = 1.5         # how far off a line a texel can still freeze, texels: at most about 3 texels (1.7 mm) wide


def fern_paths(r, x, y, ang, length, depth, t0, speed, out, ident):
    """A fern from (x, y) heading `ang` (radians, image axes: y down): append (x, y, t, id) samples every half texel."""
    step = 0.5
    n = max(2, int(length / step))
    bend = r.normal(0, 0.004)
    spacing = r.uniform(6.0, 10.0) if depth > 0 else 1e9
    side = 1 if r.random() < 0.5 else -1
    next_branch = spacing * r.uniform(0.6, 1.2)
    t = t0
    for i in range(n):
        out.append((x, y, t, ident))
        x += step * math.cos(ang)
        y += step * math.sin(ang)
        ang += bend + r.normal(0, 0.01)
        t += step * speed
        along = i * step
        if along >= next_branch and along < length * 0.92:
            taper = 1 - along / length
            blen = length * r.uniform(0.3, 0.45) * (0.3 + 0.7 * taper)
            if blen > 2:
                fern_paths(r, x, y, ang + side * r.uniform(0.9, 1.2), blen, depth - 1, t, speed * r.uniform(1.0, 1.4), out, ident)
            side = -side
            next_branch += spacing * r.uniform(0.7, 1.3)


def frost_variant(k, scratch_d):
    r = rng("frost", k)
    samples = []   # (x, y, t, fern id), image pixels
    fid = 0

    def fern(x, y, ang, length_mm, delay, depth=2):
        nonlocal fid
        fid += 1
        length = length_mm / 1000 / PANE_W * W
        # the front crosses a whole fern in about a fifth of the growth: later ferns start later, all done by 1
        speed = (1 - delay) * r.uniform(0.15, 0.3) / max(length, 1)
        fern_paths(r, x, y, ang, length, depth, delay, speed, samples, fid)

    hx, hy = px(0, HOLE_V)
    # round the breather hole, first: a few short ferns radiating from about 3 mm out (plan 7.7: frost starts there)
    for i in range(int(r.integers(3, 6))):
        a = r.uniform(0, 2 * math.pi)
        rad = r.uniform(3, 6) / 1000 / PANE_W * W
        fern(hx + rad * math.cos(a), hy + rad * math.sin(a), a + r.normal(0, 0.3), r.uniform(12, 30), r.uniform(0.0, 0.12))
    # the lower corners: ferns creeping in from the frame, up and inward, soon after
    for corner in (-1, 1):
        cx = W / 2 + corner * (W / 2 - r.uniform(14, 30))
        for i in range(int(r.integers(2, 4))):
            y = H - r.uniform(12, 70)
            ang = math.atan2(-r.uniform(0.6, 1.2), -corner * r.uniform(0.5, 1.0))
            fern(cx, y, ang, r.uniform(20, 48), r.uniform(0.12, 0.35))
    # a few small ones on the lower edge, later
    for i in range(int(r.integers(1, 4))):
        fern(r.uniform(0.25, 0.75) * W, H - r.uniform(8, 20), -math.pi / 2 + r.normal(0, 0.5), r.uniform(5, 14), r.uniform(0.35, 0.6), 1)
    # one or two on a scratch, late (nucleation on scratches, Caltech's frost page [R4]); never on the top half
    ys, xs = np.nonzero(scratch_d[H // 2:] > 0.5)
    for i in r.choice(len(xs), size=min(len(xs), int(r.integers(1, 3))), replace=False):
        fern(xs[i], ys[i] + H // 2, r.uniform(0, 2 * math.pi), r.uniform(4, 10), r.uniform(0.6, 0.85), 1)

    arrival = np.ones((H, W), np.float64)
    ident = np.zeros((H, W), np.int32)
    reach = int(math.ceil(R_LINE))
    offs = np.arange(-reach, reach + 1)
    ox, oy = np.meshgrid(offs, offs)
    for x, y, t, i in samples:
        cx, cy = int(round(x)), int(round(y))
        if cx < -reach or cy < -reach or cx >= W + reach or cy >= H + reach:
            continue
        X, Y = cx + ox, cy + oy
        ok = (X >= 0) & (X < W) & (Y >= 0) & (Y < H)
        d = np.hypot(X - x, Y - y)
        a = np.where(d <= R_LINE, min(t, 1.0) + K_WIDTH * d, 1.0)
        Xs, Ys, As = X[ok], Y[ok], a[ok]
        cur = arrival[Ys, Xs]
        better = As < cur
        arrival[Ys[better], Xs[better]] = As[better]
        ident[Ys[better], Xs[better]] = i
    return np.clip(arrival, 0, 1).astype(np.float32), (ident % 256).astype(np.uint8)


def build():
    surf, scratch_d = surface()
    maps, facets = [], []
    for k in range(4):
        a, f = frost_variant(k, scratch_d)
        maps.append(a)
        facets.append(f)
        print(f"  frost variant {k}: frozen share fully grown {np.mean(a < 0.999):.3f}, at 0.3 {np.mean(a < 0.3):.3f}", file=sys.stderr)
    frost = (np.clip(np.stack(maps, -1), 0, 1) * 255 + 0.5).astype(np.uint8)
    fac = np.stack(facets, -1).astype(np.uint8)
    return {"pane-surface.png": surf, "pane-frost.png": frost, "pane-facets.png": fac}


def png_bytes(a):
    b = io.BytesIO()
    Image.fromarray(a, mode="RGBA").save(b, format="PNG", optimize=True)
    return b.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "public", "textures", "pane"))
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--sheet")
    o = ap.parse_args()
    files = {k: png_bytes(v) for k, v in build().items()}
    if o.check:
        bad = [k for k, b in files.items() if not os.path.exists(os.path.join(o.out, k)) or open(os.path.join(o.out, k), "rb").read() != b]
        print("differ: " + ", ".join(bad) if bad else "identical", file=sys.stderr)
        sys.exit(1 if bad else 0)
    os.makedirs(o.out, exist_ok=True)
    total = 0
    for k, b in files.items():
        with open(os.path.join(o.out, k), "wb") as f:
            f.write(b)
        total += len(b)
        print(f"{k}: {len(b) / 1024:.0f} KB", file=sys.stderr)
    print(f"total {total / 1024:.0f} KB", file=sys.stderr)
    if o.sheet:
        imgs = [Image.open(io.BytesIO(b)) for b in files.values()]
        tiles = []
        for im in imgs:
            a = np.asarray(im)
            for c in range(4):
                tiles.append(a[..., c])
        sheet = Image.new("L", (W * 4 // 2, H * 3 // 2))
        for i, t in enumerate(tiles):
            sheet.paste(Image.fromarray(t).resize((W // 2, H // 2)), ((i % 4) * W // 2, (i // 4) * H // 2))
        sheet.save(o.sheet)


if __name__ == "__main__":
    main()
