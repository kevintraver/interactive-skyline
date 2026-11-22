// Photometry and colour. Pure: no three.js. Luminance in cd/m2, illuminance in lux, colours in linear sRGB.

/** Exposure value at ISO 100 for a scene of average luminance L (cd/m2), reflected-light meter constant K = 12.5. */
export const ev100FromLuminance = (cdM2) => Math.log2((cdM2 * 100) / 12.5);
export const luminanceFromEv100 = (ev) => (2 ** ev * 12.5) / 100;
/** Exposure value at ISO 100 for incident illuminance E (lux), incident-light meter constant C = 250. */
export const ev100FromIlluminance = (lux) => Math.log2((lux * 100) / 250);

/** Illuminance from a point source of visual magnitude m (lux). m = 0 gives 2.54e-6 lux (Allen's value). */
export const luxFromMagnitude = (m) => 2.54e-6 * 10 ** (-0.4 * m);
export const magnitudeFromLux = (lux) => -2.5 * Math.log10(lux / 2.54e-6);

/** Surface brightness in mag/arcsec2 to luminance in cd/m2: L = 10.8e4 x 10^(-0.4 m). */
export const cdM2FromMagArcsec2 = (m) => 10.8e4 * 10 ** (-0.4 * m);
export const magArcsec2FromCdM2 = (cdM2) => -2.5 * Math.log10(cdM2 / 10.8e4);

// CIE 1931 2-degree colour-matching functions, as the multi-lobe Gaussian fit of Wyman, Sloan and Shirley
// (JCGT 2013), within about 1 % of the tabulated functions. Wavelengths in nm.
const lobe = (x, mu, s1, s2) => { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
export function cie1931(nm) {
  return [
    1.056 * lobe(nm, 599.8, 37.9, 31.0) + 0.362 * lobe(nm, 442.0, 16.0, 26.7) - 0.065 * lobe(nm, 501.1, 20.4, 26.2),
    0.821 * lobe(nm, 568.8, 46.9, 40.5) + 0.286 * lobe(nm, 530.9, 16.3, 31.1),
    1.217 * lobe(nm, 437.0, 11.8, 36.0) + 0.681 * lobe(nm, 459.0, 26.0, 13.8),
  ];
}

/** CIE XYZ to linear sRGB (D65). */
export function xyzToLinearSrgb([X, Y, Z]) {
  return [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
}

/** XYZ of a spectral power distribution `spd(nm)`, integrated 380-780 nm in 1 nm steps, scaled to Y = 1. */
export function spectrumToXyz(spd) {
  let X = 0, Y = 0, Z = 0;
  for (let nm = 380; nm <= 780; nm++) {
    const p = spd(nm), [x, y, z] = cie1931(nm);
    X += p * x; Y += p * y; Z += p * z;
  }
  return [X / Y, 1, Z / Y];
}

/** Linear sRGB of a spectrum, with luminance (Y) 1. Components may fall outside 0..1 for saturated spectra. */
export const spectrumToLinearSrgb = (spd) => xyzToLinearSrgb(spectrumToXyz(spd));

/** Planck's law: spectral radiance of a black body at `kelvin`, at wavelength `nm` (relative units). */
export function planck(nm, kelvin) {
  const h = 6.62607015e-34, c = 2.99792458e8, k = 1.380649e-23, l = nm * 1e-9;
  return (2 * h * c * c) / (l ** 5 * (Math.exp((h * c) / (l * k * kelvin)) - 1));
}

/** Linear sRGB of a black body at `kelvin`, with luminance 1. */
export const colorTemperatureToLinearSrgb = (kelvin) => spectrumToLinearSrgb((nm) => planck(nm, kelvin));
