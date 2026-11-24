// The classic renderer's materials (plan 01, T2.1): the GLSL the app used before phase 2, moved here unchanged from
// night.js (v6), fountain.js (v6), the legacy sky's dome and the Sun and Moon discs. Loaded only with
// ?renderer=legacy, which keeps the classic WebGLRenderer reachable until phase 3 deletes it with this file. The
// uniforms are the shared TSL uniform nodes (src/render/materials/shared.js): their `.value` is what GLSL reads.
import * as THREE from 'three';
import { night, clock, haze } from '../materials/shared.js';

const HALO = 4; // the Sun's quad reaches four disc radii, for a soft glow (discs.js)

// ------------------------------------------------------------------ buildings (night.js v6)
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

// ------------------------------------------------------------------ the fountain (fountain.js v6)
const FOUNTAIN_VERTEX = /* glsl */`
uniform float uClock;
uniform float uNight;
uniform float uPixel;
attribute vec3 jetAt;
attribute vec4 jetKind;
attribute vec4 jetAxis;
varying vec2 vUv;
varying float vAlpha;
varying float vMist;
varying float vSeed;
varying float vTail;
#include <fog_pars_vertex>

const float LOOP = 80.0;
const float G = 9.81;

float span(float s, float a, float b, float ramp) {
  return smoothstep(a, a + ramp, s) * (1.0 - smoothstep(b - ramp, b, s));
}

// The water column of a burst fired tau seconds ago that rises to h, the nozzle open for dur seconds:
// x = bottom, y = top in meters above the water; y < 0 once it has all fallen back.
vec2 burst(float tau, float h, float dur) {
  if (tau < 0.0) return vec2(0.0, -1.0);
  float v0 = sqrt(2.0 * G * h), ta = v0 / G;
  float y0 = v0 * tau - 0.5 * G * tau * tau;
  float t1 = tau - dur;
  float y1 = t1 > 0.0 ? v0 * t1 - 0.5 * G * t1 * t1 : 0.0;
  float top = (t1 <= ta && tau >= ta) ? h : max(y0, y1);
  return vec2(max(min(y0, y1), 0.0), top);
}

// lean: horizontal lean as a vector (its length is the angle from vertical, radians)
struct Jet { float bottom; float top; vec2 lean; float spread; float mist; };

// Oarsmen and mini-shooters: steady jets whose height and lean follow the music.
Jet steady(float s, float type, float fig, float u, float side, float h0, vec2 tangent, vec2 normal) {
  bool oars = type < 0.5, line = fig < 0.5, bigRing = fig > 0.5 && fig < 2.5;
  float h = 0.0;
  vec2 lean = vec2(0.0);
  // 0-16 s: the oarsmen sweep, a wave of leaning jets running down the front line; the big rings breathe
  float a = span(s, 0.0, 16.0, 1.5);
  if (a > 0.0) {
    if (oars) {
      float w = sin(6.2832 * (s / 3.2 - u * 4.0));
      h = h0 * a * (0.8 + 0.2 * abs(w));
      lean += tangent * (0.6 * w * a);
    } else if (bigRing) {
      h = h0 * a * (0.25 + 0.12 * sin(6.2832 * (s / 4.0 + fig * 0.5)));
    }
  }
  // 16-30 s: a wave travels down the line, the oarsmen fan out in X shapes, the small rings chase around
  float b = span(s, 16.0, 30.0, 1.5);
  if (b > 0.0) {
    if (oars) {
      h = max(h, 0.65 * h0 * b);
      lean += tangent * (side * 0.45 * b);
    } else if (line) {
      h = max(h, h0 * b * (0.12 + 0.88 * pow(0.5 + 0.5 * sin(6.2832 * (u * 3.0 - s * 0.45)), 2.0)));
    } else if (!bigRing) {
      float d = abs(fract(u - s * 0.35) - 0.5);
      h = max(h, h0 * b * (0.15 + 0.85 * exp(-d * d * 60.0)));
    }
  }
  // 30-44 s: pulses, the two big rings beat in turn, the line holds a low curtain, the oarsmen rock
  float c = span(s, 30.0, 44.0, 1.0);
  if (c > 0.0) {
    if (oars) {
      h = max(h, 0.5 * h0 * c);
      lean += normal * (0.35 * c * sin(6.2832 * s / 2.4));
    } else if (bigRing) {
      float beat = fract(s / 2.4 + (fig - 1.0) * 0.5);
      h = max(h, h0 * c * (0.2 + 0.8 * exp(-beat * 6.0)));
    } else if (line) {
      h = max(h, 0.28 * h0 * c);
    }
  }
  // 44-58 s: the oarsmen cross, the rings hold, the line ripples low under the shooters
  float d = span(s, 44.0, 58.0, 1.5);
  if (d > 0.0) {
    if (oars) {
      h = max(h, 0.85 * h0 * d);
      lean += tangent * (side * 0.5 * d * (0.6 + 0.4 * sin(6.2832 * s / 4.0)));
    } else if (line) {
      h = max(h, h0 * d * (0.12 + 0.06 * sin(6.2832 * (u * 6.0 - s))));
    } else {
      h = max(h, 0.55 * h0 * d);
    }
  }
  // 58-69 s: the finale, everything up
  float e = span(s, 58.0, 69.0, 1.0);
  if (e > 0.0) {
    if (oars) {
      h = max(h, h0 * e);
      lean += tangent * (0.55 * e * sin(6.2832 * (s / 1.6 - u * 3.0)));
    } else {
      h = max(h, h0 * e * (0.85 + 0.15 * sin(6.2832 * (s * 0.8 - u * 2.0))));
      lean += normal * (0.2 * e);
    }
  }
  return Jet(0.0, h, lean, 1.0, clamp(h / h0, 0.0, 1.0));
}

// Super- and extreme-shooters: bursts that rise to their height and fall back as spray.
Jet shooter(float s, float type, float fig, float side, float u, float h0) {
  bool extreme = type > 2.5, line = fig < 0.5;
  float dur = extreme ? 2.4 : 1.6; // how long the nozzle stays open: the length of the rising column
  float t0 = -1000.0, k = 1.0;
  if (extreme) {
    if (s >= 36.0) { t0 = 36.0; k = 0.5; } // a first glimpse during the pulses
    if (s >= 61.0) { t0 = 61.0; k = 1.0; } // the finale: 140 m
  } else {
    if (!line) {
      // ring shooters fire on the beat, alternate ones on alternate beats
      // (each burst is gone before the same nozzle fires again)
      float first = 30.0 + (side > 0.0 ? 2.4 : 0.0) + (fig > 2.5 ? 1.2 : 0.0);
      for (int n = 0; n < 2; n++) {
        float t = first + float(n) * 7.2;
        if (s >= t) { t0 = t; k = 0.35; }
      }
      if (s >= 50.0) { t0 = 50.0; k = 0.6; }
    } else {
      float t = 44.0 + u * 5.0; // a chase down the line, north to south
      if (s >= t) { t0 = t; k = 1.0; }
    }
    if (s >= 58.5) { t0 = 58.5; k = 1.0; }
    if (s >= 68.0) { t0 = 68.0; k = 0.6; }
  }
  float h = h0 * k, tau = s - t0;
  vec2 col = burst(tau, h, dur);
  float ta = sqrt(2.0 * h / G);
  float falling = clamp((tau - ta) / ta, 0.0, 1.0);
  float mist = smoothstep(0.7 * ta, 1.6 * ta, tau) * (1.0 - smoothstep(2.0 * ta + 1.0, 2.0 * ta + 6.0, tau));
  // falling spray stretches out (its drops fall at different speeds); the column fattens as it rises and
  // opens into spray as it falls
  float bottom = max(min(col.x, col.y - h * (0.12 + 0.4 * falling)), 0.0);
  return Jet(bottom, col.y, vec2(0.0), clamp(tau / ta, 0.25, 1.0) + (extreme ? 2.2 : 1.6) * falling, mist);
}

void main() {
  float type = jetKind.x, fig = jetKind.y, u = jetKind.z;
  float side = floor(jetKind.w) > 0.5 ? 1.0 : -1.0, seed = fract(jetKind.w);
  vec2 tangent = jetAxis.xy, normal = jetAxis.zw;
  // published heights: 77, 100, 240 and 460 ft
  float h0 = (type < 0.5 ? 23.5 : type < 1.5 ? 30.5 : type < 2.5 ? 73.2 : 140.2) * (0.94 + 0.12 * seed);
  float s = mod(uClock, LOOP);
  Jet j;
  if (type < 1.5) j = steady(s, type, fig, u, side, h0, tangent, normal);
  else j = shooter(s, type, fig, side, u, h0);
  vUv = position.xy;
  vMist = position.z;
  vSeed = seed;
  vAlpha = 0.0;
  vTail = 0.0;
  vec3 p;
  if (position.z < 0.5) {
    if (j.top - j.bottom < 0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float v = position.y;
    vec3 axis;
    if (type > 1.5) {
      // a burst: a straight column between its bottom and top
      p = jetAt + vec3(0.0, mix(j.bottom, j.top, v), 0.0);
      axis = vec3(0.0, 1.0, 0.0);
    } else {
      // a steady jet follows a parabola: up to its top, then (when leaning) part of the way down
      float lean = length(j.lean);
      vec2 dir = lean > 1e-4 ? j.lean / lean : tangent;
      float q = v * (1.0 + 0.6 * smoothstep(0.08, 0.35, lean));
      float reach = 2.0 * j.top * tan(min(lean, 1.1));
      p = jetAt + vec3(dir.x * reach * q, j.top * (2.0 * q - q * q), dir.y * reach * q);
      axis = normalize(vec3(dir.x * reach, j.top * (2.0 - 2.0 * q) + 1e-3, dir.y * reach));
    }
    // a steady jet widens from its nozzle up; a burst column is as wide along its length as its spread says
    float baseW = type < 1.5 ? 0.5 : type < 2.5 ? 1.0 : 1.6;
    float topW = type < 0.5 ? 2.2 : type < 1.5 ? 2.0 : type < 2.5 ? 5.0 : 10.0;
    float w = type > 1.5 ? topW * j.spread * mix(0.6, 1.0, v) : mix(baseW, topW, v) * j.spread;
    vTail = type > 1.5 && j.bottom > 0.5 ? 1.0 : 0.0;
    vec3 toEye = cameraPosition - p;
    float dist = max(length(toEye), 1.0);
    vec3 across = cross(axis, toEye / dist);
    float len = length(across);
    across = len > 1e-3 ? across / len : vec3(1.0, 0.0, 0.0);
    // never thinner than about a pixel and a half; a widened jet gets fainter so it keeps its brightness
    float ww = max(w, 1.5 * uPixel * dist);
    float alpha = type < 0.5 ? 0.32 : type < 1.5 ? 0.28 : type < 2.5 ? 0.5 : 0.55;
    vAlpha = alpha * (w / ww) * (0.85 + 0.3 * seed);
    p += across * (position.x * 0.5 * ww);
  } else {
    // mist at the foot of a jet while its water falls back (every shooter, about one steady jet in five)
    float size = type < 1.5 ? 5.0 : type < 2.5 ? 16.0 : 34.0;
    float amount = j.mist * (type > 1.5 || seed < 0.22 ? 1.0 : 0.0);
    if (amount < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    p = jetAt + vec3(0.0, size * 0.35, 0.0) + (right * position.x + up * (position.y * 0.6)) * size;
    vAlpha = 0.1 * amount;
  }
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FOUNTAIN_FRAGMENT = /* glsl */`
uniform float uNight;
uniform float uClock;
varying vec2 vUv;
varying float vAlpha;
varying float vMist;
varying float vSeed;
varying float vTail;
#include <fog_pars_fragment>

void main() {
  float a;
  vec3 col;
  if (vMist > 0.5) {
    a = vAlpha * (1.0 - smoothstep(0.15, 1.0, length(vUv)));
    col = mix(vec3(0.9, 0.93, 0.96), vec3(1.0, 0.96, 0.9) * 1.3, uNight);
  } else {
    float across = 1.0 - vUv.x * vUv.x;
    float streak = 0.75 + 0.25 * sin(vUv.y * 37.0 + vSeed * 40.0 - uClock * 9.0);
    a = vAlpha * across * across * streak * smoothstep(0.0, 0.05, vUv.y) * (1.0 - 0.7 * smoothstep(0.55, 1.0, vUv.y));
    a *= mix(1.0, smoothstep(0.0, 0.4, vUv.y), vTail); // a column off the water trails away as spray
    // lit from the lights at the nozzles: brightest at the foot
    col = mix(vec3(0.93, 0.96, 1.0), vec3(1.0, 0.97, 0.9) * mix(2.6, 1.1, vUv.y), uNight);
  }
  if (a < 0.002) discard;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogAmount = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogAmount = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col = mix(col, fogColor, fogAmount);
  #endif
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // premultiplied: ordinary see-through water by day, mostly added light at night
  gl_FragColor = vec4(gl_FragColor.rgb * a, a * (1.0 - 0.7 * uNight));
}`;


/** The fountain's ShaderMaterial and its per-frame `uPixel` update (fountain.js v6). */
export function fountainMaterial() {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uPixel: { value: 0.001 } }]);
  uniforms.uClock = clock;
  uniforms.uNight = night;
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: FOUNTAIN_VERTEX, fragmentShader: FOUNTAIN_FRAGMENT, fog: true,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const size = new THREE.Vector2();
  const onBeforeRender = (renderer, scene, camera) => {
    // meters per pixel at 1 m from the camera, for the minimum jet width
    uniforms.uPixel.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov || 50) / 2) / Math.max(renderer.getDrawingBufferSize(size).y, 1);
  };
  return { material, onBeforeRender };
}

// ------------------------------------------------------------------ the legacy sky's dome
export function domeMaterial(zenith) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { horizon: haze, zenith },
    vertexShader: 'varying vec3 d; void main(){ d = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 horizon; uniform vec3 zenith; varying vec3 d;
      void main(){ float t = pow(clamp(d.y, 0.0, 1.0), 0.45); gl_FragColor = vec4(mix(horizon, zenith, t), 1.0); }`,
  });
}

// ------------------------------------------------------------------ the Sun and Moon discs (discs.js)
const DISC_VERTEX = 'varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const SUN_FRAGMENT = `uniform vec3 color; uniform float strength; varying vec2 vUv;
void main(){
  float r = length(vUv) * ${HALO.toFixed(1)};
  float disc = 1.0 - smoothstep(0.92, 1.04, r);
  float limb = 1.0 - 0.35 * (1.0 - sqrt(max(0.0, 1.0 - min(r, 1.0) * min(r, 1.0))));
  float glow = 0.22 * exp(-2.2 * max(r - 1.0, 0.0)) * (1.0 - disc) * step(r, ${HALO.toFixed(1)});
  gl_FragColor = vec4(color * strength * (disc * limb + glow), 1.0);
}`;
const MOON_FRAGMENT = `uniform vec3 color; uniform float strength; uniform vec3 lightDir; uniform vec3 axisX; uniform vec3 axisY; uniform vec3 axisZ;
varying vec2 vUv;
void main(){
  float r2 = dot(vUv, vUv);
  if (r2 > 1.0) discard;
  vec3 n = axisX * vUv.x + axisY * vUv.y + axisZ * sqrt(1.0 - r2);
  float lit = smoothstep(-0.015, 0.015, dot(n, lightDir));
  float edge = 1.0 - smoothstep(0.94, 1.0, sqrt(r2));
  gl_FragColor = vec4(color * strength * lit * edge * (0.86 + 0.14 * sqrt(1.0 - r2)), 1.0);
}`;


/** A disc's ShaderMaterial; `kind` 'sun' or 'moon', `uniforms` as discs.js keeps them ({ value } objects). */
export function discMaterial(kind, uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: DISC_VERTEX, fragmentShader: kind === 'sun' ? SUN_FRAGMENT : MOON_FRAGMENT, uniforms,
    transparent: true, depthWrite: false, depthTest: true, fog: false, blending: THREE.AdditiveBlending,
  });
}
