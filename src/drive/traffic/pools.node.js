// Headlamp pools of other vehicles (plan 02, D6.4) as a node material for plan 01's renderer (three r187): the
// sibling of pools.js and pools.glsl.js (plan 02, third stretch, decision 2), with the same factory, options and
// returned object. tests/manual/traffic-node-shots.mjs draws both and compares them.
//
// A soft pool of light on the road ahead of each of the nearest lit vehicles, as an instanced additive decal. One
// draw call, at most MAX_POOLS instances; nothing by day. Per fragment the illuminance from the vehicle's two lamps
// by an analytic low beam (pools.glsl.js's header has the beam), reflected by asphalt as rho E / pi, so the decal
// writes a luminance in cd/m^2 x gain x lightScale. On a wet road each lamp's light is weakened by
// 1 - cover x F(incidence) and the diffuse reflection by 1 - cover x (1 - wet/dry diffuse ratio), cover being the
// lanes' mean cover the weather part publishes for the reflected twins (uTwinWet / the twins' gloss). Pulled toward
// the eye in depth (POOL_PULL of the distance) so it shows over the road. The CPU side is poolsCore.js, shared with
// pools.js.
//
// What differs from pools.js, deliberately:
//  - light units (decision 6): `gain` in update() is the look's fade alone, not lighting.units.nit x the fade; the
//    factory's `lightScale` (a number or a TSL node) carries the scale from cd/m^2.
//  - the wet cover comes from the option `twinWet`: a TSL node, or an object with a `value` read each frame (pass
//    lights/sprites.js TWIN_UNIFORMS.uTwinWet, or its node module's equivalent, and it follows without a call, as the
//    GLSL one shares that uniform). Default: a uniform at 0 (dry), `uniforms.uTwinWet`. This module imports nothing
//    from the GLSL light sprites.
//  - pools.glsl.js tone-maps per material (toneMapped true); here the output pass does (plan 01's pipeline).
//  - the pull moves the point in object space before the transform (pools.glsl.js scales the view-space position
//    after it); the two are the same point, and the depth and a logarithmic depth buffer see the pulled one.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, If, Discard, attribute, varying, vec2, vec3, vec4, float, uniform, normalize, cross, sqrt, atan, exp, clamp, max,
  dot, modelWorldMatrixInverse, cameraPosition, renderGroup,
} from 'three/tsl';
import { LAMP_RGB } from './lamps.js';
import { WET_DIFFUSE, GLOSS } from '../weather/wetMirror.js';
import { POOL_PULL } from './lightData.js';
import { createPoolsWith, ASPHALT_RHO, POOL_LENGTH_M } from './poolsCore.js';

export { MAX_POOLS, POOL_RANGE_M, POOL_LENGTH_M, ASPHALT_RHO, poolBeam, poolIlluminance, poolLuminance } from './poolsCore.js';

const DEG = 57.29577951308232;
const shared = (v) => uniform(v).setGroup(renderGroup);
const asNode = (v) => (v && v.isNode ? v : float(v ?? 1));

/** The low beam (cd) at beta degrees below the horizontal and phi to the side (pools.js poolBeam). */
const beam = (beta, phi) => {
  const a = beta.sub(1.2).div(1.6), b = phi.div(10), c = beta.sub(3).div(4), e = phi.div(28);
  return exp(a.mul(a).add(b.mul(b)).negate()).mul(12000).add(exp(c.mul(c).add(e.mul(e)).negate()).mul(3000));
};
/** Fresnel reflectance of water (n 1.333), unpolarised, by the cosine of the incidence (pools.glsl.js poolFresnel). */
const poolFresnel = /*@__PURE__*/ Fn(([c0]) => {
  const c = clamp(c0, 0, 1);
  const st = sqrt(max(c.mul(c).oneMinus(), 0)).div(1.333);
  const ct = sqrt(max(st.mul(st).oneMinus(), 0));
  const rs = c.sub(ct.mul(1.333)).div(c.add(ct.mul(1.333)));
  const rp = ct.sub(c.mul(1.333)).div(ct.add(c.mul(1.333)));
  return rs.mul(rs).add(rp.mul(rp)).mul(0.5);
}).setLayout({ name: 'trafficPoolFresnel', type: 'float', inputs: [{ name: 'c', type: 'float' }] });
/** One lamp's illuminance (lux) at q (across, along) from a lamp at x0 across and h up. */
const lampE = /*@__PURE__*/ Fn(([q, x0, h, cover]) => {
  const g = vec2(q.x.sub(x0), q.y);
  const flat2 = dot(g, g);
  const r2 = flat2.add(h.mul(h));
  const beta = atan(h, sqrt(flat2)).mul(DEG);
  const phi = atan(g.x, max(g.y, 1e-3)).mul(DEG);
  const cosi = h.div(sqrt(r2));
  return beam(beta, phi).mul(cosi).div(r2).mul(float(1).sub(cover.mul(poolFresnel(cosi))));
}).setLayout({
  name: 'trafficPoolLamp', type: 'float',
  inputs: [{ name: 'q', type: 'vec2' }, { name: 'x0', type: 'float' }, { name: 'h', type: 'float' }, { name: 'cover', type: 'float' }],
});

/** A node for the wet cover option: a node as is, a `{ value }` holder through a uniform that reads it each frame. */
function twinWetNode(o) {
  if (o && o.isNode) return o;
  const u = shared(o?.value ?? 0).setName('uTrafficPoolTwinWet');
  if (o && 'value' in o) u.onRenderUpdate(() => o.value);
  return u;
}

/**
 * @param {{ parent: THREE.Object3D, sidecar: object, bodyNames: string[], lightScale?: number | import('three/webgpu').Node,
 *   twinWet?: import('three/webgpu').Node | { value: number } }} opts sidecar: vehicles.json (head lamp positions);
 *   lightScale: physical units -> what the material writes (default 1); twinWet: see the header
 */
export function createPools({ parent, sidecar, bodyNames, lightScale = 1, twinWet }) {
  const uniforms = {
    uLength: shared(POOL_LENGTH_M), uHalfWidth: shared(12), uPull: shared(POOL_PULL),
    uGain: shared(1), uRho: shared(ASPHALT_RHO), uColor: shared(new THREE.Vector3(...LAMP_RGB.white)),
    uTwinWet: twinWetNode(twinWet), uWetPool: shared(new THREE.Vector2(GLOSS.twin, WET_DIFFUSE)),
  };
  const material = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
  });
  material.name = 'traffic-head-pools';
  {
    const corner = attribute('corner', 'vec2'), iOrigin = attribute('iOrigin', 'vec3'), iFwd = attribute('iFwd', 'vec3');
    const iUp = attribute('iUp', 'vec3');
    const right = normalize(cross(iFwd, iUp));
    const along = corner.y.mul(uniforms.uLength);
    const across = corner.x.mul(uniforms.uHalfWidth).mul(corner.y.mul(0.65).add(0.35));
    const p = iOrigin.add(iFwd.mul(along)).add(right.mul(across)).add(iUp.mul(0.02));
    // pulled toward the eye by uPull of its distance, in the object's space (the mesh's world matrix is the identity
    // in the drive; this holds for any)
    const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
    material.positionNode = p.add(eye.sub(p).mul(uniforms.uPull));
    const vLocal = varying(vec2(across, along), 'vTrafficPoolLocal');
    const vLamp = varying(attribute('iLamp', 'vec2'), 'vTrafficPoolLamp');
    const vScale = varying(attribute('iScale', 'float'), 'vTrafficPoolScale');
    const scale = asNode(lightScale);
    material.fragmentNode = Fn(() => {
      If(vLocal.y.lessThan(0.3), () => { Discard(); });
      const cover = clamp(uniforms.uTwinWet.div(uniforms.uWetPool.x), 0, 1);
      const E = lampE(vLocal, vLamp.x.negate(), vLamp.y, cover).add(lampE(vLocal, vLamp.x, vLamp.y, cover));
      const L = uniforms.uRho.mul(E).mul(float(1).sub(cover.mul(float(1).sub(uniforms.uWetPool.y)))).div(Math.PI)
        .mul(uniforms.uGain).mul(vScale).mul(scale);
      return vec4(uniforms.uColor.mul(L), 1);
    })();
  }
  return createPoolsWith({ parent, sidecar, bodyNames, uniforms, material: () => material, positions: true });
}
