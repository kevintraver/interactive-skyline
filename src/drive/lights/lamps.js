// Street-lamp types and the light a lamp sends out (plan 02, D5.4 and D5.5; sections 5.9 and 7.8).
// Pure: no three.js, no DOM; usable in a worker.
//
// Input: the parsed data/lamp_types.json of the lamp inventory (D5.3 / plan 01 T4.0). Each type carries a key,
// a class (sodium, led, other), cctK, uplight (share of flux sent above the horizontal) and optionally mountM and
// optic. The `lamps` layer gives per lamp: position, mount height (dm), type id, flux (lm / 10), aim (cdeg).
//
// Angles: theta is measured from the nadir (0 = straight down, 90 = horizontal, 180 = straight up); phi is the
// azimuth around the pole, 0 along the road, +90 toward the street side (the way the arm points), +-180 along the
// road the other way, -90 the house side. Intensities in candela, flux in lumens, illuminance in lux.
//
// Shader mirror:
//   - a type's light toward a direction: shape(theta, phi) below, x lumens x kDown (or kUp above the horizontal);
//     or, where the azimuth is unknown or not worth it, a 1-D texture of `curve` (cd per lumen at 0.5 deg steps of
//     theta, averaged over phi);
//   - the sprite rule of spriteFlux(): diameterPx = max(D / d / pixelAngle, minPx); radiance = I / d^2 / solidAngle;
//   - the pool is a texture already: E from splatPool, and a surface adds albedo x E / pi.

import { colorTemperatureToLinearSrgb, planck, spectrumToXyz, xyzToLinearSrgb } from '../../core/units.js';

const RAD = Math.PI / 180;

// ---------------------------------------------------------------- optics (shapes ASSUMED, see each kind)
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const wing = (thetaDeg, peak, width) => Math.exp(-(((thetaDeg - peak) / width) ** 2));

/**
 * Optic kinds. Each has down(theta, phi) for theta <= 90 and up(theta) for theta > 90; both unnormalised.
 * Shapes are ASSUMED, chosen to resemble the published IES distribution types they stand for:
 *  - cutoff: an LED cobra head, IES Type II-III, full cutoff (BUG U0, as Clark County's specification requires
 *    [plan 02, L2]): a batwing peaking 65 deg from nadir thrown along the road, a little more to the street side,
 *    nothing above 90 deg.
 *  - droplens: a high-pressure sodium cobra head with a drop (sag) lens: a wider batwing peaking at 70 deg, light
 *    up to the horizontal, and a glow just above it that carries the type's uplight share.
 *  - highmast: IES Type V, round symmetric, peak at 60 deg, full cutoff.
 */
export const OPTICS = {
  cutoff: {
    down: (t, p) => (0.35 * Math.cos(t * RAD) + wing(t, 65, 14) * (0.3 + 0.7 * Math.cos(p * RAD) ** 2))
      * (1 + 0.35 * Math.sin(p * RAD)) * (1 - smoothstep(78, 90, t)),
    up: () => 0,
  },
  droplens: {
    down: (t, p) => (0.3 * Math.cos(t * RAD) + wing(t, 70, 16) * (0.35 + 0.65 * Math.cos(p * RAD) ** 2))
      * (1 + 0.3 * Math.sin(p * RAD)) * (1 - smoothstep(84, 90, t)),
    up: (t) => wing(t, 98, 10),
  },
  highmast: {
    down: (t) => (0.3 * Math.cos(t * RAD) + wing(t, 60, 18)) * (1 - smoothstep(80, 90, t)),
    up: () => 0,
  },
};

/** Which optic a type gets: its own `optic` if the JSON names one; high masts; anything with uplight is a drop
 * lens; the rest full cutoff. */
export function opticOf(t) {
  if (t.optic && OPTICS[t.optic]) return t.optic;
  if (t.key === 'led_highmast') return 'highmast';
  if (t.uplight > 0) return 'droplens';
  return 'cutoff';
}

/** Integral over the sphere of f(theta, phi) sin(theta), midpoint rule (degrees in, steradians out). */
function sphereIntegral(f, t0, t1, dt = 0.25, dp = 2) {
  let s = 0;
  for (let t = t0 + dt / 2; t < t1; t += dt) {
    const w = Math.sin(t * RAD) * dt * RAD * dp * RAD;
    for (let p = -180 + dp / 2; p < 180; p += dp) s += f(t, p) * w;
  }
  return s;
}

// ---------------------------------------------------------------- colour
/** CIE 1976 u'v' of XYZ. */
export const uvFromXyz = ([X, Y, Z]) => { const d = X + 15 * Y + 3 * Z; return [(4 * X) / d, (9 * Y) / d]; };
/** XYZ (Y = 1) of a CIE 1976 u'v'. */
export const xyzFromUv = ([u, v]) => { const x = (9 * u) / (6 * u - 16 * v + 12), y = (4 * v) / (6 * u - 16 * v + 12); return [x / y, 1, (1 - x - y) / y]; };

// Sodium warm-up (run-up). A high-pressure sodium lamp starts as a dim glow of its starting gas and mercury, pink to
// white, and reaches its full amber output as the sodium amalgam vaporises, typically in 3 to 4 minutes (ASSUMED from
// typical lamp catalogues, recalled; the plan's 3-5 minute acceptance window brackets it).
// Start chromaticity x = 0.33, y = 0.30 (a pinkish white below the Planckian locus) and the time constants are ASSUMED.
const SODIUM_START_UV = uvFromXyz([0.33 / 0.30, 1, (1 - 0.33 - 0.30) / 0.30]);
/** Colour progress 1 - exp(-(t / tau)^2): reaches 0.005 u'v' of steady at about 1.7 tau (about 4 min). */
export const SODIUM_COLOR_TAU_S = 140;
/** Flux 0.05 + 0.95 (1 - exp(-(t / tau)^2)): 90% at about 2.6 min. */
export const SODIUM_FLUX_TAU_S = 100;
const SODIUM_FLUX_START = 0.05;

/**
 * Lamp types from the parsed data/lamp_types.json.
 * @param {{ types: object[], mountDefaultM?: number }} json
 * @returns {{ byId: Map<number, LampType>, byKey: Map<string, LampType>, list: LampType[], mountDefaultM: number }}
 *
 * @typedef {Object} LampType
 * @property {number} id @property {string} key @property {string} cls 'sodium'|'led'|'other'
 * @property {number} cctK
 * @property {number[]} color        linear sRGB with luminance 1 (multiply by a luminance); may exceed 1
 * @property {number[]} colorNorm    the same with its largest channel 1, for a plain render colour
 * @property {number[]} steadyUv     u'v' of the steady colour
 * @property {string} optic          a key of OPTICS
 * @property {number} uplight        share of flux above the horizontal
 * @property {number} kDown          cd per lumen per unit of shape, below the horizontal
 * @property {number} kUp            the same above
 * @property {Float32Array} curve    cd per lumen at theta = 0, 0.5, ..., 180 deg, averaged over phi
 * @property {(thetaDeg: number, phiDeg: number, lumens: number) => number} intensity   candela
 * @property {(thetaDeg: number, lumens: number) => number} intensityAvg                candela, averaged over phi
 * @property {(seconds: number) => { flux: number, uv: number[], color: number[] }} warmup
 * @property {number} mountM         default mount height of the type, metres
 */
export function createLampTypes(json) {
  if (!json || !Array.isArray(json.types)) throw new Error('lamps: lamp_types.json with a types array is required');
  const mountDefaultM = json.mountDefaultM || 9.14; // 30 ft pole (lamp_types.json, mountDefaultNote)
  const list = json.types.map((t) => makeType(t, mountDefaultM));
  return {
    list,
    byId: new Map(list.map((t) => [t.id, t])),
    byKey: new Map(list.map((t) => [t.key, t])),
    mountDefaultM,
  };
}

function makeType(t, mountDefaultM) {
  const optic = opticOf(t);
  const { down, up } = OPTICS[optic];
  const uplight = optic === 'droplens' ? Math.max(0, Math.min(0.5, t.uplight || 0)) : 0;
  const kDown = (1 - uplight) / sphereIntegral(down, 0, 90);
  const kUp = uplight > 0 ? uplight / sphereIntegral((th) => up(th), 90, 180) : 0;
  const shape = (th, ph) => (th <= 90 ? kDown * down(th, ph) : kUp * up(th));

  const curve = new Float32Array(361);
  for (let i = 0; i <= 360; i++) {
    const th = i * 0.5;
    let s = 0;
    for (let p = -179; p < 180; p += 2) s += shape(th, p);
    curve[i] = s / 180;
  }
  const xyz = spectrumToXyz((nm) => planck(nm, t.cctK));
  const color = colorTemperatureToLinearSrgb(t.cctK);
  const max = Math.max(...color);
  const steadyUv = uvFromXyz(xyz);
  const isSodium = t.class === 'sodium';

  return {
    id: t.id,
    key: t.key,
    name: t.name,
    cls: t.class,
    cctK: t.cctK,
    color,
    colorNorm: color.map((c) => Math.max(0, c / max)),
    steadyUv,
    optic,
    uplight,
    kDown,
    kUp,
    curve,
    mountM: t.mountM || mountDefaultM,
    intensity: (thetaDeg, phiDeg, lumens) => lumens * shape(thetaDeg, phiDeg),
    intensityAvg: (thetaDeg, lumens) => {
      const x = Math.min(Math.max(thetaDeg, 0), 180) * 2;
      const i = Math.min(Math.floor(x), 359), f = x - i;
      return lumens * (curve[i] * (1 - f) + curve[i + 1] * f);
    },
    warmup: (seconds) => warmup(isSodium, steadyUv, seconds),
  };
}

/**
 * Warm-up of a lamp `seconds` after it switched on: flux as a share of steady, and colour. LEDs (and anything not
 * sodium) are instant. Before switch-on (seconds < 0 or NaN) the flux is 0.
 * @returns {{ flux: number, uv: number[], color: number[] }} color: linear sRGB, luminance 1
 */
function warmup(isSodium, steadyUv, seconds) {
  if (!(seconds >= 0)) return { flux: 0, uv: steadyUv, color: xyzToLinearSrgb(xyzFromUv(steadyUv)) };
  if (!isSodium) return { flux: 1, uv: steadyUv, color: xyzToLinearSrgb(xyzFromUv(steadyUv)) };
  const pc = 1 - Math.exp(-((seconds / SODIUM_COLOR_TAU_S) ** 2));
  const pf = 1 - Math.exp(-((seconds / SODIUM_FLUX_TAU_S) ** 2));
  const uv = [SODIUM_START_UV[0] + (steadyUv[0] - SODIUM_START_UV[0]) * pc, SODIUM_START_UV[1] + (steadyUv[1] - SODIUM_START_UV[1]) * pc];
  return { flux: SODIUM_FLUX_START + (1 - SODIUM_FLUX_START) * pf, uv, color: xyzToLinearSrgb(xyzFromUv(uv)) };
}

// ---------------------------------------------------------------- ground illuminance
/**
 * Illuminance (lux) on flat ground from one lamp.
 * @param {LampType} type
 * @param {number} lumens          the lamp's flux
 * @param {number} mountHeight     metres above the ground
 * @param {number} dx              ground offset from the point under the lamp head, metres, x east
 * @param {number} dy              the same, y north
 * @param {number|null} [aim]      direction the arm points (the street side), degrees counter-clockwise from +x;
 *                                 null or undefined (the layer's 65535): the phi-averaged curve
 */
export function illuminanceAt(type, lumens, mountHeight, dx, dy, aim) {
  const d2 = dx * dx + dy * dy + mountHeight * mountHeight;
  if (!(d2 > 0) || !(mountHeight > 0)) return 0;
  const d = Math.sqrt(d2);
  const cos = mountHeight / d;
  const theta = Math.acos(cos) / RAD;
  let i;
  if (aim == null || !Number.isFinite(aim)) i = type.intensityAvg(theta, lumens);
  else {
    const phi = dx === 0 && dy === 0 ? 0 : Math.atan2(dy, dx) / RAD - aim + 90;
    i = type.intensity(theta, ((phi + 540) % 360) - 180, lumens);
  }
  return (i * cos) / d2;
}

/**
 * Add one lamp's ground illuminance into a pool map. Pure apart from writing `grid`; worker-safe.
 * @param {Float32Array} grid      nx x ny, row-major, row 0 at y0 (south), column 0 at x0 (west)
 * @param {{ x0: number, y0: number, cell: number, nx: number, ny: number }} spec   lower-left corner and cell size, metres
 * @param {{ x: number, y: number, mount: number, lumens: number, aim?: number|null }} lamp
 * @param {LampType} type
 * @param {{ supersample?: number, maxRadius?: number }} [opts]
 *   supersample: samples per cell side (the cell's mean, not its centre); maxRadius: metres, default where the
 *   type's light reaches 85 deg from nadir, at most 150 m
 * @returns {Float32Array} grid
 */
export function splatPool(grid, spec, lamp, type, { supersample = 2, maxRadius } = {}) {
  const { x0, y0, cell, nx, ny } = spec;
  const r = maxRadius ?? Math.min(150, lamp.mount * Math.tan(85 * RAD));
  const ix0 = Math.max(0, Math.floor((lamp.x - r - x0) / cell)), ix1 = Math.min(nx - 1, Math.floor((lamp.x + r - x0) / cell));
  const iy0 = Math.max(0, Math.floor((lamp.y - r - y0) / cell)), iy1 = Math.min(ny - 1, Math.floor((lamp.y + r - y0) / cell));
  const s = Math.max(1, supersample | 0), w = 1 / (s * s);
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      let e = 0;
      for (let sy = 0; sy < s; sy++) {
        const py = y0 + (iy + (sy + 0.5) / s) * cell - lamp.y;
        for (let sx = 0; sx < s; sx++) {
          const px = x0 + (ix + (sx + 0.5) / s) * cell - lamp.x;
          e += illuminanceAt(type, lamp.lumens, lamp.mount, px, py, lamp.aim);
        }
      }
      grid[iy * nx + ix] += e * w;
    }
  }
  return grid;
}

/** Bilinear read of a pool map at (x, y), metres, cell values at cell centres (as a texture fetch reads it). */
export function poolAt(grid, { x0, y0, cell, nx, ny }, x, y) {
  const fx = Math.min(Math.max((x - x0) / cell - 0.5, 0), nx - 1), fy = Math.min(Math.max((y - y0) / cell - 0.5, 0), ny - 1);
  const ix = Math.min(Math.floor(fx), nx - 2), iy = Math.min(Math.floor(fy), ny - 2);
  const tx = fx - ix, ty = fy - iy, i = iy * nx + ix;
  return (grid[i] * (1 - tx) + grid[i + 1] * tx) * (1 - ty) + (grid[i + nx] * (1 - tx) + grid[i + nx + 1] * tx) * ty;
}

/**
 * Decode records of the `lamps` layer (16 bytes each; layout in data/derived/<city>/lamps.json of D5.3):
 * x_mm int32, y_mm int32, mount_dm uint16, type uint8, flags uint8, flux_10lm uint16, aim_cdeg uint16 (65535 unknown).
 * @returns {{ x: number, y: number, mount: number, type: number, flags: number, lumens: number, aim: number|null }[]}
 */
export function decodeLampRecords(bytes) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const v = new DataView(buf);
  const out = [];
  for (let o = 0; o + 16 <= buf.byteLength; o += 16) {
    const aim = v.getUint16(o + 14, true);
    out.push({
      x: v.getInt32(o, true) / 1000,
      y: v.getInt32(o + 4, true) / 1000,
      mount: v.getUint16(o + 8, true) / 10,
      type: v.getUint8(o + 10),
      flags: v.getUint8(o + 11),
      lumens: v.getUint16(o + 12, true) * 10,
      aim: aim === 0xffff ? null : aim / 100,
    });
  }
  return out;
}

// ---------------------------------------------------------------- sprites
/** ASSUMED luminous opening of a street luminaire, metres (a cobra head's lens is about half a metre long). */
export const LUMINAIRE_DIAMETER_M = 0.5;

/**
 * The flux-conserving sprite rule (section 7.8). A lamp of intensity I toward the eye at distance d gives the eye
 * an illuminance E = T x I / d^2. The sprite is a disk of diameterPx pixels whose radiance L makes L x solidAngle
 * equal to E, so its summed light is the same whether it is many pixels wide or clamped to the minimum size.
 * @param {{ intensityCd: number, distanceM: number, pixelSolidAngleSr: number, diameterM?: number,
 *           minDiameterPx?: number, transmittance?: number }} o
 * @returns {{ illuminanceLux: number, diameterPx: number, solidAngleSr: number, radiance: number }}
 *   radiance in cd/m^2
 */
export function spriteFlux({ intensityCd, distanceM, pixelSolidAngleSr, diameterM = LUMINAIRE_DIAMETER_M, minDiameterPx = 1.5, transmittance = 1 }) {
  const e = (transmittance * intensityCd) / (distanceM * distanceM);
  const pixelAngle = Math.sqrt(pixelSolidAngleSr);
  const diameterPx = Math.max(diameterM / distanceM / pixelAngle, minDiameterPx);
  const solidAngleSr = (Math.PI / 4) * diameterPx * diameterPx * pixelSolidAngleSr;
  return { illuminanceLux: e, diameterPx, solidAngleSr, radiance: e / solidAngleSr };
}
