// The visitor's headlamps on plan 01's renderer (plan 02, D5.1 and D5.2; third stretch, decisions 2 and 6): the beam
// and the retroreflected return of headlamps.glsl.js written in TSL, put on the drive's node materials through
// surfaceLight.node.js. Same factory and methods as headlamps.js (read its header); headlights.js picks by ctx.legacy.
// Every function below is the GLSL function of the same name, and headlampMirror.js mirrors both.
//
// Units (decision 6). The beam on a surface is an illuminance: E = I cos(i) / d^2 in lux, with I the map's candela;
// surfaceLight.node.js reflects it as albedo x E / pi. The retroreflected return is a radiance in cd/m^2 toward the
// eye (R_A x E_perp / cos(nu) for sheeting, R_L x E_perp for markings). Both are scaled by photometry.node.js: the
// pre-exposure and the lights-out slider in the shipped look, LIGHTING_UNITS at ?display=classic. The soft shoulder
// (headlamps.glsl.js RETRO_SHOULDER) stood in for the classic fixed exposure and is applied only at the classic display,
// so the parity tool compares like with like; in the shipped look the return is what the sheeting sends back.
//
// The pavement (decision 13). In the shipped look the beam on the road's pavement (the atlas' lane, marking, shoulder
// and gore columns, PAVEMENT_SPANS) is not Lambertian: it is the pavement's retroreflected luminance R_L x E_perp
// (retro.js PAVEMENT_RL, asphalt and concrete told apart by the atlas column the texel comes from, as atlas.js tileFor
// chose it), a radiance through surfaceLight.node.js, times albedo / reference so the atlas' wear shows through
// (markingMask.js pavementAlbedo). Paint keeps its own R_L (the retro term) and its Lambert share. Embankments,
// structures and barriers keep the Lambert beam. At ?display=classic the road keeps the Lambert beam it had.
//
// Programs: one beam term object and one retro term object per kind (two for the delineators' rows) for every
// material, so materials of one class share a program (surfaceLight.node.js, "Programs").

import * as THREE from 'three';
import {
  uniform, texture, attribute, uv, vec2, vec3, float, dot, length, atan, asin, acos, degrees, inverseSqrt, clamp, min, max,
  mix, select, step, floor, abs,
} from 'three/tsl';
import { addSurfaceTerm } from './surfaceLight.node.js';
import { photometryContext } from './photometry.node.js';
import { RETRO_SHOULDER } from './headlamps.glsl.js';
import { MARKING_ROWS } from './headlampMirror.js';
import { REGIONS, ATLAS_W } from '../roadnet/atlas.js';

/**
 * The atlas columns that are pavement (atlas.js REGIONS): the lanes and the asphalt around the markings, shoulders and
 * gores, and their concrete variants; not dirt, structure concrete, steel, reflectors or bridge joints. [u0, u1) pixels.
 */
export const PAVEMENT_SPANS = Object.freeze([
  [REGIONS.lane[0], REGIONS.shoulder[1]], // lane, broken, solid, yellow, white, shoulder
  REGIONS.gore,
  [REGIONS.laneR[0], REGIONS.whiteC[1]], // laneR, laneC, shoulderC, brokenC, solidC, yellowC, whiteC
]);
import { PAVEMENT_RL } from '../roadside/retro.js';

function halfTexture(half, width, height) {
  const t = new THREE.DataTexture(half, width, height, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

const LUM = [0.2126, 0.7152, 0.0722];
/** arr[i] for a float node i in 0..arr.length - 1 (arr of nodes). */
const pick = (arr, i) => arr.slice(1).reduce((acc, v, k) => select(i.greaterThan(k + 0.5), v, acc), arr[0]);

/**
 * @param {{ ctx: object, maps: { low: object, high: object }, table: object, ink: number[][], chroma: number[][],
 *   mask: { data: Uint8Array, width: number, height: number } | null, ageing: { sheeting: number, marking: number },
 *   colour: number[], range: { range: number, fade: number } }} o  as headlamps.js
 */
export function createHeadlampTerms({ ctx, maps, table, ink, chroma, mask, ageing, colour, range, pavement = null }) {
  const photometry = photometryContext({ nodes: ctx.env.nodes });
  const shoulderOn = photometry.display === 'classic';
  const beamTex = { low: halfTexture(maps.low.half, maps.low.width, maps.low.height), high: halfTexture(maps.high.half, maps.high.width, maps.high.height) };
  const retroTex = halfTexture(table.half, table.width, table.height);

  // ---- uniforms (headlamps.glsl.js HEAD), set once a frame by set()
  const uBeam = texture(beamTex.low);
  const uBeamUv = uniform(new THREE.Vector4(...maps.low.uv)).setName('uHlBeamUv');
  const uLamp = [uniform(new THREE.Vector3()).setName('uHlLamp0'), uniform(new THREE.Vector3()).setName('uHlLamp1')];
  const uRight = uniform(new THREE.Vector3(1, 0, 0)).setName('uHlRight');
  const uUp = uniform(new THREE.Vector3(0, 1, 0)).setName('uHlUp');
  const uFwd = uniform(new THREE.Vector3(0, 0, -1)).setName('uHlForward');
  // on (0 or 1) x the drive being shown: the map's own ground never shows the beam
  const uOn = uniform(0).setName('uHlOn');
  const uPeak = uniform(0).setName('uHlPeak');
  const spec = { on: 0 };
  uOn.onRenderUpdate(() => (ctx.group.visible ? spec.on : 0));
  const uRange = uniform(new THREE.Vector2(range.range, 1 / range.fade)).setName('uHlRange');
  const lampColour = vec3(...colour);
  const retro = texture(retroTex);
  const chromaN = chroma.map((c) => vec3(...c));
  const inkN = ink.map((c) => vec3(...c));

  /** Candela toward d (lamp to point, scene) over the peak: one texture fetch (hlCandela). */
  function candela(d) {
    const cx = dot(d, uRight), cy = dot(d, uUp), cz = dot(d, uFwd);
    const h = degrees(atan(cx, cz));
    const v = degrees(atan(cy, length(vec2(cx, cz))));
    const s = uBeam.sample(vec2(h.mul(uBeamUv.x).add(uBeamUv.y), v.mul(uBeamUv.z).add(uBeamUv.w))).r;
    return select(abs(h).greaterThan(90), float(0), s);
  }

  // ---- the beam on a Lambert surface (diffuseBody): E = I cos(i) / d^2, lux, coloured
  const beamTerm = {
    id: 'headlights', key: 'v1',
    lux: ({ positionWorld, normalWorld }) => {
      let e = float(0);
      for (const lamp of uLamp) {
        const d = positionWorld.sub(lamp);
        const d2 = dot(d, d), dist = d2.sqrt();
        const cosi = dot(normalWorld, d).negate().div(max(dist, 1e-3));
        const fade = clamp(uRange.x.sub(dist).mul(uRange.y), 0, 1);
        const one = candela(d).mul(uPeak).mul(cosi).mul(fade).div(max(d2, 0.25));
        e = e.add(select(cosi.greaterThan(0).and(fade.greaterThan(0)), one, float(0)));
      }
      return select(uOn.greaterThan(0.5), lampColour.mul(e), vec3(0));
    },
  };

  // ---- retroreflection (RETRO_HEAD)
  const { width, rowsPerType, height, alphaMax, betaNodes } = table;
  function betaRow(b) {
    let r = float(betaNodes.length - 1);
    for (let i = betaNodes.length - 1; i >= 1; i--) {
      const n = betaNodes[i], p = betaNodes[i - 1];
      r = select(b.lessThan(n), b.sub(p).div(n - p).add(i - 1), r);
    }
    return r;
  }
  function retroCoef(row, alphaDeg, betaDeg) {
    const x = clamp(alphaDeg.div(alphaMax), 0, 1).mul(width - 1).add(0.5);
    const y = row.mul(rowsPerType).add(betaRow(betaDeg)).add(0.5);
    return retro.sample(vec2(x.div(width), y.div(height))).r;
  }
  /** cd/m^2 returned toward the eye by two coefficient rows; marking: R_L, no 1 / cos(nu) (hlRetro). */
  function retroReturn(p, n, toEye, rows, marking) {
    const cosNu = dot(n, toEye);
    let l = vec2(0);
    for (const lamp of uLamp) {
      const tl = lamp.sub(p);
      const dl2 = dot(tl, tl);
      const ul = tl.mul(inverseSqrt(dl2));
      const cosB = dot(n, ul);
      const alpha = degrees(asin(min(1, length(ul.sub(toEye)).mul(0.5))).mul(2));
      const beta = degrees(acos(min(cosB, 1)));
      const e = candela(tl.negate()).mul(uPeak).div(dl2);
      const one = vec2(retroCoef(rows.x, alpha, beta), retroCoef(rows.y, alpha, beta)).mul(e);
      l = l.add(select(cosB.greaterThan(0), one, vec2(0)));
    }
    const out = marking ? l : l.div(max(cosNu, 0.05));
    return select(uOn.greaterThan(0.5).and(cosNu.greaterThan(0)), out, vec2(0));
  }
  /** The soft shoulder (hlShoulder), at the classic display only. */
  function shoulder(l) {
    if (!shoulderOn) return l;
    const { knee, ceiling } = RETRO_SHOULDER;
    const m = max(l.x, l.y), x = m.sub(knee);
    const k = float(knee).add(x.div(x.div(ceiling - knee).add(1))).div(max(m, 1e-6));
    return select(m.greaterThan(knee), l.mul(k), l);
  }

  // the road's marking mask, at the road map's uv (its repeat and offset)
  let markTex = null;
  const src = ctx.materials?.map;
  if (mask) {
    markTex = new THREE.DataTexture(mask.data, mask.width, mask.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    markTex.wrapS = src?.wrapS ?? THREE.ClampToEdgeWrapping;
    markTex.wrapT = src?.wrapT ?? THREE.RepeatWrapping;
    markTex.flipY = false;
    markTex.minFilter = THREE.LinearMipmapLinearFilter;
    markTex.magFilter = THREE.LinearFilter;
    markTex.generateMipmaps = true;
    markTex.anisotropy = src?.anisotropy ?? 1;
    markTex.needsUpdate = true;
  }
  const mapUv = () => {
    const rep = src?.repeat ?? { x: 1, y: 1 }, off = src?.offset ?? { x: 0, y: 0 };
    return vec2(uv().x.mul(rep.x).add(off.x), uv().y.mul(rep.y).add(off.y));
  };

  const retroTerms = {};
  function retroTerm(kind, row) {
    const key = kind === 'delineator' ? `delineator${row}` : kind;
    if (retroTerms[key]) return retroTerms[key];
    let radiance;
    if (kind === 'road') {
      radiance = ({ positionWorld, normalWorld, viewWorld }) => {
        const code = floor(attribute('retro', 'float').add(0.5));
        const sheet = shoulder(retroReturn(positionWorld, normalWorld, viewWorld, vec2(code.sub(1)), false).mul(ageing.sheeting));
        const reflector = pick(chromaN, code).mul(sheet.x);
        const m = texture(markTex, mapUv()).rg;
        const lm = shoulder(retroReturn(positionWorld, normalWorld, viewWorld, vec2(MARKING_ROWS[0], MARKING_ROWS[1]), true).mul(ageing.marking));
        const paint = select(m.r.add(m.g).greaterThan(0.002), vec3(m.r.mul(lm.x)).add(chromaN[2].mul(m.g.mul(lm.y))), vec3(0));
        return select(code.greaterThan(0.5), reflector, paint);
      };
    } else if (kind === 'sign') {
      radiance = ({ positionWorld, normalWorld, viewWorld, albedo }) => {
        const bg = floor(attribute('retro', 'float').add(0.5)), lg = floor(attribute('retroLegend', 'float').add(0.5));
        const cb = pick(inkN, bg), cl = pick(inkN, lg), dc = cl.sub(cb);
        const w = clamp(dot(albedo.sub(cb), dc).div(max(dot(dc, dc), 1e-4)), 0, 1);
        const ref = mix(cb, cl, w);
        const lumRef = dot(ref, vec3(...LUM));
        const inkK = clamp(dot(albedo, vec3(...LUM)).div(max(lumRef, 1e-3)), 0, 1);
        const raw = retroReturn(positionWorld, normalWorld, viewWorld, vec2(max(bg.sub(1), 0), max(lg.sub(1), 0)), false).mul(ageing.sheeting);
        const l = shoulder(raw.mul(vec2(step(0.5, bg), step(0.5, lg))));
        const out = mix(pick(chromaN, bg).mul(l.x), pick(chromaN, lg).mul(l.y), w).mul(inkK);
        return select(bg.add(lg).greaterThan(0.5), out, vec3(0));
      };
    } else if (kind === 'delineator') {
      radiance = ({ positionWorld, normalWorld, viewWorld }) => {
        const l = shoulder(retroReturn(positionWorld, normalWorld, viewWorld, vec2(row), false).mul(ageing.sheeting));
        return chromaN[row + 1].mul(l.x);
      };
    } else throw new Error(`headlamps.node: no retro term for "${kind}"`);
    retroTerms[key] = { id: 'retro', key: `${key}-v1`, radiance };
    return retroTerms[key];
  }

  // ---- the road's beam (decision 13): the pavement's R_L x E_perp as a radiance, the Lambert beam elsewhere
  const pave = pavement || { asphalt: 0.139, concrete: 0.324 };
  let roadShared = null;
  /** Both lamps' E (Lambert, E cos i) and E_perp, the pavement's share and its R_L per albedo; built once, shared. */
  function roadParts({ positionWorld, normalWorld }) {
    if (roadShared) return roadShared;
    let eLam = float(0), ePerp = float(0);
    for (const lamp of uLamp) {
      const dd = positionWorld.sub(lamp);
      const d2 = dot(dd, dd), dist = d2.sqrt();
      const cosi = dot(normalWorld, dd).negate().div(max(dist, 1e-3));
      const fade = clamp(uRange.x.sub(dist).mul(uRange.y), 0, 1);
      const i = candela(dd).mul(uPeak).mul(fade).div(max(d2, 0.25));
      const lit = cosi.greaterThan(0).and(fade.greaterThan(0));
      eLam = eLam.add(select(lit, i.mul(cosi), float(0)));
      ePerp = ePerp.add(select(lit, i, float(0)));
    }
    // pavement by the atlas column the texel comes from (atlas.js tileFor), not by the mesh's `kind` attribute: that
    // is a Uint8 buffer which the WebGL2 backend binds as an integer input, so reading it as a float made the road's
    // draw call fail there ("Vertex shader input type does not match the type of the bound vertex attribute")
    const au = mapUv().x.mul(ATLAS_W);
    const inSpan = ([a, b]) => au.greaterThanEqual(a).and(au.lessThan(b));
    const isPave = PAVEMENT_SPANS.map(inSpan).reduce((acc, x) => acc.or(x));
    const concrete = au.greaterThanEqual(REGIONS.laneC[0]).and(au.lessThan(REGIONS.whiteC[1]));
    // R_L per unit albedo: R_L / the pavement's reference albedo
    const rlPerAlbedo = select(concrete, float(PAVEMENT_RL.concrete / pave.concrete), float(PAVEMENT_RL.asphalt / pave.asphalt));
    const m = markTex ? texture(markTex, mapUv()) : null;
    const paint = m ? clamp(m.r.add(m.g), 0, 1) : float(0);
    const share = select(isPave, float(1).sub(paint), float(0));
    roadShared = { eLam, ePerp, share, rlPerAlbedo };
    return roadShared;
  }
  const roadBeamTerm = {
    id: 'headlights', key: 'road-v1',
    lux: (sf) => {
      const { eLam, share } = roadParts(sf);
      return select(uOn.greaterThan(0.5), lampColour.mul(eLam.mul(float(1).sub(share))), vec3(0));
    },
    radiance: (sf) => {
      const { ePerp, share, rlPerAlbedo } = roadParts(sf);
      return select(uOn.greaterThan(0.5), lampColour.mul(sf.albedo).mul(ePerp.mul(share).mul(rlPerAlbedo)), vec3(0));
    },
  };

  return {
    hasMask: !!markTex,
    /** The display this was built for ('physical' or 'classic'): headlights.js chooses its gain by it. */
    display: photometry.display,
    attach(material, kind = null, row = 0) {
      const beam = kind === 'road' && !shoulderOn ? roadBeamTerm : beamTerm; // decision 13: the pavement's R_L
      const undo = [addSurfaceTerm(material, beam, { photometry })];
      if (!kind || (kind === 'road' && !markTex)) return { undo: () => undo.reverse().forEach((u) => u()), retro: false };
      undo.push(addSurfaceTerm(material, retroTerm(kind, row), { photometry }));
      return { undo: () => undo.reverse().forEach((u) => u()), retro: true };
    },
    set({ which, peak, on, lamps, basis }) {
      if (uBeam.value !== beamTex[which]) uBeam.value = beamTex[which];
      uBeamUv.value.set(...maps[which].uv);
      spec.on = on ? 1 : 0;
      uPeak.value = peak;
      if (lamps) { uLamp[0].value.set(lamps[0][0], lamps[0][1], lamps[0][2]); uLamp[1].value.set(lamps[1][0], lamps[1][1], lamps[1][2]); }
      if (basis) { uRight.value.copy(basis.right); uUp.value.copy(basis.up); uFwd.value.copy(basis.forward); }
    },
    dispose() { for (const t of [beamTex.low, beamTex.high, retroTex, markTex]) t?.dispose(); },
  };
}
