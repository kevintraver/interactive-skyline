// The advertisements on the billboard faces (plan 02, D7.4): which image a face shows, how it fits the face, how a
// digital face rotates through them, and the loading of the packed atlas. Pure functions but the last.
//
// The images are fictional 1990s advertisements, public/textures/billboards/manifest.json, packed by
// scripts/pack_billboards.py into atlas-high.webp (desktops) or atlas-low.webp (the devices that get the low cabin
// model, vehicle/cabin.js chooseCabinModel) and atlas.json: each image's rectangle in either atlas, inside a gutter
// of its own repeated edge texels, and its mean colour (linear, computed once by the script).
//
// Choice. A face takes the kind of image nearer its own shape (bulletin 1024 x 300, poster 768 x 384, by the
// logarithm of the aspect). A static face's image is a hash of its seed (the board's seed and the face), moved on
// to the next free image when one of the faces of the NO_REPEAT_BOARDS nearest boards (either way round) already
// shows it; the faces are visited in seed order, so the same data always gives the same advertisements. A digital
// face shows image (start + k * step) mod n of its kind in hold k (HOLD_S, FADE_S and the phase of
// screens/digital.js), start and step from its seed, step prime to n: every image once before any repeats.
//
// Fit. An image never stretches: a face up to CROP_MAX wider or taller than the image crops it (cover), anything
// further is letterboxed, the bars in the image's own mean colour.

import { hash32 } from '../screens/art.js';
import { FADE_S, HOLD_S } from '../screens/digital.js';

export const ADS_DIR = '/textures/billboards/';
/** No image twice among the faces of this many nearest boards. */
export const NO_REPEAT_BOARDS = 10;
/** The most of an image's width or height a face may crop before it letterboxes instead. */
export const CROP_MAX = 0.06;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => x * x * (3 - 2 * x);
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

/** The kind (a key of `aspects`, { kind: width / height }) nearest a face's aspect, by the logarithm. */
export function kindForAspect(aspect, aspects) {
  let best = null, bd = Infinity;
  for (const [k, a] of Object.entries(aspects)) {
    const d = Math.abs(Math.log(aspect / a));
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

/**
 * How an image of aspect `imageAspect` fits a face of aspect `faceAspect`: [sx, sy] with image uv = (face uv - 0.5)
 * * [sx, sy] + 0.5 (outside 0..1: the letterbox bars). Never stretches.
 */
export function fitOf(faceAspect, imageAspect) {
  const r = faceAspect / imageAspect;
  if (r >= 1) return 1 - 1 / r <= CROP_MAX ? [1, 1 / r] : [r, 1];
  return 1 - r <= CROP_MAX ? [r, 1] : [1, 1 / r];
}

/** A step through n images prime to n (so a rotation shows every image once before it repeats). */
export function stepFor(seed, n) {
  if (n <= 1) return 1;
  let s = 1 + (hash32((seed ^ 0x51ed270b) >>> 0) % (n - 1));
  while (gcd(s, n) !== 1) s = (s % (n - 1)) + 1;
  return s;
}

/**
 * Assign images to faces.
 * @param {Array<{ board: number, x: number, y: number, seed: number, aspect: number, digital: boolean }>} faces
 *   board: the index of the face's board; x, y: its position (m)
 * @param {Array<{ kind: string, aspect: number }>} images the atlas's images, each kind's contiguous
 * @returns {Array<{ kind: string, base: number, n: number, start: number, step: number, fit: [number, number] }>}
 *   the image of hold k is images[base + (start + k * step) mod n] (step 0 for a static face)
 */
export function assignImages(faces, images) {
  const kinds = {};
  images.forEach((im, i) => {
    const k = kinds[im.kind] ||= { base: i, n: 0, aspect: im.aspect };
    if (i !== k.base + k.n) throw new Error(`atlas images of kind ${im.kind} are not contiguous`);
    k.n++;
  });
  const aspects = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, v.aspect]));
  const out = faces.map((f) => {
    const kind = kindForAspect(f.aspect, aspects), K = kinds[kind];
    return { kind, base: K.base, n: K.n, start: hash32((f.seed ^ 0x2545f491) >>> 0) % K.n, step: f.digital ? stepFor(f.seed, K.n) : 0, fit: fitOf(f.aspect, K.aspect) };
  });
  // the boards near each board (by position: the boards stand along the roads), both ways round
  const boards = new Map();
  faces.forEach((f, i) => { if (!boards.has(f.board)) boards.set(f.board, { x: f.x, y: f.y, faces: [] }); boards.get(f.board).faces.push(i); });
  const ids = [...boards.keys()], m = ids.length, K = Math.min(NO_REPEAT_BOARDS, m - 1);
  const xs = Float64Array.from(ids, (b) => boards.get(b).x), ys = Float64Array.from(ids, (b) => boards.get(b).y);
  const near = new Map(ids.map((b) => [b, new Set([b])]));
  const bd = new Float64Array(K + 1), bi = new Int32Array(K + 1);
  for (let a = 0; a < m; a++) {
    let n = 0; // the K nearest so far, sorted by distance and then id (a tie goes the same way every time)
    for (let j = 0; j < m; j++) {
      if (j === a) continue;
      const dx = xs[j] - xs[a], dy = ys[j] - ys[a], d2 = dx * dx + dy * dy;
      if (n === K && d2 >= bd[n - 1] && (d2 > bd[n - 1] || ids[j] > ids[bi[n - 1]])) continue;
      let k = n < K ? n++ : n - 1;
      while (k > 0 && (bd[k - 1] > d2 || (bd[k - 1] === d2 && ids[bi[k - 1]] > ids[j]))) { bd[k] = bd[k - 1]; bi[k] = bi[k - 1]; k--; }
      bd[k] = d2; bi[k] = j;
    }
    for (let k = 0; k < n; k++) { near.get(ids[a]).add(ids[bi[k]]); near.get(ids[bi[k]]).add(ids[a]); }
  }
  const order = faces.map((f, i) => i).filter((i) => !faces[i].digital).sort((i, j) => faces[i].seed - faces[j].seed || i - j);
  const done = new Uint8Array(faces.length);
  for (const i of order) {
    const a = out[i], used = new Map();
    for (const b of near.get(faces[i].board)) for (const j of boards.get(b).faces) {
      if (!done[j] || out[j].kind !== a.kind) continue;
      used.set(out[j].start, (used.get(out[j].start) || 0) + 1);
    }
    const probe = stepFor(faces[i].seed ^ 0x9e37, a.n);
    let pick = a.start, fewest = Infinity;
    for (let t = 0; t < a.n; t++) {
      const c = (a.start + t * probe) % a.n, u = used.get(c) || 0;
      if (u < fewest) { fewest = u; pick = c; }
      if (!u) break;
    }
    a.start = pick;
    done[i] = 1;
  }
  return out;
}

/** The image index (into the atlas's images) of hold k of an assignment. */
export const imageAt = (a, k) => a.base + ((((a.start + k * a.step) % a.n) + a.n) % a.n);

/**
 * What a face shows at content time t: { k, cur, prev, fade } as atlas image indices (fade 0 shows prev, 1 cur).
 * The timing is screens/digital.js digitalFrame's.
 */
export function adFrame(a, phase, t) {
  if (!a.step) { const i = imageAt(a, 0); return { k: 0, cur: i, prev: i, fade: 1 }; }
  const u = t + phase, k = Math.floor(u / HOLD_S), into = u - k * HOLD_S;
  return { k, cur: imageAt(a, k), prev: imageAt(a, k - 1), fade: smooth(clamp01(into / FADE_S)) };
}

/** Mean colour (linear, level 1) of a face at content time t; `means` is [r, g, b] per atlas image. */
export function adMean(means, a, phase, t, out = [0, 0, 0]) {
  const { cur, prev, fade } = adFrame(a, phase, t);
  for (let c = 0; c < 3; c++) out[c] = means[prev * 3 + c] + (means[cur * 3 + c] - means[prev * 3 + c]) * fade;
  return out;
}

/** Bytes of texture memory of an atlas of w x h RGBA8 texels with its full mipmap chain. */
export function textureBytes(w, h) {
  let n = 0;
  for (;;) {
    n += w * h * 4;
    if (w === 1 && h === 1) return n;
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
  }
}

/**
 * Load atlas.json and the atlas for this device: { doc, tier, bitmap, bytes, fetchMs, decodeMs }. The image is
 * decoded off the main thread (createImageBitmap), flipped for WebGL's texture origin. Rejects on any failure.
 * @param {'high' | 'low'} tier  @param {string} [dir]
 */
export async function loadAds(tier, dir = ADS_DIR) {
  const t0 = performance.now();
  const r = await fetch(`${dir}atlas.json`);
  if (!r.ok) throw new Error(`atlas.json: HTTP ${r.status}`);
  const doc = await r.json();
  const info = doc?.tiers?.[tier];
  if (!info || !Array.isArray(doc.images) || !doc.images.length) throw new Error('atlas.json: no images');
  const ri = await fetch(`${dir}${info.file}`);
  if (!ri.ok) throw new Error(`${info.file}: HTTP ${ri.status}`);
  const blob = await ri.blob();
  const t1 = performance.now();
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const t2 = performance.now();
  if (bitmap.width !== info.w || bitmap.height !== info.h) throw new Error(`${info.file}: ${bitmap.width} x ${bitmap.height}, not ${info.w} x ${info.h}`);
  return { doc, tier, bitmap, bytes: blob.size, fetchMs: t1 - t0, decodeMs: t2 - t1 };
}

/**
 * The shader's per-image data: rects as [u0, v0, du, dv] in texture coordinates (bottom-left origin, the bitmap is
 * flipped) and the mean colours, both flat Float32Arrays.
 */
export function shaderTables(doc, tier) {
  const { w, h } = doc.tiers[tier];
  const rects = new Float32Array(doc.images.length * 4), means = new Float32Array(doc.images.length * 3);
  doc.images.forEach((im, i) => {
    const [x, y, rw, rh] = im.rect[tier];
    rects.set([x / w, 1 - (y + rh) / h, rw / w, rh / h], i * 4);
    means.set(im.mean, i * 3);
  });
  return { rects, means };
}
