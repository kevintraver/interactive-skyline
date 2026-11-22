// The headlamp-pool decal shader (plan 02, D6.4): the light other vehicles' low beams throw on the road ahead of
// them. WebGL2 through three's ShaderMaterial. CUSTOM SHADER: listed in the plan's port table, to be ported with
// the renderer (plan 01, phase 2). Mirror: pools.js poolIlluminance (the same model in JavaScript, for tests).
//
// One instanced quad per lit vehicle, flat on its own pavement plane from its front bumper forward. Per fragment
// the illuminance from its two lamps (iLamp: half their spacing and their height) by an analytic low beam: a hot
// spot just below the horizontal (1.2 deg down, 12,000 cd: FMVSS 108 Table XIX-a asks 10,000 at 0.6D 1.3R and
// 15,000 at 1.5D 2R) and a wide foreground (3,000 cd, +-28 deg), E = I cos(incidence) / r^2, reflected by asphalt
// as rho E / pi (rho uRho) and drawn additively in scene units (uGain: lighting.units.nit x the beams' fade).
// Pulled toward the eye in depth like the contact shadows (material.js SHADOW_PULL) so it shows over the road.

export const poolVertex = /* glsl */ `
#include <common>
attribute vec2 corner;      // x: -1..1 across, y: 0..1 along
attribute vec3 iOrigin;     // the front bumper on the ground, scene metres
attribute vec3 iFwd;        // unit forward, along the pavement
attribute vec3 iUp;         // unit pavement normal
attribute vec2 iLamp;       // half the lamp spacing, lamp height (m)
attribute float iScale;     // opacity x lit
uniform float uLength;
uniform float uHalfWidth;
uniform float uPull;
varying vec2 vLocal;        // metres: across (right +), along
varying vec2 vLamp;
varying float vScale;
void main() {
  vec3 right = normalize(cross(iFwd, iUp));
  float along = corner.y * uLength;
  float across = corner.x * uHalfWidth * (0.35 + 0.65 * corner.y);
  vLocal = vec2(across, along);
  vLamp = iLamp;
  vScale = iScale;
  vec3 p = iOrigin + iFwd * along + right * across + iUp * 0.02;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  mv.xyz *= 1.0 - uPull;
  gl_Position = projectionMatrix * mv;
}`;

export const poolFragment = /* glsl */ `
uniform float uGain;
uniform float uRho;
uniform vec3 uColor;
varying vec2 vLocal;
varying vec2 vLamp;
varying float vScale;
const float DEG = 57.29577951308232;
float beam(float beta, float phi) {
  float a = (beta - 1.2) / 1.6, b = phi / 10.0, c = (beta - 3.0) / 4.0, e = phi / 28.0;
  return 12000.0 * exp(-(a * a + b * b)) + 3000.0 * exp(-(c * c + e * e));
}
float lampE(vec2 q, float x0, float h) {
  vec2 g = vec2(q.x - x0, q.y);
  float flat2 = dot(g, g);
  float r2 = flat2 + h * h;
  float flat1 = sqrt(flat2);
  float beta = atan(h, flat1) * DEG;
  float phi = atan(g.x, max(g.y, 1e-3)) * DEG;
  return beam(beta, phi) * (h / sqrt(r2)) / r2;
}
void main() {
  if (vLocal.y < 0.3) discard;
  float E = lampE(vLocal, -vLamp.x, vLamp.y) + lampE(vLocal, vLamp.x, vLamp.y);
  float L = uRho * E / 3.141592653589793 * uGain * vScale;
  gl_FragColor = vec4(uColor * L, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
