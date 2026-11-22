// The normalized weather state (plan 01, section 6.4; task T5.1): one instant after fusion and overrides. SI units,
// UTC milliseconds, heights in metres above mean sea level unless suffixed Agl. A hand-written validator, no
// dependency: it returns the problems it finds, an empty list for a valid sample.
//
// interface WeatherSample {
//   t; source: { surface: 'metar'|'model'|'preset', clouds: same, aerosol: 'cams'|'climatology'|'preset' };
//   tempC; dewPointC; rh (0..1); pressureHPa (at the ground, not reduced to sea level);
//   wind: { dirDeg (where it comes from), speedMs, gustMs };  windAloft: { level, dirDeg, speedMs }[];
//   visibilityM; visibilityCensored (the report said 10 miles or more);
//   aerosol: { aod550, angstrom, dustUgM3, pm25UgM3, layerHeightM };
//   clouds: { genus, baseM, topM, cover }[]  (at most four, lowest first);
//   precip: { rateMmH, kind, convective, virgaBaseM|null };  storm: { thunder, flashRatePerMin, cells, capeJKg|null };
//   dustWall: { active, bearingDeg, distanceM, speedMs, heightM } | null;  wxCodes: string[];
// }

export const SURFACE_SOURCES = ['metar', 'model', 'preset'];
export const AEROSOL_SOURCES = ['cams', 'climatology', 'preset'];
export const GENERA = ['cu', 'tcu', 'cb', 'sc', 'st', 'ac', 'as', 'ci', 'cs'];
/** Section 6.4's kinds, plus snow: Salt Lake City has it, Las Vegas now and then. */
export const PRECIP_KINDS = ['none', 'drizzle', 'rain', 'snow', 'virga', 'hail'];
export const ALOFT_LEVELS = [850, 700, 500, 300];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * The problems with `s` as a WeatherSample (section 6.4): missing fields, wrong types, values out of range.
 * @returns {string[]} empty when valid
 */
export function validateSample(s) {
  const out = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['not an object'];
  const num = (v, path, lo, hi) => {
    if (!isNum(v)) out.push(`${path}: not a finite number (${String(v)})`);
    else if (v < lo || v > hi) out.push(`${path}: ${v} outside ${lo}..${hi}`);
  };
  const below = (v, path, lo, hi) => { // [lo, hi)
    if (!isNum(v)) out.push(`${path}: not a finite number (${String(v)})`);
    else if (v < lo || v >= hi) out.push(`${path}: ${v} outside [${lo}, ${hi})`);
  };
  const bool = (v, path) => { if (typeof v !== 'boolean') out.push(`${path}: not a boolean`); };
  const oneOf = (v, path, list) => { if (!list.includes(v)) out.push(`${path}: ${String(v)} is not one of ${list.join(', ')}`); };
  const obj = (v, path) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { out.push(`${path}: missing`); return false; }
    return true;
  };

  num(s.t, 't', -1e14, 1e14);
  if (obj(s.source, 'source')) {
    oneOf(s.source.surface, 'source.surface', SURFACE_SOURCES);
    oneOf(s.source.clouds, 'source.clouds', SURFACE_SOURCES);
    oneOf(s.source.aerosol, 'source.aerosol', AEROSOL_SOURCES);
  }
  num(s.tempC, 'tempC', -70, 60);
  num(s.dewPointC, 'dewPointC', -90, 40);
  if (isNum(s.tempC) && isNum(s.dewPointC) && s.dewPointC > s.tempC + 0.5) out.push(`dewPointC: ${s.dewPointC} above tempC ${s.tempC}`);
  num(s.rh, 'rh', 0, 1);
  num(s.pressureHPa, 'pressureHPa', 500, 1100);
  if (obj(s.wind, 'wind')) {
    below(s.wind.dirDeg, 'wind.dirDeg', 0, 360);
    num(s.wind.speedMs, 'wind.speedMs', 0, 80);
    num(s.wind.gustMs, 'wind.gustMs', 0, 110);
  }
  if (!Array.isArray(s.windAloft)) out.push('windAloft: not an array');
  else s.windAloft.forEach((w, i) => {
    if (!obj(w, `windAloft[${i}]`)) return;
    oneOf(w.level, `windAloft[${i}].level`, ALOFT_LEVELS);
    below(w.dirDeg, `windAloft[${i}].dirDeg`, 0, 360);
    num(w.speedMs, `windAloft[${i}].speedMs`, 0, 150);
  });
  num(s.visibilityM, 'visibilityM', 1, 400000);
  bool(s.visibilityCensored, 'visibilityCensored');
  if (obj(s.aerosol, 'aerosol')) {
    num(s.aerosol.aod550, 'aerosol.aod550', 0, 6);
    num(s.aerosol.angstrom, 'aerosol.angstrom', -0.5, 3);
    num(s.aerosol.dustUgM3, 'aerosol.dustUgM3', 0, 30000);
    num(s.aerosol.pm25UgM3, 'aerosol.pm25UgM3', 0, 3000);
    num(s.aerosol.layerHeightM, 'aerosol.layerHeightM', 100, 6000);
  }
  if (!Array.isArray(s.clouds)) out.push('clouds: not an array');
  else {
    if (s.clouds.length > 4) out.push(`clouds: ${s.clouds.length} layers, at most four`);
    s.clouds.forEach((c, i) => {
      if (!obj(c, `clouds[${i}]`)) return;
      oneOf(c.genus, `clouds[${i}].genus`, GENERA);
      num(c.baseM, `clouds[${i}].baseM`, -500, 20000);
      num(c.topM, `clouds[${i}].topM`, -500, 22000);
      if (isNum(c.baseM) && isNum(c.topM) && c.topM <= c.baseM) out.push(`clouds[${i}].topM: ${c.topM} not above baseM ${c.baseM}`);
      num(c.cover, `clouds[${i}].cover`, 0, 1);
      if (i && isNum(c.baseM) && isNum(s.clouds[i - 1]?.baseM) && c.baseM < s.clouds[i - 1].baseM) out.push('clouds: not lowest first');
    });
  }
  if (obj(s.precip, 'precip')) {
    num(s.precip.rateMmH, 'precip.rateMmH', 0, 300);
    oneOf(s.precip.kind, 'precip.kind', PRECIP_KINDS);
    bool(s.precip.convective, 'precip.convective');
    if (s.precip.virgaBaseM !== null) num(s.precip.virgaBaseM, 'precip.virgaBaseM', -500, 20000);
  }
  if (obj(s.storm, 'storm')) {
    bool(s.storm.thunder, 'storm.thunder');
    num(s.storm.flashRatePerMin, 'storm.flashRatePerMin', 0, 120);
    num(s.storm.cells, 'storm.cells', 0, 50);
    if (isNum(s.storm.cells) && !Number.isInteger(s.storm.cells)) out.push('storm.cells: not an integer');
    if (s.storm.capeJKg !== null) num(s.storm.capeJKg, 'storm.capeJKg', 0, 10000);
  }
  if (s.dustWall !== null) {
    if (obj(s.dustWall, 'dustWall')) {
      bool(s.dustWall.active, 'dustWall.active');
      below(s.dustWall.bearingDeg, 'dustWall.bearingDeg', 0, 360);
      num(s.dustWall.distanceM, 'dustWall.distanceM', 0, 500000);
      num(s.dustWall.speedMs, 'dustWall.speedMs', 0, 80);
      num(s.dustWall.heightM, 'dustWall.heightM', 0, 6000);
    }
  }
  if (!Array.isArray(s.wxCodes) || s.wxCodes.some((c) => typeof c !== 'string')) out.push('wxCodes: not an array of strings');
  return out;
}

/** Relative humidity (0..1) from temperature and dew point (Magnus, over water). */
export function rhFrom(tempC, dewPointC) {
  const e = (c) => Math.exp((17.625 * c) / (243.04 + c));
  return Math.min(1, Math.max(0, e(dewPointC) / e(tempC)));
}
/** Dew point from temperature and relative humidity (the inverse of rhFrom). */
export function dewPointFrom(tempC, rh) {
  const g = Math.log(Math.max(rh, 1e-4)) + (17.625 * tempC) / (243.04 + tempC);
  return (243.04 * g) / (17.625 - g);
}
