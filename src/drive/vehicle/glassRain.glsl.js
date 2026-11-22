// Rain on the windshield (plan 02, D8.2): the shaders of glassRain.js. Written for three's ShaderMaterial on
// WebGLRenderer (WebGL2: GLSL ES 3.0, unsigned integers, gl_InstanceID); to be ported with the other custom shaders
// (see the plan's port table). All three draw in the cabin pass over the windshield opening, before the veil
// (windshield.glsl.js), and sample uFrame, a copy of the world as drawn this frame (display-referred: tone mapped and
// encoded), so they write display values straight out, with no tone mapping or colour-space step of their own.
//
//   drops  one instance per site and kind (0 the sitting drop, 1 and 2 the latest two runners): the vertex shader is
//          drops.js evalSite line for line (the same hash, bins, epoch, merging, running, wiper passes); each drop is
//          a small lens: the frame behind it flipped and shrunk (MAG times its radius, so the scene around it shows in
//          it upside down and nearby lamps as bright points), a dark rim (light from the dark cabin, refracted at the
//          drop's steep edge), a highlight of the sky on its upper side; runners leave a thin trail.
//   film   a grid over the glass: per fragment the time since a blade last passed (wipers.js passAgoAt); the fine mist
//          of small drops that re-wets the cleared glass first (micro-drops in MIST_CELL cells, each there once its
//          hashed arrival time, exponential at the mist's rate, has passed since the last wipe; everywhere outside the
//          wiped area), a soft haze of the water film over the mist, and the thin smeared film just behind the blade
//          that dries within FILM_S.
//   blades the two wipers: a dark arm and blade along each blade's line, averaged over the exposure (uQ: the sweep
//          fraction at 12 instants over it), so they blur, and at fast clock rates become a steady fan (wipers.js
//          comfortOf).

/**
 * @param {{ bins: number, binS: number, renewS: number, renewFadeS: number, nRunMin: number, nRunSpan: number,
 *   runSpeedK: number, vRun: number, side: number, runLifeS: number, r0: number, jitter: number }} k  drops.js DROP
 *   (r0 already times the size gain)
 */
export function glassRainShaders(k) {
  const f = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));
  const common = /* glsl */ `
#define BINS ${k.bins}
#define BIN_S ${f(k.binS)}
#define RENEW_S ${f(k.renewS)}
#define RENEW_FADE_S ${f(k.renewFadeS)}
#define N_RUN_MIN ${f(k.nRunMin)}
#define N_RUN_SPAN ${f(k.nRunSpan)}
#define RUN_SPEED_K ${f(k.runSpeedK)}
#define V_RUN ${f(k.vRun)}
#define SIDE ${f(k.side)}
#define RUN_LIFE_S ${f(k.runLifeS)}
#define R0 ${f(k.r0)}
#define JITTER ${f(k.jitter)}
#define NONE 1.0e6
uniform vec4 uBins[BINS];   // lambda (arrivals per site), Dy and Da at the bin's start, vy
uniform uint uK0;           // the window's first absolute bin
uniform float uTw;          // now, seconds since bin uK0's start
uniform float uRenewOffset; // the renewal clock at the window's start
uniform vec4 uWipe;         // phase, sweep, period (s), on
uniform vec4 uWiperP[2];    // pivot x, y, rIn, rOut (glass metres)
uniform vec4 uWiperA[2];    // a0, a1 (degrees)
uniform vec4 uLayout;       // glass W, H (m), sites nx, ny
uniform vec3 uBL;
uniform vec3 uBR;
uniform vec3 uTL;
uniform vec3 uTR;
uniform float uComfort;

float hash3(uint a, uint b, uint c) {
  uint h = a * 0x9e3779b1u ^ b * 0x85ebca77u ^ c * 0xc2b2ae3du;
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
  return float(h >> 8u) / 16777216.0;
}

// how long ago the blades passed the sweep fraction q (wipers.js passAgoAtPhase)
float passAgoPhase(float q) {
  if (uWipe.w < 0.5) return NONE;
  q = clamp(q, 0.0, 1.0);
  float up = uWipe.y / 6.283185307 * acos(1.0 - 2.0 * q);
  float dn = uWipe.y - up;
  float a = uWipe.x - up; if (a < 0.0) a += uWipe.z;
  float b = uWipe.x - dn; if (b < 0.0) b += uWipe.z;
  return min(a, b);
}
// ... and the glass point p (wipers.js passAgoAt); NONE outside the swept area
float passAgo(vec2 p) {
  float best = NONE;
  for (int w = 0; w < 2; w++) {
    vec2 d = p - uWiperP[w].xy;
    float r = length(d);
    if (r < uWiperP[w].z || r > uWiperP[w].w) continue;
    float a = degrees(atan(d.y, d.x));
    if (a < uWiperA[w].x || a > uWiperA[w].y) continue;
    best = min(best, passAgoPhase((a - uWiperA[w].x) / (uWiperA[w].y - uWiperA[w].x)));
  }
  return best;
}
vec3 glassPoint(vec2 p) {
  vec2 uv = p / uLayout.xy;
  return mix(mix(uBL, uBR, uv.x), mix(uTL, uTR, uv.x), uv.y);
}
`;

  // ------------------------------------------------------------------ drops
  const dropsVertex = /* glsl */ `
${common}
varying vec2 vLocal;   // in drop radii: x along the drop's motion (up the glass when sitting), y across
varying vec2 vUp;      // up the glass, in the same axes
varying float vTrail;  // trail length, radii
varying float vAlpha;
varying vec2 vCentre;  // the drop's centre on screen, 0..1

vec2 drift(float t) {
  int j = clamp(int(floor(t / BIN_S)), 0, BINS - 1);
  vec4 b = uBins[j];
  float dt = t - float(j) * BIN_S;
  return vec2(b.y + dt * b.w, b.z + dt * abs(b.w));
}

void main() {
  int inst = gl_InstanceID;
  int site = inst / 3;
  int kind = inst - site * 3;
  uint i = uint(site);
  int nx = int(uLayout.z + 0.5);
  int iy = site / nx;
  int ix = site - iy * nx;
  vec2 cell = uLayout.xy / uLayout.zw;
  vec2 c = (vec2(float(ix), float(iy)) + 0.5) * cell;
  float Lc = passAgo(c);
  float since = mod(uRenewOffset + uTw - hash3(i, 81u, 7u) * RENEW_S, RENEW_S);
  float e = max(max(uTw - Lc, uTw - since), 0.0);
  float nRun0 = N_RUN_MIN + floor(hash3(i, 82u, 7u) * N_RUN_SPAN);
  int j0 = max(0, int(floor(e / BIN_S)));
  int j1 = min(BINS - 1, int(floor(uTw / BIN_S)));
  float n = 0.0, born = 0.0;
  uint firstK = 0u;
  float r1t = -1.0, r1n = 0.0, r2t = -1.0, r2n = 0.0;
  uint r1k = 0u, r2k = 0u;
  for (int j = j0; j <= j1; j++) {
    uint k = uK0 + uint(j);
    float p = min(1.0, uBins[j].x * 0.5);
    float a = (hash3(i, k, 1u) < p ? 1.0 : 0.0) + (hash3(i, k, 2u) < p ? 1.0 : 0.0);
    if (a == 0.0) continue;
    float ta = (float(j) + hash3(i, k, 3u)) * BIN_S;
    if (ta <= e || ta > uTw) continue;
    if (n == 0.0) { firstK = k; born = ta; }
    n += a;
    float nRun = max(1.0, floor(nRun0 / (1.0 + RUN_SPEED_K * max(0.0, uBins[j].w / V_RUN)) + 0.5));
    if (n >= nRun) { r2t = r1t; r2n = r1n; r2k = r1k; r1t = ta; r1n = n; r1k = firstK; n = 0.0; }
  }
  vec2 pos = c;
  float rad = 0.0, alpha = 0.0, trail = 0.0;
  vec2 dir = vec2(0.0, 1.0);
  if (kind == 0) {
    if (n > 0.0) {
      pos = c + (vec2(hash3(i, firstK, 4u), hash3(i, firstK, 5u)) - 0.5) * cell * JITTER;
      if (!(passAgo(pos) < uTw - born)) alpha = clamp((RENEW_S - since) / RENEW_FADE_S, 0.0, 1.0);
      rad = R0 * pow(n, 1.0 / 3.0);
    }
  } else {
    float rt = kind == 1 ? r1t : r2t;
    float rn = kind == 1 ? r1n : r2n;
    uint rk = kind == 1 ? r1k : r2k;
    float age = uTw - rt;
    if (rt >= 0.0 && age <= RUN_LIFE_S) {
      vec2 s0 = c + (vec2(hash3(i, rk, 4u), hash3(i, rk, 5u)) - 0.5) * cell * JITTER;
      float side = (s0.x - uLayout.x * 0.5) / (uLayout.x * 0.5);
      vec2 dn = drift(uTw), d0 = drift(rt);
      pos = s0 + vec2(SIDE * side * (dn.y - d0.y), dn.x - d0.x);
      bool inside = pos.x >= 0.0 && pos.y >= 0.0 && pos.x <= uLayout.x && pos.y <= uLayout.y;
      if (inside && !(passAgo(pos) < age)) {
        alpha = clamp((RUN_LIFE_S - age) / 0.6, 0.0, 1.0);
        rad = 0.85 * R0 * pow(rn, 1.0 / 3.0);
        float vy = uBins[j1].w;
        vec2 v = vec2(SIDE * side * abs(vy), vy);
        dir = length(v) > 1e-5 ? normalize(v) : vec2(0.0, -1.0);
        trail = min(length(pos - s0), 0.04) / rad;
      }
    }
  }
  // at fast clock rates the wiped glass refills many times a second: its drops are drawn fainter (4.11)
  if (Lc < NONE) alpha *= 1.0 - 0.7 * uComfort;
  if (alpha <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
  vec2 across = vec2(-dir.y, dir.x);
  float along = mix(-(trail + 1.25), 1.25, position.x * 0.5 + 0.5);
  float acr = position.y * 1.25;
  vec2 p = pos + (dir * along + across * acr) * rad;
  vLocal = vec2(along, acr);
  vUp = vec2(dir.y, across.y);
  vTrail = trail;
  vAlpha = alpha;
  vec4 cc = projectionMatrix * viewMatrix * vec4(glassPoint(pos), 1.0);
  vCentre = cc.xy / cc.w * 0.5 + 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4(glassPoint(p), 1.0);
}
`;

  const dropsFragment = /* glsl */ `
uniform sampler2D uFrame;
uniform vec2 uResolution;
uniform vec3 uSky;      // the sky's light caught on a drop's top, display values
uniform float uMag;     // the lens: how much wider than the drop the scene it shows is
varying vec2 vLocal;
varying vec2 vUp;
varying float vTrail;
varying float vAlpha;
varying vec2 vCentre;

vec3 tap(vec2 uv) { return texture2D(uFrame, clamp(uv, vec2(0.001), vec2(0.999))).rgb; }

void main() {
  vec2 l = vLocal;
  float aa = max(fwidth(l.x), fwidth(l.y));
  float rh = length(l);
  float head = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, rh);
  float tr = 0.0;
  if (vTrail > 0.0 && l.x < 0.0 && l.x > -vTrail) {
    float u = -l.x / vTrail;
    float w = max(0.45 * (1.0 - 0.6 * u), 0.6 * aa);
    tr = (1.0 - smoothstep(w - aa, w + aa, abs(l.y))) * 0.75 * (1.0 - 0.8 * u);
  }
  float a = max(head, tr) * vAlpha;
  if (a < 0.004) discard;
  vec2 fuv = gl_FragCoord.xy / uResolution;
  vec3 col;
  if (head >= tr) {
    // the lens: the scene around the drop, flipped through its centre and shrunk; four taps across one shrunk
    // pixel's footprint, leaning to the brightest so a lamp in view stays a point
    vec2 d = fuv - vCentre;
    vec2 s = vCentre - d * uMag;
    vec2 px = 0.35 * uMag / uResolution;
    vec3 t0 = tap(s + vec2(px.x, px.y)), t1 = tap(s + vec2(-px.x, px.y)), t2 = tap(s + vec2(px.x, -px.y)), t3 = tap(s - px);
    vec3 avg = 0.25 * (t0 + t1 + t2 + t3);
    vec3 mx = max(max(t0, t1), max(t2, t3));
    col = mix(avg, mx, 0.5);
    float rim = smoothstep(0.45, 1.0, rh);
    col *= 1.0 - 0.65 * rim * rim;
    // the sky caught on the drop's upper side, and the light it gathers onto its lower edge
    vec2 h = l - 0.42 * vUp;
    col += uSky * 1.1 * exp(-dot(h, h) / 0.025);
    col += avg * 0.35 * smoothstep(0.55, 0.95, rh) * max(0.0, -dot(l / max(rh, 1e-3), vUp));
  } else {
    // the trail: a thin film of water, a slight shift and a darker edge
    col = tap(fuv + vec2(0.0, 2.0) / uResolution) * (0.8 - 0.25 * smoothstep(0.2, 0.45, abs(l.y))) + uSky * 0.08;
  }
  gl_FragColor = vec4(col, a);
}
`;

  // ------------------------------------------------------------------ film
  const filmVertex = /* glsl */ `
attribute vec2 aGlass;
varying vec2 vGlass;
void main() {
  vGlass = aGlass;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;
  const filmFragment = /* glsl */ `
${common}
#define MIST_CELL 0.004
#define FILM_S 0.35
#define MIST_MAX 0.45
uniform sampler2D uFrame;
uniform vec2 uResolution;
uniform vec3 uSky;
uniform float uMistRate;   // micro-drops per cell per second
uniform float uHaze;       // the film's softening at full mist
varying vec2 vGlass;

vec3 tap(vec2 uv) { return texture2D(uFrame, clamp(uv, vec2(0.001), vec2(0.999))).rgb; }

void main() {
  float L = passAgo(vGlass);
  bool swept = L < NONE;
  float Lm = swept ? mix(L, uWipe.z * 0.5, uComfort) : 1000.0;
  float mist = 1.0 - exp(-Lm * uMistRate);
  float film = swept ? exp(-L / FILM_S) * (1.0 - uComfort) : 0.0;
  vec2 fuv = gl_FragCoord.xy / uResolution;
  vec2 texel = 1.0 / uResolution;
  float scale = uResolution.y / 720.0;
  // premultiplied 'over', layer by layer
  vec3 c = vec3(0.0);
  float a = 0.0;
  float hz = mist * uHaze;
  if (hz > 0.01) {
    // two taps across a diagonal, with the texture's own linear filter: a softening of a few pixels
    vec2 o = vec2(1.6, 1.2) * scale * texel;
    vec3 b = 0.5 * (tap(fuv + o) + tap(fuv - o));
    c = b * hz; a = hz;
  }
  if (film > 0.01) {
    float ripple = sin(dot(vGlass, vec2(330.0, 910.0)) + 3.0 * sin(vGlass.x * 47.0 + vGlass.y * 23.0));
    vec3 fc = tap(fuv + ripple * 2.5 * scale * texel) * 0.97 + uSky * 0.04;
    float fa = 0.75 * film;
    c = fc * fa + c * (1.0 - fa); a = fa + a * (1.0 - fa);
  }
  if (mist > 0.002) {
    vec2 g = vGlass / MIST_CELL;
    vec2 ci = floor(g), fr = g - ci;
    uint cid = uint(int(ci.x) + 2048) * 4096u + uint(int(ci.y) + 2048);
    // at most MIST_MAX of the cells hold a micro-drop: a faint lens each, a glint on its top, no dark rim at this size
    if (hash3(cid, 91u, 3u) < MIST_MAX * mist) {
      vec2 mc = vec2(hash3(cid, 92u, 3u), hash3(cid, 93u, 3u)) * 0.5 + 0.25;
      float mr = 0.16 + 0.2 * hash3(cid, 94u, 3u);
      vec2 dl = (fr - mc) / mr;
      float md = length(dl);
      float aa = fwidth(md);
      float cov = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, md);
      if (cov > 0.0) {
        vec3 mcol = tap(fuv - dl * 6.0 * scale * texel) * (1.0 - 0.2 * smoothstep(0.5, 1.0, md));
        vec2 h = dl - vec2(-0.25, 0.4);
        mcol += uSky * 0.35 * exp(-dot(h, h) / 0.06);
        float ma = 0.45 * cov;
        c = mcol * ma + c * (1.0 - ma); a = ma + a * (1.0 - ma);
      }
    }
  }
  if (a < 0.002) discard;
  gl_FragColor = vec4(c / a, a);
}
`;

  // ------------------------------------------------------------------ blades
  const bladeVertex = /* glsl */ `
attribute vec2 aGlass;
attribute float aWiper;
varying vec2 vGlass;
varying float vWiper;
void main() {
  vGlass = aGlass;
  vWiper = aWiper;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;
  const bladeFragment = /* glsl */ `
#define SAMPLES 12
uniform vec4 uWiperP[2];
uniform vec4 uWiperA[2];
uniform float uQ[SAMPLES];  // the sweep fraction at SAMPLES instants over the exposure
uniform float uQStep;       // the largest step between them (fraction of the sweep)
uniform vec2 uQRange;       // the least and greatest of them
uniform vec3 uBlade;        // the blade's colour, display values
varying vec2 vGlass;
varying float vWiper;
void main() {
  int w = vWiper > 0.5 ? 1 : 0;
  vec4 P = uWiperP[w], A = uWiperA[w];
  vec2 d = vGlass - P.xy;
  float r = length(d);
  float px = max(fwidth(vGlass.x), fwidth(vGlass.y));
  float span = radians(A.y - A.x);
  // most of the sector is nowhere near the blade over this exposure: leave at once (a blade is under 1.5 cm wide; the
  // pivot's cap and the arm near it get a wider allowance)
  float phi = atan(d.y, d.x);
  float slack = 0.012 / max(r, 0.02) + uQStep * span;
  if (r > 0.02 && (phi < radians(A.x) + span * uQRange.x - slack || phi > radians(A.x) + span * uQRange.y + slack)) discard;
  float cov = 0.0;
  for (int s = 0; s < SAMPLES; s++) {
    float th = radians(A.x) + span * uQ[s];
    vec2 b = vec2(cos(th), sin(th));
    float along = dot(d, b);
    float acr = abs(b.x * d.y - b.y * d.x);
    float hw = along > P.z ? 0.0075 : 0.0045;   // the rubber and its carrier; the arm, narrower
    float soft = max(px, 0.5 * uQStep * span * max(along, 0.0));
    float inR = smoothstep(0.015 - px, 0.015 + px, along) * (1.0 - smoothstep(P.w - px, P.w + px, along));
    cov += inR * (1.0 - smoothstep(hw - soft, hw + soft, acr));
  }
  cov /= float(SAMPLES);
  cov = max(cov, 1.0 - smoothstep(0.016 - px, 0.016 + px, r));   // the pivot's cap
  if (cov < 0.003) discard;
  gl_FragColor = vec4(uBlade, 0.97 * cov);
}
`;
  return {
    drops: { vertex: dropsVertex, fragment: dropsFragment },
    film: { vertex: filmVertex, fragment: filmFragment },
    blades: { vertex: bladeVertex, fragment: bladeFragment },
  };
}
