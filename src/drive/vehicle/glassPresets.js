// The cabin's glass by preset (plan 02, section 7.11): the three mirrors' render targets and refresh rates, and
// the windshield layer: 'high' for the full model, 'low' for the low model. One options object holds both; app.quality's
// level picks (below).
//
// Mirror pixels per frame (section 9.1: Low 25 k, High 100 k). A mirror refreshes on the frames where
// frameNo % every === phase; when the picture is paused (or any time `all` is asked for) every mirror is drawn.
// Each mirror pass draws the whole world scene again (today's ground is two grid meshes of 1.4 and 1.7 million
// triangles that culling cannot reduce; the passes draw them at a coarser stride, groundStride), so the number of
// passes per frame, not their pixels, sets the cost: both presets run one pass a frame at most.
//   high: section 7.11's rotation, one mirror a frame: the interior mirror every second frame at 512 x 144
//         (74 k px), each door mirror every fourth frame at 320 x 192 (61 k px).
//   low:  the interior mirror every fourth frame at 256 x 72 (18 k px), each door mirror every eighth frame at
//         160 x 96 (15 k px), at most one a frame and none on half the frames. (Section 7.11's Low has the
//         rear-view mirror only; the door mirrors are kept here, small and slow, so the low model is not blind
//         to the sides.)
// Sizes follow each face's aspect (doors 0.20 x 0.12 m, interior 0.25 x 0.07 m in cabin.json).
// Rain on the glass (D8.2, glassRain.js): drop sites siteM apart (high 2 cm: 83 x 41 = 3,403 sites; low 3 cm: 56 x 27
// = 1,512), each drawn as three instances (the sitting drop and two runners) whose vertex shader walks at most 64 bins.

export const GLASS_PRESETS = Object.freeze({
  high: Object.freeze({
    mirrors: Object.freeze({
      enabled: true,
      samples: 4, // MSAA in the targets
      groundStride: Object.freeze({ far: 3, near: 2, wide: 2 }), // every n-th post of each ground grid (mirrorGeometry.js coarseGridIndex)
      skip: Object.freeze([]), // names of scene objects the mirror passes leave out (none: leaving the sprites out saved nothing measurable)
      center: Object.freeze({ size: [512, 144], every: 2, phase: 0 }),
      left: Object.freeze({ size: [320, 192], every: 4, phase: 1 }),
      right: Object.freeze({ size: [320, 192], every: 4, phase: 3 }),
    }),
    windshield: Object.freeze({ enabled: true, maskSize: [512, 256], lamps: 4, dashboard: true }),
    rain: Object.freeze({ enabled: true, siteM: 0.02 }),
  }),
  low: Object.freeze({
    mirrors: Object.freeze({
      enabled: true,
      samples: 0,
      groundStride: Object.freeze({ far: 4, near: 3, wide: 3 }),
      skip: Object.freeze([]),
      center: Object.freeze({ size: [256, 72], every: 4, phase: 0 }),
      left: Object.freeze({ size: [160, 96], every: 8, phase: 2 }),
      right: Object.freeze({ size: [160, 96], every: 8, phase: 6 }),
    }),
    windshield: Object.freeze({ enabled: true, maskSize: [256, 128], lamps: 2, dashboard: false }),
    rain: Object.freeze({ enabled: true, siteM: 0.03 }),
  }),
});

/** The glass options for a cabin model ('high' | 'low'); anything else gets 'high'. */
export const glassPresetFor = (model) => GLASS_PRESETS[model] || GLASS_PRESETS.high;

export const MIRROR_NAMES = Object.freeze(['center', 'left', 'right']);

/**
 * Which mirrors to draw on this frame. A pure function of the frame count and the preset; with `all` (the
 * picture is paused, or a settled frame was asked for) every mirror is drawn, so what a settled frame shows
 * never depends on the frame count.
 * @param {number} frameNo  @param {object} mirrors a preset's `mirrors`  @param {boolean} [all]
 * @returns {string[]} names from MIRROR_NAMES
 */
export function mirrorsDue(frameNo, mirrors, all = false) {
  if (!mirrors?.enabled) return [];
  return MIRROR_NAMES.filter((name) => {
    const m = mirrors[name];
    if (!m) return false;
    if (all) return true;
    const every = Math.max(1, m.every | 0);
    return ((frameNo % every) + every) % every === (m.phase | 0) % every;
  });
}

/** Mirror pixels drawn on one frame (for the budget check). */
export function mirrorPixels(frameNo, mirrors, all = false) {
  return mirrorsDue(frameNo, mirrors, all).reduce((a, n) => a + mirrors[n].size[0] * mirrors[n].size[1], 0);
}

// ---------------------------------------------------------------- plan 01's quality levels (third stretch, decision 8)
// app.quality's level picks the preset: Low the low preset (with the low
// model), High the high preset, Ultra the high preset with larger mirrors (interior 576 x 162, doors 384 x 230, at the
// same rates: one pass a frame at most, 90.8 k mirror pixels a frame on average, within 9.1's 100 k) and rain sites 1.6 cm
// apart (104 x 51 = 5,304 sites).
export const QUALITY_GLASS = Object.freeze({
  low: GLASS_PRESETS.low,
  high: GLASS_PRESETS.high,
  ultra: Object.freeze({
    ...GLASS_PRESETS.high,
    mirrors: Object.freeze({
      ...GLASS_PRESETS.high.mirrors,
      center: Object.freeze({ size: [576, 162], every: 2, phase: 0 }),
      left: Object.freeze({ size: [384, 230], every: 4, phase: 1 }),
      right: Object.freeze({ size: [384, 230], every: 4, phase: 3 }),
    }),
    rain: Object.freeze({ enabled: true, siteM: 0.016 }),
  }),
});

/** The glass options for one of plan 01's quality levels ('low' | 'high' | 'ultra'); anything else by the cabin's model. */
export const glassPresetForLevel = (level, model) => QUALITY_GLASS[level] || glassPresetFor(model);
