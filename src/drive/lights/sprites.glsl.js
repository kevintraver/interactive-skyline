// The light-sprite shader (plan 02, D5.4; section 7.8). WebGL2 / GLSL ES 3.0 through three's ShaderMaterial
// (three adds its WebGL2 prefix: #version 300 es: the camera uniforms, precision, gl_FragColor and the output colour space). To be ported with the renderer (port table in plan 02, "Decisions for the second stretch").
//
// Mirror: spriteMirror.js holds the same arithmetic in JavaScript, function for function (patternShape,
// spriteRule, coreNorm and gammaTerm, warm-up, tone) and tests/unit/lights/sprites.test.js holds the two to
// lamps.js and switching.js. Change both together.
//
// Instances are texels: four RGBA32F textures, one texel per instance (row-major, SPRITE_TEX_WIDTH wide):
//   T0 position.xyz (scene metres), intensity (cd multiplier: candela for pattern kinds 0 and 4, lumens for 1-3)
//   T1 colour.rgb (linear sRGB, luminance 1), pattern id (0..15)
//   T2 axis.xyz (unit: theta is measured from it; the nadir (0,-1,0) for a street lamp), aim (radians counter-
//      clockwise from map +x, the way the arm points; < -9 when unknown: the phi-averaged pattern)
//   T3 switch threshold (lux; lit while the ambient illuminance is below it; 1e30 always on), warm-up kind
//      (0 none, 1 sodium), luminous diameter (m), mount height (m, > 0 adds the light of the lamp's own pool
//      seen from afar, faded in beyond uGlowNear)
// The per-instance attribute `spriteIndex` = (texel, weight) names the texel, so a cull is a new list of indices,
// not new data; the weight multiplies the intensity (a thinned far cell's lamp carries the light of k lamps).

export const SPRITE_TEX_WIDTH = 1024;
export const MAX_PATTERNS = 16;
export const ON_TABLE_N = 37;

export const spriteVertex = /* glsl */ `
// three's ShaderMaterial prefix declares projectionMatrix, viewMatrix and cameraPosition
precision highp sampler2D;

uniform sampler2D tPos;
uniform sampler2D tColor;
uniform sampler2D tAxis;
uniform sampler2D tSwitch;

uniform vec2 uViewport;        // drawing buffer, pixels
uniform float uPixelAngle;     // radians per pixel at the centre: 2 tan(fov / 2) / height
uniform float uMinPx;          // smallest sprite diameter, pixels
uniform float uVisibility;     // metres: transmittance exp(-d / visibility)
uniform float uGain;           // scene units per cd/m^2 (lighting.units.nit) x the dusk fade
uniform float uHalo;           // share of a near sprite's light in its halo
uniform float uAmbient;        // ambient horizontal illuminance, lux
uniform float uOnTable[${ON_TABLE_N}]; // seconds since switch-on by log10 threshold (switching.js createOnTable)
uniform vec3 uOnSpec;          // log0, step, n
uniform vec4 uSodium;          // start u'v', steady u'v'
uniform vec2 uGlowRange;       // near, far: the pool-glow term fades in between (metres)
uniform float uGroundAlbedo;
uniform float uPatKind[${MAX_PATTERNS}];
uniform vec3 uPatK[${MAX_PATTERNS}];   // kDown, kUp, and the lobe exponent (kind 4) or the downward share (kinds 1-3)

in vec2 corner;                // -1..1
in vec2 spriteIndex;           // instance (texel) index, weight

out vec2 vPx;                  // pixels from the sprite's centre
out vec3 vAmp;                 // linear colour x scene radiance at the profile's normalised peak
out vec4 vShape;               // a (px), n, halo a (px), core normalisation
out float vHaloNorm;           // halo normalisation

const float RAD = 0.017453292519943295;

float smoothstep01(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float wing(float t, float peak, float width) { float u = (t - peak) / width; return exp(-u * u); }

// lamps.js OPTICS, theta and phi in degrees; phi < -900 asks for the phi-average
float patternShape(float kind, vec3 k, float t, float p, bool avg) {
  if (kind < 0.5) return 1.0;
  if (kind > 3.5) return pow(max(cos(t * RAD), 0.0), k.z);
  float cp = cos(p * RAD), sp = sin(p * RAD);
  if (kind < 1.5) {          // cutoff
    if (t > 90.0) return 0.0;
    float lat = avg ? 0.65 : (0.3 + 0.7 * cp * cp) * (1.0 + 0.35 * sp);
    float axial = avg ? 1.0 : (1.0 + 0.35 * sp);
    return k.x * (0.35 * cos(t * RAD) * axial + wing(t, 65.0, 14.0) * lat) * (1.0 - smoothstep01(78.0, 90.0, t));
  }
  if (kind < 2.5) {          // droplens
    if (t > 90.0) return k.y * wing(t, 98.0, 10.0);
    float lat = avg ? 0.675 : (0.35 + 0.65 * cp * cp) * (1.0 + 0.3 * sp);
    float axial = avg ? 1.0 : (1.0 + 0.3 * sp);
    return k.x * (0.3 * cos(t * RAD) * axial + wing(t, 70.0, 16.0) * lat) * (1.0 - smoothstep01(84.0, 90.0, t));
  }
  if (t > 90.0) return 0.0;  // highmast
  return k.x * (0.3 * cos(t * RAD) + wing(t, 60.0, 18.0)) * (1.0 - smoothstep01(80.0, 90.0, t));
}

// Gamma(1 + 2 / n) for n in [2, 6], by table (n = 2, 3, 4, 5, 6)
float gammaTerm(float n) {
  float f = clamp(n - 2.0, 0.0, 3.999);
  int i = int(floor(f));
  float t = f - float(i);
  float g0 = i == 0 ? 1.0 : i == 1 ? 0.902745 : i == 2 ? 0.886227 : 0.887264;
  float g1 = i == 0 ? 0.902745 : i == 1 ? 0.886227 : i == 2 ? 0.887264 : 0.892980;
  return mix(g0, g1, t);
}

float onSeconds(float threshold) {
  float f = clamp((log(threshold) / log(10.0) - uOnSpec.x) / uOnSpec.y, 0.0, uOnSpec.z - 1.0);
  int i = min(int(floor(f)), int(uOnSpec.z) - 2);
  float t = f - float(i);
  return mix(uOnTable[i], uOnTable[i + 1], t);
}

vec3 xyzFromUv(vec2 uv) {
  float d = 6.0 * uv.x - 16.0 * uv.y + 12.0;
  float x = 9.0 * uv.x / d, y = 4.0 * uv.y / d;
  return vec3(x / y, 1.0, (1.0 - x - y) / y);
}
vec3 linearSrgbFromXyz(vec3 c) {
  return vec3(
    3.2404542 * c.x - 1.5371385 * c.y - 0.4985314 * c.z,
    -0.9692660 * c.x + 1.8760108 * c.y + 0.0415560 * c.z,
    0.0556434 * c.x - 0.2040259 * c.y + 1.0572252 * c.z);
}

void main() {
  int idx = int(spriteIndex.x + 0.5);
  ivec2 st = ivec2(idx % ${SPRITE_TEX_WIDTH}, idx / ${SPRITE_TEX_WIDTH});
  vec4 p0 = texelFetch(tPos, st, 0);
  vec4 p1 = texelFetch(tColor, st, 0);
  vec4 p2 = texelFetch(tAxis, st, 0);
  vec4 p3 = texelFetch(tSwitch, st, 0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off screen unless drawn below
  vPx = vec2(0.0); vAmp = vec3(0.0); vShape = vec4(1.0, 2.0, 1.0, 0.0);

  if (!(uAmbient < p3.x)) return;              // switched off
  vec3 rel = p0.xyz - cameraPosition;           // relative to the eye: no large numbers on the GPU
  float d = length(rel);
  if (d < 0.5) return;
  vec3 toEye = -rel / d;

  // warm-up (lamps.js warmup): sodium from a dim pink-white to amber
  vec3 color = p1.rgb;
  float flux = 1.0;
  if (p3.y > 0.5) {
    float s = onSeconds(p3.x);
    if (!(s >= 0.0)) s = 0.0;
    float pc = 1.0 - exp(-(s / 140.0) * (s / 140.0));
    float pf = 1.0 - exp(-(s / 100.0) * (s / 100.0));
    flux = 0.05 + 0.95 * pf;
    color = linearSrgbFromXyz(xyzFromUv(mix(uSodium.xy, uSodium.zw, pc)));
  }

  // intensity toward the eye: theta from the axis, phi around it from the aim (map azimuth)
  int pid = int(p1.a + 0.5);
  float kind = uPatKind[pid];
  vec3 k = uPatK[pid];
  float theta = acos(clamp(dot(p2.xyz, toEye), -1.0, 1.0)) / RAD;
  bool avg = p2.w < -9.0;
  float phi = 0.0;
  if (!avg) {
    float az = atan(-toEye.z, toEye.x) / RAD;   // map azimuth of the eye from the lamp
    phi = mod(az - p2.w / RAD + 90.0 + 540.0, 360.0) - 180.0;
  }
  float I = p0.w * patternShape(kind, k, theta, phi, avg);
  // the lamp's own pool seen from afar: albedo x downward flux / pi x the cosine at the ground (pools.js draws it near)
  if (p3.w > 0.0 && kind > 0.5 && kind < 3.5) {
    float cz = clamp((cameraPosition.y - (p0.y - p3.w)) / d, 0.0, 1.0);
    I += uGroundAlbedo * p0.w * k.z / 3.141592653589793 * cz * smoothstep01(uGlowRange.x, uGlowRange.y, d);
  }
  I *= flux * spriteIndex.y;

  // the sprite rule (lamps.js spriteFlux): E = T I / d^2 at the eye, spread over a disc of at least uMinPx
  float T = exp(-d / uVisibility);
  float E = T * I / (d * d);
  float dPx = max(p3.z / d / uPixelAngle, uMinPx);
  float solid = 0.7853981633974483 * dPx * dPx * uPixelAngle * uPixelAngle;
  float L = E / solid;                          // cd/m^2 averaged over the disc
  // profile: a super-Gaussian core exp(-(r / a)^n) at half height at the disc's edge, plus a Gaussian halo
  float n = mix(2.0, 6.0, smoothstep01(2.0, 8.0, dPx));
  float a = 0.5 * dPx / pow(0.6931471805599453, 1.0 / n);
  float h = uHalo * smoothstep01(2.0, 6.0, dPx);
  float ha = max(2.0 * dPx, 4.0);
  // normalised so that the profile's integral over the plane is the disc's area: summed light is E either way
  float area = 0.7853981633974483 * dPx * dPx;
  float coreNorm = (1.0 - h) * area / (3.141592653589793 * a * a * gammaTerm(n));
  float haloNorm = h * area / (3.141592653589793 * ha * ha);
  float peak = L * uGain * (coreNorm + haloNorm);
  if (peak * max(color.r, max(color.g, color.b)) < 2e-4) return;
  vAmp = color * L * uGain;
  vShape = vec4(a, n, ha, coreNorm);
  vHaloNorm = haloNorm;
  // the quad reaches only as far as the profile is visible (above 1/1024 after the tone), so near bright lamps do
  // not cover hundreds of pixels with nothing: fill is what this layer costs
  float cmax = L * uGain * max(color.r, max(color.g, color.b));
  float rCore = a * pow(max(log(cmax * coreNorm * 1024.0), 0.0), 1.0 / n);
  float rHalo = h > 0.0 ? ha * sqrt(max(log(cmax * haloNorm * 1024.0), 0.0)) : 0.0;
  float extent = min(max(rCore, rHalo), max(2.6 * a, h > 0.0 ? 2.6 * ha : 0.0));
  if (extent < 0.5) return;
  vPx = corner * (extent + 0.5);

  // pull the sprite a little toward the eye so its own lamp head does not hide it
  vec3 pr = rel + toEye * min(1.0, 0.02 * d);
  vec4 clip = projectionMatrix * vec4(mat3(viewMatrix) * pr, 1.0);
  clip.xy += vPx * 2.0 / uViewport * clip.w;
  gl_Position = clip;
}
`;

export const spriteFragment = /* glsl */ `
in vec2 vPx;
in vec3 vAmp;
in vec4 vShape;
in float vHaloNorm;

// the tone of a sprite: three's ACES filmic fit applied to luminance, keeping the hue, and whitening only what
// would clip, so a far lamp keeps its colour and a near one burns to a white core with a coloured rim
float acesFit(float x) {
  x = x / 0.6;
  float a = x * (x + 0.0245786) - 0.000090537;
  float b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return clamp(a / b, 0.0, 1.0);
}
vec3 toneSprite(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (y <= 0.0) return vec3(0.0);
  vec3 o = c * (acesFit(y) / y);
  float m = max(o.r, max(o.g, o.b));
  if (m > 1.0) o = mix(o / m, vec3(1.0), (m - 1.0) / m);
  return o;
}

void main() {
  float r = length(vPx);
  float core = exp(-pow(r / vShape.x, vShape.y));
  float halo = vHaloNorm > 0.0 ? exp(-(r / vShape.z) * (r / vShape.z)) : 0.0;
  vec3 c = vAmp * (vShape.w * core + vHaloNorm * halo);
  vec3 o = toneSprite(c); // no discard: it would turn off the early depth test
  gl_FragColor = vec4(o, 1.0);
  #include <colorspace_fragment>
}
`;
