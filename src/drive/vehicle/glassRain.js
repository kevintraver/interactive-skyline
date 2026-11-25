// Rain on the windshield (plan 02, D8.2; third stretch, decisions 3 and 8). The rules are drops.js and wipers.js, and
// what the shaders get each frame is glassRainFeed.js.
//
//   drops  one instance per site and kind (0 the sitting drop, 1 and 2 the latest two runners): the vertex stage is
//          drops.js evalSite line for line (the same hash, bins, epoch, merging, running, wiper passes); each drop is
//          a small lens: the scene behind it flipped and shrunk (MAG times its radius, so the scene around it shows in
//          it upside down and nearby lamps as bright points), a dark rim (light from the dark cabin, refracted at the
//          drop's steep edge), a highlight of the sky on its upper side; runners leave a thin trail.
//   film   a grid over the glass: per fragment the time since a blade last passed (wipers.js passAgoAt); the fine mist
//          of small drops that re-wets the cleared glass first (micro-drops in MIST_CELL cells, each there once its
//          hashed arrival time, exponential at the mist's rate, has passed since the last wipe; everywhere outside the
//          wiped area), a soft haze of the water film over the mist, and the thin smeared film just behind the blade
//          that dries within FILM_S.
//   blades the two wipers: a dark arm and blade along each blade's line, averaged over the exposure (uQ: the sweep
//          fraction at 12 instants over it), so they blur, and at fast clock rates become a steady fan (wipers.js
//          comfortOf).
//
//   - The film, the drops and the blades are drawn after the scene pass into a glass layer of their own (a half-float
//     target the size of the scene pass), and they read the scene pass's own resolved colour, which is complete by
//     then. A node stage at `beforeBloom` lays the layer over the scene's colour ("over", with the layer's alpha).
//   - The layer is drawn from a node of that stage (its updateBefore), after the scene pass and before the composite,
//     only while it rains; the cabin's silhouette is drawn into the layer's depth first, so the dashboard, the pillars and
//     the mirror hide the rain behind them. Dry, nothing is drawn and the composite reads nothing (a branch on a uniform).
//   - Linear HDR throughout: the drops refract scene-referred light, the sky caught on a drop is the sky's luminance
//     (the haze's tone at the horizontal illuminance over pi, times the pre-exposure), and the blades are dark rubber in
//     that light.
//   - Texture orientation: the scene's colour is sampled at screenUV (top-left origin, as three samples render targets
//     on both backends), so the drops' centres are computed in the same orientation.
//   - The rain is composited before the bloom, so the drops get no halo; the windshield's veil (drawn in the scene pass)
//     is under the drops.

import * as THREE from 'three';
import { Mesh, MeshBasicNodeMaterial, RenderTarget, HalfFloatType, Node, NodeUpdateType } from 'three/webgpu';
import {
  Fn, If, Loop, Discard, uniform, uniformArray, texture, attribute, instanceIndex, positionGeometry, modelViewMatrix,
  cameraProjectionMatrix, screenUV, screenSize, varyingProperty, vec2, vec3, vec4, float, int, uint, select, clamp, min, max,
  abs, floor, length, dot, exp, pow, sin, acos, atan, mix, smoothstep, fwidth, normalize,
} from 'three/tsl';
import { DROP, glassOf, siteLayout } from './drops.js';
import { WIPERS } from './veil.js';
import { createTimings } from '../timing.js';
import { createRainFeed, SAMPLES, MAG, MIST_CELL } from './glassRainFeed.js';

const NONE = 1.0e6;
const DEG = 180 / Math.PI;
const FILM_S = 0.35, MIST_MAX = 0.45;
const K = { r0: DROP.R0_M * DROP.SIZE_GAIN };

/** The rain's uniforms; their values are what glassRainFeed.js writes (the `out` it is given). */
function rainUniforms(glass, layout, corners) {
  const { bottomLeft: BL, bottomRight: BR, topRight: TR, topLeft: TL } = corners;
  return {
    bins: uniformArray(Array.from({ length: DROP.BINS }, () => new THREE.Vector4()), 'vec4'),
    k0: uniform(0, 'uint'), tw: uniform(0), renewOffset: uniform(0), wipe: uniform(new THREE.Vector4(0, 1, 1, 0)),
    wiperP: uniformArray(WIPERS.map((w) => new THREE.Vector4(w.x, w.y, w.rIn, w.rOut)), 'vec4'),
    wiperA: uniformArray(WIPERS.map((w) => new THREE.Vector4(w.a0, w.a1, 0, 0)), 'vec4'),
    layout: uniform(new THREE.Vector4(glass.W, glass.H, layout.nx, layout.ny)),
    BL: uniform(BL.clone()), BR: uniform(BR.clone()), TL: uniform(TL.clone()), TR: uniform(TR.clone()),
    comfort: uniform(0), mistRate: uniform(0), haze: uniform(0), mag: uniform(MAG),
    q: uniformArray(new Array(SAMPLES).fill(0), 'float'), qStep: uniform(0), qRange: uniform(new THREE.Vector2()),
    sky: uniform(new THREE.Color(0, 0, 0)), blade: uniform(new THREE.Color(0.02, 0.02, 0.022)),
  };
}

// ------------------------------------------------------------------ common
const U32 = (v) => uint(v >>> 0);
function commonFns(u) {
  const hash3 = Fn(([a, b, c]) => {
    const h = a.mul(U32(0x9e3779b1)).bitXor(b.mul(U32(0x85ebca77))).bitXor(c.mul(U32(0xc2b2ae3d))).toVar();
    h.assign(h.bitXor(h.shiftRight(U32(16))));
    h.assign(h.mul(U32(0x7feb352d)));
    h.assign(h.bitXor(h.shiftRight(U32(15))));
    h.assign(h.mul(U32(0x846ca68b)));
    h.assign(h.bitXor(h.shiftRight(U32(16))));
    return float(h.shiftRight(U32(8))).div(16777216.0);
  }).setLayout({ name: 'grHash3', type: 'float', inputs: [{ name: 'a', type: 'uint' }, { name: 'b', type: 'uint' }, { name: 'c', type: 'uint' }] });

  // how long ago the blades passed the sweep fraction q (wipers.js passAgoAtPhase). Inline, not a layout function: three
  // r187 does not bind uniforms that only a layout function reads
  const passAgoPhase = (q0) => {
    const W = u.wipe;
    const q = clamp(q0, 0, 1);
    const up = W.y.div(6.283185307).mul(acos(float(1).sub(q.mul(2))));
    const dn = W.y.sub(up);
    const a0 = W.x.sub(up), b0 = W.x.sub(dn);
    const a = select(a0.lessThan(0), a0.add(W.z), a0), b = select(b0.lessThan(0), b0.add(W.z), b0);
    return select(W.w.lessThan(0.5), float(NONE), min(a, b));
  };

  // ... and the glass point p (wipers.js passAgoAt); NONE outside the swept area
  const passAgo = (p0) => {
    const p = vec2(p0).toVar();
    const best = float(NONE).toVar();
    for (let w = 0; w < 2; w++) {
      const P = u.wiperP.element(w), A = u.wiperA.element(w);
      const d = p.sub(P.xy).toVar();
      const r = length(d);
      const a = atan(d.y, d.x).mul(DEG).toVar();
      const inside = r.greaterThanEqual(P.z).and(r.lessThanEqual(P.w)).and(a.greaterThanEqual(A.x)).and(a.lessThanEqual(A.y));
      If(inside, () => { best.assign(min(best, passAgoPhase(a.sub(A.x).div(A.y.sub(A.x))))); });
    }
    return best;
  };

  const glassPoint = (p) => {
    const st = p.div(u.layout.xy);
    return mix(mix(u.BL, u.BR, st.x), mix(u.TL, u.TR, st.x), st.y);
  };

  return { hash3, passAgoPhase, passAgo, glassPoint };
}

/** GLSL's mod (floored), which WGSL's % is not. */
const fmod = (x, y) => x.sub(floor(x.div(y)).mul(y));
const clip = (p) => cameraProjectionMatrix.mul(modelViewMatrix.mul(vec4(p, 1)));

// ------------------------------------------------------------------ drops
const vLocal = varyingProperty('vec2', 'vGrLocal');
const vUp = varyingProperty('vec2', 'vGrUp');
const vTrail = varyingProperty('float', 'vGrTrail');
const vAlpha = varyingProperty('float', 'vGrAlpha');
const vCentre = varyingProperty('vec2', 'vGrCentre');

function dropsVertex(u, f) {
  const { hash3, passAgo, glassPoint } = f;
  return Fn(() => {
    const inst = int(instanceIndex).toVar();
    const site = inst.div(3).toVar();
    const kind = inst.sub(site.mul(3)).toVar();
    const i = uint(site).toVar();
    const nx = int(u.layout.z.add(0.5));
    const iy = site.div(nx).toVar();
    const ix = site.sub(iy.mul(nx));
    const cell = u.layout.xy.div(u.layout.zw).toVar();
    const c = vec2(float(ix), float(iy)).add(0.5).mul(cell).toVar();
    const Lc = passAgo(c).toVar();
    const since = fmod(u.renewOffset.add(u.tw).sub(hash3(i, uint(81), uint(7)).mul(DROP.RENEW_S)), float(DROP.RENEW_S)).toVar();
    const e = max(max(u.tw.sub(Lc), u.tw.sub(since)), 0).toVar();
    const nRun0 = float(DROP.N_RUN_MIN).add(floor(hash3(i, uint(82), uint(7)).mul(DROP.N_RUN_SPAN))).toVar();
    const j0 = max(int(0), int(floor(e.div(DROP.BIN_S)))).toVar();
    const j1 = min(int(DROP.BINS - 1), int(floor(u.tw.div(DROP.BIN_S)))).toVar();
    const n = float(0).toVar(), born = float(0).toVar();
    const firstK = uint(0).toVar();
    const r1t = float(-1).toVar(), r1n = float(0).toVar(), r2t = float(-1).toVar(), r2n = float(0).toVar();
    const r1k = uint(0).toVar(), r2k = uint(0).toVar();
    Loop({ start: j0, end: j1, type: 'int', condition: '<=' }, ({ i: j }) => {
      const k = u.k0.add(uint(j)).toVar();
      const bin = u.bins.element(j);
      const p = min(1, bin.x.mul(0.5));
      const a = select(hash3(i, k, uint(1)).lessThan(p), float(1), float(0)).add(select(hash3(i, k, uint(2)).lessThan(p), float(1), float(0))).toVar();
      If(a.greaterThan(0), () => {
        const ta = float(j).add(hash3(i, k, uint(3))).mul(DROP.BIN_S).toVar();
        If(ta.greaterThan(e).and(ta.lessThanEqual(u.tw)), () => {
          If(n.equal(0), () => { firstK.assign(k); born.assign(ta); });
          n.addAssign(a);
          const nRun = max(1, floor(nRun0.div(float(1).add(max(0, bin.w.div(DROP.V_RUN)).mul(DROP.RUN_SPEED_K))).add(0.5)));
          If(n.greaterThanEqual(nRun), () => {
            r2t.assign(r1t); r2n.assign(r1n); r2k.assign(r1k);
            r1t.assign(ta); r1n.assign(n); r1k.assign(firstK);
            n.assign(0);
          });
        });
      });
    });
    const pos = vec2(c).toVar();
    const rad = float(0).toVar(), alpha = float(0).toVar(), trail = float(0).toVar();
    const dir = vec2(0, 1).toVar();
    If(kind.equal(0), () => {
      If(n.greaterThan(0), () => {
        pos.assign(c.add(vec2(hash3(i, firstK, uint(4)), hash3(i, firstK, uint(5))).sub(0.5).mul(cell).mul(DROP.JITTER)));
        If(passAgo(pos).lessThan(u.tw.sub(born)).not(), () => {
          alpha.assign(clamp(float(DROP.RENEW_S).sub(since).div(DROP.RENEW_FADE_S), 0, 1));
        });
        rad.assign(pow(n, 1 / 3).mul(K.r0));
      });
    }).Else(() => {
      const rt = select(kind.equal(1), r1t, r2t).toVar();
      const rn = select(kind.equal(1), r1n, r2n).toVar();
      const rk = select(kind.equal(1), r1k, r2k).toVar();
      const age = u.tw.sub(rt).toVar();
      If(rt.greaterThanEqual(0).and(age.lessThanEqual(DROP.RUN_LIFE_S)), () => {
        const s0 = c.add(vec2(hash3(i, rk, uint(4)), hash3(i, rk, uint(5))).sub(0.5).mul(cell).mul(DROP.JITTER)).toVar();
        const side = s0.x.sub(u.layout.x.mul(0.5)).div(u.layout.x.mul(0.5)).toVar();
        // drift(t): the runners' integral at t
        const drift = (t) => {
          const jj = clamp(int(floor(t.div(DROP.BIN_S))), int(0), int(DROP.BINS - 1));
          const b = u.bins.element(jj);
          const dt = t.sub(float(jj).mul(DROP.BIN_S));
          return vec2(b.y.add(dt.mul(b.w)), b.z.add(dt.mul(abs(b.w))));
        };
        const dn = drift(u.tw).toVar(), d0 = drift(rt).toVar();
        pos.assign(s0.add(vec2(side.mul(DROP.SIDE).mul(dn.y.sub(d0.y)), dn.x.sub(d0.x))));
        const inside = pos.x.greaterThanEqual(0).and(pos.y.greaterThanEqual(0)).and(pos.x.lessThanEqual(u.layout.x)).and(pos.y.lessThanEqual(u.layout.y));
        If(inside.and(passAgo(pos).lessThan(age).not()), () => {
          alpha.assign(clamp(float(DROP.RUN_LIFE_S).sub(age).div(0.6), 0, 1));
          rad.assign(pow(rn, 1 / 3).mul(K.r0 * 0.85));
          const vy = u.bins.element(j1).w;
          const v = vec2(side.mul(DROP.SIDE).mul(abs(vy)), vy).toVar();
          dir.assign(select(length(v).greaterThan(1e-5), normalize(v), vec2(0, -1)));
          trail.assign(min(length(pos.sub(s0)), 0.04).div(rad));
        });
      });
    });
    // at fast clock rates the wiped glass refills many times a second: its drops are drawn fainter (4.11)
    If(Lc.lessThan(NONE), () => { alpha.mulAssign(float(1).sub(u.comfort.mul(0.7))); });
    const out = vec4(2, 2, 2, 1).toVar();
    vAlpha.assign(0);
    vLocal.assign(vec2(0)); vUp.assign(vec2(0, 1)); vTrail.assign(0); vCentre.assign(vec2(0.5));
    If(alpha.greaterThan(0), () => {
      const across = vec2(dir.y.negate(), dir.x);
      const along = mix(trail.add(1.25).negate(), float(1.25), positionGeometry.x.mul(0.5).add(0.5));
      const acr = positionGeometry.y.mul(1.25);
      const p = pos.add(dir.mul(along).add(across.mul(acr)).mul(rad));
      vLocal.assign(vec2(along, acr));
      vUp.assign(vec2(dir.y, across.y));
      vTrail.assign(trail);
      vAlpha.assign(alpha);
      const cc = clip(glassPoint(pos));
      const ndc = cc.xy.div(cc.w);
      // in screenUV's orientation (top-left origin), where the scene's colour is sampled
      vCentre.assign(vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5))));
      out.assign(clip(glassPoint(p)));
    });
    return out;
  })();
}

function dropsColor(u, frameTex) {
  return Fn(() => {
    const tap = (st) => texture(frameTex, clamp(st, vec2(0.001), vec2(0.999))).rgb;
    const l = vLocal;
    const aa = max(fwidth(l.x), fwidth(l.y)).toVar();
    const rh = length(l).toVar();
    const head = float(1).sub(smoothstep(float(1).sub(aa), float(1).add(aa), rh)).toVar();
    const tr = float(0).toVar();
    If(vTrail.greaterThan(0).and(l.x.lessThan(0)).and(l.x.greaterThan(vTrail.negate())), () => {
      const uu = l.x.negate().div(vTrail);
      const w = max(float(1).sub(uu.mul(0.6)).mul(0.45), aa.mul(0.6));
      tr.assign(float(1).sub(smoothstep(w.sub(aa), w.add(aa), abs(l.y))).mul(0.75).mul(float(1).sub(uu.mul(0.8))));
    });
    const a = max(head, tr).mul(vAlpha).toVar();
    Discard(a.lessThan(0.004));
    const fuv = screenUV;
    const res = screenSize;
    const col = vec3(0).toVar();
    If(head.greaterThanEqual(tr), () => {
      // the lens: the scene around the drop, flipped through its centre and shrunk; four taps leaning to the brightest
      const d = fuv.sub(vCentre);
      const s = vCentre.sub(d.mul(u.mag));
      const px = u.mag.mul(0.35).div(res);
      const t0 = tap(s.add(vec2(px.x, px.y))), t1 = tap(s.add(vec2(px.x.negate(), px.y))), t2 = tap(s.add(vec2(px.x, px.y.negate()))), t3 = tap(s.sub(px));
      const avg = t0.add(t1).add(t2).add(t3).mul(0.25).toVar();
      const mx = max(max(t0, t1), max(t2, t3));
      col.assign(mix(avg, mx, 0.5));
      const rim = smoothstep(0.45, 1.0, rh);
      col.mulAssign(float(1).sub(rim.mul(rim).mul(0.65)));
      const h = l.sub(vUp.mul(0.42));
      col.addAssign(u.sky.mul(1.1).mul(exp(dot(h, h).negate().div(0.025))));
      col.addAssign(avg.mul(0.35).mul(smoothstep(0.55, 0.95, rh)).mul(max(0, dot(l.div(max(rh, 1e-3)), vUp).negate())));
    }).Else(() => {
      // the trail: a thin film of water, a slight shift (two pixels up the screen) and a darker edge
      col.assign(tap(fuv.sub(vec2(0, 2).div(res))).mul(float(0.8).sub(smoothstep(0.2, 0.45, abs(l.y)).mul(0.25))).add(u.sky.mul(0.08)));
    });
    return vec4(col, a);
  })();
}

// ------------------------------------------------------------------ film
function filmColor(u, f, frameTex) {
  const { hash3, passAgo } = f;
  return Fn(() => {
    const tap = (st) => texture(frameTex, clamp(st, vec2(0.001), vec2(0.999))).rgb;
    const g = attribute('aGlass', 'vec2');
    const L = passAgo(g).toVar();
    const swept = L.lessThan(NONE);
    const Lm = select(swept, mix(L, u.wipe.z.mul(0.5), u.comfort), float(1000));
    const mist = float(1).sub(exp(Lm.negate().mul(u.mistRate))).toVar();
    const film = select(swept, exp(L.negate().div(FILM_S)).mul(float(1).sub(u.comfort)), float(0)).toVar();
    const fuv = screenUV;
    const texel = vec2(1).div(screenSize).toVar();
    const scale = screenSize.y.div(720).toVar();
    const c = vec3(0).toVar(), a = float(0).toVar();
    const hz = mist.mul(u.haze);
    If(hz.greaterThan(0.01), () => {
      const o = vec2(1.6, 1.2).mul(scale).mul(texel);
      c.assign(tap(fuv.add(o)).add(tap(fuv.sub(o))).mul(0.5).mul(hz));
      a.assign(hz);
    });
    If(film.greaterThan(0.01), () => {
      const ripple = sin(dot(g, vec2(330.0, 910.0)).add(sin(g.x.mul(47.0).add(g.y.mul(23.0))).mul(3)));
      const fc = tap(fuv.add(texel.mul(ripple.mul(2.5).mul(scale)))).mul(0.97).add(u.sky.mul(0.04));
      const fa = film.mul(0.75);
      c.assign(fc.mul(fa).add(c.mul(float(1).sub(fa))));
      a.assign(fa.add(a.mul(float(1).sub(fa))));
    });
    If(mist.greaterThan(0.002), () => {
      const gg = g.div(MIST_CELL);
      const ci = floor(gg), fr = gg.sub(ci);
      const cid = uint(int(ci.x).add(2048)).mul(uint(4096)).add(uint(int(ci.y).add(2048))).toVar();
      If(hash3(cid, uint(91), uint(3)).lessThan(mist.mul(MIST_MAX)), () => {
        const mc = vec2(hash3(cid, uint(92), uint(3)), hash3(cid, uint(93), uint(3))).mul(0.5).add(0.25);
        const mr = hash3(cid, uint(94), uint(3)).mul(0.2).add(0.16);
        const dl = fr.sub(mc).div(mr).toVar();
        const md = length(dl).toVar();
        const aa = fwidth(md);
        const cov = float(1).sub(smoothstep(float(1).sub(aa), float(1).add(aa), md)).toVar();
        If(cov.greaterThan(0), () => {
          const h = dl.sub(vec2(-0.25, 0.4));
          const mcol = tap(fuv.sub(dl.mul(6).mul(scale).mul(texel))).mul(float(1).sub(smoothstep(0.5, 1.0, md).mul(0.2)))
            .add(u.sky.mul(0.35).mul(exp(dot(h, h).negate().div(0.06))));
          const ma = cov.mul(0.45);
          c.assign(mcol.mul(ma).add(c.mul(float(1).sub(ma))));
          a.assign(ma.add(a.mul(float(1).sub(ma))));
        });
      });
    });
    Discard(a.lessThan(0.002));
    return vec4(c.div(max(a, 1e-6)), a);
  })();
}

// ------------------------------------------------------------------ blades
function bladeColor(u) {
  return Fn(() => {
    const g = attribute('aGlass', 'vec2');
    const wi = attribute('aWiper', 'float');
    const P = select(wi.greaterThan(0.5), u.wiperP.element(1), u.wiperP.element(0)).toVar();
    const A = select(wi.greaterThan(0.5), u.wiperA.element(1), u.wiperA.element(0)).toVar();
    const d = g.sub(P.xy).toVar();
    const r = length(d).toVar();
    const px = max(fwidth(g.x), fwidth(g.y)).toVar();
    const span = A.y.sub(A.x).div(DEG).toVar();
    const a0 = A.x.div(DEG);
    const phi = atan(d.y, d.x);
    const slack = float(0.012).div(max(r, 0.02)).add(u.qStep.mul(span));
    Discard(r.greaterThan(0.02).and(phi.lessThan(a0.add(span.mul(u.qRange.x)).sub(slack)).or(phi.greaterThan(a0.add(span.mul(u.qRange.y)).add(slack)))));
    const cov = float(0).toVar();
    for (let s = 0; s < SAMPLES; s++) {
      const th = a0.add(span.mul(u.q.element(s)));
      const b = vec2(th.cos(), th.sin());
      const along = dot(d, b);
      const acr = abs(b.x.mul(d.y).sub(b.y.mul(d.x)));
      const hw = select(along.greaterThan(P.z), float(0.0075), float(0.0045));
      const soft = max(px, u.qStep.mul(span).mul(max(along, 0)).mul(0.5));
      const inR = smoothstep(px.negate().add(0.015), px.add(0.015), along).mul(float(1).sub(smoothstep(P.w.sub(px), P.w.add(px), along)));
      cov.addAssign(inR.mul(float(1).sub(smoothstep(hw.sub(soft), hw.add(soft), acr))));
    }
    cov.divAssign(SAMPLES);
    cov.assign(max(cov, float(1).sub(smoothstep(float(0.016).sub(px), px.add(0.016), r))));
    Discard(cov.lessThan(0.003));
    return vec4(u.blade, cov.mul(0.97));
  })();
}

/** A node whose value is the glass layer, drawn (only while it rains) before the frame's composite reads it. */
class GlassLayerNode extends Node {
  constructor(draw, layer) {
    super('vec4');
    this.draw = draw;
    this.layer = layer;
    this.updateBeforeType = NodeUpdateType.RENDER;
  }

  updateBefore(frame) { this.draw(frame); }

  setup() { return texture(this.layer, screenUV); }
}

/**
 * @param {{ car: THREE.Object3D, corners: object, options: object, env: object, session: object, renderer: object,
 *   pipeline: object, occluders: THREE.Scene, scene: THREE.Scene }} o
 *   car: the car's group (its matrix is the body's); options: a preset's `rain`; occluders: the cabin's silhouette
 *   (meshes in place, kept in step by the cabin), drawn into the layer's depth first; staged: whether the layer's
 *   stage starts registered (setStaged changes it: the cabin registers it only while the drive is shown)
 */
export function createGlassRain({ car, corners, options, env, session, renderer, pipeline, occluders, scene, staged = true }) {
  const { bottomLeft: BL, bottomRight: BR, topRight: TR, topLeft: TL } = corners;
  const glass = glassOf(corners);
  const layout = siteLayout(glass, options.siteM);
  const glassPoint = (x, y, out) => {
    const s = x / glass.W, t = y / glass.H;
    const b = new THREE.Vector3().lerpVectors(BL, BR, s), tt = new THREE.Vector3().lerpVectors(TL, TR, s);
    return out.lerpVectors(b, tt, t);
  };
  const u = rainUniforms(glass, layout, corners);
  const fns = commonFns(u);
  const frameTex = pipeline.scenePass.getTexture('output');

  const layer = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true, generateMipmaps: false });
  layer.texture.name = 'glass-rain-layer';
  const material = (name) => new MeshBasicNodeMaterial({ name, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false });

  // the film: a grid over the glass (fine enough that the trapezoid's bilinear map holds), glass metres per vertex
  const filmGeo = new THREE.BufferGeometry();
  {
    const NX = 24, NY = 12, pos = [], g = [], idx = [], p = new THREE.Vector3();
    for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
      const x = (i / NX) * glass.W, y = (j / NY) * glass.H;
      pos.push(...glassPoint(x, y, p).toArray()); g.push(x, y);
    }
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const a = j * (NX + 1) + i;
      idx.push(a, a + 1, a + NX + 2, a, a + NX + 2, a + NX + 1);
    }
    filmGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    filmGeo.setAttribute('aGlass', new THREE.Float32BufferAttribute(g, 2));
    filmGeo.setIndex(idx);
  }
  // the drops: one quad per site and kind
  const dropGeo = new THREE.InstancedBufferGeometry();
  dropGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  dropGeo.setIndex([0, 1, 2, 0, 2, 3]);
  dropGeo.instanceCount = layout.count * 3;
  // the blades: each wiper's swept sector and a margin
  const bladeGeo = new THREE.BufferGeometry();
  {
    const pos = [], g = [], wi = [], idx = [], p = new THREE.Vector3();
    const NA = 48, NR = 6;
    WIPERS.forEach((w, k) => {
      const base = pos.length / 3;
      for (let j = 0; j <= NR; j++) for (let i = 0; i <= NA; i++) {
        const a = ((w.a0 - 6 + ((w.a1 - w.a0 + 12) * i) / NA) * Math.PI) / 180, r = ((w.rOut + 0.02) * j) / NR;
        const x = w.x + r * Math.cos(a), y = w.y + r * Math.sin(a);
        pos.push(...glassPoint(x, y, p).toArray()); g.push(x, y); wi.push(k);
      }
      for (let j = 0; j < NR; j++) for (let i = 0; i < NA; i++) {
        const a = base + j * (NA + 1) + i;
        idx.push(a, a + 1, a + NA + 2, a, a + NA + 2, a + NA + 1);
      }
    });
    bladeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    bladeGeo.setAttribute('aGlass', new THREE.Float32BufferAttribute(g, 2));
    bladeGeo.setAttribute('aWiper', new THREE.Float32BufferAttribute(wi, 1));
    bladeGeo.setIndex(idx);
  }
  const filmMat = material('glass-film'), dropsMat = material('glass-drops'), bladesMat = material('glass-blades');
  filmMat.colorNode = filmColor(u, fns, frameTex);
  dropsMat.vertexNode = dropsVertex(u, fns);
  dropsMat.colorNode = dropsColor(u, frameTex);
  bladesMat.colorNode = bladeColor(u);
  const film = new Mesh(filmGeo, filmMat), drops = new Mesh(dropGeo, dropsMat), blades = new Mesh(bladeGeo, bladesMat);
  film.renderOrder = 17; drops.renderOrder = 18; blades.renderOrder = 19;
  const meshes = [film, drops, blades];
  // the glass's own scene: the three layers under a group at the car's body
  const glassScene = new THREE.Scene();
  glassScene.name = 'glass-rain';
  const holder = new THREE.Group();
  holder.matrixAutoUpdate = false;
  glassScene.add(holder);
  for (const m of meshes) { m.frustumCulled = false; m.name = m.material.name; holder.add(m); }
  const depthOnly = new MeshBasicNodeMaterial({ colorWrite: false, side: THREE.DoubleSide, fog: false });

  const feed = createRainFeed({ glass, layout, env, session, enabled: options.enabled !== false });
  const sky = new THREE.Color(), blade = new THREE.Color();
  const out = {
    bins: u.bins.array, k0: u.k0, tw: u.tw, renewOffset: u.renewOffset, wipe: u.wipe.value, comfort: u.comfort,
    q: u.q.array, qStep: u.qStep, qRange: u.qRange.value, mistRate: u.mistRate, haze: u.haze, sky, blade,
  };
  const raining = uniform(0);
  let camera = null, drawn = 0, copied = null;
  const timing = createTimings(), drawTiming = createTimings();
  const _size = new THREE.Vector2(), _clear = new THREE.Color(), _tint = new THREE.Color();

  /** Draw the glass layer: after the scene pass (the layer reads its colour), before the composite. */
  function draw(frame) {
    if (!raining.value || !camera) return;
    const t0 = performance.now();
    pipeline.scenePass.updateBefore(frame); // the scene pass first (once per frame: a no-op when it has run)
    const rt = pipeline.scenePass.renderTarget;
    _size.set(rt.width, rt.height);
    if (layer.width !== _size.x || layer.height !== _size.y) layer.setSize(_size.x, _size.y);
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear, alpha = renderer.getClearAlpha();
    renderer.getClearColor(_clear);
    renderer.setRenderTarget(layer);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    occluders.overrideMaterial = depthOnly;
    renderer.render(occluders, camera); // the cabin's silhouette into the layer's depth
    occluders.overrideMaterial = null;
    renderer.autoClear = false;
    renderer.render(glassScene, camera);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(_clear, alpha);
    renderer.autoClear = auto;
    drawn++;
    copied = [0, 0, _size.x, _size.y];
    drawTiming.add(performance.now() - t0);
  }

  const layerNode = new GlassLayerNode(draw, layer.texture);
  const composite = ({ color }) => Fn(() => {
    const c = vec4(color).toVar();
    If(raining.greaterThan(0.5), () => {
      const g = layerNode;
      c.assign(vec4(g.rgb.add(c.rgb.mul(float(1).sub(g.a))), c.a));
    });
    return c;
  })();
  const rainStage = { id: 'cabin-rain', at: 'beforeBloom', node: composite };
  let removeStage = null;
  /** The layer's pipeline stage registered (on) or removed (off): registered only while the drive is shown. */
  function setStaged(on) {
    if (on && !removeStage) removeStage = pipeline.addStage(rainStage);
    else if (!on && removeStage) { removeStage(); removeStage = null; }
  }
  setStaged(staged);

  /**
   * @param {object} frame the session's frame  @param {{ camera: THREE.Camera, L: object }} o the scene camera, rig.last
   */
  function update(frame, { camera: cam, L }) {
    const t0 = performance.now();
    const on = feed.update(frame, out, {});
    raining.value = on ? 1 : 0;
    camera = cam;
    if (on) {
      holder.matrix.copy(L.body);
      holder.matrixWorldNeedsUpdate = true;
      holder.updateMatrixWorld(true);
      // the sky caught on a drop and the blades' rubber in its light, in buffer units
      const fog = scene.fog?.color;
      _tint.copy(fog || _tint.setRGB(1, 1, 1));
      const l = Math.max(1e-6, 0.2126 * _tint.r + 0.7152 * _tint.g + 0.0722 * _tint.b);
      const lux = env?.lighting?.ambientLux ? env.lighting.ambientLux() : 0;
      sky.copy(_tint).multiplyScalar((lux / Math.PI) * (env?.nodes?.exposure?.value ?? 1) / l);
      u.sky.value.copy(sky);
      u.blade.value.copy(sky).multiplyScalar(0.04);
    }
    timing.add(performance.now() - t0);
  }

  return {
    meshes, layout, glass, layer, /** the shaders' uniforms (tests) */ uniforms: u,
    get enabled() { return feed.enabled; },
    get raining() { return raining.value > 0; },
    setEnabled(v) { feed.setEnabled(v); if (!feed.enabled) raining.value = 0; },
    setSpeedOverride: feed.setSpeedOverride,
    update,
    hide() { raining.value = 0; },
    setStaged,
    get staged() { return !!removeStage; },
    drops: feed.drops,
    state: feed.state,
    stats: () => ({ enabled: feed.enabled, raining: raining.value > 0, mode: feed.mode, sites: layout.count, bins: feed.binCount, copied, drawn, js: timing.summary(), draw: drawTiming.summary() }),
    dispose() {
      setStaged(false);
      for (const m of meshes) { holder.remove(m); m.geometry.dispose(); m.material.dispose(); }
      depthOnly.dispose();
      layer.dispose();
    },
  };
}
