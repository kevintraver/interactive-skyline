// The driver's night adaptation (plan 02, third stretch, decision 13): a node stage at the pipeline's `afterBloom`
// slot, the last scene-referred one before tone mapping, registered by the session while Drive is shown on plan 01's
// renderer in the shipped look (never at ?display=classic, never on the classic renderer).
//
// Why. Plan 01's Eye exposure lowers its key to 0.005 at night (src/render/exposure.js, eyeKey): fitted so that a city
// seen from the air reads as night, with its sources authored to sit near 1.2 to 1.4 in the pre-exposed buffer
// (windows 30 cd/m^2, LED skins 36). A road at 0.25 to 1 cd/m^2 then lands near 0.01 and is drawn black. A driver's
// eye adapts to the road it looks at. So the dim part of the frame is lifted and the bright part left where it is:
//
//   out = c g / (1 + (g - 1) Y(c) / W)
//
// with Y the luminance of c (Rec. 709, the working space) in the pre-exposed buffer. Every channel is scaled by the
// same factor, so the hue is kept. A value with Y = W is unchanged; far below W the factor is g; far above it the
// luminance approaches W g / (g - 1) and never passes it (monotonic). It runs on the whole frame, plan 01's buildings
// and sky included, so nothing is tuned class by class; it runs after the scene pass, so pipeline.probe() (which
// reads the scene pass) does not see it.
//
// The gain follows the light as plan 01's eye key does: 1 at EV100 9 and above (by day the stage is the identity, bit
// for bit: the shader passes the colour through untouched when g is 1), G at EV100 1 and below, log-linear in between
// (g = G^(1 - t), t = (EV - 1) / 8, as eyeKey is log-linear in its key). The EV is plan 01's env.state.exposure.ev100
// (section 11.4: the EV100 of the horizontal illuminance), the contract's quantity; the look's own prior is not
// part of the contract. It runs a little lower than the prior at dusk (it leaves out the city's light), so the lift
// starts a little earlier in twilight than the key falls; by night both are below 1 and the gain is G.
//
// G and W (ADAPTATION) were fitted by measuring the displayed frame (tests/manual/night-display.mjs, 2026-11-24, WebGPU)
// and by looking. W = 1.2: plan 01's windows, LED skins and the boards' white (authored near 1.2 to 1.4 in the buffer)
// stay at +1.65 to +1.9 stops on the display and unclipped for every G tried (2 to 4). G = 2, not the analysis' 4:
// the shipped display's contrast lift (plan 01, src/render/look.js SHIPPED_DISPLAY contrast 0.08, applied around 0.5
// in sRGB) clips display values under about 0.003 to black, and AgX's toe is steep just above that, so a lift of the
// buffer by g shows on screen as far more than g at the bottom: at G = 4 the road at 30 m in the low beam was 1 stop
// under mid-grey (wanted 2 to 4) and the night sky 3.4 under (wanted under 4). At G = 2 the low beam's road reads at
// -0.4, -2.3 and -6.1 stops at 10, 30 and 60 m, the road under the lamps 40 to 150 m ahead at -3.5 (it was -5.4), the
// desert sky at -5.5, with the pavement's return (headlamps.node.js) in.

import { Fn, vec4, vec3, float, dot, max, select, uniform } from 'three/tsl';

/** The stage's constants. G: the night gain; W: the buffer luminance left unchanged; the EV100 ends of the ramp. */
export const ADAPTATION = Object.freeze({ G: 2, W: 1.2, dayEv: 9, nightEv: 1 });

const LUMA = [0.2126, 0.7152, 0.0722];
/** Rec. 709 luminance of linear RGB. */
export const lumaOf = (c) => LUMA[0] * c[0] + LUMA[1] * c[1] + LUMA[2] * c[2];

/** The gain for a scene EV100: 1 by day, G by night, log-linear in between; 1 when the EV is unknown. */
export function adaptationGain(ev100, { G = ADAPTATION.G, dayEv = ADAPTATION.dayEv, nightEv = ADAPTATION.nightEv } = {}) {
  if (!Number.isFinite(ev100)) return 1;
  const t = Math.min(1, Math.max(0, (ev100 - nightEv) / (dayEv - nightEv)));
  return t >= 1 ? 1 : G ** (1 - t);
}

/** The CPU twin of the stage: out = c g / (1 + (g - 1) Y / W); exactly c when g is 1. */
export function adaptRgb(c, g, W = ADAPTATION.W) {
  if (!(g > 1)) return c.slice();
  const k = g / (1 + ((g - 1) * Math.max(lumaOf(c), 0)) / W);
  return [c[0] * k, c[1] * k, c[2] * k];
}

/**
 * The stage's node: the colour passed through untouched while `gain` is 1 or less.
 * @param {{ color: object }} inputs the pipeline's stage inputs  @param {object} gain a float uniform  @param {number} W
 */
export function adaptationNode({ color }, gain, W = ADAPTATION.W) {
  return Fn(() => {
    const c = vec4(color);
    const y = max(dot(c.rgb, vec3(...LUMA)), 0);
    const k = gain.div(float(1).add(gain.sub(1).mul(y).div(W)));
    return select(gain.greaterThan(1), vec4(c.rgb.mul(k), c.a), c);
  })();
}

/**
 * Register the stage on plan 01's pipeline. `ev100()` gives the scene's EV100 for the frame being drawn.
 * @param {{ pipeline: object, ev100: () => number, G?: number, W?: number }} o
 * @returns {{ readonly gain: number, setEnabled(on: boolean): void, readonly enabled: boolean, setPeak(g: number): void, remove(): void }}
 */
export function createAdaptationStage({ pipeline, ev100, G = ADAPTATION.G, W = ADAPTATION.W }) {
  let enabled = true, peak = G;
  const gainOf = () => (enabled ? adaptationGain(ev100(), { G: peak }) : 1);
  const gain = uniform(1).setName('uDriveAdaptGain');
  gain.onRenderUpdate(() => gainOf());
  const remove = pipeline.addStage({ id: 'drive-adaptation', at: 'afterBloom', node: (inputs) => adaptationNode(inputs, gain, W) });
  return {
    /** The gain the next frame is drawn with (1 when switched off). */
    get gain() { return gainOf(); },
    get enabled() { return enabled; },
    /** A test hook: off, the stage passes every frame through untouched. */
    setEnabled(on) { enabled = !!on; },
    /** A tuning hook (tests/manual/night-display.mjs --gain): the night gain G. */
    setPeak(g) { peak = Math.max(1, Number(g) || 1); },
    get peak() { return peak; },
    remove,
  };
}
