// The aircraft's own lights, the drawn part (plan 03, section 7.8; F3.8): the baked attributes _LIGHTS0 and _LIGHTS1
// turned into light on the skin, and each lamp as a light point. No light sources: the bake already knows how much of
// each lamp reaches each corner of the airframe (distance, cone, cosine, occlusion), so the skin's emission is
// sum(baked x candela x level x colour) x albedo / pi, in cd/m^2, through the environment's emissive().
//
// Units. A baked value of 1 is the lamp's on-axis irradiance at 1 m, so baked x candela is lux. The bake stores it
// sRGB-encoded in byte colours (Blender's byte colour attributes; the glTF exporter writes them as they are), which the
// vertex stage decodes. The points go through the environment's pointSource(), so they bloom and conserve flux at any
// size, as plan 2's lamps do. Neither is marked artificial: the lights-out control is about the city.
//
// The NAV channel holds three colours (red left tip, green right tip, white aft on both); a corner's share of the
// white is the inverse-square share of the aft lamp, its red or green the side it is on.

import { BufferAttribute, BufferGeometry, Mesh, Vector4, AdditiveBlending } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute, varying, uniform, vec3, vec4, float, mix, step, pow, max, dot, select, normalize, exp, smoothstep,
  cameraPosition, cameraProjectionMatrix, cameraViewMatrix, positionWorld, modelWorldMatrix, screenSize,
} from 'three/tsl';
import { GROUPS, CANDELA, COLOURS, lampLevels } from './lights.js';

/** sRGB-encoded 0..1 to linear (the IEC 61966-2-1 curve), one number: the CPU twin of the vertex stage's decode. */
export function decodeBaked(v) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
const decodeNode = (v) => mix(v.div(12.92), pow(v.add(0.055).div(1.055), 2.4), step(0.04045, v));

/** Uniforms of the skin's light: candela x level of each group, groups 0..3 and 4..7. */
export function createLampUniforms() {
  return [uniform(new Vector4()), uniform(new Vector4())];
}

/**
 * Write the current candela x level of each group into the two uniforms.
 * @param {ReturnType<typeof createLampUniforms>} u  @param {ArrayLike<number>} levels  GROUPS order, 0..1
 */
export function setLampUniforms(u, levels) {
  const c = GROUPS.map((g, i) => CANDELA[g] * levels[i]);
  u[0].value.set(c[0], c[1], c[2], c[3]);
  u[1].value.set(c[4], c[5], c[6], c[7]);
}

const col = (c) => vec3(c[0], c[1], c[2]);

/**
 * The skin's emission node, HDR units: decode the baked attributes in the vertex stage, weigh them by the groups'
 * candela, colour them, and scatter them by the surface's albedo.
 * @param {{ nodes: { emissive: (cdM2: any) => any }, uniforms: ReturnType<typeof createLampUniforms>, bodyPosition: any,
 *   albedo: any, navLamps: { left: number[], right: number[], aftLeft: number[], aftRight: number[] } }} o
 *   bodyPosition: the vertex in body axes (a node); albedo: the material's diffuse colour (a node)
 */
export function skinLightNode({ nodes, uniforms: [i0, i1], bodyPosition, albedo, navLamps }) {
  const b0 = varying(decodeNode(attribute('_lights0', 'vec4')));
  const b1 = varying(decodeNode(attribute('_lights1', 'vec4')));
  const right = bodyPosition.x.greaterThan(0);
  const front = select(right, vec3(...navLamps.right), vec3(...navLamps.left));
  const aft = select(right, vec3(...navLamps.aftRight), vec3(...navLamps.aftLeft));
  const df = bodyPosition.sub(front), da = bodyPosition.sub(aft);
  const df2 = dot(df, df), da2 = dot(da, da);
  const whiteShare = df2.div(max(df2.add(da2), 1e-6));
  const navColour = mix(select(right, col(COLOURS.green), col(COLOURS.red)), col(COLOURS.white), whiteShare);
  const lux = navColour.mul(b0.x.mul(i0.x))
    .add(col(COLOURS.red).mul(b0.y.mul(i0.y)))
    .add(col(COLOURS.white).mul(b0.z.mul(i0.z).add(b0.w.mul(i0.w)).add(dot(b1, i1))));
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

