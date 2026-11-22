// JavaScript mirrors of headlamps.glsl.js, and the data its textures hold (plan 02, D5.1 and D5.2). Pure: no three.js,
// no DOM. Each function names the GLSL it mirrors; tests/unit/lights/headlamps.test.js checks them against beam.js
// and retro.js, and the acceptance numbers of D5.1 and D5.2 are computed through them.
//
// Car frame (beam.js): x right, y up, z forward. Scene vectors go to it through the car's basis
// { right, up, forward } (unit vectors in the scene), as the shader's `d * uHlCar` does.

import { RETRO_TYPES, retroCoefficient } from '../roadside/retro.js';

const RAD = Math.PI / 180;

// ---------------------------------------------------------------- half floats (what the GPU textures hold)
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
/** A number to IEEE 754 half bits (round to nearest even). */
export function toHalf(x) {
  f32[0] = x;
  const b = u32[0];
  const s = (b >>> 16) & 0x8000;
  const e = (b >>> 23) & 0xff;
  let m = b & 0x7fffff;
  if (e === 255) return s | 0x7c00 | (m ? 0x200 : 0);
  let he = e - 127 + 15;
  if (he >= 31) return s | 0x7c00;
  if (he <= 0) {
    if (he < -10) return s;
    m |= 0x800000;
    const shift = 14 - he;
    let h = m >> shift;
    const rem = m & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rem > half || (rem === half && h & 1)) h++;
    return s | h;
  }
  let h = (he << 10) | (m >> 13);
  const rem = m & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++;
  return s | h;
}
/** Half bits to a number. */
export function fromHalf(u) {
  const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 0x1f, f = u & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/** A width x height single-channel texture: bilinear at uv, texel centres at (i + 0.5) / width, clamp to edge. */
export function sampleBilinear(tex, u, v) {
  const { width: w, height: h, data } = tex;
  const x = Math.min(Math.max(u * w - 0.5, 0), w - 1), y = Math.min(Math.max(v * h - 0.5, 0), h - 1);
  const x0 = Math.min(Math.floor(x), w - 2), y0 = Math.min(Math.floor(y), h - 2);
  const fx = x - x0, fy = y - y0, i = y0 * w + x0;
  const a = data[i] * (1 - fx) + data[i + 1] * fx;
  const b = data[i + w] * (1 - fx) + data[i + w + 1] * fx;
  return a * (1 - fy) + b * fy;
}

// ---------------------------------------------------------------- the beam (uHlBeam, hlCandela)
/**
 * The beam map as the GPU holds it: I / peak in half floats, one texel per grid node.
 * @param {object} map decodeBeam()'s result
 * @returns {{ width, height, half: Uint16Array, data: Float32Array, peakCd: number, uv: number[] }}
 *   uv: uHlBeamUv, so that u = h * uv[0] + uv[1] and v = vDeg * uv[2] + uv[3] land on texel centres
 */
export function beamTexture(map) {
  const n = map.nh * map.nv, half = new Uint16Array(n), data = new Float32Array(n);
  for (let i = 0; i < n; i++) { half[i] = toHalf(map.data[i] / map.peakCd); data[i] = fromHalf(half[i]); }
  const uv = [1 / (map.dh * map.nh), (-map.hMin / map.dh + 0.5) / map.nh, 1 / (map.dv * map.nv), (-map.vMin / map.dv + 0.5) / map.nv];
  return { width: map.nh, height: map.nv, half, data, peakCd: map.peakCd, uv };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3 = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

/** Scene vector to the car frame: the shader's `d * uHlCar`. */
export const toCar = (d, basis) => [dot(d, v3(basis.right)), dot(d, v3(basis.up)), dot(d, v3(basis.forward))];

/** Mirrors hlCandela: candela over the peak toward d (lamp to point, scene). */
export function beamCandela(tex, d, basis) {
  const c = toCar(d, basis);
  const h = Math.atan2(c[0], c[2]) / RAD;
  if (Math.abs(h) > 90) return 0;
  const v = Math.atan2(c[1], Math.hypot(c[0], c[2])) / RAD;
  return sampleBilinear(tex, h * tex.uv[0] + tex.uv[1], v * tex.uv[2] + tex.uv[3]);
}

/** Lamp positions in the scene for a pose: position + right x + up y + forward (z + nose). */
export function lampPositions(pose, lamps, nose) {
  const p = v3(pose.position), r = v3(pose.right), u = v3(pose.up), f = v3(pose.forward);
  return lamps.map((l) => [0, 1, 2].map((k) => p[k] + r[k] * l.x + u[k] * l.y + f[k] * (l.z + nose)));
}

/**
 * Mirrors diffuseBody: illuminance (lux) on a surface from both lamps, before scene units and colour.
 * @param {{ tex: object, lamps: number[][], basis: object, point: number[], normal: number[], gain?: number, range?: number, fade?: number }} o
 */
export function headlampIrradiance({ tex, lamps, basis, point, normal, gain = 1, range = Infinity, fade = 1 }) {
  let e = 0;
  for (const lamp of lamps) {
    const d = sub(point, lamp);
    const d2 = dot(d, d), dist = Math.sqrt(d2);
    const cosi = -dot(normal, d) / Math.max(dist, 1e-3);
    const f = Math.min(Math.max((range - dist) * fade, 0), 1);
    if (cosi > 0 && f > 0) e += (beamCandela(tex, d, basis) * tex.peakCd * gain * cosi * f) / Math.max(d2, 0.25);
  }
  return e;
}

// ---------------------------------------------------------------- retroreflection (uHlRetro, hlRetro)
/** Rows of the coefficient table, in order: sheeting codes 1-4 (sheeting.js) are rows 0-3. */
export const RETRO_ROWS = Object.freeze(['white', 'yellow', 'red', 'green', 'markingWhite', 'markingYellow']);
export const MARKING_ROWS = Object.freeze([RETRO_ROWS.indexOf('markingWhite'), RETRO_ROWS.indexOf('markingYellow')]);
/** The table's layout: alpha 0..ALPHA_MAX across in WIDTH columns, beta at the sheeting tables' nodes down. */
export const RETRO_LAYOUT = Object.freeze({ width: 129, alphaMax: 4, betaNodes: Object.freeze([0, 4, 30, 40, 60, 90]) });

/**
 * The coefficient table, half floats: RETRO_ROWS.length blocks of betaNodes.length rows.
 * Bilinear filtering is exact in beta (retro.js is linear between the same nodes) and close in alpha
 * (log-linear segments sampled every alphaMax / (width - 1) degrees).
 */
export function retroTable(layout = RETRO_LAYOUT) {
  const { width, alphaMax, betaNodes } = layout;
  const rowsPerType = betaNodes.length, height = RETRO_ROWS.length * rowsPerType;
  const half = new Uint16Array(width * height), data = new Float32Array(width * height);
  RETRO_ROWS.forEach((name, t) => {
    const type = RETRO_TYPES[name];
    betaNodes.forEach((b, j) => {
      for (let i = 0; i < width; i++) {
        const k = (t * rowsPerType + j) * width + i;
        half[k] = toHalf(retroCoefficient(type, (i / (width - 1)) * alphaMax, b));
        data[k] = fromHalf(half[k]);
      }
    });
  });
  return { width, height, rowsPerType, alphaMax, betaNodes: [...betaNodes], half, data };
}

/** Mirrors hlBetaRow. */
export function betaRow(nodes, b) {
  for (let i = 1; i < nodes.length; i++) if (b < nodes[i]) return i - 1 + (b - nodes[i - 1]) / (nodes[i] - nodes[i - 1]);
  return nodes.length - 1;
}

/** Mirrors hlRetroCoef: the coefficient of a row at (alpha, beta), degrees. */
export function retroTableLookup(table, row, alphaDeg, betaDeg) {
  const x = Math.min(Math.max(alphaDeg / table.alphaMax, 0), 1) * (table.width - 1) + 0.5;
  const y = row * table.rowsPerType + betaRow(table.betaNodes, betaDeg) + 0.5;
  return sampleBilinear(table, x / table.width, y / table.height);
}

const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** Mirrors the angles of hlRetro: alpha (lamp-point-eye) by the chord, beta and nu by their cosines, degrees. */
export function retroAnglesMirror(lamp, eye, point, normal) {
  const ul = unit(sub(lamp, point)), ue = unit(sub(eye, point)), n = unit(normal);
  const alpha = 2 * Math.asin(Math.min(1, 0.5 * len(sub(ul, ue)))) / RAD;
  const cosB = dot(n, ul), cosNu = dot(n, ue);
  return { alphaDeg: alpha, betaDeg: Math.acos(Math.min(Math.max(cosB, -1), 1)) / RAD, viewAngleDeg: Math.acos(Math.min(Math.max(cosNu, -1), 1)) / RAD, cosB, cosNu };
}

/**
 * Mirrors hlRetro: luminance (cd/m^2) returned toward the eye for two rows, both lamps, before ageing and units.
 * @param {{ tex: object, table: object, lamps: number[][], basis: object, eye: number[], point: number[], normal: number[],
 *           rows: number[], marking?: boolean, gain?: number, on?: boolean }} o
 * @returns {number[]} [L for rows[0], L for rows[1]]
 */
export function retroReturn({ tex, table, lamps, basis, eye, point, normal, rows, marking = false, gain = 1, on = true }) {
  const out = [0, 0];
  const n = unit(normal), toEye = unit(sub(eye, point));
  const cosNu = dot(n, toEye);
  if (!on || cosNu <= 0) return out;
  for (const lamp of lamps) {
    const tl = sub(lamp, point);
    const dl2 = dot(tl, tl), ul = unit(tl);
    const cosB = dot(n, ul);
    if (cosB <= 0) continue;
    const alpha = 2 * Math.asin(Math.min(1, 0.5 * len(sub(ul, toEye)))) / RAD;
    const beta = Math.acos(Math.min(cosB, 1)) / RAD;
    const e = (beamCandela(tex, [-tl[0], -tl[1], -tl[2]], basis) * tex.peakCd * gain) / dl2;
    out[0] += e * retroTableLookup(table, rows[0], alpha, beta);
    out[1] += e * retroTableLookup(table, rows[1], alpha, beta);
  }
  if (marking) return out;
  const c = Math.max(cosNu, 0.05);
  return [out[0] / c, out[1] / c];
}

// ---------------------------------------------------------------- colours (uHlChroma, uHlInk)
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** '#rrggbb' to linear [r, g, b]. */
export const linearOf = (hex) => [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
export const luminanceOf = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** A colour scaled to luminance 1 (black stays black). */
export const chromaOf = (c) => { const l = luminanceOf(c); return l > 1e-4 ? c.map((x) => x / l) : [0, 0, 0]; };

/**
 * Mirrors the sign variant of retroBody: luminance of a sign texel from its albedo and its two sheeting codes.
 * @param {{ albedo: number[], bg: number, lg: number, ink: number[][], L: number[] }} o
 *   ink: albedo per code (uHlInk); L: hlRetro's return for rows [bg - 1, lg - 1]
 * @returns {{ w: number, luminance: number }}  w the legend's share; luminance before colour
 */
export function signTexel({ albedo, bg, lg, ink, L }) {
  const cb = ink[bg], cl = ink[lg], dc = sub(cl, cb);
  const w = Math.min(Math.max(dot(sub(albedo, cb), dc) / Math.max(dot(dc, dc), 1e-4), 0), 1);
  const ref = cb.map((x, i) => x + (cl[i] - x) * w);
  const k = Math.min(Math.max(luminanceOf(albedo) / Math.max(luminanceOf(ref), 1e-3), 0), 1);
  const lb = bg > 0 ? L[0] : 0, ll = lg > 0 ? L[1] : 0;
  return { w, luminance: (lb + (ll - lb) * w) * k };
}
