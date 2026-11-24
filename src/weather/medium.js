// The atmosphere's medium from weather (plan 01, section 7.5; task T5.4): aerosol optical depth, mixing-layer height
// and visibility to extinction, phase asymmetry and albedo. Small and dependency-free, so the environment facade can
// import it without the rest of src/weather (derive.js re-exports all of it). Every constant is named and tested.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, f) => a + (b - a) * f;

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

// ------------------------------------------------------------------ medium (section 7.5)

/** Phase asymmetry: 0.70 for dust, 0.76 for dry haze, 0.82 when the air is humid (above 80 %). */
export const G_DUST = 0.70, G_HAZE = 0.76, G_HUMID = 0.82;
/** Single-scattering albedo at 550 nm, and at 440 nm when dust dominates (the brown-yellow cast of a dusty sky). */
export const SSA = 0.93, SSA_440_DUST = 0.88;
/** Ångström exponent from fine urban haze (1.4) down to dust (0.2). */
export const ANGSTROM_FINE = 1.4, ANGSTROM_DUST = 0.2;

/** The dust share of the aerosol, 0..1, as the Ångström exponent encodes it. */
export const dustShareOf = (angstrom) => clamp((ANGSTROM_FINE - angstrom) / (ANGSTROM_FINE - ANGSTROM_DUST), 0, 1);
/** The Ångström exponent for a dust share. */
export const angstromFor = (dustShare) => ANGSTROM_FINE - (ANGSTROM_FINE - ANGSTROM_DUST) * clamp(dustShare, 0, 1);

/**
 * The atmosphere's medium from a weather sample (section 7.5): what phase 3's atmosphere takes as uniforms.
 * The aerosol layer holds the optical depth over the mixing-layer height. Where the sample's visibility differs from
 * what that layer gives (it came from an observation: below 10 miles, fog, rain, or an uncensored older report such
 * as 1975's 35SM), extinction at the ground is set to match it and the layer's depth changed so the optical depth is
 * kept (section 7.5 raises it only; matching both ways keeps an uncensored report honest too).
 */
export function atmosphereMedium(sample, { elevationM }) {
  const { aod550, angstrom, layerHeightM } = sample.aerosol;
  const rayleigh = rayleighExtinction(elevationM);
  let beta = aerosolExtinction(sample.aerosol), height = layerHeightM;
  const wanted = Math.max(0, KOSCHMIEDER / sample.visibilityM - rayleigh);
  if (Math.abs(wanted - beta) > beta * 0.001 + 1e-9) {
    beta = wanted;
    height = beta > 0 ? clamp(Math.max(0, aod550 - FREE_TROPOSPHERE_AOD) / beta, 50, 8000) : layerHeightM;
  }
  const dustShare = dustShareOf(angstrom);
  const dryG = lerp(G_HAZE, G_DUST, dustShare);
  return {
    rayleighExtinctionPerM: rayleigh,
    aerosolExtinctionPerM: beta,
    aerosolScaleHeightM: height,
    aerosolOpticalDepth: aod550,
    angstrom,
    asymmetryG: lerp(dryG, G_HUMID, clamp((sample.rh - 0.6) / 0.2, 0, 1)),
    singleScatteringAlbedo: SSA,
    singleScatteringAlbedo440: dustShare > 0.5 ? SSA_440_DUST : SSA,
    dustShare,
    visibilityM: KOSCHMIEDER / (beta + rayleigh),
  };
}

/** Uniform name -> medium field: the names phase 3's atmosphere (section 7.4) is expected to use. */
export const ATMOSPHERE_UNIFORMS = {
  rayleighExtinction: 'rayleighExtinctionPerM', aerosolExtinction: 'aerosolExtinctionPerM', aerosolScaleHeight: 'aerosolScaleHeightM',
  aerosolAngstrom: 'angstrom', miePhaseG: 'asymmetryG', aerosolAlbedo: 'singleScatteringAlbedo', aerosolAlbedo440: 'singleScatteringAlbedo440',
};

/**
 * Phase 3 calls this each time env.state.medium changes: it writes the medium into the atmosphere's uniforms
 * (objects with a `value`, as three's uniforms are). Uniforms it does not have are skipped. Returns the names written.
 */
export function setAtmosphereFromWeather(uniforms, medium) {
  const written = [];
  for (const [name, field] of Object.entries(ATMOSPHERE_UNIFORMS)) {
    if (uniforms && uniforms[name] && typeof uniforms[name] === 'object' && 'value' in uniforms[name]) {
      uniforms[name].value = medium[field];
      written.push(name);
    }
  }
  return written;
}

