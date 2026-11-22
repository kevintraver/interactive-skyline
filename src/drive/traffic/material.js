// The traffic's two materials (plan 02, D6.4). CUSTOM SHADERS: listed in the plan's port table, to be
// ported with the renderer (plan 01, phase 2).
//
// 1. Bodies: the model's MeshStandardMaterial (lit by the app's lights and fogged like the rest of the
//    scene, so it darkens at night with them) with four additions by onBeforeCompile:
//    - paint: colour = COLOR_0.rgb * mix(1, instanceColor, _paint) (vehicles.json "paint"), replacing
//      three's instance-colour multiply, which would tint glass and tyres too;
//    - lamps: the per-vertex `_lamp` (0 none, 1 head lamp lens, 2 tail lamp lens; made at load from the
//      lens colours baked in COLOR_0) adds emission: head lamps uHead x dusk, tail lamps uTail x dusk,
//      and the tail lenses uBrake while the instance brakes (day or night);
//    - dissolve: the per-instance `iTraffic.x` (0..1) discards fragments against interleaved-gradient
//      noise in screen space, so a vehicle fades in and out as an opaque body (no sorting, no blending);
//    - iTraffic.y is the brake flag.
//    Uniforms: uDusk (0 day .. 1 night), uHead, uTail, uBrake (emission in scene units at today's fixed
//    exposure; ACES filmic tone mapping takes the glow to white or deep red).
// 2. Contact shadows: one instanced unit quad per vehicle under its footprint, black, with a soft
//    rounded-rectangle alpha, multiplied by the vehicle's dissolve and by (1 - fog) so it vanishes into
//    the haze with the road. Pulled toward the camera in depth (as the road pavement is, roadnet/material.js
//    PULL) a little more than the pavement so it wins over it at any distance; depthWrite off.
//    Uniforms: uStrength (alpha at the centre), fog.
import * as THREE from 'three';
import { PULL } from '../roadnet/material.js';

export const LAMP = Object.freeze({ none: 0, head: 1, tail: 2 });
export const SHADOW_PULL = PULL * 1.6;

const DISSOLVE = /* glsl */`
  if (vTrafficFade < 0.999) {
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (ign >= vTrafficFade) discard;
  }`;

/**
 * A body material from the model's own. The geometry needs `_paint` and `_lamp` vertex attributes and the
 * mesh an instanced `iTraffic` (vec2) attribute.
 * @param {THREE.Material} base the glTF's material  @param {{ uniforms: object }} shared uniforms (createTrafficUniforms)
 */
export function createBodyMaterial(base, shared) {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: base.roughness ?? 0.55,
    metalness: base.metalness ?? 0,
  });
  m.name = 'traffic-body';
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, shared.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float _paint;
attribute float _lamp;
attribute vec2 iTraffic;
varying float vLamp;
varying float vTrafficFade;
varying float vBrake;`)
      .replace('#include <color_vertex>', `
  vColor = vec4(1.0);
  #ifdef USE_COLOR_ALPHA
    vColor *= color;
  #elif defined(USE_COLOR)
    vColor.rgb *= color;
  #endif
  #ifdef USE_INSTANCING_COLOR
    vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, _paint);
  #endif
  vLamp = _lamp;
  vTrafficFade = iTraffic.x;
  vBrake = iTraffic.y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uDusk;
uniform float uHead;
uniform float uTail;
uniform float uBrake;
varying float vLamp;
varying float vTrafficFade;
varying float vBrake;`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
${DISSOLVE}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    float head = 1.0 - step(0.5, abs(vLamp - 1.0));
    float tail = 1.0 - step(0.5, abs(vLamp - 2.0));
    totalEmissiveRadiance += head * uDusk * uHead * vec3(1.0, 0.94, 0.82);
    totalEmissiveRadiance += tail * (uDusk * uTail + vBrake * uBrake) * vec3(1.0, 0.012, 0.006);
  }`);
  };
  m.customProgramCacheKey = () => 'traffic-body-1';
  return m;
}

/** Uniforms every traffic material shares: set once per look change. */
export function createTrafficUniforms() {
  return {
    uniforms: {
      uDusk: { value: 0 },
      uHead: { value: 6.0 },
      uTail: { value: 0.9 },
      uBrake: { value: 2.2 },
      uStrength: { value: 0.6 },
    },
  };
}

/** The contact-shadow material for an InstancedMesh of a unit quad in the XZ plane (x across, z along), with an instanced `iAlpha`. */
export function createShadowMaterial(shared) {
  const m = new THREE.ShaderMaterial({
    name: 'traffic-shadow',
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    transparent: true,
    depthWrite: false,
    fog: true,
    vertexShader: /* glsl */`
#include <common>
#include <fog_pars_vertex>
attribute float iAlpha;
varying vec2 vUv2;
varying float vAlpha;
void main() {
  vUv2 = position.xz * 2.0;
  vAlpha = iAlpha;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  mvPosition.xyz *= ${(1 - SHADOW_PULL).toFixed(6)};
  gl_Position = projectionMatrix * mvPosition;
  vFogDepth = -mvPosition.z;
}`,
    fragmentShader: /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform float uStrength;
varying vec2 vUv2;
varying float vAlpha;
void main() {
  vec2 q = abs(vUv2);
  float a = (1.0 - smoothstep(0.55, 1.0, q.x)) * (1.0 - smoothstep(0.8, 1.0, q.y));
  float fogK = 0.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      fogK = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      fogK = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * uStrength * vAlpha * (1.0 - fogK));
}`,
  });
  m.uniforms.uStrength = shared.uniforms.uStrength;
  return m;
}
