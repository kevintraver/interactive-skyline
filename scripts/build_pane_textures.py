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
                     B     scratch density d (fine wipe marks on the inner pane: cleaning swirls and a few straight
                           wipes, and the outer pane's pitting)
                     A     dirt and smears (low-frequency blotches, finger smudges near the lower edge)
  pane-frost.png     R, G, B, A  four frost growth maps (seeded variants): for every texel the step of Reiter's
                           hexagonal automaton [R4] at which it froze, rank-normalised to 0..1, so the run-time test
                           ice = smoothstep(a - w, a, cover) covers a share `cover` of the pane. Never frozen: 1.
                     Seeds: a ring round the breather hole (low on the centre line), points along the scratch lines
                           and along the lower edge, where the pane is coldest.
  pane-facets.png    R, G, B, A  each variant's crystal id (0..255), for per-crystal glints (High and Ultra)

Plan 6.6 asks for 16-bit arrival values; these are 8-bit (one channel per variant, four variants in one texture),
which leaves 256 growth steps, finer than the run-time smoothstep's width (0.04).

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

    # cleaning swirls: groups of nearly concentric arcs (a cloth's circular wipe), radii 2 to 12 cm
    for g in range(9):
        cx, cy = r.uniform(-0.1, 1.1) * W, r.uniform(-0.1, 1.1) * H
        base = r.uniform(0.02, 0.12) / PANE_W * W
        for k in range(int(r.integers(6, 16))):
            rad = base * r.uniform(0.85, 1.25)
            a0 = r.uniform(0, 2 * math.pi)
            stroke_arc(cx + r.normal(0, 4), cy + r.normal(0, 4), rad, a0, a0 + r.uniform(0.6, 2.6), r.uniform(0.45, 0.9), r.uniform(0.25, 0.8))
    # a few long straight wipes, mostly fore and aft
    for k in range(10):
        y = r.uniform(0, H)
        ang = r.normal(0, 0.25)
        L = r.uniform(0.3, 1.0) * W
        x = r.uniform(-0.2, 0.8) * W
        stroke_line(x, y, x + L * math.cos(ang), y + L * math.sin(ang), r.uniform(0.4, 0.8), r.uniform(0.3, 0.7))
    # fine random scratches everywhere
    for k in range(220):
        x, y = r.uniform(0, W), r.uniform(0, H)
        ang = r.uniform(0, math.pi)
        L = r.uniform(4, 40)
        stroke_line(x, y, x + L * math.cos(ang), y + L * math.sin(ang), 0.45, r.uniform(0.15, 0.5))

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
def reiter(seeds, beta, gamma, alpha, rows, cols, max_steps, r):
    """Reiter's hexagonal automaton (Chaos, Solitons & Fractals 23, 2005) on an axial grid (q along columns, r down rows):
    cells hold water s; a cell is receptive if frozen (s >= 1) or next to a frozen one; receptive cells gain gamma,
    the others' water diffuses (alpha). Returns the step each cell froze at (inf if never) and its crystal id."""
    s = np.full((rows, cols), beta, np.float64)
    s += r.normal(0, 0.002, s.shape)  # a little noise in the vapour field: crystals not perfectly symmetric
    arrival = np.full((rows, cols), np.inf)
    ident = np.zeros((rows, cols), np.int32)
    # seeds nucleate at their own steps (rr, qq, step): the hole first, then the cold lower edge, the scratches last
    pending = sorted(((d, i, rr, qq) for i, (rr, qq, d) in enumerate(seeds)), reverse=True)

    def nucleate(step):
        while pending and pending[-1][0] <= step:
            _, i, rr, qq = pending.pop()
            if s[rr, qq] < 1.0:
                s[rr, qq] = 1.0
                arrival[rr, qq] = step
                ident[rr, qq] = 1 + (i % 255)
    nucleate(0)
    # axial neighbours: (0,+-1), (+-1,0), (+1,-1), (-1,+1)
    shifts = [(0, 1), (0, -1), (1, 0), (-1, 0), (1, -1), (-1, 1)]

    def nb(a, op):
        out = None
        for dr, dq in shifts:
            v = np.roll(np.roll(a, dr, 0), dq, 1)
            out = v if out is None else op(out, v)
        return out

    total = rows * cols
    for step in range(1, max_steps + 1):
        nucleate(step)
        frozen = s >= 1.0
        receptive = frozen | nb(frozen, np.logical_or)
        u = np.where(receptive, 0.0, s)
        v = np.where(receptive, s + gamma, s)
        avg = nb(u, np.add) / 6.0
        u = u + (alpha / 2.0) * (avg - u)
        s = u + np.where(receptive, v, 0.0)
        # the edges hold the background vapour (an open boundary)
        s[0, :] = s[-1, :] = beta
        s[:, 0] = s[:, -1] = beta
        newly = (s >= 1.0) & ~frozen
        if newly.any():
            arrival[newly] = step
            ident[newly] = nb(np.where(frozen, ident, 0), np.maximum)[newly]
        if step % 50 == 0 and not pending and np.isfinite(arrival).sum() > 0.985 * total:
            break
    return arrival, ident


def frost_variant(k, scratch_d):
    r = rng("frost", k)
    S = 2  # the automaton runs at half resolution (about 1.1 mm a cell); at far focus the pane is blurred by 3.5 mm
    w, h = W // S, H // S
    rows = int(math.ceil(h / (math.sqrt(3) / 2))) + 2
    cols = int(math.ceil(w + rows / 2)) + 2

    def cell(x, y):  # half-res pixel -> axial (r, q)
        rr = int(round(y / (math.sqrt(3) / 2)))
        qq = int(round(x - rr / 2)) + rows // 2
        return min(max(rr, 1), rows - 2), min(max(qq, 1), cols - 2)

    seeds = []  # (row, q, nucleation step); positions kept in half-res pixels for the per-crystal rotation
    where = []
    hx, hy = px(0, HOLE_V)
    for i in range(int(r.integers(5, 9))):  # a ring round the hole, about 6 mm out: first
        a = r.uniform(0, 2 * math.pi)
        rad = r.uniform(5, 9) / 1000 / PANE_W * W
        where.append(((hx + rad * math.cos(a)) / S, (hy + rad * math.sin(a)) / S, r.uniform(0, 60)))
    for i in range(int(r.integers(8, 14))):  # along the lower edge and up the lower corners: soon after
        t = r.uniform(0, 1)
        x = t * w
        y = h - 2 - r.exponential(5) - 50 * (1 - math.sin(math.pi * t)) * r.uniform(0, 1)
        where.append((x, max(2, y), r.uniform(150, 900)))
    ys, xs = np.nonzero(scratch_d > 0.5)
    for i in r.choice(len(xs), size=min(len(xs), int(r.integers(10, 18))), replace=False):  # on scratches: later,
        up = 1 - ys[i] / H                                                                    # the higher the later
        where.append((xs[i] / S, ys[i] / S, r.uniform(700, 1800) + 2200 * up))
    seeds = [(*cell(x, y), d) for x, y, d in where]
    angles = r.uniform(-math.pi / 6, math.pi / 6, len(where))
    beta = r.uniform(0.35, 0.45)
    gamma = r.uniform(0.0006, 0.0015)
    arrival, ident = reiter(seeds, beta, gamma, 1.0, rows, cols, 6000, r)
    # resample the hex grid to the image (nearest cell for the id, the cell's own arrival smoothed below)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    # every crystal turned about its own seed (the lattice grows them all with the same axes): each pixel takes the
    # nearest seed's frame, so the turns meet at the seeds' Voronoi borders, where crystals meet anyway
    pts = np.array([(x, y) for x, y, _ in where])
    d2 = (xx[..., None] - pts[:, 0]) ** 2 + (yy[..., None] - pts[:, 1]) ** 2
    near = np.argmin(d2, -1)
    ca, sa = np.cos(angles)[near], np.sin(angles)[near]
    ox, oy = xx - pts[near, 0], yy - pts[near, 1]
    xx, yy = pts[near, 0] + ca * ox - sa * oy, pts[near, 1] + sa * ox + ca * oy
    rr = np.clip(np.rint(yy / (math.sqrt(3) / 2)).astype(int), 0, rows - 1)
    qq = np.clip(np.rint(xx - rr / 2).astype(int) + rows // 2, 0, cols - 1)
    a = arrival[rr, qq]
    ids = ident[rr, qq]
    # rank-normalise the finite arrivals to 0..1 (share of the pane frozen by then); never frozen -> 1. Cells that froze
    # at the same step share one value (the middle of their run), so ties add no noise
    fin = np.isfinite(a)
    steps, inverse, counts = np.unique(a[fin], return_inverse=True, return_counts=True)
    before = np.concatenate([[0], np.cumsum(counts)[:-1]])
    out = np.ones_like(a)
    out[fin] = ((before + counts / 2.0) / a.size)[inverse]
    img = Image.fromarray(out.astype(np.float32), mode="F").resize((W, H), Image.BILINEAR)
    ids_img = Image.fromarray((ids % 256).astype(np.uint8), mode="L").resize((W, H), Image.NEAREST)
    return np.asarray(img), np.asarray(ids_img)


def build():
    surf, scratch_d = surface()
    maps, facets = [], []
    for k in range(4):
        a, f = frost_variant(k, scratch_d)
        maps.append(a)
        facets.append(f)
        print(f"  frost variant {k}: frozen share {np.mean(a < 1):.3f}", file=sys.stderr)
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
