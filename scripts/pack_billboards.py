#!/usr/bin/env python3
"""Pack the billboard advertisements into atlases for the drive (plan 02, D7.4).

Reads public/textures/billboards/manifest.json and its images (32 bulletins of 1024 x 300, 8 posters of 768 x 384)
and writes, beside them:

  atlas-high.webp  2048 texels wide: every image downscaled to 496 texels wide, for desktops (about 20 MB of texture
                   memory with mipmaps, RGBA8)
  atlas-low.webp   the same layout at 344 texels wide, for the devices that get the low cabin model (about 10 MB)
  atlas.json       { version, tiers: { high: { file, w, h, bytes }, low: {...} }, images: [ { id, kind, aspect,
                   rect: { high: [x, y, w, h], low: [...] } (texels, top-left origin), mean: [r, g, b] (linear, of the
                   full-size image), luminance } ], sources: { file: sha1 } }

Each image sits in its own cell with a gutter of GUTTER texels on every side filled by repeating its edge texels,
so mipmaps and anisotropic taps near an edge read the image's own border, never a neighbour (the face shader also
keeps its taps inside the rectangle). One request and one texture per device instead of forty.

The runtime (src/drive/roadside/billboardsImages.js) loads atlas.json and one atlas; tests/unit/roadside/
billboards-images.test.js checks that atlas.json matches the manifest and the files (rerun this script when the
images change):

  python3 scripts/pack_billboards.py [--dir public/textures/billboards] [--quality 90]
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
GUTTER = 8
COLS = 4
# image width in the atlas per tier (texels); a cell is that plus two gutters, COLS cells a row
TIERS = {"high": 496, "low": 344}
KIND_ORDER = {"bulletin": 0, "poster": 1}


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


LIN = [srgb_to_linear(i) for i in range(256)]


def mean_linear(im):
    """Mean colour of an RGB image in linear light."""
    hist = im.histogram()  # 3 x 256
    n = im.width * im.height
    return [sum(LIN[i] * hist[c * 256 + i] for i in range(256)) / n for c in range(3)]


def padded(im, g):
    """The image with a border of g texels that repeats its edge texels (corners included)."""
    w, h = im.size
    out = Image.new("RGB", (w + 2 * g, h + 2 * g))
    out.paste(im, (g, g))
    out.paste(im.crop((0, 0, w, 1)).resize((w, g)), (g, 0))
    out.paste(im.crop((0, h - 1, w, h)).resize((w, g)), (g, h + g))
    left = out.crop((g, 0, g + 1, h + 2 * g)).resize((g, h + 2 * g))
    right = out.crop((g + w - 1, 0, g + w, h + 2 * g)).resize((g, h + 2 * g))
    out.paste(left, (0, 0))
    out.paste(right, (w + g, 0))
    return out


def layout(images, width):
    """Cells per image: bulletins first, then posters, COLS a row. Returns ({id: [x, y, w, h]}, atlas w, atlas h)."""
    rects, y = {}, 0
    for kind in dict.fromkeys(i["kind"] for i in images):
        group = [i for i in images if i["kind"] == kind]
        if not group:
            continue
        ih = round(width * group[0]["h"] / group[0]["w"])
        cell_w, cell_h = width + 2 * GUTTER, ih + 2 * GUTTER
        for k, img in enumerate(group):
            cx, cy = (k % COLS) * cell_w, y + (k // COLS) * cell_h
            rects[img["id"]] = [cx + GUTTER, cy + GUTTER, width, ih]
        y += -(-len(group) // COLS) * cell_h
    return rects, COLS * (width + 2 * GUTTER), y


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dir", default=str(ROOT / "public" / "textures" / "billboards"))
    ap.add_argument("--quality", type=int, default=90)
    args = ap.parse_args(argv)
    d = Path(args.dir)
    manifest = json.loads((d / "manifest.json").read_text())
    # each kind's images together, bulletins first (the runtime needs them contiguous), the manifest's order within
    images = sorted(manifest["images"], key=lambda i: KIND_ORDER.get(i["kind"], len(KIND_ORDER)))
    src = {}
    for img in images:
        im = Image.open(d / img["file"]).convert("RGB")
        if im.size != (img["w"], img["h"]):
            sys.exit(f"{img['file']}: {im.size} is not the stated {img['w']} x {img['h']}")
        src[img["id"]] = im
    out = {"version": 1, "gutter": GUTTER, "tiers": {}, "images": [], "sources": {}}
    rects_by_tier = {}
    for tier, width in TIERS.items():
        rects, aw, ah = layout(images, width)
        atlas = Image.new("RGB", (aw, ah), (128, 128, 128))
        for img in images:
            x, y, w, h = rects[img["id"]]
            small = src[img["id"]].resize((w, h), Image.LANCZOS, reducing_gap=3.0)
            atlas.paste(padded(small, GUTTER), (x - GUTTER, y - GUTTER))
        name = f"atlas-{tier}.webp"
        atlas.save(d / name, "WEBP", quality=args.quality, method=6)
        out["tiers"][tier] = {"file": name, "w": aw, "h": ah, "bytes": (d / name).stat().st_size}
        rects_by_tier[tier] = rects
    for img in images:
        m = mean_linear(src[img["id"]])
        out["images"].append({
            "id": img["id"], "kind": img["kind"], "aspect": round(img["w"] / img["h"], 6),
            "rect": {t: rects_by_tier[t][img["id"]] for t in TIERS},
            "mean": [round(v, 6) for v in m],
            "luminance": round(0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2], 6),
        })
    for f in ["manifest.json"] + [i["file"] for i in images]:
        out["sources"][f] = hashlib.sha1((d / f).read_bytes()).hexdigest()
    (d / "atlas.json").write_text(json.dumps(out, indent=1) + "\n")
    for t, info in out["tiers"].items():
        print(f"{info['file']}: {info['w']} x {info['h']}, {info['bytes'] / 1024:.0f} KiB, "
              f"{info['w'] * info['h'] * 4 * 4 / 3 / 2**20:.1f} MiB on the GPU with mipmaps")


if __name__ == "__main__":
    main()
