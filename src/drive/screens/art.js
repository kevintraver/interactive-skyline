// Original abstract artwork for billboard faces (plan 02, D7.4 and section 7.9): colour fields, stripes, bands,
// blocks, discs and wedges generated from a hash. No words, letters, numbers or logos, and nothing that could read
// as one: a design is at most MAX_SHAPES large primitives of a fixed set of types (no glyph, no thin ring, no
// shape under MIN_SHAPE of the panel's height), so there is no way to spell anything; tests check that over many
// seeds. Pure: the same seed gives the same design and the same pixels.
//
// The designs are rasterised once into an atlas (ATLAS_COLS x ATLAS_ROWS cells of CELL_W x CELL_H texels, sRGB
// bytes), with a signed-distance edge for anti-aliasing, and each design's mean colour (linear) is kept for the
// screens registry and the light the faces throw.

export const CELL_W = 256, CELL_H = 80;
export const ATLAS_COLS = 8, ATLAS_ROWS = 8;
export const DESIGNS = ATLAS_COLS * ATLAS_ROWS;
export const SHAPE_TYPES = Object.freeze(['gradient', 'rect', 'disc', 'stripes', 'triangle']);
export const MAX_SHAPES = 8;
/** Smallest extent of any shape, as a share of the panel's height (letters would need far smaller strokes). */
export const MIN_SHAPE = 0.12;

/** A 32-bit integer hash (lowbias32, C. Wellons); the face shader has the same one in GLSL. */
export function hash32(x) {
  x >>>= 0;
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** A small deterministic stream of numbers in [0, 1) from a seed. */
function stream(seed) {
  let s = hash32(seed ^ 0x5bd1e995);
  return () => { s = hash32(s + 0x9e3779b9); return s / 4294967296; };
}

function hsl(h, s, l) {
  const k = (n) => (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
  const c = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [Math.round(c(0) * 255), Math.round(c(8) * 255), Math.round(c(4) * 255)];
}

/** Four colours (sRGB bytes) from one of a few schemes around a base hue. */
function palette(rnd) {
  const h0 = rnd(), scheme = Math.floor(rnd() * 4);
  const offs = [[0, 0.08, 0.5, 0.58], [0, 0.33, 0.66, 0.16], [0, 0.04, 0.1, 0.55], [0, 0.45, 0.5, 0.95]][scheme];
  return offs.map((o, i) => hsl((h0 + o) % 1, 0.45 + 0.4 * rnd(), [0.3, 0.55, 0.7, 0.88][(i + Math.floor(rnd() * 4)) % 4] - 0.1 * rnd()));
}

/**
 * The design of a seed: { colors, shapes }, shapes in panel units (x 0..aspect, y 0..1, y up), drawn in order.
 * @param {number} seed
 */
export function designOf(seed) {
  const rnd = stream(seed), c = palette(rnd), A = CELL_W / CELL_H;
  const between = (a, b) => a + (b - a) * rnd();
  const shapes = [{ type: 'gradient', from: c[0], to: c[1], angle: between(-0.6, 0.6) }];
  const layout = Math.floor(rnd() * 6);
  if (layout === 0) { // a field with a large disc and a ground band
    shapes.push({ type: 'disc', x: between(0.55, 0.85) * A, y: between(0.35, 0.65), r: between(0.3, 0.55), color: c[2] });
    shapes.push({ type: 'rect', x0: 0, y0: 0, x1: A, y1: between(0.14, 0.22), color: c[3] });
  } else if (layout === 1) { // diagonal stripes beside a solid block
    const w = between(0.25, 0.4) * A;
    shapes.push({ type: 'stripes', angle: between(0.35, 1.1), width: between(0.16, 0.3), colors: [c[2], c[3]], x0: w, x1: A });
    shapes.push({ type: 'rect', x0: 0, y0: 0, x1: w, y1: 1, color: c[0] });
  } else if (layout === 2) { // horizontal bands
    let y = 0;
    const n = 3 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) {
      let y1 = i === n - 1 ? 1 : Math.min(1, y + between(0.16, 0.38));
      if (1 - y1 < 0.16) y1 = 1; // no sliver of a band at the top
      shapes.push({ type: 'rect', x0: 0, y0: y, x1: A, y1, color: c[i % 4] });
      y = y1;
      if (y >= 1) break;
    }
  } else if (layout === 3) { // vertical blocks and a disc
    let x = 0;
    for (let i = 0; i < 4 && x < A; i++) {
      let x1 = i === 3 ? A : Math.min(A, x + between(0.5, 1.2));
      if (A - x1 < 0.3) x1 = A; // no sliver of a block at the right
      shapes.push({ type: 'rect', x0: x, y0: 0, x1, y1: 1, color: c[(i + 1) % 4] });
      x = x1;
    }
    shapes.push({ type: 'disc', x: between(0.2, 0.8) * A, y: between(0.3, 0.7), r: between(0.18, 0.3), color: c[0] });
  } else if (layout === 4) { // a large arc entering from an edge
    const left = rnd() < 0.5;
    shapes.push({ type: 'disc', x: left ? between(-0.2, 0.3) : A - between(-0.2, 0.3), y: between(-0.2, 0.4), r: between(0.8, 1.2), color: c[2] });
    shapes.push({ type: 'disc', x: left ? between(-0.2, 0.3) : A - between(-0.2, 0.3), y: between(-0.2, 0.4), r: between(0.35, 0.6), color: c[3] });
  } else { // two wedges from the corners
    shapes.push({ type: 'triangle', p: [[0, 0], [between(0.6, 1.4) * A * 0.5, 0], [0, between(0.6, 1)]], color: c[2] });
    shapes.push({ type: 'triangle', p: [[A, 1], [A - between(0.6, 1.4) * A * 0.5, 1], [A, between(0, 0.4)]], color: c[3] });
  }
  return { colors: c, shapes };
}

// signed distance (panel units, negative inside) of a point to a shape
function sdRect(s, x, y) { return Math.max(s.x0 - x, x - s.x1, s.y0 - y, y - s.y1); }
function sdTri(p, x, y) {
  let d = -Infinity;
  const sign = Math.sign((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])) || 1;
  for (let i = 0; i < 3; i++) {
    const a = p[i], b = p[(i + 1) % 3], ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey) || 1;
    d = Math.max(d, (sign * ((x - a[0]) * ey - (y - a[1]) * ex)) / len);
  }
  return d;
}

const toLinear = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const LIN = Float64Array.from({ length: 256 }, (_, i) => toLinear(i));

/**
 * Rasterise a design into `out` (RGBA bytes, sRGB) at (ox, oy) of an image `stride` texels wide; returns its mean
 * colour, linear [r, g, b]. Row 0 is the bottom of the panel (WebGL's texture origin).
 */
export function rasterise(design, out, stride = CELL_W, ox = 0, oy = 0, w = CELL_W, h = CELL_H) {
  const px = 1 / h; // one texel in panel units
  let mr = 0, mg = 0, mb = 0;
  const col = [0, 0, 0];
  for (let j = 0; j < h; j++) {
    const y = (j + 0.5) / h;
    for (let i = 0; i < w; i++) {
      const x = (i + 0.5) / h;
      for (const s of design.shapes) {
        let cov = 1, c = s.color;
        if (s.type === 'gradient') {
          const u = Math.min(1, Math.max(0, (x / (w / h)) * Math.cos(s.angle) + y * Math.sin(s.angle)));
          for (let k = 0; k < 3; k++) col[k] = s.from[k] + (s.to[k] - s.from[k]) * u;
          continue;
        }
        if (s.type === 'rect') cov = 0.5 - sdRect(s, x, y) / px;
        else if (s.type === 'disc') cov = 0.5 - (Math.hypot(x - s.x, y - s.y) - s.r) / px;
        else if (s.type === 'triangle') cov = 0.5 - sdTri(s.p, x, y) / px;
        else if (s.type === 'stripes') {
          if (x < s.x0 || x > s.x1) continue;
          const v = (x * Math.cos(s.angle) + y * Math.sin(s.angle)) / s.width;
          const k = Math.floor(v);
          c = s.colors[((k % 2) + 2) % 2];
          cov = 1;
        }
        cov = Math.min(1, Math.max(0, cov));
        if (cov > 0) for (let k = 0; k < 3; k++) col[k] += (c[k] - col[k]) * cov;
      }
      const o = ((oy + j) * stride + ox + i) * 4;
      const r = Math.round(col[0]), g = Math.round(col[1]), b = Math.round(col[2]);
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      mr += LIN[r]; mg += LIN[g]; mb += LIN[b];
    }
  }
  const n = w * h;
  return [mr / n, mg / n, mb / n];
}

/** The design shown in atlas cell `i` (0 .. DESIGNS - 1). */
export const designSeed = (i) => hash32(0xb111b0a7 + i * 7919);

/**
 * Every design in one atlas: { data: Uint8Array RGBA (sRGB), width, height, means: Float32Array [r, g, b] x DESIGNS }.
 * About 1.3 M texels; a few tens of milliseconds.
 */
export function buildAtlas() {
  const width = CELL_W * ATLAS_COLS, height = CELL_H * ATLAS_ROWS;
  const data = new Uint8Array(width * height * 4);
  const means = new Float32Array(DESIGNS * 3);
  for (let i = 0; i < DESIGNS; i++) {
    const m = rasterise(designOf(designSeed(i)), data, width, (i % ATLAS_COLS) * CELL_W, Math.floor(i / ATLAS_COLS) * CELL_H);
    means.set(m, i * 3);
  }
  return { data, width, height, means };
}
