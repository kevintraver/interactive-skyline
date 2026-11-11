// skyline-integration: v6 (blender-landmark-model skill)
// (older tools test for the text "skyline-integration: v4" and replace files without it; v6 includes it here)
// Night lighting without any extra lights or draw calls: buildings glow from their own material.
// Three sources are added as emissive light:
//   - `glow`, an optional per-vertex color baked into hand-made models (see customModels.js)
//   - lit windows, drawn procedurally on the walls of extruded buildings, and on the parts of hand-made
//     models whose `windows` attribute asks for them (their glass, usually)
//   - animated LED surfaces: model faces whose `led` attribute is set (glTF material named Led...) show
//     slowly drifting color bands, strong at night and faint by day, driven by the shared `clock`
// By day the same facade glass of a hand-made model also gets a mullion and floor grid, slightly uneven
// panes, and the sky reflected at grazing angles. Extruded buildings carry no `windows` attribute, so by
// day they look exactly as before.

/** 0 by day, 1 at night. Every lit material shares this object, so switching is one assignment. */
export const night = { value: 0 };
/** Seconds for animated surfaces (LED skins, the fountain show); attractions.js advances it. */
export const clock = { value: 0 };

const VERTEX_HEAD = /* glsl */`
attribute vec3 glow;
attribute float windows;
attribute float led;
varying vec3 vGlow;
varying float vWindows;
varying float vLed;
varying vec3 vNightPos;
varying vec3 vNightNormal;`;

// Geometry is built in world coordinates and a moved building only shifts its mesh,
// so reading the untransformed position keeps the windows fixed to the building.
const VERTEX_BODY = /* glsl */`
vGlow = glow;
vWindows = windows;
vLed = led;
vNightPos = transformed;
vNightNormal = objectNormal;`;

const FRAGMENT_HEAD = /* glsl */`
uniform float uNight;
uniform float uWindows;
uniform float uClock;
varying vec3 vGlow;
varying float vWindows;
varying float vLed;
varying vec3 vNightPos;
varying vec3 vNightNormal;

float nightHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Which faces count as facade: on extruded buildings the walls (within about 12 degrees of vertical); on a
// model's marked glass also slopes up to about 60 degrees from vertical, such as a pyramid's faces.
float facadeFacing() {
  return 1.0 - step(uWindows > 0.5 ? 0.2 : 0.87, abs(vNightNormal.y));
}

// Window grid on a wall: one bay (3.6 m) across, one floor (3.4 m) up. Bays run along the face's horizontal
// direction and floors stay level, also on a sloped face. Worked out for every pixel, roofs included,
// because screen-space derivatives are only defined outside a branch.
vec2 gridAlong() {
  vec2 wall = vNightNormal.xz + vec2(1e-5, 0.0);
  return normalize(vec2(-wall.y, wall.x));
}
vec2 gridCell(vec2 along) {
  return vec2(dot(vNightPos.xz, along) / 3.6, vNightPos.y / 3.4);
}
// far away a window is smaller than a pixel: fade to the wall's average so it does not shimmer
float gridDetail(vec2 cell) {
  return 1.0 - smoothstep(0.35, 1.2, max(fwidth(cell.x), fwidth(cell.y)));
}

vec3 nightGlow() {
  vec3 light = vGlow;
  vec2 along = gridAlong(), cell = gridCell(along);
  float detail = gridDetail(cell);
  // extruded buildings get windows everywhere; a hand-made model only where its windows attribute says
  float windowed = uWindows > 0.5 ? 1.0 : vWindows;
  if (windowed > 0.0 && facadeFacing() > 0.5) {
    vec2 id = floor(cell) + 17.0 * floor(along * 5.0), f = fract(cell);
    float busy = mix(0.05, 0.4, nightHash(floor(vNightPos.xz / 90.0))); // share of windows lit, block by block
    float lit = step(1.0 - busy, nightHash(id));
    float pane = step(0.18, f.x) * step(f.x, 0.82) * step(0.25, f.y) * step(f.y, 0.8);
    float amount = mix(busy * 0.35, lit * pane, detail);
    vec3 tint = mix(vec3(1.0, 0.72, 0.38), vec3(0.7, 0.82, 1.0), step(0.8, nightHash(id + 3.7)));
    light += tint * amount * 0.75 * windowed;
  }
  return light * uNight;
}

// Value noise in 3D for the LED skins (smooth, no texture lookups).
float ledHash(vec3 p) {
  return nightHash(p.xy + vec2(p.z * 7.13, p.z * 3.71));
}
float ledNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(ledHash(i), ledHash(i + vec3(1.0, 0.0, 0.0)), f.x);
  float b = mix(ledHash(i + vec3(0.0, 1.0, 0.0)), ledHash(i + vec3(1.0, 1.0, 0.0)), f.x);
  float c = mix(ledHash(i + vec3(0.0, 0.0, 1.0)), ledHash(i + vec3(1.0, 0.0, 1.0)), f.x);
  float d = mix(ledHash(i + vec3(0.0, 1.0, 1.0)), ledHash(i + vec3(1.0, 1.0, 1.0)), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}

// An LED skin: soft color bands drifting up and across the surface, broken up by slow noise. Abstract on
// purpose: no text, logos or show content. Strong at night, faint by day.
vec3 ledGlow() {
  if (vLed <= 0.0) return vec3(0.0);
  vec3 p = vNightPos;
  float t = uClock;
  float n = ledNoise(p * 0.022 + vec3(0.0, -0.11 * t, 0.05 * t));
  float band = p.y * 0.018 + dot(p.xz, vec2(0.009, 0.006)) - 0.05 * t + 0.7 * n;
  vec3 color = 0.55 + 0.45 * cos(6.2832 * (band + vec3(0.0, 0.33, 0.67)));
  float pulse = 0.65 + 0.35 * sin(6.2832 * (2.0 * band - 0.07 * t));
  return color * pulse * vLed * mix(0.05, 1.2, uNight);
}

// Day detail on a model's facade glass: darkens the albedo along mullions and floor slabs, varies the panes
// a little, and returns the sky it reflects (Schlick fresnel: little head-on, a lot at grazing angles).
// n and toEye are in view space; horizon is the current haze color, so the reflection follows day and night.
vec3 facadeDay(inout vec3 albedo, vec3 n, vec3 toEye, vec3 horizon) {
  vec2 along = gridAlong(), cell = gridCell(along);
  float detail = gridDetail(cell);
  float glass = clamp(vWindows, 0.0, 1.0) * facadeFacing();
  if (glass <= 0.0) return vec3(0.0);
  vec2 f = fract(cell), id = floor(cell) + 17.0 * floor(along * 5.0);
  float frame = 1.0 - step(0.07, f.x) * step(f.x, 0.93) * step(0.1, f.y) * step(f.y, 0.92);
  float pane = (nightHash(id + 9.1) - 0.5) * 0.16;
  albedo *= 1.0 + glass * detail * (pane - frame * 0.35);
  vec3 r = reflect(-toEye, n);
  vec3 rw = normalize((vec4(r, 0.0) * viewMatrix).xyz); // view to world: the transpose undoes a rotation
  vec3 zenith = horizon * vec3(0.38, 0.55, 0.92);
  vec3 sky = rw.y > 0.0 ? mix(horizon, zenith, pow(clamp(rw.y, 0.0, 1.0), 0.5)) : horizon * 0.35;
  float fres = 0.04 + 0.96 * pow(1.0 - clamp(dot(n, toEye), 0.0, 1.0), 5.0);
  return sky * fres * glass * (1.0 - 0.7 * uNight) * (1.0 - frame * detail * 0.6);
}`;

// Runs once the normal is known. fogColor (the haze) and vViewPosition are declared after FRAGMENT_HEAD,
// so they are read here and passed in.
const FRAGMENT_BODY = /* glsl */`
totalEmissiveRadiance += nightGlow() + ledGlow();
#ifdef USE_FOG
vec3 facadeSky = fogColor;
#else
vec3 facadeSky = vec3(0.65, 0.73, 0.81);
#endif
vec3 facadeAlbedo = diffuseColor.rgb;
totalEmissiveRadiance += facadeDay(facadeAlbedo, normal, normalize(vViewPosition), facadeSky);
diffuseColor.rgb = facadeAlbedo;`;

/**
 * Make a Lambert material glow at night. `windows: false` is for hand-made models, which carry their own
 * `glow` colors and get lit windows (and the day facade detail) only where their `windows` attribute is set.
 */
export function lightAtNight(material, { windows = true } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = night;
    shader.uniforms.uClock = clock;
    shader.uniforms.uWindows = { value: windows ? 1 : 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>${VERTEX_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${FRAGMENT_HEAD}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>${FRAGMENT_BODY}`);
  };
  material.customProgramCacheKey = () => 'night-v5';
  return material;
}
