// The mirror faces' shader (plan 02, D4.3): each face shows its render target, flipped in u (cabin.json's
// mirrorsNote: the face's u runs to the driver's right, the reflected camera's x the other way), with a barrel
// mapping on the convex passenger mirror, the glass's reflectance, and on the door mirrors the car's own flank
// along the inner edge (the body is not modelled outside the cabin). Written for three's ShaderMaterial on
// WebGLRenderer; to be ported with the other custom shaders (see the plan's port table).
//
// Uniforms
//   map          the mirror's render target: tone-mapped and sRGB-encoded as the screen is (mirrors.js
//                displayTarget), in plain RGBA8: decoded here
//   uExposure    the renderer's toneMappingExposure, for the flank and the stand-in (drawn in scene units)
//   uReady       0 until the first image: the face shows uStandIn
//   uStandIn     linear colour shown before the first image
//   uReflect     reflectance (linear, 0..1): the image has it already (mirrors.js applies it before the tone
//                mapping); here only for the flank and the stand-in
//   uBarrel      tan of the half-angles (x, y) of the convex mirror's field; (0, 0) for a flat mirror
//   uFlank       x: which edge is inboard (+1 u = 1, -1 u = 0, 0 none); y, z: the flank's width (share of the
//                face) at the bottom and the top; w: the beltline's height (v)
//   uFlankPaint  linear colour of the lit paint; uFlankGlass that of the side windows above the beltline

export const mirrorVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const mirrorFragment = /* glsl */ `
uniform sampler2D map;
uniform float uReady;
uniform vec3 uStandIn;
uniform float uReflect;
uniform vec2 uBarrel;
uniform vec4 uFlank;
uniform vec3 uFlankPaint;
uniform vec3 uFlankGlass;
uniform float uExposure;
varying vec2 vUv;

vec3 srgbDecode(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
// three's ACESFilmicToneMapping, for what this shader draws in scene units (the flank, the stand-in)
vec3 acesFit(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 toneMap(vec3 c) {
  const mat3 inM = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 outM = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  return clamp(outM * acesFit(inM * (c * uExposure / 0.6)), 0.0, 1.0);
}

void main() {
  // the face as the driver sees it, u right and v up: three keeps glTF's texture coordinates, whose v runs down
  // (the model's v up was flipped on export, as for the displays)
  vec2 f = vec2(vUv.x, 1.0 - vUv.y);
  // the reflected camera's x runs against the face's u
  vec2 t = vec2(1.0 - f.x, f.y);
  if (uBarrel.x > 0.0) {
    // a spherical convex mirror turns rays by an angle proportional to the offset from its centre: sample the
    // perspective image at tan(s A) / tan(A) for s in -1..1 (A the half-angle of the field)
    vec2 s = t * 2.0 - 1.0;
    vec2 A = atan(uBarrel);
    t = tan(s * A) / uBarrel * 0.5 + 0.5;
  }
  // linear, as displayed (already tone-mapped)
  vec3 c = uReady > 0.5 ? srgbDecode(texture2D(map, t).rgb) : toneMap(uStandIn * uReflect);
  if (uFlank.x != 0.0) {
    // the car's own side along the inboard edge: wider low down (the door bulges toward the rear wheel), a
    // window line at the beltline, soft by a pixel or so
    float edge = uFlank.x > 0.0 ? 1.0 - f.x : f.x;
    float w = mix(uFlank.y, uFlank.z, f.y);
    float k = 1.0 - smoothstep(w - 0.012, w + 0.004, edge);
    vec3 side = f.y > uFlank.w ? uFlankGlass : uFlankPaint * (0.8 + 0.4 * smoothstep(0.0, uFlank.w, f.y));
    // a highlight along the shoulder just under the beltline
    side += uFlankPaint * 0.5 * (1.0 - smoothstep(0.0, 0.035, abs(f.y - uFlank.w + 0.03)));
    c = mix(c, toneMap(side * uReflect), k);
  }
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;
