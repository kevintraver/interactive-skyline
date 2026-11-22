// GLSL of the spray behind vehicles on a wet road (plan 02, D8.3): soft camera-facing puffs, premultiplied "over"
// blending, sorted far to near on the CPU (spray.js). To be ported with the renderer (plan 02, port table).
// The puff's grain drifts with simulation time (uTime), so a paused frame holds still.

export const sprayVertex = /* glsl */ `
in vec2 corner;          // -1..1
in vec3 aPos;            // centre relative to the reference point (m)
in float aSize;          // radius (m)
in float aAlpha;         // peak opacity
in vec3 aColor;          // radiance (scene units, linear)
in float aSeed;
uniform vec3 uRef;       // the reference point relative to the eye
out vec2 vUv;
out float vAlpha;
out vec3 vColor;
out float vSeed;
void main() {
  vec3 v = mat3(viewMatrix) * (aPos + uRef);
  vUv = corner;
  vAlpha = aAlpha; vColor = aColor; vSeed = aSeed;
  if (aAlpha <= 0.0 || v.z > -0.3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  v.xy += corner * aSize;
  gl_Position = projectionMatrix * vec4(v, 1.0);
}
`;

export const sprayFragment = /* glsl */ `
in vec2 vUv;
in float vAlpha;
in vec3 vColor;
in float vSeed;
uniform float uTime;     // simulation seconds, modulo 1000
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  float body = exp(-3.0 * r2) * (1.0 - smoothstep(0.6, 1.0, r2));
  body *= smoothstep(-1.0, -0.35, vUv.y);    // the road cuts the bottom: fade it rather than show the edge
  vec2 p = vUv * 1.7 + vec2(vSeed * 17.0, vSeed * 5.0 + uTime * 0.9);
  float n = 0.6 * vnoise(p) + 0.4 * vnoise(p * 2.3 + 7.1);
  float a = clamp(vAlpha * body * (0.45 + 1.1 * n), 0.0, 1.0);
  gl_FragColor = vec4(vColor * a, a);
  #include <colorspace_fragment>
}
`;
