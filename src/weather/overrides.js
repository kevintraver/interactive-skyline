// Overrides (plan 01, sections 4.2 and 6.4; task T5.1): a sparse layer on top of the data, one value per slider,
// never written into the data. `applyOverrides` returns a new sample (or the same one when there are none), so
// clearing an override gives back the data value exactly.
import { dewPointFrom } from './schema.js';
import { visibilityFromAerosol } from './derive.js';

/** The ten sliders of section 4.2, in their order: key, label, range, step and display unit kind. */
export const OVERRIDES = [
  { key: 'lowCloud', label: 'Low cloud', min: 0, max: 1, step: 0.05, unit: 'fraction' },
  { key: 'highCloud', label: 'High cloud', min: 0, max: 1, step: 0.05, unit: 'fraction' },
  { key: 'cloudBase', label: 'Cloud base', min: 150, max: 4500, step: 50, unit: 'height' },
  { key: 'haze', label: 'Haze', min: 0, max: 1.5, step: 0.01, unit: 'aod' },
  { key: 'dust', label: 'Dust', min: 0, max: 5000, step: 10, unit: 'dust' },
  { key: 'humidity', label: 'Humidity', min: 0.02, max: 1, step: 0.01, unit: 'fraction' },
  { key: 'windSpeed', label: 'Wind speed', min: 0, max: 30, step: 0.5, unit: 'speed' },
  { key: 'windDir', label: 'Wind direction', min: 0, max: 359, step: 1, unit: 'direction' },
  { key: 'rain', label: 'Rain', min: 0, max: 50, step: 0.5, unit: 'rate' },
  { key: 'lightning', label: 'Lightning', min: 0, max: 30, step: 1, unit: 'flashes' },
];

/** Above this height over the ground a layer is not "low" cloud (the top of the observed layers, section 6.4). */
const LOW_TOP_AGL = 3700;
const HIGH_GENERA = new Set(['ci', 'cs']);

/** The data value a slider shows while it follows data. */
export function dataValue(sample, key, groundM) {
  const low = sample.clouds.filter((c) => c.baseM - groundM < LOW_TOP_AGL);
  switch (key) {
    case 'lowCloud': return low.reduce((m, c) => Math.max(m, c.cover), 0);
    case 'highCloud': return sample.clouds.filter((c) => HIGH_GENERA.has(c.genus)).reduce((m, c) => Math.max(m, c.cover), 0);
    case 'cloudBase': return low.length ? low[0].baseM - groundM : null;
    case 'haze': return sample.aerosol.aod550;
    case 'dust': return sample.aerosol.dustUgM3;
    case 'humidity': return sample.rh;
    case 'windSpeed': return sample.wind.speedMs;
    case 'windDir': return sample.wind.dirDeg;
    case 'rain': return sample.precip.kind === 'virga' ? 0 : sample.precip.rateMmH;
    case 'lightning': return sample.storm.flashRatePerMin;
    default: return null;
  }
}

/**
 * The sample with `overrides` ({ key: value }, keys of OVERRIDES) applied. Pure: `sample` is not changed.
 * @param {object} sample  a WeatherSample
 * @param {Record<string, number>} overrides
 * @param {{ groundM: number }} o  the ground's height above sea level
 */
export function applyOverrides(sample, overrides, { groundM }) {
  const keys = Object.keys(overrides).filter((k) => typeof overrides[k] === 'number' && Number.isFinite(overrides[k]));
  if (!keys.length) return sample;
  const s = structuredClone(sample);
  const has = (k) => keys.includes(k);
  const v = (k) => overrides[k];
  const isLow = (c) => c.baseM - groundM < LOW_TOP_AGL && !HIGH_GENERA.has(c.genus);

  if (has('lowCloud')) {
    const cover = v('lowCloud');
    const low = s.clouds.filter(isLow);
    if (cover <= 0) s.clouds = s.clouds.filter((c) => !isLow(c));
    else if (low.length) for (const c of low) c.cover = cover;
    else {
      const base = groundM + (has('cloudBase') ? v('cloudBase') : 1800);
      s.clouds.push({ genus: cover > 0.6 ? 'sc' : 'cu', baseM: base, topM: base + (cover > 0.6 ? 700 : 1000), cover });
    }
  }
  if (has('cloudBase')) {
    const low = s.clouds.filter(isLow).sort((a, b) => a.baseM - b.baseM);
    if (low.length) {
      const shift = groundM + v('cloudBase') - low[0].baseM;
      for (const c of low) { c.baseM += shift; c.topM += shift; }
    }
  }
  if (has('highCloud')) {
    const cover = v('highCloud');
    const high = s.clouds.filter((c) => HIGH_GENERA.has(c.genus));
    if (cover <= 0) s.clouds = s.clouds.filter((c) => !HIGH_GENERA.has(c.genus));
    else if (high.length) for (const c of high) c.cover = cover;
    else {
      const base = Math.max(groundM + 6500, 9000);
      s.clouds.push({ genus: cover >= 0.75 ? 'cs' : 'ci', baseM: base, topM: base + 1200, cover });
    }
  }
  s.clouds.sort((a, b) => a.baseM - b.baseM);
  if (s.clouds.length > 4) s.clouds = [...s.clouds].sort((a, b) => b.cover - a.cover).slice(0, 4).sort((a, b) => a.baseM - b.baseM);

  if (has('haze')) s.aerosol.aod550 = v('haze');
  if (has('dust')) s.aerosol.dustUgM3 = v('dust');
  if (has('haze') || has('dust')) {
    s.visibilityM = visibilityFromAerosol(s.aerosol, groundM);
    s.visibilityCensored = false;
  }
  if (has('humidity')) {
    s.rh = v('humidity');
    s.dewPointC = Math.min(s.tempC, dewPointFrom(s.tempC, s.rh));
  }
  if (has('windSpeed')) {
    const ratio = s.wind.speedMs > 0 ? s.wind.gustMs / s.wind.speedMs : 1.5;
    s.wind.speedMs = v('windSpeed');
    s.wind.gustMs = Math.max(v('windSpeed'), v('windSpeed') * Math.max(1, ratio));
  }
  if (has('windDir')) s.wind.dirDeg = ((v('windDir') % 360) + 360) % 360;
  if (has('rain')) {
    s.precip.rateMmH = v('rain');
    if (v('rain') > 0) { s.precip.kind = s.tempC < 1 ? 'snow' : 'rain'; s.precip.virgaBaseM = null; }
    else if (s.precip.kind !== 'virga') s.precip.kind = 'none';
  }
  if (has('lightning')) {
    s.storm.flashRatePerMin = v('lightning');
    s.storm.thunder = v('lightning') > 0;
    s.storm.cells = s.storm.thunder ? Math.max(1, s.storm.cells) : 0;
  }
  return s;
}
