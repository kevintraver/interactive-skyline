// skyline-integration: v6 (blender-landmark-model skill)
import * as THREE from 'three';
import * as nightModule from './night.js'; // (a namespace import: an older night.js has no clock)

const night = nightModule.night || { value: 0 };
const clock = nightModule.clock || { value: 0 };

// A fountain show on a lake, from a data file the skill writes (public/models/<city>/attractions/*.json): the lake
// outline and every nozzle in meters east and north of the city origin, each as
//   [east, north, type, figure, u, tangent_e, tangent_n, normal_e, normal_n, seed]
// type 0 oarsman, 1 mini-shooter, 2 super-shooter, 3 extreme-shooter; figure 0 is the front line, 1.. rings;
// u is the place along that figure (0..1). All jets are one InstancedMesh (one draw call): each is a soft
// camera-facing ribbon plus a mist puff at its foot, animated in the vertex shader from the shared clock
// through a looping choreography. White and translucent by day, brightly lit from below at night.

const SEGMENTS = 14; // rows along a jet, so a leaning jet can arc
const MAX_JETS = 5000;

const VERTEX = /* glsl */`
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

const FRAGMENT = /* glsl */`
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

/** One ribbon (side -1|1, v 0..1, part 0) and one mist quad (corners -1|1, part 1), shared by every jet. */
function jetGeometry(jets, waterY) {
  const geo = new THREE.BufferGeometry();
  const pos = [], index = [];
  for (let i = 0; i <= SEGMENTS; i++) pos.push(-1, i / SEGMENTS, 0, 1, i / SEGMENTS, 0);
  for (let i = 0; i < SEGMENTS; i++) { const a = 2 * i; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const m = pos.length / 3;
  pos.push(-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1);
  index.push(m, m + 1, m + 2, m, m + 2, m + 3);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  const at = new Float32Array(jets.length * 3), kind = new Float32Array(jets.length * 4), axis = new Float32Array(jets.length * 4);
  const counts = new Map(); // alternate jets of a type along a figure lean and fire in turn
  jets.forEach(([east, north, type, figure, u, te, tn, ne, nn, seed], i) => {
    const key = `${figure}:${type}`, k = counts.get(key) || 0;
    counts.set(key, k + 1);
    at.set([east, waterY, -north], i * 3);
    kind.set([type, figure, u, (k % 2) + THREE.MathUtils.clamp(seed, 0, 0.99)], i * 4);
    axis.set([te, -tn, ne, -nn], i * 4); // map east/north to world x/z
  });
  geo.setAttribute('jetAt', new THREE.InstancedBufferAttribute(at, 3));
  geo.setAttribute('jetKind', new THREE.InstancedBufferAttribute(kind, 4));
  geo.setAttribute('jetAxis', new THREE.InstancedBufferAttribute(axis, 4));
  return geo;
}

const isJet = (j) => Array.isArray(j) && j.length >= 10 && j.slice(0, 10).every(Number.isFinite)
  && j[2] >= 0 && j[2] <= 3;

/**
 * Build the show from its data file's contents. `groundY(east, north)` is the app's terrain height; the jets
 * start at the median height under the nozzles (the lake is flat).
 * @param {{name?: string, jets: number[][], center?: number[], radius?: number}} data
 * @param {(east: number, north: number) => number} groundY
 * @returns {THREE.InstancedMesh}
 */
export function createFountain(data, groundY) {
  const jets = (Array.isArray(data?.jets) ? data.jets : []).filter(isJet).slice(0, MAX_JETS);
  if (!jets.length) throw new Error('the fountain file lists no valid jets');
  const heights = jets.filter((_, i) => i % 7 === 0).map((j) => groundY(j[0], j[1])).sort((a, b) => a - b);
  const waterY = heights[Math.floor(heights.length / 2)] + 0.2;
  const xs = jets.map((j) => j[0]), ys = jets.map((j) => j[1]);
  const box = new THREE.Box3(
    new THREE.Vector3(Math.min(...xs) - 40, waterY, -Math.max(...ys) - 40),
    new THREE.Vector3(Math.max(...xs) + 40, waterY + 150, -Math.min(...ys) + 40),
  );
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uPixel: { value: 0.001 } }]);
  uniforms.uClock = clock;
  uniforms.uNight = night;
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, fog: true,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.InstancedMesh(jetGeometry(jets, waterY), material, jets.length);
  mesh.name = data.name || 'Fountain';
  mesh.boundingBox = box;
  mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  mesh.raycast = () => {}; // water is not clickable, and its shape lives in the shader
  const size = new THREE.Vector2();
  mesh.onBeforeRender = (renderer, scene, camera) => {
    // meters per pixel at 1 m from the camera, for the minimum jet width
    uniforms.uPixel.value = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov || 50) / 2) / Math.max(renderer.getDrawingBufferSize(size).y, 1);
  };
  mesh.userData.fountain = { name: mesh.name, jets: jets.length, waterY, center: box.getCenter(new THREE.Vector3()) };
  return mesh;
}
