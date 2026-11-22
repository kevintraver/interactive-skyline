// The light-sprite shader's arithmetic in JavaScript (sprites.glsl.js), function for function, for tests and for
// anything on the CPU that must agree with what the GPU draws. Pure. Change both together.

import { ON_TABLE } from './switching.js';

const RAD = Math.PI / 180;
const smoothstep01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const wing = (t, peak, width) => Math.exp(-(((t - peak) / width) ** 2));

/** Pattern kinds of the sprite shader. */
export const PATTERN = Object.freeze({ isotropic: 0, cutoff: 1, droplens: 2, highmast: 3, lobe: 4 });

/**
 * Shape of a pattern toward (theta, phi) in degrees; phi null for the phi-average. k = [kDown, kUp, z] where z is the
 * lobe exponent (kind 4) or the downward share (kinds 1-3). For kinds 1-3 multiply by lumens for candela.
 */
export function patternShape(kind, k, t, p) {
  const avg = p == null;
  if (kind === PATTERN.isotropic) return 1;
  if (kind === PATTERN.lobe) return Math.max(Math.cos(t * RAD), 0) ** k[2];
  const cp = avg ? 0 : Math.cos(p * RAD), sp = avg ? 0 : Math.sin(p * RAD);
  if (kind === PATTERN.cutoff) {
    if (t > 90) return 0;
    const lat = avg ? 0.65 : (0.3 + 0.7 * cp * cp) * (1 + 0.35 * sp);
    const axial = avg ? 1 : 1 + 0.35 * sp;
    return k[0] * (0.35 * Math.cos(t * RAD) * axial + wing(t, 65, 14) * lat) * (1 - smoothstep01(78, 90, t));
  }
  if (kind === PATTERN.droplens) {
    if (t > 90) return k[1] * wing(t, 98, 10);
    const lat = avg ? 0.675 : (0.35 + 0.65 * cp * cp) * (1 + 0.3 * sp);
    const axial = avg ? 1 : 1 + 0.3 * sp;
    return k[0] * (0.3 * Math.cos(t * RAD) * axial + wing(t, 70, 16) * lat) * (1 - smoothstep01(84, 90, t));
  }
  if (t > 90) return 0;
  return k[0] * (0.3 * Math.cos(t * RAD) + wing(t, 60, 18)) * (1 - smoothstep01(80, 90, t));
}

/** The pattern kind for a lamp type's optic (lamps.js opticOf). */
export const kindOfOptic = (optic) => PATTERN[optic] ?? PATTERN.cutoff;

/** Gamma(1 + 2 / n) for n in [2, 6], by the shader's table. */
export function gammaTerm(n) {
  const G = [1, 0.902745, 0.886227, 0.887264, 0.89298];
  const f = Math.min(Math.max(n - 2, 0), 3.999), i = Math.floor(f), t = f - i;
  return G[i] + (G[i + 1] - G[i]) * t;
}

/**
 * The sprite rule and profile as the shader computes them.
 * @returns {{ illuminanceLux, diameterPx, solidAngleSr, radiance, a, n, haloA, halo, coreNorm, haloNorm, extentPx }}
 *   radiance: cd/m^2 averaged over the disc; profile(r) = radiance x (coreNorm e^{-(r/a)^n} + haloNorm e^{-(r/haloA)^2})
 */
export function spriteRule({ intensityCd, distanceM, pixelAngle, diameterM = 0.5, minPx = 1.5, visibilityM = Infinity, halo = 0 }) {
  const T = Math.exp(-distanceM / visibilityM);
  const E = (T * intensityCd) / (distanceM * distanceM);
  const dPx = Math.max(diameterM / distanceM / pixelAngle, minPx);
  const solid = (Math.PI / 4) * dPx * dPx * pixelAngle * pixelAngle;
  const L = E / solid;
  const n = 2 + 4 * smoothstep01(2, 8, dPx);
  const a = (0.5 * dPx) / Math.LN2 ** (1 / n);
  const h = halo * smoothstep01(2, 6, dPx);
  const ha = Math.max(2 * dPx, 4);
  const area = (Math.PI / 4) * dPx * dPx;
  const coreNorm = ((1 - h) * area) / (Math.PI * a * a * gammaTerm(n));
  const haloNorm = (h * area) / (Math.PI * ha * ha);
  return {
    illuminanceLux: E, diameterPx: dPx, solidAngleSr: solid, radiance: L, a, n, haloA: ha, halo: h, coreNorm, haloNorm,
    /** half size of the quad for a colour whose largest channel is cmax (the sprite's radiance x gain x colour) */
    extentFor(cmax) {
      const rCore = a * Math.max(Math.log(cmax * coreNorm * 1024), 0) ** (1 / n);
      const rHalo = h > 0 ? ha * Math.sqrt(Math.max(Math.log(cmax * haloNorm * 1024), 0)) : 0;
      const e = Math.min(Math.max(rCore, rHalo), Math.max(2.6 * a, h > 0 ? 2.6 * ha : 0));
      return e < 0.5 ? 0 : e + 0.5;
    },
  };
}

/** The profile at r pixels from the centre, per unit radiance (spriteRule's fields). */
export const profileAt = (s, r) => s.coreNorm * Math.exp(-((r / s.a) ** s.n)) + (s.haloNorm > 0 ? s.haloNorm * Math.exp(-((r / s.haloA) ** 2)) : 0);

/** A lamp's seconds since switch-on from the table, as the shader reads it (switching.js secondsOnFromTable). */
export function onSeconds(table, threshold, { log0, step, n } = ON_TABLE) {
  const f = Math.min(Math.max((Math.log(threshold) / Math.log(10) - log0) / step, 0), n - 1);
  const i = Math.min(Math.floor(f), n - 2), t = f - i;
  return table[i] + (table[i + 1] - table[i]) * t;
}

/** Sodium warm-up as the shader does it: flux share and linear sRGB colour (luminance 1). */
export function warmSodium(seconds, startUv, steadyUv) {
  const s = seconds >= 0 ? seconds : 0;
  const pc = 1 - Math.exp(-((s / 140) ** 2));
  const pf = 1 - Math.exp(-((s / 100) ** 2));
  const u = startUv[0] + (steadyUv[0] - startUv[0]) * pc, v = startUv[1] + (steadyUv[1] - startUv[1]) * pc;
  const d = 6 * u - 16 * v + 12, x = (9 * u) / d, y = (4 * v) / d;
  const X = x / y, Y = 1, Z = (1 - x - y) / y;
  return {
    flux: 0.05 + 0.95 * pf,
    color: [
      3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
      -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
      0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
    ],
  };
}

/** The sprite tone (fragment shader): ACES fit on luminance, hue kept, only what would clip whitened (whiten: the share
 * of it, the layer's uWhiten, 1 by default). */
export function toneSprite([r, g, b], whiten = 1) {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (!(y > 0)) return [0, 0, 0];
  const x = y / 0.6;
  const t = Math.min(1, Math.max(0, (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081)));
  let o = [r, g, b].map((c) => (c * t) / y);
  const m = Math.max(...o);
  if (m > 1) { const w = (whiten * (m - 1)) / m; o = o.map((c) => (c / m) * (1 - w) + w); }
  return o;
}

/**
 * Intensity toward the eye as the vertex shader computes it, for one instance (theta from the axis, phi from the
 * aim, the far pool glow). Positions in scene metres; aimRad NaN for unknown.
 */
export function instanceIntensity({ pos, eye, intensity, kind, k, axis, aimRad, mount = 0, groundAlbedo = 0, glowRange = [800, 1000] }) {
  const rel = [pos[0] - eye[0], pos[1] - eye[1], pos[2] - eye[2]];
  const d = Math.hypot(...rel);
  const toEye = rel.map((c) => -c / d);
  const theta = Math.acos(Math.min(1, Math.max(-1, axis[0] * toEye[0] + axis[1] * toEye[1] + axis[2] * toEye[2]))) / RAD;
  let phi = null;
  if (Number.isFinite(aimRad)) {
    const az = Math.atan2(-toEye[2], toEye[0]) / RAD;
    phi = ((((az - aimRad / RAD + 90 + 540) % 360) + 360) % 360) - 180;
  }
  let I = intensity * patternShape(kind, k, theta, phi);
  if (mount > 0 && kind >= 1 && kind <= 3) {
    const cz = Math.min(1, Math.max(0, (eye[1] - (pos[1] - mount)) / d));
    I += ((groundAlbedo * intensity * k[2]) / Math.PI) * cz * smoothstep01(glowRange[0], glowRange[1], d);
  }
  return { intensity: I, theta, phi, distance: d };
}

// ---------------------------------------------------------------- reflected twins (sprites.glsl.js spriteTwinVertex)

/** Mirrors twinFresnel: Fresnel reflectance of water (n 1.333), unpolarised, by the cosine of the incidence angle. */
export function twinFresnel(c, n = 1.333) {
  c = Math.min(1, Math.max(0, c));
  const st = Math.sqrt(Math.max(0, 1 - c * c)) / n;
  const ct = Math.sqrt(Math.max(0, 1 - st * st));
  const rs = (c - n * ct) / (c + n * ct), rp = (ct - n * c) / (ct + n * c);
  return 0.5 * (rs * rs + rp * rp);
}

/**
 * A twin as the shader draws it, on a level road (grade 0; the shader's plane may tilt with the car's grade).
 * @param {{ lamp: number[], eye: number[], roadY: number, intensityCd: number, wet: number, slope: number,
 *   pixelAngle: number, diameterM?: number, visibilityM?: number, mask?: number, gain?: number }} o
 *   lamp, eye: scene positions; intensityCd: the lamp's intensity toward the reflection point; wet: uTwinWet
 * @returns {{ E, fresnel, dm, cosi, r, sigU, sUp, sDn, amp, reach, extent: { across, up, down }, profile(u, v) } | null}
 *   E: summed light at the eye (lux); amp: the peak per unit gain (cd/m^2 x gain is the scene value); profile(u, v)
 *   the drawn value per unit gain at pixel offsets (u across, v up), 0 outside the quad
 */
export function twinRule({ lamp, eye, roadY, intensityCd, wet, slope, pixelAngle, diameterM = 0.14, visibilityM = Infinity, mask = 1, gain = 1 }) {
  if (!(wet > 0)) return null;
  const he = eye[1] - roadY, hl = lamp[1] - roadY;
  if (he < 0.1 || hl < 0.1) return null;
  const m = [lamp[0] - eye[0], lamp[1] - 2 * hl - eye[1], lamp[2] - eye[2]];
  const dm = Math.hypot(...m);
  if (dm < 1) return null;
  const t = he / (he + hl);
  const r = m.map((x) => x * t);
  const cosi = (he + hl) / dm;
  const fresnel = twinFresnel(cosi);
  const nearFade = smoothstep01(5, 15, Math.hypot(r[0], r[2]));
  const E = wet * mask * nearFade * fresnel * Math.exp(-dm / visibilityM) * intensityCd / (dm * dm);
  const k = hl / (he + hl);
  let sigU = (2 * slope * cosi * k) / pixelAngle;
  let sigA = (2 * slope * k) / pixelAngle;
  const disc = (0.4247 * diameterM) / dm / pixelAngle;
  sigU = Math.max(sigU, disc, 0.6);
  sigA = Math.max(sigA, sigU);
  const D = Math.hypot(lamp[0] - eye[0], lamp[2] - eye[2]);
  const dUp = (Math.atan(he / Math.max(Math.hypot(r[0], r[2]), 1e-3)) - Math.atan(he / Math.max(D, 1e-3))) / pixelAngle;
  const sUp = Math.min(0.5 * sigA, Math.max(dUp, 0.5) / 3), sDn = 2.2 * sigA;
  const amp = (E * gain) / (pixelAngle * pixelAngle * Math.PI * sigU * (sUp + sDn));
  const reach = Math.min(Math.sqrt(2 * Math.max(Math.log(amp * 1024), 0)), 4.5);
  const extent = { across: reach * sigU, up: reach * sUp, down: reach * sDn };
  const edge = Math.exp(-0.5 * reach * reach);
  return {
    E, fresnel, dm, cosi, r, sigU, sUp, sDn, amp, reach, extent,
    profile(u, v) {
      if (Math.abs(u) > extent.across || v > extent.up || v < -extent.down) return 0;
      const sv = v > 0 ? sUp : sDn;
      const gu = Math.max(Math.exp(-0.5 * (u / sigU) ** 2) - edge, 0), gv = Math.max(Math.exp(-0.5 * (v / sv) ** 2) - edge, 0);
      return (amp / (1 - edge)) * (gu * gv) / (1 - edge);
    },
  };
}
