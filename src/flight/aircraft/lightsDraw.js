// The aircraft's own lights, the drawn part (plan 03, section 7.8; F3.8): the baked attributes _LIGHTS0 and _LIGHTS1
// turned into light on the skin, and each lamp as a light point. No light sources: the bake already knows how much of
// each lamp reaches each corner of the airframe (photometry, distance, the surface's cosine, the airframe's own
// shadows), so the skin's emission is lux x albedo / pi, in cd/m^2, through the environment's emissive().
//
// Decoding (rig.json lightBake, written by models/aircraft/build_airframe.py). Each channel stores v = sqrt(E / scale),
// E being the illuminance per candela of the lamps' peak (lux/cd), 16 bits a channel, so nothing clips and the light
// a few metres from a lamp keeps its precision. Lux on a corner = v^2 x scale x candela x level. The vertex stage
// squares the codes once; scale x candela x level of each channel is one uniform, set on the CPU each frame.
//
// Colours. NAV holds the coloured forward position lights only: green where the body x > 0, red where x < 0. The
// TAXI channel is shared: inboard of lightBake.mux.TAXI.outboardOf it is the taxi light's, outboard it is the white
// aft position lights' (on with NAV, at CANDELA.NAV_AFT). The other channels are each one group's, red for the beacon
// and white for the rest. The points go through the environment's pointSource(), so they bloom and conserve flux at
// any size, as plan 2's lamps do. Neither is marked artificial: the lights-out control is about the city.

import { BufferAttribute, BufferGeometry, Mesh, Vector4, AdditiveBlending } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute, varying, uniform, vec3, vec4, float, max, dot, select, normalize, exp, smoothstep, step, abs,
  cameraPosition, cameraProjectionMatrix, cameraViewMatrix, positionWorld, modelWorldMatrix, screenSize,
} from 'three/tsl';
import { GROUPS, CANDELA, COLOURS, lampLevels } from './lights.js';

const NAV = GROUPS.indexOf('NAV'), TAXI = GROUPS.indexOf('TAXI');

/**
 * Light on the skin per candela, over what the bake holds, by group (the lamp points keep their candela). ESTIMATED,
 * a stand-in for a lamp shape the bake lacks: it takes the forward position light as a hemisphere about the outboard
 * axis, which leaves the winglet's inner face, above and inboard of the lamp, 0.035 lux (median) of green per 100 cd.
 * Window-seat photographs at night show that face clearly green the whole flight: the lens wraps round the wingtip and
 * its spill reaches the winglet. 30 gives it 0.85 lux (median: a green 0.24 cd/m^2, three times the night sky behind)
 * and 14 lux near its foot. F8.1, 25 Nov 2026; to go when
 * models/aircraft bakes the position light's spill.
 */
export const SKIN_GAIN = Object.freeze({ NAV: 30 });
const gain = GROUPS.map((g) => SKIN_GAIN[g] ?? 1);

/** A stored code (0..1) back to lux per candela: v^2 x the channel's scale. The CPU twin of the vertex stage. */
export function decodeBaked(v, scale) {
  return v * v * scale;
}

const tables = new WeakMap();
/** rig.json's lightBake, checked once: { scale: number[8] in GROUPS order, outboardOf }. */
export function bakeTable(bake) {
  let t = bake && tables.get(bake);
  if (t) return t;
  if (!bake || bake.encoding !== 'sqrt') throw new Error('airframe: rig.json has no lightBake with the sqrt encoding');
  if (bake.channels.join() !== GROUPS.join()) throw new Error('airframe: rig.json lightBake channels are not the groups');
  t = Object.freeze({ scale: GROUPS.map((g) => bake.scale[g]), outboardOf: bake.mux.TAXI.outboardOf });
  tables.set(bake, t);
  return t;
}

/**
 * Each channel's multiplier for the squared codes, lux per unit code^2: scale x candela x SKIN_GAIN x level, GROUPS
 * order; and
 * `aft`, the TAXI channel's multiplier outboard of the split (the white aft position lights).
 * @param {ArrayLike<number>} levels  GROUPS order, 0..1  @param {object} bake  rig.json lightBake
 * @param {{ channels: number[], aft: number }} [out]
 */
export function lampIntensities(levels, bake, out = { channels: new Array(GROUPS.length), aft: 0 }) {
  const { scale } = bakeTable(bake);
  for (let i = 0; i < GROUPS.length; i++) out.channels[i] = scale[i] * CANDELA[GROUPS[i]] * gain[i] * levels[i];
  out.aft = scale[TAXI] * CANDELA.NAV_AFT * levels[NAV];
  return out;
}

/**
 * Illuminance on one corner, linear RGB lux (each colour of unit luminance x its lux): the CPU twin of skinLightNode.
 * @param {ArrayLike<number>} codes  the corner's eight stored values, 0..1  @param {number[]} bodyPosition  body axes
 * @param {ReturnType<typeof lampIntensities>} k  @param {object} bake  rig.json lightBake
 */
export function skinLux(codes, bodyPosition, k, bake) {
  const { outboardOf } = bakeTable(bake);
  const e = Array.from(codes, (v) => v * v);
  const navColour = bodyPosition[0] > 0 ? COLOURS.green : COLOURS.red;
  const taxi = Math.abs(bodyPosition[0]) >= outboardOf ? k.aft : k.channels[TAXI];
  const white = e[2] * k.channels[2] + e[3] * k.channels[3] + e[4] * taxi + e[5] * k.channels[5] + e[6] * k.channels[6] + e[7] * k.channels[7];
  return [0, 1, 2].map((c) => navColour[c] * e[0] * k.channels[0] + COLOURS.red[c] * e[1] * k.channels[1] + COLOURS.white[c] * white);
}

/** Uniforms of the skin's light: lampIntensities' channels 0..3 and 4..7, and the aft position lights' multiplier. */
export function createLampUniforms() {
  return [uniform(new Vector4()), uniform(new Vector4()), uniform(0)];
}

/**
 * Write the current multipliers into the uniforms.
 * @param {ReturnType<typeof createLampUniforms>} u  @param {ArrayLike<number>} levels  GROUPS order, 0..1
 * @param {object} bake  rig.json lightBake
 */
const scratch = { channels: new Array(GROUPS.length), aft: 0 };
export function setLampUniforms(u, levels, bake) {
  const { channels: c, aft } = lampIntensities(levels, bake, scratch);
  u[0].value.set(c[0], c[1], c[2], c[3]);
  u[1].value.set(c[4], c[5], c[6], c[7]);
  u[2].value = aft;
}

const col = (c) => vec3(c[0], c[1], c[2]);

/**
 * The skin's emission node, HDR units: square the baked codes in the vertex stage, weigh them by the uniforms, colour
 * them, and scatter them by the surface's albedo.
 * @param {{ nodes: { emissive: (cdM2: any) => any }, uniforms: ReturnType<typeof createLampUniforms>, bodyPosition: any,
 *   albedo: any, bake: object }} o  bodyPosition: the vertex in body axes (a node); albedo: the material's diffuse colour
 *   (a node); bake: rig.json lightBake
 */
export function skinLightNode({ nodes, uniforms: [i0, i1, iAft], bodyPosition, albedo, bake }) {
  const { outboardOf } = bakeTable(bake);
  const a0 = attribute('_lights0', 'vec4'), a1 = attribute('_lights1', 'vec4');
  const e0 = varying(a0.mul(a0)), e1 = varying(a1.mul(a1));
  const right = bodyPosition.x.greaterThan(0);
  const navColour = select(right, col(COLOURS.green), col(COLOURS.red));
  const taxi = select(abs(bodyPosition.x).greaterThanEqual(outboardOf), iAft, i1.x);
  const white = e0.z.mul(i0.z).add(e0.w.mul(i0.w)).add(e1.x.mul(taxi)).add(dot(e1.yzw, i1.yzw));
  const lux = navColour.mul(e0.x.mul(i0.x)).add(col(COLOURS.red).mul(e0.y.mul(i0.y))).add(col(COLOURS.white).mul(white));
  return nodes.emissive(lux.mul(albedo).div(Math.PI));
}

/**
 * The lamps as light points: one camera-facing quad per lamp, sized in pixels, carrying pointSource()'s flux with a
 * Gaussian profile, dimmed outside each lamp's cone. A child of the airframe's root (body axes).
 * @param {ReturnType<import('./lights.js').lampTable>} lamps
 * @param {{ nodes: { pointSource: (candela: any, o?: object) => { color: any, sizePx: any } }, minPixels?: number }} o
 */
export function createLampPoints(lamps, { nodes, minPixels = 2 }) {
  const n = lamps.length;
  const pos = new Float32Array(n * 12), dir = new Float32Array(n * 12), colour = new Float32Array(n * 12);
  const cone = new Float32Array(n * 4), corner = new Float32Array(n * 8), candela = new Float32Array(n * 4);
  const index = [];
  const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  lamps.forEach((l, i) => {
    for (let k = 0; k < 4; k++) {
      const v = 4 * i + k;
      pos.set(l.position, 3 * v); dir.set(l.direction, 3 * v); colour.set(l.colour, 3 * v);
      // cos of the half angle; lamps narrower than a hemisphere keep a glint of their lens outside the beam
      cone[v] = Math.cos(((l.coneDeg / 2) * Math.PI) / 180);
      corner.set(C[k], 2 * v);
    }
    index.push(4 * i, 4 * i + 1, 4 * i + 2, 4 * i, 4 * i + 2, 4 * i + 3);
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('lampDir', new BufferAttribute(dir, 3));
  g.setAttribute('lampColour', new BufferAttribute(colour, 3));
  g.setAttribute('lampCone', new BufferAttribute(cone, 1));
  g.setAttribute('corner', new BufferAttribute(corner, 2));
  const cdAttr = new BufferAttribute(candela, 1);
  g.setAttribute('lampCandela', cdAttr);
  g.setIndex(index);
  // the quads are collapsed onto their lamps until the vertex stage spreads them, so their bounds mean nothing:
  // the layer is never frustum-culled (mesh.frustumCulled below); it is 18 quads

  const m = new MeshBasicNodeMaterial({ name: 'aircraft-lamps', transparent: true, depthWrite: false, depthTest: true, blending: AdditiveBlending, fog: false });
  m.lights = false;
  const SIGMA = 0.6; // of the sprite's size in pixels: the Gaussian's width, its quad 3 sigma each way
  const { color: flat, sizePx } = nodes.pointSource(attribute('lampCandela', 'float'), { minPixels });
  const sigma = float(sizePx).mul(SIGMA);
  const vCorner = varying(attribute('corner', 'vec2').mul(sigma).mul(3), 'vLampPx');
  m.vertexNode = (() => {
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(positionWorld, 1));
    return vec4(clip.xy.add(vCorner.mul(2).div(screenSize).mul(clip.w)), clip.z, clip.w);
  })();
  const toEye = normalize(cameraPosition.sub(positionWorld));
  const axis = normalize(modelWorldMatrix.mul(vec4(attribute('lampDir', 'vec3'), 0)).xyz);
  const c = dot(axis, toEye), edge = attribute('lampCone', 'float');
  const inBeam = smoothstep(edge.sub(0.08), edge.add(0.02), c);
  const beam = max(inBeam, select(edge.greaterThan(0.01), float(0.002).mul(step(0, c)), float(0)));
  const r2 = dot(vCorner, vCorner);
  const profile = exp(r2.div(sigma.mul(sigma).mul(-2))).mul(float(sizePx).mul(sizePx)).div(sigma.mul(sigma).mul(2 * Math.PI));
  m.colorNode = vec4(attribute('lampColour', 'vec3').mul(flat).mul(beam).mul(profile).mul(step(r2, sigma.mul(sigma).mul(9))), 1);

  const mesh = new Mesh(g, m);
  mesh.name = 'aircraft-lamps';
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  // the quads are expanded in the vertex stage, so ray picking must not hit their collapsed triangles
  mesh.raycast = () => {};
  const levels = new Float32Array(GROUPS.length);
  return {
    mesh,
    /** Set each lamp's candela from the bits and presentation time. Returns the levels, GROUPS order. */
    update(bits, wallS, { reducedMotion = false } = {}) {
      lampLevels(bits, wallS, { reducedMotion }, levels);
      lamps.forEach((l, i) => candela.fill(l.candela * levels[l.group], 4 * i, 4 * i + 4));
      cdAttr.needsUpdate = true;
      return levels;
    },
    levels,
    dispose() { g.dispose(); m.dispose(); },
  };
}

