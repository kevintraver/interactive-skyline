// The optics of a cabin window (plan 03, section 7.7; F5.2): three acrylic sheets, each with two faces that reflect
// by Fresnel's law for n = 1.49 [R5], so the stack passes roughly four fifths of the light and returns the rest as
// faint, offset reflections that rise steeply toward grazing. Scratches throw light across themselves; the glare of a
// bright source falls off as the inverse square of the angle from it (the Stiles-Holladay form, as the drive's
// windshield veil, src/drive/vehicle/veil.js). Each function has a CPU twin (tested) and a TSL twin (the shader).

import { Fn, float, vec3, sqrt, max, min, clamp, acos, select, dot, pow, mix } from 'three/tsl';
import { VEIL } from '../../drive/vehicle/veil.js';

/** Refractive index of cast and stretched acrylic (PMMA) in the visible [R5]. */
export const ACRYLIC_N = 1.49;

/** Unpolarised Fresnel reflectance of one acrylic face for the cosine of the angle of incidence (from air). */
export function fresnel(cosI, n = ACRYLIC_N) {
  const ci = Math.min(1, Math.max(1e-6, cosI));
  const si = Math.sqrt(Math.max(0, 1 - ci * ci)) / n;
  if (cosI <= 0) return 1;
  const ct = Math.sqrt(Math.max(0, 1 - si * si));
  const rs = (ci - n * ct) / (ci + n * ct);
  const rp = (n * ci - ct) / (n * ci + ct);
  return 0.5 * (rs * rs + rp * rp);
}

/**
 * The stack for a view ray at cosI to the pane's normal: T, what the three sheets pass; Rinner, what the inner sheet
 * returns toward the eye (its two faces, incoherently, (2R / (1 + R))); Router, what the middle and outer sheets return
 * through the inner one (seen offset by the gaps: the second reflection). Each sheet passes (1 - R) / (1 + R).
 * Absorption is left to the tint (paneTint).
 */
export function stackOptics(cosI, n = ACRYLIC_N) {
  const R = fresnel(cosI, n);
  const sheetR = (2 * R) / (1 + R), sheetT = (1 - R) / (1 + R);
  const t2 = sheetT * sheetT;
  return { T: sheetT * t2, Rinner: sheetR, Router: t2 * sheetR * (1 + t2) };
}

/** A slight tint of the stack (linear RGB), ESTIMATED: aged stretched acrylic and the outer pane's coating read faintly
 * green-grey in photographs; under 3 % on any channel. */
export const PANE_TINT = Object.freeze([0.975, 0.99, 0.98]);

/**
 * How brightly a scratch glints for a source in a given direction across the pane. `dir2`: the scratches' direction
 * as a doubled angle (cos 2a, sin 2a), averaged over the patch (length = their coherence; pass `coherence` with it);
 * `radial`: the unit direction on the pane from this point toward the source. A scratch scatters light in the plane
 * at right angles to it, so it lights when it lies across the radial line (tangent to circles round the source):
 * ((1 - cos 2(a - b)) / 2)^GLINT_POWER, averaged with the mean over all directions as coherence falls.
 */
export const GLINT_POWER = 4;
const GLINT_MEAN = 35 / 128; // the mean of sin^8 over a turn
export function scratchGlint(dir2, radial, coherence) {
  const r2x = radial[0] * radial[0] - radial[1] * radial[1], r2y = 2 * radial[0] * radial[1];
  const len = Math.hypot(dir2[0], dir2[1]);
  const c = len > 1e-9 ? (dir2[0] * r2x + dir2[1] * r2y) / len : 0;
  const t = Math.pow(Math.max(0, 0.5 - 0.5 * c), GLINT_POWER);
  const k = Math.min(1, Math.max(0, coherence));
  return k * t + (1 - k) * GLINT_MEAN;
}

/** The glare phase cos(theta) / (theta_deg^2 + theta_c^2), deg^-2; 0 behind. The drive's THETA_C (0.5 degrees). */
export function glarePhase(cosT, thetaC = VEIL.THETA_C) {
  if (!(cosT > 0)) return 0;
  const th = (Math.acos(Math.min(1, cosT)) * 180) / Math.PI;
  return cosT / (th * th + thetaC * thetaC);
}

/** The glare constant: cd/m^2 per lux per deg^-2 for a pane wholly covered (the drive's windshield K, assumed). */
export const GLARE_K = VEIL.K;

// ------------------------------------------------------------------------------------------------ TSL twins

const DEG = 180 / Math.PI;

/** fresnel() in TSL. */
export const fresnelNode = Fn(([cosI]) => {
  const n = float(ACRYLIC_N);
  const ci = clamp(cosI, 1e-4, 1);
  const si = sqrt(max(0, float(1).sub(ci.mul(ci)))).div(n);
  const ct = sqrt(max(0, float(1).sub(si.mul(si))));
  const rs = ci.sub(n.mul(ct)).div(ci.add(n.mul(ct)));
  const rp = n.mul(ci).sub(ct).div(n.mul(ci).add(ct));
  return rs.mul(rs).add(rp.mul(rp)).mul(0.5);
});

/** stackOptics() in TSL: vec3(T, Rinner, Router). */
export const stackNode = Fn(([cosI]) => {
  const R = fresnelNode(cosI);
  const sheetR = R.mul(2).div(R.add(1)), sheetT = float(1).sub(R).div(R.add(1));
  const t2 = sheetT.mul(sheetT);
  return vec3(sheetT.mul(t2), sheetR, t2.mul(sheetR).mul(t2.add(1)));
});

/** glarePhase() in TSL, with the core angle thetaC (degrees) as a parameter. */
export const glarePhaseNode = Fn(([c, thetaC]) => {
  const th = acos(min(c, 1)).mul(DEG);
  return select(c.greaterThan(0), c.div(th.mul(th).add(thetaC.mul(thetaC))), float(0));
});

/** scratchGlint() in TSL: dir2 the raw averaged doubled-angle vector, radial a unit vec2. */
export const scratchGlintNode = Fn(([dir2, radial, coherence]) => {
  const r2 = radial.x.mul(radial.x).sub(radial.y.mul(radial.y)).toVar();
  const r2y = radial.x.mul(radial.y).mul(2);
  const len = max(sqrt(dot(dir2, dir2)), 1e-5);
  const c = dir2.x.mul(r2).add(dir2.y.mul(r2y)).div(len);
  const t = pow(max(0, float(0.5).sub(c.mul(0.5))), GLINT_POWER);
  return mix(float(GLINT_MEAN), t, clamp(coherence, 0, 1));
});
