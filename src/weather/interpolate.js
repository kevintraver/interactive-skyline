// Sampling between hours (plan 01, section 6.4; task T5.1): linear for scalars, the shortest arc for directions,
// cloud layers matched by level and cross-faded, codes held until the next sample.

const lerp = (a, b, f) => a + (b - a) * f;

/** Interpolate two directions in degrees the short way round; the result is in [0, 360). */
export function lerpAngle(a, b, f) {
  if (f <= 0) return a;
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  const v = (a + d * f) % 360;
  const out = v < 0 ? v + 360 : v;
  return out >= 360 ? out - 360 : out;
}

// a layer's level, for matching layers between two samples
const LEVEL = { cu: 0, tcu: 0, cb: 0, sc: 0, st: 0, ac: 1, as: 1, ci: 2, cs: 2 };

/** Cloud layers between two samples: same-level layers paired in height order and blended; the rest fade. */
function blendClouds(ca, cb, f) {
  const out = [];
  for (const level of [0, 1, 2]) {
    const la = ca.filter((c) => LEVEL[c.genus] === level), lb = cb.filter((c) => LEVEL[c.genus] === level);
    const n = Math.max(la.length, lb.length);
    for (let i = 0; i < n; i++) {
      const a = la[i], b = lb[i];
      if (a && b) out.push({ genus: f < 0.5 ? a.genus : b.genus, baseM: lerp(a.baseM, b.baseM, f), topM: lerp(a.topM, b.topM, f), cover: lerp(a.cover, b.cover, f) });
      else if (a) out.push({ ...a, cover: a.cover * (1 - f) });
      else out.push({ ...b, cover: b.cover * f });
    }
  }
  const kept = out.filter((c) => c.cover > 0).sort((x, y) => x.baseM - y.baseM);
  return kept.length > 4 ? kept.sort((x, y) => y.cover - x.cover).slice(0, 4).sort((x, y) => x.baseM - y.baseM) : kept;
}

function blendAloft(wa, wb, f) {
  const out = [];
  for (const a of wa) {
    const b = wb.find((w) => w.level === a.level);
    out.push(b ? { level: a.level, dirDeg: lerpAngle(a.dirDeg, b.dirDeg, f), speedMs: lerp(a.speedMs, b.speedMs, f) } : { ...a });
  }
  for (const b of wb) if (!wa.some((w) => w.level === b.level)) out.push({ ...b });
  return out.sort((x, y) => y.level - x.level);
}

/** The sample a fraction `f` of the way from `a` to `b` (two WeatherSamples). f = 0 is `a`, f = 1 is `b`. */
export function lerpSample(a, b, f) {
  if (f <= 0) return a;
  if (f >= 1) return b;
  const num = (x, y) => lerp(x, y, f);
  return {
    t: Math.round(num(a.t, b.t)),
    source: a.source,
    tempC: num(a.tempC, b.tempC), dewPointC: num(a.dewPointC, b.dewPointC), rh: num(a.rh, b.rh),
    pressureHPa: num(a.pressureHPa, b.pressureHPa),
    wind: { dirDeg: lerpAngle(a.wind.dirDeg, b.wind.dirDeg, f), speedMs: num(a.wind.speedMs, b.wind.speedMs), gustMs: num(a.wind.gustMs, b.wind.gustMs) },
    windAloft: blendAloft(a.windAloft, b.windAloft, f),
    // visibility spans orders of magnitude: interpolate its logarithm
    visibilityM: Math.exp(num(Math.log(a.visibilityM), Math.log(b.visibilityM))),
    visibilityCensored: a.visibilityCensored,
    aerosol: {
      aod550: num(a.aerosol.aod550, b.aerosol.aod550), angstrom: num(a.aerosol.angstrom, b.aerosol.angstrom),
      dustUgM3: num(a.aerosol.dustUgM3, b.aerosol.dustUgM3), pm25UgM3: num(a.aerosol.pm25UgM3, b.aerosol.pm25UgM3),
      layerHeightM: num(a.aerosol.layerHeightM, b.aerosol.layerHeightM),
    },
    clouds: blendClouds(a.clouds, b.clouds, f),
    precip: { rateMmH: num(a.precip.rateMmH, b.precip.rateMmH), kind: a.precip.kind, convective: a.precip.convective, virgaBaseM: a.precip.virgaBaseM },
    storm: { thunder: a.storm.thunder, flashRatePerMin: num(a.storm.flashRatePerMin, b.storm.flashRatePerMin), cells: a.storm.cells,
      capeJKg: a.storm.capeJKg !== null && b.storm.capeJKg !== null ? num(a.storm.capeJKg, b.storm.capeJKg) : a.storm.capeJKg },
    dustWall: a.dustWall ? { ...a.dustWall } : null,
    wxCodes: [...a.wxCodes],
  };
}

/**
 * A series of samples (sorted by t) at time `t`: the blend of the two around it, the nearest end outside it,
 * null when empty.
 */
export function sampleSeries(points, t) {
  if (!points.length) return null;
  if (t <= points[0].t) return points[0];
  const last = points[points.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  return t === a.t ? a : lerpSample(a, b, (t - a.t) / (b.t - a.t));
}
