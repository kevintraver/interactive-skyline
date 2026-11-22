// Headlamp candela maps (plan 02, D5.1 and section 7.7). Pure: no three.js, no DOM, no fetch.
//
// A map is a candela grid for ONE lamp, written by scripts/make_beam.py into public/data/drive/beam_{low,high}.bin
// (float16) with public/data/drive/beam.json. Angles are degrees from the lamp's aimed H-V axis: h positive to
// the driver's right, v positive up (FMVSS 108's convention). Car frame for positions: x right, y up, z forward,
// metres.
//
// Shader mirror. A renderer reproduces three things:
//   1. the direction to angles of lampAngles():  h = atan(dx, dz) - yaw,  v = atan(dy, hypot(dx, dz)) - pitch;
//   2. candelaAt() as one bilinear texture fetch at uv = ((h - hMin) / (hMax - hMin), (v - vMin) / (vMax - vMin)),
//      texels at their centres (half-texel inset), linear filtering, clamp to edge;
//   3. illuminance E = I x max(0, dot(n, -l)) / d^2  (l: unit vector from lamp to point).
// Through three's SpotLight.map instead, use spotMapTexture() and set the light's intensity to peakCd x units.candela.

const RAD = Math.PI / 180;

/** FMVSS 108 (49 CFR 571.108, 2023 ed.) Table XIX-a, Lower beam #1V (LB1V), one lamp [plan 02, C6].
 * v and h are [lo, hi] in degrees (a range means every angle in it; +-45 stands for the edge of the map);
 * min and max in candela, null where the table sets none. */
export const FMVSS108_LOW = [
  { name: '10U-90U, 90L-90R', v: [10, 10], h: [-45, 45], min: null, max: 125 },
  { name: '4U 8L', v: [4, 4], h: [-8, -8], min: 64, max: null },
  { name: '4U 8R', v: [4, 4], h: [8, 8], min: 64, max: null },
  { name: '2U 4L', v: [2, 2], h: [-4, -4], min: 135, max: null },
  { name: '1.5U 1R-3R', v: [1.5, 1.5], h: [1, 3], min: 200, max: null },
  { name: '1.5U 1R-R', v: [1.5, 1.5], h: [1, 45], min: null, max: 1400 },
  { name: '1U 1.5L-L', v: [1, 1], h: [-45, -1.5], min: null, max: 700 },
  { name: '0.5U 1.5L-L', v: [0.5, 0.5], h: [-45, -1.5], min: null, max: 1000 },
  { name: '0.5U 1R-3R', v: [0.5, 0.5], h: [1, 3], min: 500, max: 2700 },
  { name: 'H-V', v: [0, 0], h: [0, 0], min: null, max: 5000 },
  { name: 'H 4L', v: [0, 0], h: [-4, -4], min: 135, max: null },
  { name: 'H 8L', v: [0, 0], h: [-8, -8], min: 64, max: null },
  { name: '0.6D 1.3R', v: [-0.6, -0.6], h: [1.3, 1.3], min: 10000, max: null },
  { name: '0.86D V', v: [-0.86, -0.86], h: [0, 0], min: 4500, max: null },
  { name: '0.86D 3.5L', v: [-0.86, -0.86], h: [-3.5, -3.5], min: 1800, max: 12000 },
  { name: '1.5D 2R', v: [-1.5, -1.5], h: [2, 2], min: 15000, max: null },
  { name: '2D 9L', v: [-2, -2], h: [-9, -9], min: 1250, max: null },
  { name: '2D 9R', v: [-2, -2], h: [9, 9], min: 1250, max: null },
  { name: '2D 15L', v: [-2, -2], h: [-15, -15], min: 1000, max: null },
  { name: '2D 15R', v: [-2, -2], h: [15, 15], min: 1000, max: null },
  { name: '4D V', v: [-4, -4], h: [0, 0], min: null, max: 10000 },
  { name: '4D 4R', v: [-4, -4], h: [4, 4], min: null, max: 12500 },
  { name: '4D 20L', v: [-4, -4], h: [-20, -20], min: 300, max: null },
  { name: '4D 20R', v: [-4, -4], h: [20, 20], min: 300, max: null },
];

/** FMVSS 108 Table XVIII, Upper beam #2 (UB2), one lamp [plan 02, C6]. */
export const FMVSS108_HIGH = [
  { name: '2U V', v: [2, 2], h: [0, 0], min: 1500, max: null },
  { name: '1U 3L', v: [1, 1], h: [-3, -3], min: 5000, max: null },
  { name: '1U 3R', v: [1, 1], h: [3, 3], min: 5000, max: null },
  { name: 'H-V', v: [0, 0], h: [0, 0], min: 40000, max: 75000 },
  { name: 'H 3L', v: [0, 0], h: [-3, -3], min: 15000, max: null },
  { name: 'H 3R', v: [0, 0], h: [3, 3], min: 15000, max: null },
  { name: 'H 6L', v: [0, 0], h: [-6, -6], min: 5000, max: null },
  { name: 'H 6R', v: [0, 0], h: [6, 6], min: 5000, max: null },
  { name: 'H 9L', v: [0, 0], h: [-9, -9], min: 3000, max: null },
  { name: 'H 9R', v: [0, 0], h: [9, 9], min: 3000, max: null },
  { name: 'H 12L', v: [0, 0], h: [-12, -12], min: 1500, max: null },
  { name: 'H 12R', v: [0, 0], h: [12, 12], min: 1500, max: null },
  { name: '1.5D V', v: [-1.5, -1.5], h: [0, 0], min: 5000, max: null },
  { name: '1.5D 9L', v: [-1.5, -1.5], h: [-9, -9], min: 2000, max: null },
  { name: '1.5D 9R', v: [-1.5, -1.5], h: [9, 9], min: 2000, max: null },
  { name: '2.5D V', v: [-2.5, -2.5], h: [0, 0], min: 2500, max: null },
  { name: '2.5D 12L', v: [-2.5, -2.5], h: [-12, -12], min: 1000, max: null },
  { name: '2.5D 12R', v: [-2.5, -2.5], h: [12, 12], min: 1000, max: null },
  { name: '4D V', v: [-4, -4], h: [0, 0], min: null, max: 12000 },
];

/** Default headlamp placement on a crossover, car frame, metres. ASSUMED: FMVSS 108 allows a mounting height of
 * 22-54 in (0.56-1.37 m) [C6]; 0.65 m high and 1.4 m apart is typical of a small SUV. */
export const DEFAULT_LAMPS = Object.freeze([
  Object.freeze({ x: -0.7, y: 0.65, z: 0 }),
  Object.freeze({ x: 0.7, y: 0.65, z: 0 }),
]);

/** IEEE 754 half (as a uint16) to a number. */
export function halfToFloat(u) {
  const s = u & 0x8000 ? -1 : 1;
  const e = (u >> 10) & 0x1f;
  const f = u & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

/**
 * A candela map from the bytes of beam_{low,high}.bin and the parsed beam.json.
 * @param {ArrayBuffer|ArrayBufferView} bytes
 * @param {object} meta  parsed beam.json
 * @param {'low'|'high'} [which]  only used to read the peak from meta
 * @returns {{ hMin:number, vMin:number, dh:number, dv:number, nh:number, nv:number, data: Float32Array, peakCd:number }}
 */
export function decodeBeam(bytes, meta, which) {
  const g = meta.grid;
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const n = g.nh * g.nv;
  if (buf.byteLength !== n * 2) throw new Error(`beam: expected ${n * 2} bytes, got ${buf.byteLength}`);
  const view = new DataView(buf);
  const data = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const c = halfToFloat(view.getUint16(i * 2, true));
    data[i] = c;
    if (c > peak) peak = c;
  }
  if (which && meta[which]?.peakCd && Math.abs(meta[which].peakCd - peak) > 1) {
    throw new Error(`beam: peak ${peak} does not match beam.json (${meta[which].peakCd})`);
  }
  return { hMin: g.hMin, vMin: g.vMin, dh: g.dh, dv: g.dv, nh: g.nh, nv: g.nv, data, peakCd: peak };
}

/**
 * Candela toward (hDeg, vDeg), bilinear, clamped to the edge of the grid (the regulation keeps the light above
 * +10 deg under 125 cd, so clamping there is safe). Zero behind the lamp (|h| or |v| beyond 90 deg).
 */
export function candelaAt(map, hDeg, vDeg) {
  if (!map || !(Math.abs(hDeg) <= 90 && Math.abs(vDeg) <= 90)) return 0;
  const { hMin, vMin, dh, dv, nh, nv, data } = map;
  const x = Math.min(Math.max((hDeg - hMin) / dh, 0), nh - 1);
  const y = Math.min(Math.max((vDeg - vMin) / dv, 0), nv - 1);
  const x0 = Math.min(Math.floor(x), nh - 2), y0 = Math.min(Math.floor(y), nv - 2);
  const fx = x - x0, fy = y - y0;
  const i = y0 * nh + x0;
  const a = data[i] * (1 - fx) + data[i + 1] * fx;
  const b = data[i + nh] * (1 - fx) + data[i + nh + 1] * fx;
  return a * (1 - fy) + b * fy;
}

function axisValues(lo, hi, step, a0, n) {
  lo = Math.max(lo, a0);
  hi = Math.min(hi, a0 + step * (n - 1));
  if (lo > hi) return [];
  const vals = new Set([lo, hi]);
  for (let k = Math.ceil((lo - a0) / step - 1e-9); k <= Math.floor((hi - a0) / step + 1e-9); k++) vals.add(a0 + step * k);
  return [...vals].sort((p, q) => p - q);
}

/**
 * Check a map against a test-point table: every grid angle inside each point's range, and its ends.
 * @returns {{ name:string, min:number|null, max:number|null, low:number, high:number, ok:boolean }[]}
 */
export function checkBeam(map, points = FMVSS108_LOW) {
  return points.map((p) => {
    let low = Infinity, high = -Infinity;
    for (const v of axisValues(p.v[0], p.v[1], map.dv, map.vMin, map.nv)) {
      for (const h of axisValues(p.h[0], p.h[1], map.dh, map.hMin, map.nh)) {
        const c = candelaAt(map, h, v);
        low = Math.min(low, c);
        high = Math.max(high, c);
      }
    }
    const ok = (p.min == null || low >= p.min) && (p.max == null || high <= p.max);
    return { name: p.name, min: p.min, max: p.max, low, high, ok };
  });
}

const xyz = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

/**
 * Angles of a point as the lamp sees it, and the distance. aim: { yawDeg (positive right), pitchDeg (positive
 * up) } of the lamp's H-V axis from straight ahead; small aims are treated as offsets in h and v.
 * @returns {{ hDeg:number, vDeg:number, d:number, l:number[] }}  l: unit vector from lamp to point
 */
export function lampAngles(lamp, point, aim) {
  const [lx, ly, lz] = xyz(lamp), [px, py, pz] = xyz(point);
  const dx = px - lx, dy = py - ly, dz = pz - lz;
  const flat = Math.hypot(dx, dz);
  const d = Math.hypot(flat, dy);
  const hDeg = Math.atan2(dx, dz) / RAD - (aim?.yawDeg || 0);
  const vDeg = Math.atan2(dy, flat) / RAD - (aim?.pitchDeg || 0);
  return { hDeg, vDeg, d, l: d > 0 ? [dx / d, dy / d, dz / d] : [0, 0, 1] };
}

/** Illuminance (lux) on a plane facing the lamp, at a point: I / d^2. What retroreflection needs (section 7.4). */
export function illuminancePerpendicular(map, lamp, point, aim) {
  const a = lampAngles(lamp, point, aim);
  return a.d > 0 ? candelaAt(map, a.hDeg, a.vDeg) / (a.d * a.d) : 0;
}

/**
 * Illuminance (lux) at a point from several lamps sharing one map, on a surface with the given normal (default:
 * level road, normal up). With map null (lamps off) the result is exactly 0.
 * @param {object|null} map
 * @param {Array<{x,y,z}|number[]>} lampPositions  car frame, metres
 * @param {{x,y,z}|number[]} point
 * @param {{ normal?: number[], aim?: { yawDeg?: number, pitchDeg?: number } }} [opts]
 */
export function roadIlluminance(map, lampPositions, point, { normal = [0, 1, 0], aim } = {}) {
  if (!map) return 0;
  let e = 0;
  for (const lamp of lampPositions) {
    const a = lampAngles(lamp, point, aim);
    if (!(a.d > 0)) continue;
    const cos = -(normal[0] * a.l[0] + normal[1] * a.l[1] + normal[2] * a.l[2]);
    if (cos > 0) e += (candelaAt(map, a.hDeg, a.vDeg) * cos) / (a.d * a.d);
  }
  return e;
}

/**
 * The map resampled for three's SpotLight.map, which projects a texture through the light's perspective camera
 * (gnomonic: texel (s, t) looks along (tan(half) * (2s - 1), tan(half) * (2t - 1), 1)). Values are I / peakCd.
 * Row 0 is the bottom (t = 0, looking down), as a DataTexture with flipY false is read. Set the SpotLight's
 * angle to halfAngleDeg, penumbra 0, intensity peakCd x lighting.units.candela, decay 2. The light camera's x
 * axis must be the car's right; if a renderer finds it mirrored, flip the columns, not the beam.
 * @param {object} map
 * @param {{ size?: number, halfAngleDeg?: number, channels?: 1|4 }} [opts]
 * @returns {{ data: Float32Array, width: number, height: number, channels: number, peakCd: number, halfAngleDeg: number }}
 */
export function spotMapTexture(map, { size = 256, halfAngleDeg = 45, channels = 4 } = {}) {
  const t = Math.tan(halfAngleDeg * RAD);
  const data = new Float32Array(size * size * channels);
  const peak = map.peakCd || Math.max(...map.data);
  for (let j = 0; j < size; j++) {
    const y = t * ((2 * (j + 0.5)) / size - 1);
    for (let i = 0; i < size; i++) {
      const x = t * ((2 * (i + 0.5)) / size - 1);
      const h = Math.atan(x) / RAD;
      const v = Math.atan2(y, Math.hypot(x, 1)) / RAD;
      const c = candelaAt(map, h, v) / peak;
      const k = (j * size + i) * channels;
      data[k] = c;
      if (channels === 4) { data[k + 1] = c; data[k + 2] = c; data[k + 3] = 1; }
    }
  }
  return { data, width: size, height: size, channels, peakCd: peak, halfAngleDeg };
}
