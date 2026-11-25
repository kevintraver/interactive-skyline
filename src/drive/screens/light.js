// The screens' light on their surroundings (plan 02, D7.5; third stretch, decision 6): two terms as illuminances in lux,
// added through src/drive/lights/surfaceLight.js, which reflects them as albedo x lux / pi x the light scale (the
// pre-exposure x the lights-out slider):
//
// sphere: a spherical emitter of mean luminance L (cd/m^2) and radius R lights a surface at distance d from its centre
// with normal n by E = pi L (R / d)^2 cos(theta), the exact illuminance of a uniform sphere wholly above the surface's
// horizon, theta the angle between n and the direction to the centre; it fades out between 60% and 100% of the range.
// No shadows (nothing is precomputed per facade): a wall turned away from the Sphere gets nothing, one behind another
// building still does.
//
// glow: up to `count` flat emitters (digital billboard faces) of area A, normal m and mean luminance L (cd/m^2) light a
// point at distance d by E = L A cos(theta_e) cos(theta_r) / (d^2 + A / pi), the far-field formula softened near the
// face so it stays finite (the +A/pi keeps E at most pi L, a face's own luminance, at the face); it fades out between
// 50% and 100% of the range.
//
// The uniforms are in the render group (one buffer for every object, refreshed once per render call), so the on/off
// switch the screens part flips around each draw reaches every material. One term object per light: every material it
// is added to shares its nodes and so its program.

import * as THREE from 'three';
import { uniform, uniformArray, renderGroup, float, vec3, max, clamp, dot, length, smoothstep } from 'three/tsl';
import { addSurfaceTerm } from '../lights/surfaceLight.js';
import { photometryContext } from '../lights/photometry.js';

/** The digital faces whose glow is drawn at most (the nearest). */
export const GLOW_MAX = 6;

const shared = (v) => uniform(v).setGroup(renderGroup);

/**
 * The Sphere's light: { uniforms, attach(material) -> detach }. The uniforms are TSL uniform nodes: uScrSphere (centre in
 * scene metres, radius), uScrSphereL (mean luminance, cd/m^2), uScrSphereSpec (range, on 0/1).
 * @param {{ range: number, photometry?: object }} o
 */
export function createSphereLight({ range, photometry = {} }) {
  const ctx = photometryContext(photometry);
  const uniforms = {
    uScrSphere: shared(new THREE.Vector4(0, 0, 0, 1)).setName('uScrSphere'),
    uScrSphereL: shared(new THREE.Vector3()).setName('uScrSphereL'),
    uScrSphereSpec: shared(new THREE.Vector4(range, 0, 0, 0)).setName('uScrSphereSpec'),
  };
  const { uScrSphere: C, uScrSphereL: L, uScrSphereSpec: spec } = uniforms;
  const term = {
    id: 'screenSphere',
    key: 'node-v1',
    lux: ({ positionWorld, normalWorld }) => {
      const v = C.xyz.sub(positionWorld);
      const d = length(v);
      const R = C.w;
      const dd = max(d, R.mul(1.02));
      const cosT = clamp(dot(normalWorld, v.div(max(d, 1e-3))), 0, 1);
      const fade = float(1).sub(smoothstep(spec.x.mul(0.6), spec.x, d)); // 0 at and past the range
      return L.mul(R.mul(R).mul(Math.PI).div(dd.mul(dd)).mul(cosT).mul(fade).mul(spec.y));
    },
  };
  return { uniforms, attach: (material) => addSurfaceTerm(material, term, { photometry: ctx }) };
}

/**
 * The digital faces' glow: { uniforms, count, attach }. The uniforms' `.value` are arrays of `count` vectors (uScrGlowP:
 * centre, area; uScrGlowN: normal, range; uScrGlowL: mean luminance, cd/m^2), changed in place; the term reads them as
 * uniform arrays.
 * @param {{ range: number, count?: number, photometry?: object }} o  count: faces (GLOW_MAX at most; 0 makes no term)
 */
export function createGlowLight({ range, count = GLOW_MAX, photometry = {} }) {
  const ctx = photometryContext(photometry);
  const n = Math.max(0, Math.min(GLOW_MAX, count | 0));
  const P = Array.from({ length: Math.max(1, n) }, () => new THREE.Vector4());
  const N = Array.from({ length: Math.max(1, n) }, () => new THREE.Vector4(0, 0, 1, range));
  const Lv = Array.from({ length: Math.max(1, n) }, () => new THREE.Vector3());
  const uniforms = { uScrGlowP: { value: P }, uScrGlowN: { value: N }, uScrGlowL: { value: Lv } };
  const uP = uniformArray(P, 'vec4'), uN = uniformArray(N, 'vec4'), uL = uniformArray(Lv, 'vec3');
  const term = {
    id: 'screenGlow',
    key: `node-v1-${n}`,
    lux: ({ positionWorld, normalWorld }) => {
      let E = vec3(0);
      for (let i = 0; i < n; i++) {
        const p = uP.element(i), m = uN.element(i), L = uL.element(i).xyz;
        const v = positionWorld.sub(p.xyz);
        const d2 = dot(v, v);
        const d = d2.sqrt();
        const u = v.div(max(d, 1e-3));
        const ce = max(dot(m.xyz, u), 0);
        const cr = max(dot(normalWorld, u.negate()), 0);
        const A = p.w;
        const fade = float(1).sub(smoothstep(m.w.mul(0.5), m.w, d)); // 0 at and past the range
        E = E.add(L.mul(A.mul(ce).mul(cr).div(d2.add(A.div(Math.PI))).mul(fade)));
      }
      return E;
    },
  };
  return {
    uniforms, count: n,
    attach: (material) => (n ? addSurfaceTerm(material, term, { photometry: ctx }) : () => {}),
  };
}
