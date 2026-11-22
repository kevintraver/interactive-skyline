// Quality presets (plan 01, sections 7.14 and 11.8; task T2.7): the profiles, automatic detection, the governor
// that holds the frame budget, and the user's choice. The decision table and the governor are pure and unit-tested
// (tests/unit/render/quality.test.js); apply() puts a profile on the renderer and the pipeline.
//
// What phase 2 can apply of 7.14: output size and pixel ratio, dynamic render scale (0.6 to 1.0), MSAA samples,
// bloom resolution and the shadow map's size. The rest of each profile (sky-view LUT, froxels, clouds, rain, ...) is
// read by the phases that build those features. Ultra's TRAA and TAAU upscaling are not built in phase 2: Ultra
// uses MSAA 4x at up to pixel ratio 2 until they are (plan correction, phase 2 outcome).
export const LEVELS = ['low', 'high', 'ultra'];
/** The governor is fed the interval between frames, which vsync rounds up: allow 15 % over the frame budget. */
export const GOVERNOR_MARGIN = 1.15;

export const PROFILES = {
  low: {
    level: 'low', maxPixelRatio: 1, maxPixels: 1920 * 1080, msaa: 2, bloomScale: 0.25, shadowMapSize: 2048,
    shadows: { cascades: 2, mapSize: 1024, maxFarM: 3000, localCascades: 1 },
    skyView: [192, 108], froxels: 16, clouds: 'shells', rain: 'layers', reflections: 'sky', milkyWay: '2k',
    starTwinkle: false, skyGlowVolume: [64, 64, 12], envMap: 0, frameMs: 1000 / 30,
  },
  high: {
    level: 'high', maxPixelRatio: 1.5, maxPixels: 2560 * 1440, msaa: 4, bloomScale: 0.5, shadowMapSize: 4096,
    shadows: { cascades: 3, mapSize: 2048, maxFarM: 8000, localCascades: 2 },
    skyView: [192, 108], froxels: 32, clouds: 'slabs', rain: 16000, reflections: 'ssr-half', milkyWay: '4k',
    starTwinkle: true, skyGlowVolume: [128, 128, 16], envMap: 64, frameMs: 1000 / 60,
  },
  ultra: {
    level: 'ultra', maxPixelRatio: 2, maxPixels: 3840 * 2160, msaa: 4, bloomScale: 0.5, shadowMapSize: 4096,
    shadows: { cascades: 4, mapSize: 2048, maxFarM: 12000, localCascades: 2 },
    skyView: [384, 216], froxels: 64, clouds: 'volumetric', rain: 64000, reflections: 'ssr-half-rough', milkyWay: '4k',
    starTwinkle: true, skyGlowVolume: [128, 128, 16], envMap: 128, frameMs: 1000 / 60,
  },
};

/** The budget split of section 9.1, per level (ms). */
export const BUDGET_MS = {
  low: { frame: 33.3, environment: 7.0, city: 11.0, modes: 15.3, weather: 2.5 },
  high: { frame: 16.7, environment: 4.0, city: 4.5, modes: 8.1, weather: 4.0 },
  ultra: { frame: 16.7, environment: 4.0, city: 3.5, modes: 9.2, weather: 5.7 },
};

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|microsoft basic|lavapipe/i;
const MOBILE = /android|iphone|ipad|mobile/i;
const APPLE_PRO = /apple.*m\d+\s*(pro|max|ultra)/i;
const APPLE = /apple|metal/i;
const INTEGRATED = /intel|uhd|iris|integrated|mali|adreno|powervr|apple a\d/i;
const STRONG_DISCRETE = /rtx\s*(30[6-9]0|40[6-9]0|50[6-9]0)|rx\s*(6[7-9]|7[7-9]|9[0-9])\d\d|radeon pro w7/i;
const DISCRETE = /nvidia|geforce|rtx|gtx|radeon|amd/i;

/**
 * The detected level and why: { level, reasons[] }.
 * @param {{ backend: 'webgpu'|'webgl2', gpu: string, deviceMemory?: number, cores?: number, userAgent?: string,
 *   canvasPixels?: number, fillRateMs?: number|null }} o  `gpu`: adapter info or WebGL's renderer string.
 *   `fillRateMs`: the 30-frame fill-rate benchmark, ms per frame at the canvas size (null: not run).
 */
export function detectLevel({ backend, gpu = '', deviceMemory, cores, userAgent = '', canvasPixels = 0, fillRateMs = null }) {
  const reasons = [];
  let level;
  if (SOFTWARE.test(gpu)) { level = 'low'; reasons.push('software rendering'); }
  else if (MOBILE.test(userAgent)) { level = 'low'; reasons.push('phone or tablet'); }
  else if ((deviceMemory && deviceMemory <= 4) || (cores && cores <= 4)) { level = 'low'; reasons.push('little memory or few cores'); }
  else if (APPLE_PRO.test(gpu)) { level = 'ultra'; reasons.push('Apple M-series Pro or Max'); }
  else if (APPLE.test(gpu) && !/apple a\d/i.test(gpu)) { level = 'high'; reasons.push('Apple M-series'); }
  else if (STRONG_DISCRETE.test(gpu)) { level = 'ultra'; reasons.push('upper discrete GPU'); }
  else if (DISCRETE.test(gpu)) { level = 'high'; reasons.push('discrete GPU'); }
  else if (INTEGRATED.test(gpu)) { level = 'low'; reasons.push('integrated GPU'); }
  else { level = 'high'; reasons.push('unknown GPU'); }
  if (level === 'ultra' && backend !== 'webgpu') { level = 'high'; reasons.push('Ultra needs the WebGPU backend'); }
  // the fill-rate benchmark: a frame of 32-step ray marching over the whole canvas; slower than the level's whole
  // frame budget at full size means a tier down
  if (fillRateMs !== null && Number.isFinite(fillRateMs)) {
    const budget = PROFILES[level].frameMs * 0.5;
    if (fillRateMs > budget && level !== 'low') { level = LEVELS[LEVELS.indexOf(level) - 1]; reasons.push(`fill rate ${fillRateMs.toFixed(1)} ms per frame`); }
  }
  void canvasPixels;
  return { level, reasons };
}

/** Can this level run on this backend? { ok, reason } */
export function allowed(level, backend) {
  if (level === 'ultra' && backend !== 'webgpu') return { ok: false, reason: 'Ultra needs WebGPU; this browser draws with WebGL 2.' };
  return { ok: LEVELS.includes(level), reason: LEVELS.includes(level) ? '' : `unknown level ${level}` };
}

/**
 * The governor (pure): if the 95th-percentile frame time exceeds the budget for two seconds, lower the render scale
 * in steps of 0.1 down to 0.6, then drop one tier. It never raises a tier; it raises the scale back by 0.1 only after
 * ten seconds well under budget (below 70 %). Feed it frame times with their timestamps.
 */
export function createGovernor({ budgetMs, windowMs = 2000, minScale = 0.6, step = 0.1, recoverMs = 10000 } = {}) {
  const samples = []; // [timeMs, frameMs]
  const g = { scale: 1, budgetMs, drops: 0, lastChange: -Infinity, under: null };
  g.feed = (timeMs, frameMs) => {
    samples.push([timeMs, frameMs]);
    while (samples.length && samples[0][0] < timeMs - windowMs) samples.shift();
    if (timeMs - g.lastChange < windowMs || samples.length < 10 || timeMs - samples[0][0] < windowMs * 0.9) return null;
    const sorted = samples.map((s) => s[1]).sort((a, b) => a - b);
    const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];
    if (p95 > g.budgetMs) {
      g.under = null;
      g.lastChange = timeMs;
      samples.length = 0;
      if (g.scale > minScale + 1e-6) { g.scale = Math.round((g.scale - step) * 10) / 10; return { action: 'scale', scale: g.scale, p95 }; }
      g.drops++;
      g.scale = 1;
      return { action: 'drop', p95 };
    }
    if (p95 < g.budgetMs * 0.7 && g.scale < 1) {
      if (g.under === null) g.under = timeMs;
      if (timeMs - g.under >= recoverMs) {
        g.under = null; g.lastChange = timeMs; samples.length = 0;
        g.scale = Math.min(1, Math.round((g.scale + step) * 10) / 10);
        return { action: 'scale', scale: g.scale, p95 };
      }
    } else g.under = null;
    return null;
  };
  return g;
}

/**
 * The live quality object of section 11.8. `choice` is the stored setting: 'auto' or a level.
 * apply(profile, renderScale) is called on every change.
 */
export function createQuality({ backend, detected, choice = 'auto', apply = () => {}, caps = {} }) {
  const listeners = new Set();
  const q = {
    backend,
    detected,
    choice: 'auto',
    level: detected.level,
    renderScale: 1,
    caps: { webgpu: backend === 'webgpu', compute: backend === 'webgpu', reversedDepth: false, floatTargets: true, maxTextureSize: 4096, ...caps },
    get profile() { return PROFILES[q.level]; },
    get budgetMs() { return BUDGET_MS[q.level]; },
    message: '',
    governor: null,
    /** 'auto' | 'low' | 'high' | 'ultra'. Returns { ok, reason }; Ultra on WebGL2 is refused. */
    set(level) {
      if (level !== 'auto') {
        const a = allowed(level, backend);
        if (!a.ok) { q.message = a.reason; return a; }
      }
      q.choice = level;
      q.level = level === 'auto' ? q.detected.level : level;
      q.renderScale = 1;
      q.message = '';
      q.governor = createGovernor({ budgetMs: PROFILES[q.level].frameMs * GOVERNOR_MARGIN });
      apply(q.profile, q.renderScale);
      for (const fn of listeners) fn(q);
      return { ok: true, reason: '' };
    },
    /** Feed a rendered frame's time to the governor (automatic choice only). */
    frame(timeMs, frameMs) {
      if (q.choice !== 'auto' || !q.governor) return;
      const r = q.governor.feed(timeMs, frameMs);
      if (!r) return;
      if (r.action === 'scale') q.renderScale = r.scale;
      else if (q.level !== 'low') { q.level = LEVELS[LEVELS.indexOf(q.level) - 1]; q.renderScale = 1; q.governor = createGovernor({ budgetMs: PROFILES[q.level].frameMs * GOVERNOR_MARGIN }); }
      apply(q.profile, q.renderScale);
      for (const fn of listeners) fn(q);
    },
    on(type, fn) { if (type === 'change') listeners.add(fn); return () => listeners.delete(fn); },
  };
  const r = q.set(choice);
  if (!r.ok) q.set('auto');
  return q;
}
