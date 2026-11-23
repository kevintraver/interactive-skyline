// Automatic exposure (plan 01, section 7.2; task T2.6): a prior predicted from the light, a meter that reads the
// frame, a clamp that keeps the meter within -3 and +2 EV of the prior, adaptation toward the target, and two
// modes. Exposure is applied as pre-exposure (env.nodes.exposure): light intensities and emission are multiplied by
// it before they reach the HDR buffer, and tone mapping runs at exposure 1.
//
//   meter       the HDR frame reduced to 64 x 64 log2-luminance texels, centre-weighted, clamped at 8 stops above
//               the prior (so a few signs cannot drag it), averaged down to one texel and read back asynchronously
//               (one to three frames late, on both backends)
//   prior       L = 0.2 (E_key max(sin alt, 0) + E_sky + E_city) / pi (src/render/photometry.js); the exposure for the
//               first frame after a seek, and the centre of the clamp
//   adaptation  exponential in EV: 0.6 s toward brighter, 3 s toward darker; instantaneous on a seek or when the
//               clock runs faster than 60x
//   Camera      maps the adapted average to middle grey at every light level, as a long-exposure photograph
//   Eye         the default: the key falls from 0.18 at EV 9 and above to 0.03 at EV 0 and below, so night is drawn
//               as dark as it is seen; a tunable perceptual model, not a measurement
//   compensation  +-EV from the settings
import { RenderTarget, QuadMesh, MeshBasicNodeMaterial, FloatType, HalfFloatType, RGBAFormat, NearestFilter } from 'three/webgpu';
import { Fn, texture, uniform, vec2, vec4, float, uv, log2, max, min, dot, vec3, length, exp, Loop, int } from 'three/tsl';
import { exposureFromEv100, ev100FromExposure } from './photometry.js';
import { ev100FromLuminance } from '../core/units.js';

export const ADAPT_UP_S = 0.6;
export const ADAPT_DOWN_S = 3;
export const CLAMP_BELOW_EV = 3;
export const CLAMP_ABOVE_EV = 2;
/** The meter ignores light more than this many stops above the prior's average. */
export const METER_CLAMP_STOPS = 8;
/** Settled once the adapted exposure is this close to its target. */
export const SETTLED_EV = 0.03;

/**
 * Eye mode's key: 0.18 at EV100 9 and above, falling to EYE_NIGHT_KEY at EYE_NIGHT_EV and below, linear in EV
 * between. Section 7.2 proposed 0.05 at EV -4; on the city at night (EV 0 to 2 here) that kept the key near 0.1 and
 * drew the night city three times brighter than the classic look, so phase 2 lowered the dark end (a tunable
 * perceptual model, checked against the photo boards in phase 4).
 */
export const EYE_NIGHT_KEY = 0.03;
export const EYE_NIGHT_EV = 0;
export function eyeKey(ev100) {
  const t = Math.min(1, Math.max(0, (ev100 - EYE_NIGHT_EV) / (9 - EYE_NIGHT_EV)));
  return EYE_NIGHT_KEY + (0.18 - EYE_NIGHT_KEY) * t;
}

/** The EV to expose at, from a metered EV (or null) and the prior's: the meter clamped to [prior - 3, prior + 2]. */
export function targetEv(meteredEv, priorEv) {
  if (meteredEv === null || !Number.isFinite(meteredEv)) return priorEv;
  return Math.min(priorEv + CLAMP_ABOVE_EV, Math.max(priorEv - CLAMP_BELOW_EV, meteredEv));
}

/** One step of adaptation in EV over `dtS` seconds: fast toward brighter, slow toward darker. */
export function adaptEv(currentEv, target, dtS) {
  if (!Number.isFinite(currentEv)) return target;
  // a higher EV means a brighter scene: the eye closes down quickly, opens up slowly
  const tau = target > currentEv ? ADAPT_UP_S : ADAPT_DOWN_S;
  return target + (currentEv - target) * Math.exp(-Math.max(dtS, 0) / tau);
}

/**
 * The pre-exposure for a scene EV in a mode: Camera maps the average to middle grey (exposureFromEv100); Eye scales
 * that by key / 0.18. `compensation` is in EV (+1 = twice as bright).
 */
export function exposureFor(ev100, mode = 'eye', compensation = 0) {
  const k = exposureFromEv100(ev100) * 2 ** compensation;
  return mode === 'camera' ? k : k * (eyeKey(ev100) / 0.18);
}

const SIZE = 64;

/** The GPU half: meter the scene pass's colour into one texel and read it back. */
function createMeter(renderer, colorTexture) {
  const clampLog = uniform(20); // log2 of the buffer value above which light is ignored
  const exposureAt = uniform(1);
  const target = (n, type = HalfFloatType) => new RenderTarget(n, n, { type, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
  const t64 = target(SIZE), t16 = target(16), t4 = target(4), t1 = target(1, FloatType);
  // pass 1: log2 luminance, centre-weighted (r: weight x log, g: weight)
  const first = new MeshBasicNodeMaterial();
  first.fragmentNode = Fn(() => {
    const c = texture(colorTexture, uv()).rgb;
    const l = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-7);
    const lg = min(log2(l), clampLog);
    const r = length(uv().sub(0.5)).mul(2);
    const w = exp(r.mul(r).mul(-1.5)); // centre weighting: the middle counts about 4.5 times the corners
    return vec4(lg.mul(w), w, 0, 1);
  })();
  // passes 2 to 4: each output texel averages 4 x 4 input texels
  const reducer = (src, n) => {
    const m = new MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => {
      const acc = vec4(0).toVar();
      const texel = float(1 / (n * 4));
      const base = uv().sub(texel.mul(1.5));
      Loop({ start: int(0), end: int(4) }, ({ i }) => {
        Loop({ start: int(0), end: int(4) }, ({ i: j }) => {
          acc.addAssign(texture(src.texture, base.add(vec2(float(i), float(j)).mul(texel))));
        });
      });
      return vec4(acc.xy.div(16), 0, 1);
    })();
    return new QuadMesh(m);
  };
  const quads = [[new QuadMesh(first), t64], [reducer(t64, 16), t16], [reducer(t16, 4), t4], [reducer(t4, 1), t1]];
  let pending = null, latest = null;
  return {
    clampLog, exposureAt,
    /** Run the passes for the frame just drawn and start a readback if none is in flight. */
    measure(exposure, gen = 0) {
      if (pending) return null;
      const previous = renderer.getRenderTarget();
      for (const [quad, t] of quads) { renderer.setRenderTarget(t); quad.render(renderer); }
      renderer.setRenderTarget(previous);
      const k = exposure, askedAt = performance.now(); // the time of the frame measured, not of the readback
      pending = renderer.readRenderTargetPixelsAsync(t1, 0, 0, 1, 1).then((px) => {
        pending = null;
        const meanLog = px[0] / Math.max(px[1], 1e-6);
        // back to scene luminance: the buffer held cd/m2 x exposure
        latest = { luminanceCdM2: 2 ** meanLog / k, at: askedAt, gen };
        return latest;
      }, () => { pending = null; return null; });
      return pending;
    },
    get latest() { return latest; },
    reset() { latest = null; },
    dispose() { for (const t of [t64, t16, t4, t1]) t.dispose(); },
  };
}

/**
 * The exposure subsystem. `prior()` returns the prior EV100 for the current state; `uniform` is the pre-exposure
 * uniform it drives. Frame step 45 (after env.update, before the pipeline).
 *
 * A seek (a clock seek, a new view, a pinned look) lands on the prior plus the meter's last offset from it, so a
 * time seek in the same view is right on its first frame; the first meter reading taken after the seek is then
 * applied at once. Continuous change (a pan, the clock playing) adapts with the time constants above.
 */
export function createExposure({ renderer, pipeline, prior, uniform: exposureUniform, settings = {}, clock = null, offsetEv = 0, invalidate = () => {} }) {
  const meter = pipeline && pipeline.scenePass ? createMeter(renderer, pipeline.scenePass.getTexture('output')) : null;
  const state = { mode: settings.exposureMode || 'eye', compensation: settings.exposureComp || 0, enabled: true,
    ev: NaN, target: NaN, prior: NaN, bias: 0, biases: [], metered: null, meteredAt: -Infinity, lastSnapMs: -Infinity, lastPrior: NaN, settled: false, snapRequested: true, awaiting: !!meter, lastMs: null, gen: 0 };
  if (clock) {
    clock.on('seek', () => { state.snapRequested = true; });
    clock.on('rate', () => { if (Math.abs(clock.rate) > 60) state.snapRequested = true; });
  }
  const sub = {
    state,
    /** Turn adaptation off (the classic display): exposure is then held at `value`; hold() turns it back on. */
    hold(value) {
      state.enabled = value === undefined;
      if (!state.enabled) { exposureUniform.value = value; state.settled = true; } // held: nothing left to adapt
      else { state.snapRequested = true; state.settled = false; }
    },
    setMode(mode) { state.mode = mode; },
    setCompensation(ev) { state.compensation = ev; },
    /**
     * A seek: the next frame lands on prior + bias, the next meter reading is taken at once. `newView`: the meter's
     * offsets from the prior, remembered per light level, belong to the old view and are forgotten.
     */
    snap(newView = false) { state.snapRequested = true; if (newView) state.biases = []; },
    update(frame) {
      if (!state.enabled) return;
      const nowMs = frame ? frame.nowMs : performance.now();
      // up to a second per frame, so a slow (software) renderer still adapts in about the same wall time
      const dtS = state.lastMs === null ? 0 : Math.min((nowMs - state.lastMs) / 1000, 1);
      state.lastMs = nowMs;
      state.prior = prior();
      if (state.snapRequested) {
        state.snapRequested = false;
        // a seek within half a second of the last is a scrub: keep adapting smoothly instead of jumping to each
        // fresh reading (a dusk scrub would otherwise step at every reading)
        const scrubbing = nowMs - state.lastSnapMs < 500;
        state.lastSnapMs = nowMs;
        state.gen++;
        // the offset remembered nearest this light level (within 1.5 EV), else the last one
        let best = null;
        for (const [p, b] of state.biases) if (Math.abs(p - state.prior) < 1.5 && (!best || Math.abs(p - state.prior) < Math.abs(best[0] - state.prior))) best = [p, b];
        if (best) state.bias = best[1];
        if (!scrubbing) { state.ev = state.prior + state.bias; state.awaiting = !!meter; }
        else { state.ev += state.prior - state.lastPrior; state.awaiting = false; } // follow the light, keep the offset
      }
      state.lastPrior = state.prior;
      const reading = meter && meter.latest && meter.latest.gen === state.gen ? meter.latest : null;
      const metered = reading ? ev100FromLuminance(reading.luminanceCdM2) : null;
      state.metered = metered;
      state.meteredAt = reading ? reading.at : state.meteredAt; // when the reading in use was taken (ms)
      if (metered !== null) {
        state.bias = Math.min(CLAMP_ABOVE_EV, Math.max(-CLAMP_BELOW_EV, metered - state.prior));
        const i = state.biases.findIndex(([p]) => Math.abs(p - state.prior) < 0.25);
        if (i >= 0) state.biases.splice(i, 1);
        state.biases.push([state.prior, state.bias]);
        if (state.biases.length > 48) state.biases.shift();
      }
      state.target = metered !== null ? targetEv(metered, state.prior) : state.prior + state.bias;
      const fast = clock && (clock.playing || clock.live) && Math.abs(clock.rate) > 60;
      if (state.awaiting && metered !== null) { state.ev = state.target; state.awaiting = false; }
      else if (fast || !Number.isFinite(state.ev)) state.ev = state.target;
      else state.ev = adaptEv(state.ev, state.target, dtS);
      state.settled = !state.awaiting && Math.abs(state.ev - state.target) < SETTLED_EV;
      exposureUniform.value = exposureFor(state.ev, state.mode, state.compensation + offsetEv);
      // the meter ignores light more than 8 stops above the prior's average (in buffer units)
      if (meter) meter.clampLog.value = Math.log2(Math.max(2 ** state.prior * 12.5 / 100, 1e-9) * exposureUniform.value) + METER_CLAMP_STOPS;
    },
    /** After the frame is drawn: meter it. */
    afterRender() {
      if (!state.enabled || !meter) return;
      const p = meter.measure(exposureUniform.value, state.gen);
      // a reading that moves the target asks for frames (the scene may be idle by then: a pan draws one frame)
      if (p) p.then((r) => {
        if (!r || r.gen !== state.gen || !state.enabled) return;
        const t = targetEv(ev100FromLuminance(r.luminanceCdM2), state.prior);
        if (state.awaiting || Math.abs(t - state.target) > 0.05) { state.settled = false; invalidate(); }
      });
    },
    /** Continuous until the eye has adapted (section 5.5); idle once settled. */
    demand() { return state.enabled && !state.settled ? 'continuous' : 'idle'; },
    get ev100() { return state.ev; },
    /** The exposure the prior alone would give (for surfaces that keep their classic relation to the scene). */
    expectedFor: (ev) => exposureFor(ev, state.mode, state.compensation + offsetEv),
    dispose() { if (meter) meter.dispose(); },
  };
  return sub;
}

export { ev100FromExposure };
