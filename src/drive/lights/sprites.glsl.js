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
uniform float uWhiten;         // share of the clipping excess turned to white (1: street lamps; vehicle lamps less, so a
                               // red lamp stays red)

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
  if (m > 1.0) o = mix(o / m, vec3(1.0), uWhiten * (m - 1.0) / m);
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

// ---------------------------------------------------------------- reflected twins (plan 02, D8.1)
// Added for the weather (src/drive/weather/): each sprite of a layer made with `reflect` gains a twin on wet pavement,
// drawn by a second mesh over the same instance textures with its own short list of instances near the car
// (sprites.js). Nothing above changes. Mirror: spriteMirror.js twinRule, twinFresnel; tests/unit/weather/twins.test.js.
//
// Geometry. The road near the car is taken as a plane through the car's road point with the car's grade (uTwinPlane);
// a light h_l above it, seen from an eye h_e above it, has its mirror image h_l below the plane, and the image's ray
// meets the pavement at the reflection point R (a share h_e / (h_e + h_l) of the way). The twin is drawn at R (pulled
// a little toward the eye, so the pavement does not hide it), only where R lies on the carriageways around the car
// (|across| under the half width, |along| under the range, both with soft edges) and from 5-15 m out (nearer, at
// steep incidence, a lamp's reflection spreads into a broad sheen over its pool, which the pool already shows).
// Light. The summed light of the twin is the mirror's: E = cover x F(i) x T x I(toward R) / d_m^2, where d_m is the
// distance to the mirror image (the reflected path), F the Fresnel reflectance of water (n 1.333, unpolarised) at the
// angle of incidence, I the lamp's intensity toward R by its pattern, and cover the water's share of the pavement.
// Shape. A rough water surface (rms facet slope s) reflects the light from a band of pavement around R: a facet tilted
// by tau sends it to the eye from an elevation shifted by tau x 2 h_l / (h_e + h_l), and sideways by that times the
// sine of the grazing angle (sigma 2 s h_l / (h_e + h_l) along the screen's vertical, that times sin(grazing) across,
// never narrower than the lamp's own disc). Facets tilted toward the lamp carry the light up the screen as far as the
// road under the lamp (B, where a wet road's reflections of it begin) and no farther; tilted away, down toward the
// viewer. So the twin is a thin streak that starts at B: from B down to R it brightens linearly from TWIN_FOOT of its
// peak to the peak at R (fading in over its first pixels under the lamp), and below R it falls as a Gaussian of 2.2
// sigma (perspective stretches the near side), with a Gaussian across. It is normalised so its summed light is E
// exactly, over the quad it is drawn on (its Gaussians lowered by their value at the quad's edge, so a bright twin
// never shows the quad's border).

/** Share of a twin's peak left at the lamp's foot (the streak brightens from there to the mirror point). Mirrored in spriteMirror.js. */
export const TWIN_FOOT = 0.5;

/** Vertex shader of the twins: the sprite shader's declarations and functions, then its own main. */
export const spriteTwinVertex = /* glsl */ `${spriteVertex.slice(0, spriteVertex.indexOf('void main()'))}
uniform float uTwinWet;     // water's share of the pavement, 0..1: 0 draws nothing
uniform float uTwinSlope;   // rms facet slope of the wet surface, radians
uniform vec4 uTwinRoad;     // the car's road point x, z (scene) and the road's forward x, z (unit)
uniform vec4 uTwinPlane;    // the road's height at the car (scene y), grade (dy per metre forward), half width (m), range (m)

out vec2 vTw;               // pixels from R: across, along the screen's up there
out vec3 vTwAmp;            // linear colour x scene radiance at R
out vec3 vTwSig;            // sigma across, pixels up from R to B (the road under the lamp), sigma down
out float vTwEdge;          // the Gaussians' value at the quad's edge (subtracted, so they end without a seam)

// erf by Abramowitz and Stegun 7.1.26 (error under 1.5e-7), for the share of a Gaussian inside the quad
float twinErf(float x) {
  float t = 1.0 / (1.0 + 0.3275911 * abs(x));
  float y = 1.0 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return x < 0.0 ? -y : y;
}

// Fresnel reflectance of water (n = 1.333) for unpolarised light, by the cosine of the angle of incidence
float twinFresnel(float c) {
  c = clamp(c, 0.0, 1.0);
  float n = 1.333;
  float st = sqrt(max(0.0, 1.0 - c * c)) / n;
  float ct = sqrt(max(0.0, 1.0 - st * st));
  float rs = (c - n * ct) / (c + n * ct);
  float rp = (ct - n * c) / (ct + n * c);
  return 0.5 * (rs * rs + rp * rp);
}

void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vTw = vec2(0.0); vTwAmp = vec3(0.0); vTwSig = vec3(1.0); vTwEdge = 0.0;
  vPx = vec2(0.0); vAmp = vec3(0.0); vShape = vec4(1.0, 2.0, 1.0, 0.0); vHaloNorm = 0.0;
  if (!(uTwinWet > 0.0)) return;
  int idx = int(spriteIndex.x + 0.5);
  ivec2 st = ivec2(idx % ${SPRITE_TEX_WIDTH}, idx / ${SPRITE_TEX_WIDTH});
  vec4 p0 = texelFetch(tPos, st, 0);
  vec4 p1 = texelFetch(tColor, st, 0);
  vec4 p2 = texelFetch(tAxis, st, 0);
  vec4 p3 = texelFetch(tSwitch, st, 0);
  if (!(uAmbient < p3.x)) return;

  // the plane, relative to the eye: y = -he + grade * (forward . xz)
  vec2 fwd = uTwinRoad.zw;
  vec2 eyeQ = cameraPosition.xz - uTwinRoad.xy;
  float he = cameraPosition.y - (uTwinPlane.x + uTwinPlane.y * dot(eyeQ, fwd));
  vec3 rel = p0.xyz - cameraPosition;
  float hl = rel.y - (-he + uTwinPlane.y * dot(rel.xz, fwd));
  if (he < 0.1 || hl < 0.1) return;
  vec3 m = vec3(rel.x, rel.y - 2.0 * hl, rel.z);  // the mirror image
  float dm = length(m);
  if (dm < 1.0) return;
  vec3 r = m * (he / (he + hl));                  // the reflection point
  vec2 rq = eyeQ + r.xz;
  float along = dot(rq, fwd), across = dot(rq, vec2(-fwd.y, fwd.x));
  float mask = (1.0 - smoothstep(uTwinPlane.z - 4.0, uTwinPlane.z, abs(across))) * (1.0 - smoothstep(0.75 * uTwinPlane.w, uTwinPlane.w, abs(along)))
    * smoothstep(5.0, 15.0, length(r.xz));   // nearer, a lamp's reflection is a broad sheen the pools already show
  if (!(mask > 0.0)) return;

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
  // the lamp's intensity toward R (the pattern's "toward the eye" is toward R here)
  vec3 dirL = normalize(r - rel);
  int pid = int(p1.a + 0.5);
  float kind = uPatKind[pid];
  float theta = acos(clamp(dot(p2.xyz, dirL), -1.0, 1.0)) / RAD;
  bool avg = p2.w < -9.0;
  float phi = 0.0;
  if (!avg) {
    float az = atan(-dirL.z, dirL.x) / RAD;
    phi = mod(az - p2.w / RAD + 90.0 + 540.0, 360.0) - 180.0;
  }
  float I = p0.w * patternShape(kind, uPatK[pid], theta, phi, avg) * flux * spriteIndex.y;

  float cosi = (he + hl) / dm;
  float E = uTwinWet * mask * twinFresnel(cosi) * exp(-dm / uVisibility) * I / (dm * dm);
  float k = hl / (he + hl);
  float sigU = 2.0 * uTwinSlope * cosi * k / uPixelAngle;
  float sigA = 2.0 * uTwinSlope * k / uPixelAngle;
  float disc = 0.4247 * p3.z / dm / uPixelAngle;   // the lamp's own disc, FWHM to sigma
  sigU = max(max(sigU, disc), 0.6);
  sigA = max(sigA, sigU);
  // the streak: from B, the road under the lamp as seen from the eye, down through R and on toward the viewer
  float dUp = max((atan(he / max(length(r.xz), 1e-3)) - atan(he / max(length(rel.xz), 1e-3))) / uPixelAngle, 0.5);
  float sDn = 2.2 * sigA;
  float a = clamp(0.2 * dUp, 0.5, dUp), Q = ${TWIN_FOOT.toFixed(3)};
  float runUp = dUp * (1.0 + Q) * 0.5 - a * (Q * 0.5 + 0.15 * (1.0 - Q) * a / dUp);   // B to R, integrated
  float k0 = E * uGain / (uPixelAngle * uPixelAngle * 2.5066282746 * sigU * (runUp + 1.2533141373 * sDn));
  float cmax0 = k0 * max(color.r, max(color.g, color.b));
  if (cmax0 < 2e-4) return;
  float reach = min(sqrt(2.0 * max(log(cmax0 * 1024.0), 0.0)), 4.5);   // sigmas to where it falls under 1/1024
  if (reach * sigU < 0.25) return;
  float edge = exp(-0.5 * reach * reach), ef = twinErf(reach * 0.7071067812);
  float acrossInt = sigU * (2.5066282746 * ef - 2.0 * reach * edge) / (1.0 - edge);
  float downInt = sDn * (1.2533141373 * ef - reach * edge) / (1.0 - edge);
  vec3 c = color * (E * uGain / (uPixelAngle * uPixelAngle * acrossInt * (runUp + downInt)));

  // the screen's up at R, and R itself pulled toward the eye
  mat3 vr = mat3(viewMatrix);
  vec3 pr = r * (1.0 - min(0.03, 1.5 / max(length(r), 1.0)));
  vec4 c0 = projectionMatrix * vec4(vr * pr, 1.0);
  vec4 c1 = projectionMatrix * vec4(vr * (pr + vec3(0.0, 0.02 * length(r) + 0.05, 0.0)), 1.0);
  if (c0.w <= 0.0 || c1.w <= 0.0) return;
  vec2 up = c1.xy / c1.w - c0.xy / c0.w;
  up = normalize(up * uViewport + vec2(0.0, 1e-6));
  vec2 side = vec2(up.y, -up.x);
  vec2 px = vec2(corner.x * reach * sigU, corner.y > 0.0 ? dUp : -reach * sDn);
  vTwEdge = edge;
  vTw = px; vTwAmp = c; vTwSig = vec3(sigU, dUp, sDn);
  c0.xy += (side * px.x + up * px.y) * 2.0 / uViewport * c0.w;
  gl_Position = c0;
}
`;

/** Fragment shader of the twins: the anisotropic Gaussian, toned like the sprites. */
export const spriteTwinFragment = /* glsl */ `
in vec2 vTw;
in vec3 vTwAmp;
in vec3 vTwSig;
in float vTwEdge;
uniform float uWhiten;
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
void main() {
  // separable: across a Gaussian, along from B (up) to R a linear rise from the foot's share to 1, fading in over the
  // first pixels under the lamp, and below R a Gaussian; the Gaussians less their value at the edge (no seam)
  float u = vTw.x / vTwSig.x;
  float gu = max(exp(-0.5 * u * u) - vTwEdge, 0.0) / (1.0 - vTwEdge);
  float gv;
  if (vTw.y > 0.0) {
    float dUp = vTwSig.y, a = clamp(0.2 * dUp, 0.5, dUp);
    gv = (1.0 - (1.0 - ${TWIN_FOOT.toFixed(3)}) * vTw.y / dUp) * (1.0 - smoothstep(dUp - a, dUp, vTw.y));
  } else {
    float v = vTw.y / vTwSig.z;
    gv = max(exp(-0.5 * v * v) - vTwEdge, 0.0) / (1.0 - vTwEdge);
  }
  gl_FragColor = vec4(toneSprite(vTwAmp * (gu * gv)), 1.0);
  #include <colorspace_fragment>
}
`;
