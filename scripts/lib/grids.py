"""Helpers for the nested terrain grids of plan 03 (F6.1, F4.8): the delta-gzip height encoding, the
summit-preserving downsample, stitching a grid's border to its parent, and the colour work on the draped
images. Used by scripts/build_terrain.py and scripts/build_imagery.py; tested in tests/python/flight/test_grids.py.

Grids here are numpy arrays (ny, nx) with row 0 = south and column 0 = west, posts at x0 + i*step, y0 + j*step,
as in terrain.json. Images are (H, W, 3) uint8 or float arrays with row 0 = north, pixel centres at
x0 + (i + 0.5)*mpp, y1 - (j + 0.5)*mpp, as build_imagery.py writes them.
"""
import gzip

import numpy as np

# --- the delta-gzip height encoding -----------------------------------------------------------------
#
# DELTA_GZIP_SPEC is copied into terrain.json's entry of each grid that uses it, so the reader needs nothing else.
DELTA_GZIP_SPEC = (
    "delta-gzip v1: the file is one gzip member (RFC 1952; DecompressionStream('gzip') reads it). Inflated, it is "
    "2*nx*ny bytes: the low bytes of nx*ny 16-bit words, then their high bytes, word k = lo[k] + 256*hi[k], the "
    "words in row-major order, row 0 = south, column 0 = west. Heights are quantised to q = round((h - offset) / "
    "scale), an integer 0..65535, so h = q * scale + offset (scale and offset are in the grid's entry). Each word "
    "is d = (q - p) mod 65536, where the prediction p from the posts already decoded is: 0 at (i=0, j=0); "
    "q[j][i-1] (left) along row 0; q[j-1][i] (up: the row before, to the south) down column 0; and "
    "q[j][i-1] + q[j-1][i] - q[j-1][i-1] everywhere else, all mod 65536. Decode in order with "
    "q = (d + p) mod 65536 (a Uint16Array wraps by itself)."
)


def quantise(h, scale, offset):
    """Heights in metres to the uint16 steps of the encoding; refuses a height the range cannot hold."""
    q = np.round((np.asarray(h, dtype=np.float64) - offset) / scale)
    if q.min() < 0 or q.max() > 65535:
        raise ValueError(f"heights {np.min(h):.1f}..{np.max(h):.1f} m do not fit {offset} + 0..65535 x {scale} m")
    return q.astype(np.int64)


def encode_delta_gzip(h, scale=0.1, offset=-500.0):
    """Heights (ny, nx) in metres to the bytes of a delta-gzip file (DELTA_GZIP_SPEC)."""
    q = quantise(h, scale, offset)
    p = np.zeros_like(q)
    p[0, 1:] = q[0, :-1]
    p[1:, 0] = q[:-1, 0]
    p[1:, 1:] = q[1:, :-1] + q[:-1, 1:] - q[:-1, :-1]
    d = ((q - p) % 65536).astype(np.uint16).ravel()
    planes = np.concatenate([(d & 0xFF).astype(np.uint8), (d >> 8).astype(np.uint8)])
    return gzip.compress(planes.tobytes(), compresslevel=9, mtime=0)


def decode_delta_gzip(blob, nx, ny, scale=0.1, offset=-500.0):
    """The heights in metres (ny, nx) of a delta-gzip file. Row by row, as a browser would."""
    body = np.frombuffer(gzip.decompress(blob), dtype=np.uint8).astype(np.int64)
    n = nx * ny
    d = (body[:n] + 256 * body[n:2 * n]).reshape(ny, nx)
    q = np.zeros_like(d)
    q[0] = np.cumsum(d[0]) % 65536
    for j in range(1, ny):
        # q[j][i] - q[j-1][i] = d[j][i] + (q[j][i-1] - q[j-1][i-1]): a running sum of d along the row, on top of
        # the column-0 term
        q[j] = (q[j - 1] + np.cumsum(d[j])) % 65536
    return q * scale + offset


# --- the summit-preserving downsample -------------------------------------------------------------------

def downsample_summits(fine, k, relief=100.0):
    """Posts from k x k fine samples each (block (j, i) of `fine` is post (j, i)'s footprint), keeping summits.

    The area mean M loses a peak's height; the block maximum X lifts every valley and lake. So a post takes
    M + w (X - M), where w is 1 at a summit (X is the highest in the 3 x 3 posts around it, and M is at least
    the 5 x 5 mean L) and otherwise rises from 0 to 1 as M stands from 0 to `relief` metres above L. Summits
    and ridges keep their height on the skyline; plains, valley floors and lakes keep their mean.
    """
    return keep_summits(*block_stats(fine, k), relief)


def block_stats(fine, k):
    """The mean and the maximum of each k x k block of fine samples: two (ny, nx) arrays."""
    ny, nx = fine.shape[0] // k, fine.shape[1] // k
    blocks = fine[: ny * k, : nx * k].reshape(ny, k, nx, k)
    return blocks.mean(axis=(1, 3)), blocks.max(axis=(1, 3))


def keep_summits(m, x, relief=100.0):
    """downsample_summits from the blocks' means `m` and maxima `x`."""
    from scipy.ndimage import maximum_filter, uniform_filter

    lm = uniform_filter(m, 5, mode="nearest")
    w = np.clip((m - lm) / relief, 0, 1)
    summit = (x >= maximum_filter(x, 3, mode="nearest")) & (m >= lm)
    summit[[0, -1], :] = summit[:, [0, -1]] = False  # an edge post is no summit: a slope rises to it
    w = np.where(summit, 1.0, w)
    return m + w * (x - m)


# --- a grid's surface, and stitching ---------------------------------------------------------------------

class Surface:
    """A height grid in metres with heightfield.js's bilinear sample (clamped to the edge outside it)."""

    def __init__(self, h, g):
        self.h = np.asarray(h, dtype=np.float64)
        self.ny, self.nx = self.h.shape
        self.x0, self.y0, self.step = g["x0"], g["y0"], g["step"]
        self.x1 = self.x0 + (self.nx - 1) * self.step
        self.y1 = self.y0 + (self.ny - 1) * self.step

    def sample(self, x, y):
        fx = np.clip((np.asarray(x, dtype=np.float64) - self.x0) / self.step, 0, self.nx - 1.001)
        fy = np.clip((np.asarray(y, dtype=np.float64) - self.y0) / self.step, 0, self.ny - 1.001)
        i, j = np.floor(fx).astype(np.intp), np.floor(fy).astype(np.intp)
        ax, ay = fx - i, fy - j
        h = self.h
        return ((1 - ay) * ((1 - ax) * h[j, i] + ax * h[j, i + 1])
                + ay * ((1 - ax) * h[j + 1, i] + ax * h[j + 1, i + 1]))

    def contains(self, x, y):
        return (x > self.x0) & (x < self.x1) & (y > self.y0) & (y < self.y1)


def post_xy(g):
    """Map coordinates (x, y) of every post of a grid entry, each (ny, nx)."""
    return np.meshgrid(g["x0"] + np.arange(g["nx"]) * float(g["step"]), g["y0"] + np.arange(g["ny"]) * float(g["step"]))


def edge_weight(g, band):
    """0 on a grid's outer posts, easing (smoothstep) to 1 at `band` posts in, as an (ny, nx) array."""
    i, j = np.meshgrid(np.arange(g["nx"]), np.arange(g["ny"]))
    d = np.minimum.reduce([i, g["nx"] - 1 - i, j, g["ny"] - 1 - j])
    u = np.clip(d / band, 0, 1)
    return u * u * (3 - 2 * u)


def stitch_to_parent(h, g, parent, band=8):
    """Blend a grid's outer `band` posts to its parent's surface, so the two agree exactly along its edge.

    The grid's edges must lie on the parent's post lines and its step divide the parent's, as the patches of
    plan 2 do with the wide grid: then along each edge the parent's surface is linear between its posts, the
    child's edge posts lie on it, and the two meshes share their edge with no crack (to the encoding's 5 cm).
    """
    ps = parent.step
    if ps % g["step"]:
        raise ValueError(f"step {g['step']} does not divide the parent's {ps}")
    x1, y1 = g["x0"] + (g["nx"] - 1) * g["step"], g["y0"] + (g["ny"] - 1) * g["step"]
    for v, o in ((g["x0"], parent.x0), (x1, parent.x0), (g["y0"], parent.y0), (y1, parent.y0)):
        if (v - o) % ps:
            raise ValueError(f"edge {v} is not on the parent's posts ({ps} m from {o})")
    if not (parent.x0 <= g["x0"] and x1 <= parent.x1 and parent.y0 <= g["y0"] and y1 <= parent.y1):
        raise ValueError("the grid is not inside its parent")
    w = edge_weight(g, band)
    gx, gy = post_xy(g)
    return w * h + (1 - w) * parent.sample(gx, gy)


def conform_to_child(h, g, child, band=8):
    """Bend a parent grid to a finer child grid it contains but that does not sit on its posts (far in valley).

    Posts inside the child take the child's surface. Outside it, a post keeps its own relief and is shifted by the
    difference between the child and itself at the nearest point of the child's edge: wholly within one post of
    the edge (the cells that straddle it), then eased (smoothstep) to nothing `band` posts out. The child's slope is never continued past its edge: in steep ground that dug false trenches
    and raised false ridges hundreds of metres high. Along the child's edge the parent then differs from it by the
    curvature its coarser cells cannot follow and, in the cells that straddle the edge, by the difference between
    the two slopes across it.
    """
    gx, gy = post_xy(g)
    s = g["step"]
    out = np.array(h, dtype=np.float64)
    inside = (gx >= child.x0) & (gx <= child.x1) & (gy >= child.y0) & (gy <= child.y1)
    out[inside] = child.sample(gx[inside], gy[inside])
    cx, cy = np.clip(gx, child.x0, child.x1), np.clip(gy, child.y0, child.y1)
    d = np.hypot(gx - cx, gy - cy) / s  # distance outside the child, in posts
    u = np.clip((d - 1) / (band - 1), 0, 1)
    w = 1 - u * u * (3 - 2 * u)  # the whole offset in the cells that straddle the edge, nothing from `band` posts out
    near = ~inside & (w > 0)
    own = Surface(h, g)
    delta = child.sample(cx[near], cy[near]) - own.sample(cx[near], cy[near])
    out[near] = out[near] + w[near] * delta
    return out


# --- colour ------------------------------------------------------------------------------------------------

def match_colour(parent, child, inside, feather_px, blur_px):
    """A coarser image matched to a finer one it contains, and its seam with it feathered away.

    `parent` is (H, W, 3); `child` is the finer image resampled onto the parent's pixels (NaN where it has
    none); `inside` is the finer image's footprint on the parent's pixels. Two steps:
    1. Over the overlap, each channel of the parent is scaled and shifted to the child's mean and spread.
    2. The seam: the difference of the two images' local means (Gaussian, `blur_px`) inside the footprint is
       carried out past its edge from the nearest pixel inside and added to the parent, fully within the
       footprint and easing (smoothstep) to nothing `feather_px` outside it. At the edge the parent then has
       the child's local colour, so the drawn ground shows no step; further out only step 1 remains.
    Returns float (H, W, 3), unclipped.
    """
    from scipy.ndimage import distance_transform_edt, gaussian_filter

    parent = np.asarray(parent, dtype=np.float64)
    out = np.empty_like(parent)
    for c in range(3):
        p, q = parent[..., c][inside], child[..., c][inside]
        a = q.std() / max(p.std(), 1e-6)
        out[..., c] = (parent[..., c] - p.mean()) * a + q.mean()
    m = inside.astype(np.float64)
    gm = gaussian_filter(m, blur_px, mode="nearest")
    dist, (iy, ix) = distance_transform_edt(~inside, return_indices=True)
    u = np.clip(dist / feather_px, 0, 1)
    w = 1 - u * u * (3 - 2 * u)
    for c in range(3):
        cc = np.where(inside, child[..., c], 0)
        d = (gaussian_filter(cc, blur_px, mode="nearest") - gaussian_filter(out[..., c] * m, blur_px, mode="nearest")) / np.maximum(gm, 1e-6)
        d = d[iy, ix]  # outside, the nearest pixel inside
        out[..., c] += w * d
    return out


def flatten_sea(h, deep=-150.0):
    """The sea at sea level. Terrarium carries bathymetry; every connected area below 0 m that reaches `deep`
    metres is sea and is set to 0. Dry basins below sea level (Death Valley, the Salton Trough) never reach it
    and keep their heights."""
    from scipy.ndimage import label

    lab, _ = label(h < 0)
    sea = np.isin(lab, np.unique(lab[(h < deep) & (lab > 0)]))
    return np.where(sea, 0.0, h)


def despike(h, limit=500.0):
    """Terrarium's low zooms hold single pixels thousands of metres off their neighbours (3,812 m among 373 m
    east of Lake Mead at zoom 9). A pixel further than `limit` metres from the median of its 3 x 3 neighbourhood
    takes that median. A real gorge one pixel wide is never more than its depth from that median, so it stays."""
    from scipy.ndimage import median_filter

    med = median_filter(h, 3, mode="nearest")
    return np.where(np.abs(h - med) > limit, med, h)
