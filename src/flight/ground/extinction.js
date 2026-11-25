// The air between the eye and the lit ground (plan 03, section 7.11): how far a lamp's light carries before the air
// takes it, seen from any height. Pure: no three.js.
//
// The weather gives the visibility at the ground (Koschmieder: extinction sigma = 3.912 / V there). Seen from the
// ground, a lamp d away keeps exp(-sigma d). Seen from the air, the path climbs out of the haze: molecules thin with
// an 8 km scale height and dust and haze with about 1.5 km above the ground, so a lamp 60 km away seen from cruise
// loses far less than one 60 km away along the ground. For a straight path from the eye down to the ground the
// optical depth is exactly linear in the distance, tau = d / L, with
//   L = (eye height - ground height) / (integral of sigma from the ground up to the eye),
// so one length per frame serves every lamp (they all stand within a few hundred metres of the same ground height).
// A path that runs along the ground (eye on the ground) gives L = 1 / sigma(ground), the Koschmieder case.
// The sprite layer (src/drive/lights/sprites.js) takes exactly this: T = exp(-d / uVisibility).

/** Koschmieder's constant: the contrast threshold 2 % (ln 50). */
export const KOSCHMIEDER = 3.912;
/** Molecular (Rayleigh) extinction at sea level, 550 nm, per metre, and its scale height (m). */
export const RAYLEIGH_SEA = 1.16e-5;
export const RAYLEIGH_H = 8000;
/** Scale height of the haze above the ground (m). ASSUMED: a desert boundary layer's aerosol, 1 to 2 km. */
export const AEROSOL_H = 1500;

const rayleighAt = (h) => RAYLEIGH_SEA * Math.exp(-h / RAYLEIGH_H);

/**
 * Extinction length (m) for lamps on the ground seen from the eye: T = exp(-d / L).
 * @param {{ eyeAltM: number, groundAltM: number, visibilityM?: number }} o heights above sea level; visibility at the
 *   ground (m)
 */
export function extinctionLength({ eyeAltM, groundAltM, visibilityM = 80000 }) {
  const V = Math.max(50, Number.isFinite(visibilityM) ? visibilityM : 80000);
  const sigmaGround = KOSCHMIEDER / V;
  const ray0 = rayleighAt(groundAltM);
  const aer0 = Math.max(0, sigmaGround - ray0);
  const dh = Math.max(0, eyeAltM - groundAltM);
  if (dh < 1) return 1 / Math.max(sigmaGround, 1e-9);
  // the integral of sigma from the ground to the eye, both terms exponential in height
  const ray = RAYLEIGH_SEA * RAYLEIGH_H * (Math.exp(-groundAltM / RAYLEIGH_H) - Math.exp(-eyeAltM / RAYLEIGH_H));
  const aer = aer0 * AEROSOL_H * (1 - Math.exp(-dh / AEROSOL_H));
  return dh / Math.max(ray + aer, 1e-12);
}

/** The visibility (m) whose Koschmieder extinction is 1 / L: for code that takes a visibility (the airport's lights). */
export const visibilityForLength = (L) => KOSCHMIEDER * L;
