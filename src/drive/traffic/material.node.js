// The traffic's two materials (plan 02, D6.4) as node materials for plan 01's renderer (three r187, `three/webgpu`,
// `three/tsl`): the sibling of material.js (plan 02, third stretch, decision 2), with the same factories, options
// and returned objects. tests/manual/traffic-node-shots.mjs draws both and compares them.
//
// 1. Bodies: an ordinary lit MeshStandardNodeMaterial (the scene's lights and fog) with
//    - paint: colour = COLOR_0.rgb * mix(1, instanceColor, _paint) (vehicles.json "paint"), in place of three's
//      instance-colour multiply, which would tint glass and tyres too (TrafficBodyNodeMaterial.setupDiffuseColor);
//    - lamps: the per-vertex `_lamp` (0 none, 1 head lamp lens, 2 tail lamp lens) emits head lamps uHead x dusk, tail
//      lamps uTail x dusk, and the tail lenses uBrake while the instance brakes (iTraffic.y, day or night). The
//      luminances are in cd/m^2 (lightData.js LAMP_FACE_CDM2) and are multiplied by `lightScale` (decision 6);
//    - dissolve: the per-instance iTraffic.x (0..1) discards fragments against interleaved-gradient noise in screen
//      space (maskNode), so a vehicle fades in and out as an opaque body (no sorting, no blending). The noise is
//      read at the classic renderer's gl_FragCoord (y up), so both renderers drop the same pixels.
// 2. Contact shadows: one instanced unit quad per vehicle under its footprint, black, with a soft rounded-rectangle
//    alpha x the vehicle's dissolve (iAlpha) x (1 - the scene fog's factor), pulled toward the eye in depth by
//    SHADOW_PULL of the distance (in the object's own space, so the depth, the fog and a logarithmic depth buffer
//    all see the pulled point); depthWrite off.
//
// Uniforms (createTrafficUniforms): uDusk (0 day .. 1 night), uHead, uTail, uBrake (cd/m^2), uStrength (shadow alpha
// at the centre). Each is a TSL uniform node; the caller sets `.value` as on the GLSL module's uniform objects.
//
// What differs from material.js, deliberately:
//  - uHead, uTail and uBrake are luminances in cd/m^2 x lightScale, not scene values at a fixed exposure (decision 6).
//    At lightScale 0.1 (the classic constant, LIGHTING_UNITS.nit) they write what material.js writes.
//  - the contact shadow reads no fog when the scene has none (material.js's GLSL does not compile then: it writes
//    vFogDepth, which three declares only with USE_FOG).
//  - the shadow's pull moves the point in object space instead of scaling the view-space position after the
//    transform; the two are the same point.
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, attribute, vec2, vec3, vec4, float, uniform, abs, step, fract, dot, mix, smoothstep, bool, positionGeometry,
  positionLocal, modelWorldMatrixInverse, cameraPosition, screenCoordinate, screenSize, instanceColor, diffuseColor,
  vertexColor, densityFogFactor, rangeFogFactor, reference, renderGroup,
} from 'three/tsl';
import { LAMP, SHADOW_PULL, LAMP_FACE_CDM2, HEAD_FACE_RGB, TAIL_FACE_RGB, SHADOW_STRENGTH } from './lightData.js';

export { LAMP, SHADOW_PULL };

const shared = (v) => uniform(v).setGroup(renderGroup);
const asNode = (v) => (v && v.isNode ? v : float(v ?? 1));

/** Interleaved-gradient noise at the classic renderer's gl_FragCoord (origin bottom left, pixel centres at .5). */
function classicNoise() {
  const frag = vec2(screenCoordinate.x, screenSize.y.sub(screenCoordinate.y));
  return fract(fract(dot(frag, vec2(0.06711056, 0.00583715))).mul(52.9829189));
}

/** Standard node material with the traffic's paint rule in place of three's instance-colour multiply. */
class TrafficBodyNodeMaterial extends MeshStandardNodeMaterial {
  static get type() { return 'TrafficBodyNodeMaterial'; }

  setupDiffuseColor(builder) {
    const { object, geometry } = builder;
    if (this.maskNode !== null) bool(this.maskNode).not().discard();
    let rgb = vec3(1);
    if (geometry.hasAttribute('color')) rgb = vertexColor().rgb;
    if (object.instanceColor) {
      const paint = geometry.hasAttribute('_paint') ? attribute('_paint', 'float') : float(1);
      rgb = rgb.mul(mix(vec3(1), instanceColor, paint));
    }
    diffuseColor.assign(vec4(rgb, 1));
  }
}

/**
 * Uniforms every traffic material shares: set once per look change.
 * @param {{ lightScale?: number | import('three/webgpu').Node }} [o] physical units -> what the material writes
 *   (the pre-exposure in the shipped look; 0.1 at the classic display). Default 1.
 * @returns {{ uniforms: { uDusk, uHead, uTail, uBrake, uStrength }, lightScale: import('three/webgpu').Node }}
 */
export function createTrafficUniforms({ lightScale = 1 } = {}) {
  return {
    uniforms: {
      uDusk: shared(0).setName('uTrafficDusk'),
      uHead: shared(LAMP_FACE_CDM2.head).setName('uTrafficHead'),
      uTail: shared(LAMP_FACE_CDM2.tail).setName('uTrafficTail'),
      uBrake: shared(LAMP_FACE_CDM2.brake).setName('uTrafficBrake'),
      uStrength: shared(SHADOW_STRENGTH).setName('uTrafficShadow'),
    },
    lightScale: asNode(lightScale),
  };
}

/**
 * A body material from the model's own. The geometry needs `_paint` and `_lamp` vertex attributes and the mesh an
 * instanced `iTraffic` (vec2) attribute.
 * @param {import('three').Material} base the glTF's material
 * @param {ReturnType<typeof createTrafficUniforms>} shared uniforms (createTrafficUniforms)
 */
export function createBodyMaterial(base, shared) {
  const m = new TrafficBodyNodeMaterial({
    vertexColors: true,
    roughness: base.roughness ?? 0.55,
    metalness: base.metalness ?? 0,
  });
  m.name = 'traffic-body';
  const u = shared.uniforms;
  const traffic = attribute('iTraffic', 'vec2');
  const fade = traffic.x, brake = traffic.y;
  m.maskNode = fade.greaterThanEqual(0.999).or(classicNoise().lessThan(fade));
  const lamp = attribute('_lamp', 'float');
  const head = float(1).sub(step(0.5, abs(lamp.sub(LAMP.head))));
  const tail = float(1).sub(step(0.5, abs(lamp.sub(LAMP.tail))));
  m.emissiveNode = vec3(...HEAD_FACE_RGB).mul(head.mul(u.uDusk).mul(u.uHead))
    .add(vec3(...TAIL_FACE_RGB).mul(tail.mul(u.uDusk.mul(u.uTail).add(brake.mul(u.uBrake)))))
    .mul(asNode(shared.lightScale));
  return m;
}

/** The scene fog's factor at this fragment (0 without fog), from the scene being drawn. */
const sceneFogFactor = Fn((builder) => {
  const fog = builder.scene?.fog;
  if (fog?.isFogExp2) return densityFogFactor(reference('density', 'float', fog).setGroup(renderGroup));
  if (fog?.isFog) return rangeFogFactor(reference('near', 'float', fog).setGroup(renderGroup), reference('far', 'float', fog).setGroup(renderGroup));
  return float(0);
});

/**
 * The contact-shadow material for an InstancedMesh of a unit quad in the XZ plane (x across, z along), with an
 * instanced `iAlpha`. `m.uniforms.uStrength` is the shared uniform, as on material.js's.
 */
export function createShadowMaterial(shared) {
  const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  m.name = 'traffic-shadow';
  // pulled toward the eye by SHADOW_PULL of its distance: p + (eye - p) x pull, in the object's space
  const eye = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;
  m.positionNode = positionLocal.add(eye.sub(positionLocal).mul(SHADOW_PULL));
  const q = abs(positionGeometry.xz.mul(2));
  const a = float(1).sub(smoothstep(0.55, 1.0, q.x)).mul(float(1).sub(smoothstep(0.8, 1.0, q.y)));
  m.colorNode = vec3(0);
  m.opacityNode = a.mul(shared.uniforms.uStrength).mul(attribute('iAlpha', 'float')).mul(float(1).sub(sceneFogFactor()));
  m.uniforms = { uStrength: shared.uniforms.uStrength };
  return m;
}
