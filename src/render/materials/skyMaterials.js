// The legacy sky's dome and the Sun and Moon discs on the new renderer (plan 01, T2.3): TSL ports of the classic
// ShaderMaterials, interim until phase 3's atmosphere replaces both.
//
// The classic shaders wrote their colour straight to the canvas: no tone mapping, no sRGB encoding (they include
// neither chunk), so a uniform's linear value was shown as-is. The new renderer tone-maps and encodes every pixel
// in one output pass. To show the same pixels, these materials hand the output pass the scene value that ACES and
// the sRGB encoding turn back into the classic value: displayToScene(), the exact inverse of three's
// acesFilmicToneMapping (ToneMappingFunctions.js) and sRGBTransferOETF.
import { Matrix3, BackSide, AdditiveBlending, Color, Vector3 } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, vec3, float, uniform, varying, positionGeometry, normalize, clamp, pow, mix, sqrt, max, uv, length,
  smoothstep, exp, step, dot, select, Discard, If, toneMappingExposure, output, vec4, densityFogFactor,
  acesFilmicToneMapping, sRGBTransferOETF,
} from 'three/tsl';
import { haze as sharedHaze, physical, legacyScale } from './shared.js';

/** 1 in the classic look; the legacy surfaces' scale in the physical one (T2.5) */
const legacy = () => mix(float(1), legacyScale, physical);

// three's ACES matrices, rows as written in ToneMappingFunctions.js (out.r = row 0 . in)
const IN = new Matrix3().set(0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777);
const OUT = new Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602);
const IN_INV = IN.clone().invert(), OUT_INV = OUT.clone().invert();
// m . v with explicit row dot products (no question of a matrix constructor's element order)
const applyRows = (m, v) => {
  const e = m.elements; // column-major
  return vec3(dot(vec3(e[0], e[3], e[6]), v), dot(vec3(e[1], e[4], e[7]), v), dot(vec3(e[2], e[5], e[8]), v));
};

/** sRGB-encoded display value -> linear (inverse of three's sRGBTransferOETF) */
const srgbToLinear = Fn(([c]) => select(c.lessThanEqual(0.04045), c.mul(0.0773993808), pow(c.mul(0.9478672986).add(0.0521327014), 2.4)));

/** inverse of RRTAndODTFit, per channel: the root of a quadratic */
const fitInverse = Fn(([u]) => {
  const a = u.mul(-0.983729).add(1);
  const b = u.mul(-0.432951).add(0.0245786);
  const c = u.mul(0.238081).add(0.000090537).negate();
  return b.negate().add(sqrt(max(b.mul(b).sub(a.mul(c).mul(4)), 0))).div(a.mul(2));
});

/**
 * The scene-referred colour that three's ACES output pass (at the renderer's exposure) and sRGB encoding show as
 * `display` (0..1 per channel, the value a classic shader wrote to the canvas). Exact up to half-float rounding.
 */
export const displayToScene = Fn(([display]) => {
  const y = srgbToLinear(clamp(display, 0, 0.999));
  const u = applyRows(OUT_INV, y);
  const v = fitInverse(clamp(u, 0, 1.01));
  return applyRows(IN_INV, v).mul(0.6).div(toneMappingExposure);
});

/** The two-colour dome: horizon (the haze) to zenith, as legacySky's ShaderMaterial. */
export function domeNodeMaterial(zenithColor, horizon = sharedHaze) {
  const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  // as the classic shader: normalised per vertex, interpolated, not normalised again
  const d = varying(normalize(positionGeometry), 'vDomeDir');
  const t = pow(clamp(d.y, 0, 1), 0.45);
  material.colorNode = displayToScene(mix(horizon, uniform(zenithColor), t)).mul(legacy());
  return material;
}

const HALO = 4; // the Sun's quad reaches four disc radii, for a soft glow (discs.js)

/**
 * A disc's material on the new renderer; `uniforms` are discs.js's ({ value } objects, TSL uniform nodes here).
 * 'sun': a limb-darkened disc with a soft glow; 'moon': a sphere lit from the Sun's direction.
 */
export function discNodeMaterial(kind, uniforms) {
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, fog: false, blending: AdditiveBlending });
  const p = uv().mul(2).sub(1);
  if (kind === 'sun') {
    material.colorNode = Fn(() => {
      const r = length(p).mul(HALO);
      const disc = float(1).sub(smoothstep(0.92, 1.04, r));
      const rc = r.min(1);
      const limb = float(1).sub(float(0.35).mul(float(1).sub(sqrt(max(float(1).sub(rc.mul(rc)), 0)))));
      const glow = float(0.22).mul(exp(float(-2.2).mul(max(r.sub(1), 0)))).mul(float(1).sub(disc)).mul(step(r, HALO));
      return displayToScene(clamp(uniforms.color.mul(uniforms.strength).mul(disc.mul(limb).add(glow)), 0, 1)).mul(legacy());
    })();
  } else {
    material.colorNode = Fn(() => {
      const r2 = dot(p, p);
      If(r2.greaterThan(1), () => { Discard(); });
      const n = uniforms.axisX.mul(p.x).add(uniforms.axisY.mul(p.y)).add(uniforms.axisZ.mul(sqrt(max(float(1).sub(r2), 0))));
      const lit = smoothstep(-0.015, 0.015, dot(n, uniforms.lightDir));
      const edge = float(1).sub(smoothstep(0.94, 1.0, sqrt(r2)));
      const shade = sqrt(max(float(1).sub(r2), 0)).mul(0.14).add(0.86);
      return displayToScene(clamp(uniforms.color.mul(uniforms.strength).mul(lit).mul(edge).mul(shade), 0, 1)).mul(legacy());
    })();
  }
  material.uniforms = uniforms;
  return material;
}

/** The disc uniforms as TSL uniform nodes; discs.js reads and writes `.value` on them, as on GLSL uniforms. */
export function discUniforms(kind) {
  if (kind === 'sun') return { color: uniform(new Color(1, 0.97, 0.9)), strength: uniform(1) };
  return {
    color: uniform(new Color(0.93, 0.93, 0.9)), strength: uniform(1), lightDir: uniform(new Vector3(0, 1, 0)),
    axisX: uniform(new Vector3(1, 0, 0)), axisY: uniform(new Vector3(0, 1, 0)), axisZ: uniform(new Vector3(0, 0, 1)),
  };
}


/**
 * The legacy sky's exponential-squared fog as a scene fog node (T2.3). Classic look: three's classic shaders apply
 * fog after tone mapping and sRGB encoding (fog_fragment follows colorspace_fragment), mixing the encoded colour with
 * the fog colour's linear value; this reproduces that mix exactly for opaque surfaces and hands the output pass the
 * scene value that shows as the result. Physical look: fog mixes in the linear HDR buffer, toward the haze as a
 * legacy surface (scaled like the dome).
 */
export function legacyFogNode(horizon, density) {
  return Fn(() => {
    const f = densityFogFactor(density);
    const shown = sRGBTransferOETF(acesFilmicToneMapping(output.rgb, toneMappingExposure));
    const classic = displayToScene(mix(shown, horizon, f));
    const physicalFog = mix(output.rgb, displayToScene(horizon).mul(legacyScale), f);
    return vec4(mix(classic, physicalFog, physical), output.a);
  })();
}
