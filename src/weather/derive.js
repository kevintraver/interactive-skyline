// From weather to medium (plan 01, sections 6.4 and 7.5; tasks T5.1 and T5.4). Pure functions: aerosol optical
// depth, mixing-layer height and visibility to extinction; observations and model hours fused into a WeatherSample
// at an instant. Every constant is named and tested.
import { lerpAngle } from './interpolate.js';
import { rhFrom } from './schema.js';
import { remarkCodes, TEN_MILES_M } from './normalize.js';

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

// ------------------------------------------------------------------ fusion (section 6.4)


const H = 3600000, MIN = 60000;
/** An observation within this of the sample time is used (section 6.4); 100 minutes where reports are three-hourly. */
export const OBS_WINDOW_MS = 40 * MIN, OBS_WINDOW_SPARSE_MS = 100 * MIN;
/** Layer cover by METAR amount (section 6.4). */
export const COVER = { FEW: 0.19, SCT: 0.44, BKN: 0.75, OVC: 1, VV: 1 };
/** Layers up to this height above the ground are what a station observes (section 6.4). */
export const OBSERVED_TOP_AGL = 3700;
/** Thunderstorm base at the airport when none is reported: the median of thunderstorm reports (section 6.1). */
export const TS_BASE_AGL = 2600;
/** Lifting condensation level: about 125 m per degree of dew-point depression. */
export const LCL_M_PER_C = 125;
/** Standard heights of the pressure levels, metres above sea level (ICAO standard atmosphere). */
export const LEVEL_HEIGHT = { 850: 1457, 700: 3012, 500: 5574, 300: 9164 };

/** A model series (sorted ModelHours) at time t: linear, shortest arc for directions; null beyond 90 minutes of it. */
export function modelAt(hours, t) {
  if (!hours || !hours.length) return null;
  if (t < hours[0].t - 1.5 * H || t > hours[hours.length - 1].t + 1.5 * H) return null;
  let i = 0;
  while (i < hours.length - 1 && hours[i + 1].t <= t) i++;
  const a = hours[i], b = hours[Math.min(i + 1, hours.length - 1)];
  const f = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
  const out = { t };
  for (const k of Object.keys(a)) {
    if (k === 't' || k === 'aloft') continue;
    const x = a[k], y = b[k];
    out[k] = x === null ? (f > 0 ? y : null) : y === null ? x : k === 'windDirDeg' ? lerpAngle(x, y, f) : lerp(x, y, f);
  }
  out.aloft = a.aloft.map((w) => {
    const v = b.aloft.find((u) => u.level === w.level);
    return v ? { level: w.level, speedMs: lerp(w.speedMs, v.speedMs, f), dirDeg: lerpAngle(w.dirDeg, v.dirDeg, f) } : { ...w };
  });
  return out;
}

/** Aerosol hours at time t (linear), or null beyond 90 minutes of the data. */
export function aerosolAt(hours, t) {
  const m = modelAt(hours && hours.map((h) => ({ ...h, aloft: [] })), t);
  return m && m.aod550 !== null ? m : null;
}

/** The climatology's month for time t (UTC month), or a desert default when there is none. */
export function climatologyAt(clim, t) {
  const m = clim && Array.isArray(clim.months) ? clim.months[new Date(t).getUTCMonth()] : null;
  return m ? { aod550: m.aod550Median, dustUgM3: m.dustUgM3, pm10UgM3: m.pm10UgM3, pm25UgM3: m.pm25UgM3 }
    : { aod550: 0.07, dustUgM3: 3, pm10UgM3: 12, pm25UgM3: 5 };
}

/** The reports around t: the nearest within the window, and the two that bracket t (each within the window). */
function reportsAround(obs, t) {
  if (!obs || !obs.length) return null;
  let i = obs.findIndex((o) => o.t > t);
  if (i === -1) i = obs.length;
  const before = obs[i - 1] || null, after = obs[i] || null;
  const gap = before && after ? after.t - before.t : Infinity;
  const window = gap > 150 * MIN && gap < 7 * H ? OBS_WINDOW_SPARSE_MS : OBS_WINDOW_MS;
  const near = (o) => o && Math.abs(o.t - t) <= window;
  const b = near(before) ? before : null, a = near(after) ? after : null;
  const nearest = b && a ? (t - b.t <= a.t - t ? b : a) : b || a;
  if (!nearest) return null;
  // the previous report with a direction, for a variable or calm wind (section 6.4: VRB keeps the previous direction)
  let prevDir = null;
  for (let j = i - 1; j >= 0 && j > i - 12; j--) if (obs[j].windDirDeg !== null) { prevDir = obs[j].windDirDeg; break; }
  return { before: b, after: a, nearest, prevDir };
}

/** A field of the bracketing reports at t: interpolated when both have it, else the nearest's, else null. */
function obsField(r, t, k, angle = false) {
  const { before: b, after: a, nearest } = r;
  if (b && a && b[k] !== null && a[k] !== null && a.t > b.t) {
    const f = (t - b.t) / (a.t - b.t);
    return angle ? lerpAngle(b[k], a[k], f) : lerp(b[k], a[k], f);
  }
  return nearest[k] !== null ? nearest[k] : (b && b[k] !== null ? b[k] : a && a[k] !== null ? a[k] : null);
}

/** Station pressure from an altimeter setting and the station's height (NOAA's formula). */
export const stationPressure = (altimeterHPa, elevationM) => (altimeterHPa ** 0.190263 - 8.417286e-5 * elevationM) ** (1 / 0.190263);

const bandOf = (agl) => (agl < 2000 ? 'low' : agl < 6000 ? 'mid' : 'high');
function genusFor(band, cover, agl, convective) {
  if (band === 'low') return agl < 300 && cover >= 0.75 ? 'st' : convective && cover < 0.75 ? 'cu' : cover >= 0.6 ? 'sc' : 'cu';
  if (band === 'mid') return cover >= 0.75 ? 'as' : 'ac';
  return cover >= 0.75 ? 'cs' : 'ci';
}
function topFor(genus, baseM, freezingLevelM) {
  const fl = freezingLevelM ?? baseM + 2500;
  switch (genus) {
    case 'st': return baseM + 300;
    case 'sc': return baseM + 600;
    case 'cu': return baseM + 1000;
    case 'tcu': return Math.max(baseM + 3000, fl + 1500);
    case 'cb': return clamp(Math.max(12000, fl + 6000), baseM + 4000, 15000);
    case 'ac': return baseM + 500;
    case 'as': return baseM + 2000;
    case 'cs': return baseM + 1500;
    default: return baseM + 1000; // ci
  }
}

/** The cloud layers at an instant (section 6.4): the report up to 3.7 km, the model above unless the report says. */
function cloudLayers(report, m, groundM, convective, thunder, tempC, dewPointC) {
  const layers = [];
  const lcl = clamp(LCL_M_PER_C * Math.max(0, tempC - dewPointC), 300, OBSERVED_TOP_AGL);
  let observedHigh = false;
  if (report && report.skyReported) {
    for (const c of report.clouds) {
      const cover = COVER[c.cover];
      let agl = c.baseAglM ?? (c.type || thunder ? TS_BASE_AGL : lcl); // no bases in the record before 1973
      if (agl > OBSERVED_TOP_AGL) observedHigh = true;
      const band = bandOf(agl);
      const genus = c.type === 'CB' ? 'cb' : c.type === 'TCU' ? 'tcu' : c.cover === 'VV' ? 'st' : genusFor(band, cover, agl, convective);
      layers.push({ genus, baseM: groundM + agl, cover, observed: true });
    }
    if (thunder && !layers.some((l) => l.genus === 'cb')) {
      const low = layers.find((l) => l.baseM - groundM < OBSERVED_TOP_AGL && l.genus !== 'st');
      if (low) low.genus = 'cb';
      else layers.push({ genus: 'cb', baseM: groundM + TS_BASE_AGL, cover: 0.3 });
    }
  } else if (m) {
    // the model's low cover at the condensation level
    if ((m.cloudLow ?? 0) >= 0.05) {
      const genus = thunder ? 'cb' : genusFor('low', m.cloudLow, lcl, convective);
      layers.push({ genus, baseM: groundM + (thunder ? TS_BASE_AGL : lcl), cover: m.cloudLow });
    } else if (thunder) layers.push({ genus: 'cb', baseM: groundM + TS_BASE_AGL, cover: 0.3 });
  }
  if (!observedHigh && m) {
    if ((m.cloudMid ?? 0) >= 0.05) layers.push({ genus: genusFor('mid', m.cloudMid, 0, false), baseM: Math.max(groundM + OBSERVED_TOP_AGL + 100, 5000), cover: m.cloudMid });
    if ((m.cloudHigh ?? 0) >= 0.05) layers.push({ genus: genusFor('high', m.cloudHigh, 0, false), baseM: Math.max(groundM + 6500, 10000), cover: m.cloudHigh });
  }
  // merge layers at the same base, keep the four that cover most, lowest first
  const merged = [];
  for (const l of layers.sort((a, b) => a.baseM - b.baseM)) {
    const same = merged.find((x) => Math.abs(x.baseM - l.baseM) < 1);
    if (same) same.cover = Math.max(same.cover, l.cover); else merged.push(l);
  }
  const kept = merged.length > 4 ? [...merged].sort((a, b) => (b.observed ? 1 : 0) - (a.observed ? 1 : 0) || b.cover - a.cover).slice(0, 4) : merged;
  return kept.sort((a, b) => a.baseM - b.baseM).map((l) => ({ ...l, topM: topFor(l.genus, l.baseM, m && m.freezingLevelM) }))
    .map(({ genus, baseM, topM, cover }) => ({ genus, baseM, topM, cover }));
}

const RATE = { drizzle: [0.2, 0.5, 1], rain: [1, 4, 10], snow: [0.5, 1.5, 4], hail: [5, 15, 40] };
const intensity = (wx) => (/(^|\s)\+/.test(wx) ? 2 : /(^|\s)-/.test(wx) ? 0 : 1);

/**
 * The fused weather at time t (section 6.4) from a series { model, observations, aerosol }.
 * @param {{ model: object[], observations: object[], aerosol: object[] }} series  normalized (src/weather/normalize.js)
 * @param {number} t  UTC ms
 * @param {{ groundM: number, climatology?: object|null }} ctx  groundM: the station's height above sea level
 * @returns {object|null} a WeatherSample, or null when there is no model hour near t
 */
export function fuse(series, t, { groundM, climatology = null }) {
  const m = modelAt(series.model, t);
  const r = reportsAround(series.observations, t);
  if (!m && !r) return null;
  const rep = r ? r.nearest : null;
  const mv = (k, fallback) => (m && m[k] !== null && m[k] !== undefined ? m[k] : fallback);

  // surface
  let tempC = r ? obsField(r, t, 'tempC') : null;
  let dewPointC = r ? obsField(r, t, 'dewPointC') : null;
  const surface = tempC !== null ? 'metar' : 'model';
  if (tempC === null) tempC = mv('tempC', 15);
  if (dewPointC === null) dewPointC = mv('dewPointC', tempC - 15);
  dewPointC = Math.min(dewPointC, tempC);
  const alt = r ? obsField(r, t, 'altimeterHPa') : null;
  const pressureHPa = alt !== null ? stationPressure(alt, groundM) : mv('pressureHPa', 1013.25 * (1 - 2.25577e-5 * groundM) ** 5.25588);
  let speed = r ? obsField(r, t, 'windSpeedMs') : null;
  let dir = r ? obsField(r, t, 'windDirDeg', true) : null;
  if (speed === null) { speed = mv('windSpeedMs', 0); dir = mv('windDirDeg', 0); }
  if (dir === null) dir = r && r.prevDir !== null ? r.prevDir : mv('windDirDeg', 0);
  const obsGust = rep && rep.gustMs !== null ? rep.gustMs : null;
  const gust = Math.max(speed, obsGust ?? (surface === 'metar' ? speed : mv('gustMs', speed)));

  // present weather and remarks of the nearest report
  const wx = rep ? rep.wx.join(' ') : '';
  const remarks = rep ? rep.remarks : {};
  const tsHere = /(^|\s)[-+]?TS/.test(wx);
  let flash = /(^|\s)\+TS/.test(wx) ? 20 : tsHere ? 6 : /VCTS/.test(wx) || remarks.ltg || remarks.ts ? 1 : 0;
  if (!rep && m) flash = m.weatherCode >= 95 ? 6 : (m.capeJKg ?? 0) > 800 && (m.precipMm ?? 0) > 0 ? 2 : 0;
  const thunder = flash > 0;
  const convective = /SH|TS/.test(wx) || !!remarks.tcu || !!remarks.cb || (!rep && (mv('showersMm', 0) > 0 || thunder));

  // precipitation
  let kind = /GR|GS/.test(wx) ? 'hail' : /SN|SG|PL/.test(wx) ? 'snow' : /RA/.test(wx) ? 'rain' : /DZ/.test(wx) ? 'drizzle' : 'none';
  let rateMmH = 0;
  if (rep) {
    if (kind !== 'none') rateMmH = Math.max(RATE[kind][intensity(wx.split(' ').find((w) => /DZ|RA|SN|SG|PL|GR|GS/.test(w)) || '')], rep.precipMm ?? 0);
  } else if (m) {
    rateMmH = mv('precipMm', 0);
    if (rateMmH > 0.05) kind = mv('snowCm', 0) > 0 && tempC < 1 ? 'snow' : 'rain';
  }
  let virgaBaseM = null;
  const dryAir = tempC - dewPointC > 20;
  if (kind === 'none' && (remarks.virga || (mv('precipMm', 0) > 0.1 && dryAir && !(rep && (rep.precipMm ?? 0) > 0)))) kind = 'virga';
  else if (kind === 'rain' && !rep && dryAir) kind = 'virga';
  if (kind === 'virga') rateMmH = 0;

  // visibility
  const repVis = rep && rep.visibilityM !== null ? rep : null;
  const visibilityCensored = repVis ? repVis.visibilityCensored : false;

  // aerosols
  const cams = aerosolAt(series.aerosol, t);
  const base = cams || climatologyAt(climatology, t);
  let dust = base.dustUgM3 ?? 0;
  const aerosol = {
    aod550: base.aod550, angstrom: 0, dustUgM3: dust, pm25UgM3: base.pm25UgM3 ?? 5,
    layerHeightM: clamp(mv('blhM', 1500), LAYER_MIN_M, LAYER_MAX_M),
  };
  let visibilityM;
  if (repVis && (!repVis.visibilityCensored || repVis.visibilityM < TEN_MILES_M - 1)) visibilityM = repVis.visibilityM;
  else visibilityM = visibilityFromAerosol(aerosol, groundM);
  if (repVis && repVis.visibilityCensored) visibilityM = Math.max(visibilityM, TEN_MILES_M); // the report said 10 miles or more
  // blowing dust the feed cannot see (section 6.1, finding 3): the dust a reported visibility implies
  if (/DU|SS|DS/.test(wx) && repVis && !repVis.visibilityCensored) {
    const implied = (KOSCHMIEDER / visibilityM - rayleighExtinction(groundM)) / (DUST_MEE_M2_PER_G * 1e-6);
    dust = Math.max(dust, implied);
    aerosol.dustUgM3 = dust;
  }
  const pm10 = Math.max(base.pm10UgM3 ?? dust, dust, 1);
  aerosol.angstrom = angstromFor(dust / pm10);

  const clouds = cloudLayers(rep, m, groundM, convective, thunder, tempC, dewPointC);
  if (kind === 'virga') virgaBaseM = clouds.length ? clouds[0].baseM : groundM + 3000;

  // dust wall (section 6.4): blowing dust with strong gusts while thunder is about
  const dustWall = /DS|SS|BLDU/.test(wx) && gust > 18 && (thunder || remarks.cb)
    ? { active: true, bearingDeg: dir, distanceM: 0, speedMs: gust, heightM: 1500 } : null;

  // winds aloft: the model's levels, else the surface wind veered 20 degrees and scaled by a power law
  let windAloft = m && m.aloft.length ? m.aloft.map((w) => ({ level: w.level, dirDeg: ((w.dirDeg % 360) + 360) % 360, speedMs: w.speedMs })) : null;
  if (!windAloft) {
    windAloft = Object.entries(LEVEL_HEIGHT).filter(([, h]) => h > groundM + 100)
      .map(([level, h]) => ({ level: Number(level), dirDeg: (dir + 20) % 360, speedMs: speed * ((h - groundM) / 10) ** 0.143 }));
  }

  return {
    t,
    source: { surface, clouds: rep && rep.skyReported ? 'metar' : 'model', aerosol: cams ? 'cams' : 'climatology' },
    tempC, dewPointC, rh: rhFrom(tempC, dewPointC), pressureHPa,
    wind: { dirDeg: ((dir % 360) + 360) % 360, speedMs: speed, gustMs: gust },
    windAloft: windAloft.sort((a, b) => b.level - a.level),
    visibilityM: clamp(visibilityM, 1, 400000), visibilityCensored,
    aerosol,
    clouds,
    precip: { rateMmH, kind, convective, virgaBaseM },
    storm: { thunder, flashRatePerMin: flash, cells: thunder ? (flash >= 20 ? 3 : flash >= 6 ? 2 : 1) : 0, capeJKg: m && m.capeJKg !== null ? m.capeJKg : null },
    dustWall,
    wxCodes: rep ? [...rep.wx, ...remarkCodes(rep)] : [],
  };
}
