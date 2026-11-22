// From weather to medium (plan 01, sections 6.4 and 7.5; tasks T5.1 and T5.4). Pure functions: aerosol optical
// depth, mixing-layer height and visibility to extinction; observations and model hours fused into a WeatherSample
// at an instant. Every constant is named and tested.

/** Koschmieder: visual range = 3.912 / extinction (a 2 % contrast threshold). */
export const KOSCHMIEDER = 3.912;
/** Rayleigh extinction at 550 nm at sea level, per metre (Bucholtz 1995, US standard atmosphere). */
export const RAYLEIGH_550_SEA_PER_M = 1.16e-5;
/** Scale height of the molecular atmosphere, metres. */
export const RAYLEIGH_SCALE_M = 8434;
/** Optical depth of the free troposphere above the mixing layer (section 7.5), spread over an 8 km scale height. */
export const FREE_TROPOSPHERE_AOD = 0.02;
/** Mass extinction efficiency of mineral dust at 550 nm, m^2/g (coarse dust is 0.3 to 1). */
export const DUST_MEE_M2_PER_G = 0.6;
/** Mixing-layer height limits for the aerosol layer (section 6.4). */
export const LAYER_MIN_M = 300, LAYER_MAX_M = 4500;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, f) => a + (b - a) * f;

/** Molecular extinction at 550 nm at an elevation, per metre. */
export const rayleighExtinction = (elevationM) => RAYLEIGH_550_SEA_PER_M * Math.exp(-elevationM / RAYLEIGH_SCALE_M);

/**
 * Aerosol extinction at the ground, 550 nm, per metre: beta0 = (tau - 0.02) / H (section 7.5), and never less than
 * what the near-surface dust alone gives (blowing dust is a surface layer the column total underweights).
 */
export function aerosolExtinction({ aod550, layerHeightM, dustUgM3 = 0 }) {
  const fromColumn = Math.max(0, aod550 - FREE_TROPOSPHERE_AOD) / Math.max(layerHeightM, 1);
  const fromDust = DUST_MEE_M2_PER_G * dustUgM3 * 1e-6;
  return Math.max(fromColumn, fromDust);
}

/** Meteorological visual range from aerosols and air alone (Koschmieder), metres. */
export const visibilityFromAerosol = (aerosol, elevationM) =>
  KOSCHMIEDER / (aerosolExtinction(aerosol) + rayleighExtinction(elevationM));
