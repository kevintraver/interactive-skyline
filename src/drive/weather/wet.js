// The wet road's term (plan 02, D8.1), as a `filter` term of src/drive/lights/surfaceLight.js. Mirror: wetMirror.js wetFragment (the same
// arithmetic, tests/unit/weather/wet.test.js). Added last on a material, it sees every other term's light.
//
// Per fragment: the water's cover (wetness, and on the road the wheel paths' wear read from the atlas coordinate),
// faded out on anything steeper than about 30 degrees from level (walls, barriers, their reflectors). Then, in the
// filter's terms:
//   diffuse   three's diffuse light (direct and indirect) x k, k = 1 - cover x (1 - wet/dry diffuse ratio)
//   lux       the other terms' illuminance x k x (1 - cover x F(view)): light arriving at grazing angles (the visitor's
//             own headlamps, whose lamps are beside the eye, so their incidence is the view's) mostly glances off the
//             film forward and does not come back; a street lamp's pool goes the same way into its reflected twin
//   radiance  the other terms' radiance (the markings' retroreflection) x (1 - cover x (1 - WET_RETRO))
//             plus the sky near the horizon mirrored by the film: sky x cover x gloss x F(view)
// The sky is in cd/m^2 here (surfaceLight.js scales a term's radiance by the light scale); wetRoad.js sets
// it. With the wetness (uWet.x) at 0 the whole block is skipped behind a uniform branch: the factors stay 1, 1, 1, 0
// and the term adds nothing.

import { Fn, If, float, vec4, uv, clamp, sqrt, max, exp, dot, smoothstep } from 'three/tsl';
import { GLOSS } from './wetMirror.js';

export const TERM_ID = 'wet';

/** Unpolarised Fresnel reflectance of water (n = 1.333) at cos(incidence) c (wetMirror.js fresnelWater). */
export function wetFresnel(c0) {
  const c = clamp(c0, 0, 1);
  const st = sqrt(max(float(1).sub(c.mul(c)), 0)).div(1.333);
  const ct = sqrt(max(float(1).sub(st.mul(st)), 0));
  const rs = c.sub(ct.mul(1.333)).div(c.add(ct.mul(1.333)));
  const rp = ct.sub(c.mul(1.333)).div(ct.add(c.mul(1.333)));
  return rs.mul(rs).add(rp.mul(rp)).mul(0.5);
}

const gauss = (t, m, s) => { const u = t.sub(m).div(s); return exp(u.mul(u).mul(-0.5)); };

/**
 * The term for one kind of surface. Build it once per kind and add the same object to every material of that kind,
 * so they share a program (node identity decides, surfaceLight.js).
 * @param {'road' | 'ground'} kind  'road' reads the atlas coordinate for the wheel paths and the dirt region
 * @param {{ uWet, uWetSky, uWetLanes, uWetPath, uWetDirt }} U  uniform nodes: uWet vec4 (wetness, wet/dry diffuse
 *   ratio, markings' retro kept wet, gloss), uWetSky vec3 (cd/m^2), the atlas' lane regions, wheel paths and dirt region
 * @returns {{ id: string, key: string, filter: Function }}
 */
export function wetTerm(kind, U) {
  const road = kind === 'road';
  return {
    id: TERM_ID,
    key: `${kind}-v1`,
    filter: ({ normalWorld, viewWorld }, acc) => {
      // (k, k x (1 - cover F), retro kept, cover x gloss x F); 1, 1, 1, 0 when dry
      const f = Fn(() => {
        const out = vec4(1, 1, 1, 0).toVar('wetFactors');
        If(U.uWet.x.greaterThan(0), () => {
          const path = float(0).toVar('wetPath');
          const gloss = U.uWet.w.toVar('wetGloss');
          if (road) {
            const u = uv().x;
            const L = U.uWetLanes;
            const t = float(-1).toVar('wetT');
            If(u.greaterThanEqual(L.x).and(u.lessThan(L.y)), () => { t.assign(u.sub(L.x).div(L.y.sub(L.x))); })
              .ElseIf(u.greaterThanEqual(L.z).and(u.lessThan(L.w)), () => { t.assign(u.sub(L.z).div(L.w.sub(L.z))); });
            If(t.greaterThanEqual(0), () => { path.assign(max(gauss(t, U.uWetPath.x, U.uWetPath.z), gauss(t, U.uWetPath.y, U.uWetPath.z))); });
            If(u.greaterThanEqual(U.uWetDirt.x).and(u.lessThan(U.uWetDirt.y)), () => { gloss.assign(GLOSS.ground); });
          }
          const cover = clamp(U.uWet.x.mul(path.add(1)), 0, 1).mul(smoothstep(0.5, 0.9, normalWorld.y)).toVar('wetCover');
          const F = wetFresnel(dot(normalWorld, viewWorld)).toVar('wetF');
          const k = float(1).sub(cover.mul(float(1).sub(U.uWet.y))).toVar('wetK');
          out.assign(vec4(k, k.mul(float(1).sub(cover.mul(F))), float(1).sub(cover.mul(float(1).sub(U.uWet.z))), cover.mul(gloss).mul(F)));
        });
        return out;
      })().toVar('wetW');
      return { diffuse: f.x, lux: acc.lux.mul(f.y), radiance: acc.radiance.mul(f.z).add(U.uWetSky.mul(f.w)) };
    },
  };
}
