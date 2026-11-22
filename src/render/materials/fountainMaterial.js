// The fountain show's material on the new renderer (plan 01, section 7.12; task T2.11): fountain.js v6's
// ShaderMaterial ported to TSL, on the same InstancedMesh and attributes. One instance per jet: a soft
// camera-facing ribbon (position.z 0) and a mist quad at its foot (position.z 1), both moved in the vertex stage by a
// looping 80 s choreography from the shared show clock. White and translucent by day, lit from below at night.
//
// Differences from v6, each deliberate:
//  - a part that is not shown collapses onto its nozzle (zero area) instead of moving outside the clip volume;
//  - uPixel, the metres per pixel at 1 m, comes from the projection and the framebuffer instead of a uniform that
//    onBeforeRender set;
//  - the branches of v6's steady() whose factor is zero outside their part of the loop are evaluated without the
//    branch (a zero factor makes each a no-op there), and the shooters' schedule is a chain of selects;
//  - blending is premultiplied as before, but in the renderer's linear HDR target, before tone mapping (v6 blended
//    tone-mapped, sRGB-encoded colour); the fog is the shared haze with the legacy density.
import { DoubleSide, CustomBlending, OneFactor, OneMinusSrcAlphaFactor } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, attribute, varying, positionGeometry, cameraPosition, cameraWorldMatrix, cameraProjectionMatrix, screenSize,
  vec2, vec3, vec4, float, floor, fract, mod, sin, abs, pow, exp, sqrt, tan, min, max, clamp, mix, smoothstep, length,
  normalize, cross, select, Discard, If, densityFogFactor, uniform, acesFilmicToneMapping, sRGBTransferOETF,
} from 'three/tsl';
import { displayToScene } from './skyMaterials.js';
import { night as sharedNight, clock as sharedClock, haze as sharedHaze, physical as sharedPhysical, legacyScale as sharedLegacyScale } from './shared.js';

const LOOP = 80, G = 9.81, TAU = 6.2832;
export const FOG_DENSITY = 0.000014;

const span = (s, a, b, ramp) => smoothstep(a, a + ramp, s).mul(float(1).sub(smoothstep(b - ramp, b, s)));

/** v6 burst(): bottom and top (m above the water) of a column fired tau s ago that rises to h, open dur s */
function burst(tau, h, dur) {
  const v0 = sqrt(h.mul(2 * G)), ta = v0.div(G);
  const y0 = v0.mul(tau).sub(tau.mul(tau).mul(0.5 * G));
  const t1 = tau.sub(dur);
  const y1 = select(t1.greaterThan(0), v0.mul(t1).sub(t1.mul(t1).mul(0.5 * G)), float(0));
  const top = select(t1.lessThanEqual(ta).and(tau.greaterThanEqual(ta)), h, max(y0, y1));
  const bottom = max(min(y0, y1), 0);
  return { bottom: select(tau.lessThan(0), float(0), bottom), top: select(tau.lessThan(0), float(-1), top) };
}

/** v6 steady(): oarsmen and mini-shooters, jets whose height and lean follow the music */
function steady(s, type, fig, u, side, h0, tangent, normal) {
  const oars = type.lessThan(0.5), line = fig.lessThan(0.5), bigRing = fig.greaterThan(0.5).and(fig.lessThan(2.5));
  const zero2 = vec2(0);
  // 0-16 s: the oarsmen sweep down the front line; the big rings breathe
  const a = span(s, 0, 16, 1.5);
  const w = sin(s.div(3.2).sub(u.mul(4)).mul(TAU));
  let h = select(oars, h0.mul(a).mul(abs(w).mul(0.2).add(0.8)),
    select(bigRing, h0.mul(a).mul(sin(s.div(4).add(fig.mul(0.5)).mul(TAU)).mul(0.12).add(0.25)), float(0)));
  let lean = select(oars, tangent.mul(w.mul(a).mul(0.6)), zero2);
  // 16-30 s: a wave down the line, the oarsmen fan out in X shapes, the small rings chase around
  const b = span(s, 16, 30, 1.5);
  const chase = abs(fract(u.sub(s.mul(0.35))).sub(0.5));
  h = max(h, select(oars, h0.mul(b).mul(0.65),
    select(line, h0.mul(b).mul(pow(sin(u.mul(3).sub(s.mul(0.45)).mul(TAU)).mul(0.5).add(0.5), 2).mul(0.88).add(0.12)),
      select(bigRing, float(0), h0.mul(b).mul(exp(chase.mul(chase).mul(-60)).mul(0.85).add(0.15))))));
  lean = lean.add(select(oars, tangent.mul(side.mul(0.45).mul(b)), zero2));
  // 30-44 s: pulses; the big rings beat in turn, the line holds a low curtain, the oarsmen rock
  const c = span(s, 30, 44, 1.0);
  const beat = fract(s.div(2.4).add(fig.sub(1).mul(0.5)));
  h = max(h, select(oars, h0.mul(c).mul(0.5),
    select(bigRing, h0.mul(c).mul(exp(beat.mul(-6)).mul(0.8).add(0.2)), select(line, h0.mul(c).mul(0.28), float(0)))));
  lean = lean.add(select(oars, normal.mul(c.mul(0.35).mul(sin(s.mul(TAU / 2.4)))), zero2));
  // 44-58 s: the oarsmen cross, the rings hold, the line ripples low under the shooters
  const d = span(s, 44, 58, 1.5);
  h = max(h, select(oars, h0.mul(d).mul(0.85),
    select(line, h0.mul(d).mul(sin(u.mul(6).sub(s).mul(TAU)).mul(0.06).add(0.12)), h0.mul(d).mul(0.55))));
  lean = lean.add(select(oars, tangent.mul(side.mul(0.5).mul(d).mul(sin(s.mul(TAU / 4)).mul(0.4).add(0.6))), zero2));
  // 58-69 s: the finale, everything up
  const e = span(s, 58, 69, 1.0);
  h = max(h, select(oars, h0.mul(e), h0.mul(e).mul(sin(s.mul(0.8).sub(u.mul(2)).mul(TAU)).mul(0.15).add(0.85))));
  lean = lean.add(select(oars, tangent.mul(e.mul(0.55).mul(sin(s.div(1.6).sub(u.mul(3)).mul(TAU)))), normal.mul(e.mul(0.2))));
  return { bottom: float(0), top: h, lean, spread: float(1), mist: clamp(h.div(h0), 0, 1) };
}

/** v6 shooter(): super- and extreme-shooters, bursts that rise to their height and fall back as spray */
function shooter(s, type, fig, side, u, h0) {
  const extreme = type.greaterThan(2.5), line = fig.lessThan(0.5);
  const dur = select(extreme, float(2.4), float(1.6));
  // the last firing at or before s, in the order v6 tested them
  const pick = (t0, k, cond, t, kk) => [select(cond, float(t), t0), select(cond, float(kk), k)];
  let t0 = float(-1000), k = float(1);
  // extreme shooters: a first glimpse during the pulses, then the 140 m finale
  let te = t0, ke = k;
  [te, ke] = pick(te, ke, s.greaterThanEqual(36), 36, 0.5);
  [te, ke] = pick(te, ke, s.greaterThanEqual(61), 61, 1);
  // ring shooters fire on the beat, alternate ones on alternate beats; line shooters chase north to south
  const first = float(30).add(select(side.greaterThan(0), float(2.4), float(0))).add(select(fig.greaterThan(2.5), float(1.2), float(0)));
  let tr = t0, kr = k;
  for (let n = 0; n < 2; n++) {
    const t = first.add(n * 7.2), cond = s.greaterThanEqual(t);
    tr = select(cond, t, tr); kr = select(cond, float(0.35), kr);
  }
  [tr, kr] = pick(tr, kr, s.greaterThanEqual(50), 50, 0.6);
  const tl = u.mul(5).add(44), condL = s.greaterThanEqual(tl);
  let ts = select(line, select(condL, tl, t0), tr), ks = select(line, select(condL, float(1), k), kr);
  [ts, ks] = pick(ts, ks, s.greaterThanEqual(58.5), 58.5, 1);
  [ts, ks] = pick(ts, ks, s.greaterThanEqual(68), 68, 0.6);
  t0 = select(extreme, te, ts); k = select(extreme, ke, ks);
  const h = h0.mul(k), tau = s.sub(t0);
  const col = burst(tau, h, dur);
  const ta = sqrt(h.mul(2).div(G));
  const falling = clamp(tau.sub(ta).div(ta), 0, 1);
  const mist = smoothstep(ta.mul(0.7), ta.mul(1.6), tau).mul(float(1).sub(smoothstep(ta.mul(2).add(1), ta.mul(2).add(6), tau)));
  // falling spray stretches out; the column fattens as it rises and opens into spray as it falls
  const bottom = max(min(col.bottom, col.top.sub(h.mul(falling.mul(0.4).add(0.12)))), 0);
  const spread = clamp(tau.div(ta), 0.25, 1).add(select(extreme, float(2.2), float(1.6)).mul(falling));
  return { bottom, top: col.top, lean: vec2(0), spread, mist };
}

/**
 * The node material for createFountain()'s InstancedMesh. `pixel` overrides the metres-per-pixel node (tests).
 * Uses the shared night, clock and haze uniforms unless given others.
 */
export function createFountainMaterial({ night = sharedNight, clock = sharedClock, haze = sharedHaze, physical = sharedPhysical, legacyScale = sharedLegacyScale } = {}) {
  const material = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: DoubleSide, fog: false,
    blending: CustomBlending, blendSrc: OneFactor, blendDst: OneMinusSrcAlphaFactor,
  });
  const jetAt = attribute('jetAt', 'vec3'), jetKind = attribute('jetKind', 'vec4'), jetAxis = attribute('jetAxis', 'vec4');
  const type = jetKind.x, fig = jetKind.y, u = jetKind.z;
  const side = select(floor(jetKind.w).greaterThan(0.5), float(1), float(-1)), seed = fract(jetKind.w);
  const tangent = jetAxis.xy, normal = jetAxis.zw;
  // published heights: 77, 100, 240 and 460 ft
  const h0 = select(type.lessThan(0.5), float(23.5), select(type.lessThan(1.5), float(30.5), select(type.lessThan(2.5), float(73.2), float(140.2))))
    .mul(seed.mul(0.12).add(0.94));
  const s = mod(clock, LOOP);
  const st = steady(s, type, fig, u, side, h0, tangent, normal), sh = shooter(s, type, fig, side, u, h0);
  const isSteady = type.lessThan(1.5), isBurst = type.greaterThan(1.5);
  const pick = (k) => select(isSteady, st[k], sh[k]);
  const j = { bottom: pick('bottom'), top: pick('top'), lean: select(isSteady, st.lean, sh.lean), spread: pick('spread'), mist: pick('mist') };

  const pos = positionGeometry, v = pos.y, isMist = pos.z.greaterThan(0.5);
  // metres per pixel at 1 m: 2 tan(fov / 2) / framebuffer height, from the projection (P[1][1] = 1 / tan(fov / 2))
  const pixel = float(2).div(cameraProjectionMatrix.element(1).y.mul(screenSize.y).max(1));

  // the ribbon
  const leanLen = length(j.lean);
  const dir = select(leanLen.greaterThan(1e-4), j.lean.div(leanLen.max(1e-6)), tangent);
  const q = v.mul(smoothstep(0.08, 0.35, leanLen).mul(0.6).add(1));
  const reach = j.top.mul(2).mul(tan(min(leanLen, 1.1)));
  const steadyP = jetAt.add(vec3(dir.x.mul(reach).mul(q), j.top.mul(q.mul(2).sub(q.mul(q))), dir.y.mul(reach).mul(q)));
  const steadyAxis = normalize(vec3(dir.x.mul(reach), j.top.mul(q.mul(-2).add(2)).add(1e-3), dir.y.mul(reach)));
  const burstP = jetAt.add(vec3(0, mix(j.bottom, j.top, v), 0));
  const center = select(isBurst, burstP, steadyP);
  const axis = select(isBurst, vec3(0, 1, 0), steadyAxis);
  const baseW = select(type.lessThan(1.5), float(0.5), select(type.lessThan(2.5), float(1.0), float(1.6)));
  const topW = select(type.lessThan(0.5), float(2.2), select(type.lessThan(1.5), float(2.0), select(type.lessThan(2.5), float(5.0), float(10.0))));
  const w = select(isBurst, topW.mul(j.spread).mul(mix(0.6, 1.0, v)), mix(baseW, topW, v).mul(j.spread));
  const toEye = cameraPosition.sub(center);
  const dist = max(length(toEye), 1);
  const acrossRaw = cross(axis, toEye.div(dist));
  const acrossLen = length(acrossRaw);
  const across = select(acrossLen.greaterThan(1e-3), acrossRaw.div(acrossLen.max(1e-6)), vec3(1, 0, 0));
  // never thinner than about a pixel and a half; a widened jet gets fainter so it keeps its brightness
  const ww = max(w, pixel.mul(1.5).mul(dist));
  const alpha0 = select(type.lessThan(0.5), float(0.32), select(type.lessThan(1.5), float(0.28), select(type.lessThan(2.5), float(0.5), float(0.55))));
  const ribbonAlpha = alpha0.mul(w.div(ww)).mul(seed.mul(0.3).add(0.85));
  const ribbonP = center.add(across.mul(pos.x.mul(0.5).mul(ww)));
  const ribbonShown = j.top.sub(j.bottom).greaterThanEqual(0.05);

  // the mist at the foot of a jet while its water falls back (every shooter, about one steady jet in five)
  const size = select(type.lessThan(1.5), float(5), select(type.lessThan(2.5), float(16), float(34)));
  const amount = j.mist.mul(select(isBurst.or(seed.lessThan(0.22)), float(1), float(0)));
  const right = cameraWorldMatrix.element(0).xyz, up = cameraWorldMatrix.element(1).xyz;
  const mistP = jetAt.add(vec3(0, size.mul(0.35), 0)).add(right.mul(pos.x).add(up.mul(pos.y.mul(0.6))).mul(size));
  const mistShown = amount.greaterThanEqual(0.01);

  const shown = select(isMist, mistShown, ribbonShown);
  // a part that is not shown collapses onto its nozzle: zero area, nothing drawn
  material.positionNode = select(shown, select(isMist, mistP, ribbonP), jetAt);

  const vUv = varying(pos.xy, 'vJetUv');
  const vMist = varying(pos.z, 'vJetMist');
  const vSeed = varying(seed, 'vJetSeed');
  const vAlpha = varying(select(shown, select(isMist, amount.mul(0.1), ribbonAlpha), float(0)), 'vJetAlpha');
  const vTail = varying(select(isBurst.and(j.bottom.greaterThan(0.5)), float(1), float(0)), 'vJetTail');

  material.fragmentNode = Fn(() => {
    const mistA = vAlpha.mul(float(1).sub(smoothstep(0.15, 1.0, length(vUv))));
    const mistCol = mix(vec3(0.9, 0.93, 0.96), vec3(1.0, 0.96, 0.9).mul(1.3), night);
    const acrossF = float(1).sub(vUv.x.mul(vUv.x));
    const streak = sin(vUv.y.mul(37).add(vSeed.mul(40)).sub(clock.mul(9))).mul(0.25).add(0.75);
    const jetA = vAlpha.mul(acrossF).mul(acrossF).mul(streak).mul(smoothstep(0.0, 0.05, vUv.y))
      .mul(float(1).sub(smoothstep(0.55, 1.0, vUv.y).mul(0.7)))
      .mul(mix(float(1), smoothstep(0.0, 0.4, vUv.y), vTail)); // a column off the water trails away as spray
    // lit from the lights at the nozzles: brightest at the foot
    const jetCol = mix(vec3(0.93, 0.96, 1.0), vec3(1.0, 0.97, 0.9).mul(mix(2.6, 1.1, vUv.y)), night);
    const m = vMist.greaterThan(0.5);
    const a = select(m, mistA, jetA);
    If(a.lessThan(0.002), () => { Discard(); });
    const fogged = mix(select(m, mistCol, jetCol), haze, densityFogFactor(uniform(FOG_DENSITY)));
    // premultiplied: ordinary see-through water by day, mostly added light at night.
    // Classic look: v6 tone-mapped and encoded the colour, premultiplied it and blended in display space. Here the
    // blend is in the linear HDR buffer before tone mapping, so the premultiplied display colour is turned back into
    // the scene value that shows as it: exact over a black background, close over the dark night city. Physical look:
    // the show's light is a legacy surface until phase 4, scaled like the dome (T2.5).
    const classicRgb = displayToScene(sRGBTransferOETF(acesFilmicToneMapping(fogged, float(1))).mul(a));
    const rgb = mix(classicRgb, fogged.mul(legacyScale).mul(a), physical);
    return vec4(rgb, a.mul(float(1).sub(night.mul(0.7))));
  })();
  return material;
}
