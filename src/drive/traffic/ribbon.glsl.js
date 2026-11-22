// The light-ribbon shader (plan 02, D6.4): each lane of each carriageway beyond the lamp sprites drawn as one
// emissive strip whose light is density x per-vehicle intensity. WebGL2 / GLSL ES 3.0 through three's
// ShaderMaterial. CUSTOM SHADER: listed in the plan's port table, to be ported with the renderer (plan 01, phase 2).
// Mirror: lamps.js vehicleIntensity, ribbonIlluminance and spriteWeight hold the same arithmetic in JavaScript
// (tests/unit/traffic/lamps.test.js checks the handover with it). Change both together.
//
// Flux. A stretch ds of a lane holding lambda ds vehicles, each of intensity I toward the eye, gives the eye
// E = lambda ds I T / d^2 (T the haze's transmittance), exactly what as many sprites would (lamps.js
// ribbonIlluminance; the handover test holds the two within 10%).
// Display. Each lamp sprite is tone-mapped on its own (lights/sprites.glsl.js): far away a vehicle's lamp pair is
// one sprite of uMinPx pixels whose light, concentrated there, shows as a vivid dot; the same light spread thin
// along a strip would fall into the tone curve's toe and vanish (the red river would end where the sprites do).
// So the strip shows what the vehicles' sprites would: per vehicle, for each of its lights (the head pair, the tail
// pair with a truck's red markers, a truck's amber markers), the tone-mapped sprite integrated over its profile
// (a Gaussian of the sprite rule's core at uMinPx: S = pi a^2 sum_i w_i tone(colour P e^{-u_i})), and the strip
// spreads lambda x that over its pixels: W pixels across (a Gaussian whose integral is W) and pxPerM per metre
// along, however foreshortened. The colour it writes is already toned.
//
// Attributes: position (the lane's centre line at lamp height, scene metres), aTangent (unit, the direction of
// travel), aInfo = (route chainage s, density row, side -1/+1, lane weight), aTruck (truck share).
// The density table tDensity (R32F, nearest): x = bin along the route (uBinM metres, from uS0), y = row; three
// sets of 16 rows (direction x 8 + lane - 1) for three quantised times, uRows = (row of set A, row of set B, mix).

export const ribbonVertex = /* glsl */ `
precision highp sampler2D;
uniform sampler2D tDensity;
uniform float uS0;
uniform float uBinM;
uniform int uBins;
uniform vec3 uRows;
uniform float uCarS;
uniform float uAhead;
uniform float uBehind;
uniform float uBand;
uniform vec2 uViewport;
uniform float uPixelAngle;
uniform float uWidthPx;
uniform float uVisibility;
uniform float uGain;
uniform float uLit;
uniform vec3 uCw;
uniform vec3 uCr;
uniform vec3 uCa;
uniform vec4 uCd;      // head, tail, amber marker, red marker (cd per lamp)
uniform vec4 uLobe;    // head, tail, marker exponents, markers per truck
uniform float uMinPx;  // the lamp sprites' smallest diameter, pixels
uniform float uWhiten; // the lamp sprites' whitening (sprites.js whiten)

in vec3 aTangent;
in vec4 aInfo;
in float aTruck;

out vec3 vRad;
out float vAcross;

// the lamp sprites' tone (lights/sprites.glsl.js toneSprite, with the vehicle layer's whitening)
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
  if (m > 1.0) o = mix(o / m, vec3(1.0), uWhiten * (m - 1.0) / m);
  return o;
}
// the toned light of one far sprite of colour x illuminance E (lux), integrated over its pixels (px^2): the sprite
// rule at uMinPx (n = 2, no halo: a Gaussian core e^{-r^2 / a^2}, a = 0.5 minPx / sqrt(ln 2), peak L x coreNorm)
vec3 spriteDisplay(vec3 colour, float E) {
  if (E <= 0.0) return vec3(0.0);
  float px = uMinPx * uPixelAngle;
  float solid = 0.7853981633974483 * px * px;
  float a = 0.5 * uMinPx / 0.8325546111576977;
  float coreNorm = 0.7853981633974483 * uMinPx * uMinPx / (3.141592653589793 * a * a);
  float P = E / solid * uGain * coreNorm;
  // integral over u = r^2 / a^2 in [0, 8] (the Gaussian is under 1/3000 beyond), trapezoids on a stretched grid
  vec3 acc = vec3(0.0);
  float uPrev = 0.0;
  vec3 fPrev = toneSprite(colour * P);
  for (int i = 1; i <= 12; i++) {
    float t = float(i) / 12.0;
    float u = 8.0 * t * t;
    vec3 f = toneSprite(colour * (P * exp(-u)));
    acc += 0.5 * (f + fPrev) * (u - uPrev);
    uPrev = u; fPrev = f;
  }
  return 3.141592653589793 * a * a * acc;
}

float rowAt(float s, int row) {
  float f = clamp((s - uS0) / uBinM, 0.0, float(uBins - 1));
  int i = int(floor(f));
  int i1 = min(i + 1, uBins - 1);
  float u = f - float(i);
  return mix(texelFetch(tDensity, ivec2(i, row), 0).r, texelFetch(tDensity, ivec2(i1, row), 0).r, u);
}

void main() {
  vRad = vec3(0.0);
  vAcross = 0.0;
  float s = aInfo.x;
  int row = int(aInfo.y + 0.5);
  float ds = s - uCarS;
  float R = ds >= 0.0 ? uAhead : uBehind;
  float B = uBand * R;
  float x = clamp((abs(ds) - (R - B)) / B, 0.0, 1.0);
  float wr = x * x * (3.0 - 2.0 * x);       // 1 - the sprites' weight (lamps.js spriteWeight)

  vec3 rel = position - cameraPosition;      // relative to the eye: no large numbers on the GPU
  float d = max(length(rel), 1.0);
  vec3 toEye = -rel / d;
  vec4 c0 = projectionMatrix * vec4(mat3(viewMatrix) * rel, 1.0);
  vec4 c1 = projectionMatrix * vec4(mat3(viewMatrix) * (rel + aTangent), 1.0);
  gl_Position = c0;
  if (wr <= 0.0 || c0.w < 0.05 || c1.w < 0.05) return;   // zero width: the quad degenerates in place

  float lam = mix(rowAt(s, int(uRows.x) + row), rowAt(s, int(uRows.y) + row), uRows.z) * aInfo.w;
  float c = dot(aTangent, toEye);
  float f = max(c, 0.0), b = max(-c, 0.0);
  float T = exp(-d / uVisibility) / (d * d);
  // a vehicle's lights toward the eye (lamps.js vehicleIntensity), each shown as its far sprite would be
  vec3 S = spriteDisplay(uCw, 2.0 * uCd.x * pow(f, uLobe.x) * T)
         + spriteDisplay(uCr, (2.0 * uCd.y * pow(b, uLobe.y) + aTruck * uLobe.w * uCd.w * pow(b, uLobe.z)) * T)
         + aTruck * spriteDisplay(uCa, uLobe.w * uCd.z * pow(f, uLobe.z) * T);

  vec2 p0 = c0.xy / c0.w * 0.5 * uViewport;
  vec2 p1 = c1.xy / c1.w * 0.5 * uViewport;
  vec2 dp = p1 - p0;
  float pxPerM = max(length(dp), 1e-4);
  vec2 dir = dp / pxPerM;
  vec2 perp = vec2(-dir.y, dir.x);
  vRad = lam * uLit * wr * S / (pxPerM * uWidthPx);
  float halfW = 1.5 * uWidthPx;
  vAcross = aInfo.z * halfW;
  gl_Position.xy += perp * (aInfo.z * halfW) * 2.0 / uViewport * c0.w;
}
`;

export const ribbonFragment = /* glsl */ `
uniform float uWidthPx;
in vec3 vRad;
in float vAcross;

void main() {
  // a Gaussian across whose integral is uWidthPx: sigma = W / sqrt(pi), peak 1; the colour is already toned
  float sigma = uWidthPx * 0.5641895835;
  float g = exp(-(vAcross / sigma) * (vAcross / sigma));
  gl_FragColor = vec4(vRad * g, 1.0);
  #include <colorspace_fragment>
}
`;
