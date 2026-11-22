// The valley's light ribbons (plan 02, D6.6): vertex and fragment shaders. WebGL2 / GLSL ES 3.0 through three's
// ShaderMaterial (three adds the WebGL2 prefix, the camera uniforms and the output colour space). A custom shader:
// to be ported with the renderer (port table in plan 02, "Decisions for the second stretch").
//
// Mirror: valleyModel.js holds the same arithmetic in JavaScript (shapeAt, densityPerMetre, lampIntensity,
// ribbonRadiance, driftSpeed, hash11 and driftFactor); tests/unit/traffic/valley.test.js tests that file. Change
// both together.
//
// Geometry (valleyGeometry.js): every ribbon is a run of points along one direction of one road, two vertices per
// point (aAlong.y = -1, +1). The vertex shader turns the pair into a strip: flat on the ground at the carriageway's
// width where that looks at least uMinPx wide, else uMinPx wide, facing the eye and standing on the ground.
//   position   the point: scene metres, on the ground plus a small lift, offset to the right of travel
//   aDir       the direction of travel, scene axes, unit
//   aAlong     metres along the ribbon (with a per-ribbon offset for the pattern), side (-1 or +1)
//   aTraffic   daily volume of this direction, shape row, speed (m/s), carriageway width (m)

export const valleyVertex = /* glsl */ `
precision highp sampler2D;

uniform sampler2D tShapes;     // R32F, 168 wide, one row per shape: the share of a mean day in each hour of the week
uniform float uHow;            // local hour of week, real
uniform float uPixelAngle;     // radians per pixel: 2 tan(fov / 2) / height
uniform float uMinPx;          // narrowest strip, pixels
uniform vec2 uNear;            // the ribbons fade in between these distances from the eye (m)
uniform float uVisibility;     // metres: transmittance exp(-d / visibility)
uniform vec4 uLamps;           // head cd, head power, spill cd, tail cd (valleyModel.js VALLEY_LAMPS)
uniform float uGain;           // scene units per cd/m^2 (lighting.units.nit) x the look's fade

in vec3 aDir;
in vec2 aAlong;
in vec4 aTraffic;

out vec2 vLight;               // scene radiance of white and of red at the strip's centre line
out float vU;                  // metres along the ribbon
out float vSpeed;              // drift speed, m/s
out float vAmp;                // drift amplitude (0 where a cell is under a few pixels)
out float vSide;               // -1 .. 1 across the strip

float shapeAt(float row, float how) {
  float x = how - 0.5;
  float i = floor(x);
  float f = x - i;
  int r = int(row + 0.5);
  float a = texelFetch(tShapes, ivec2(int(mod(i, 168.0)), r), 0).r;
  float b = texelFetch(tShapes, ivec2(int(mod(i + 1.0, 168.0)), r), 0).r;
  return mix(a, b, f);
}

float driftSpeed(float v) {
  float q = ${(60 * 64) / 3600};
  return max(1.0, floor(v / q + 0.5)) * q;
}

void main() {
  vec3 rel = position - cameraPosition;          // relative to the eye: no large numbers on the GPU
  float d = length(rel);
  vec3 toEye = -rel / max(d, 1e-3);
  float fade = smoothstep(uNear.x, uNear.y, d);
  vLight = vec2(0.0); vU = aAlong.x; vSpeed = 0.0; vAmp = 0.0; vSide = aAlong.y;
  if (fade <= 0.0 || aTraffic.x <= 0.0) {
    // no light here: the strip pinches to its centre line (moving the vertex away would stretch the triangles it
    // shares with lit neighbours across the screen)
    gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * rel, 1.0);
    return;
  }

  // Two ways to draw the strip, both sending the eye n I per metre of road (valleyModel.js ribbonRadiance):
  //  - flat on the ground at the carriageway's width, where that is at least uMinPx wide on the screen seen from
  //    above: luminance n I / (w sin(elevation of the eye));
  //  - otherwise a strip uMinPx wide facing the eye (across both the road and the line of sight), standing on
  //    the ground: luminance n I / (w sin(angle between road and line of sight)).
  vec3 across = cross(aDir, toEye);
  float sinT = length(across);
  across = sinT > 1e-4 ? across / sinT : vec3(0.0, 1.0, 0.0);
  float elev = max(toEye.y, 1e-3);
  float wMin = uMinPx * d * uPixelAngle;
  bool onGround = aTraffic.w * elev >= wMin;
  float w, proj;
  vec3 p = rel;
  if (onGround) {
    vec3 ground = normalize(vec3(-aDir.z, 0.0, aDir.x));
    w = aTraffic.w; proj = elev;
    p += ground * (0.5 * w * aAlong.y);
  } else {
    w = wMin; proj = max(sinT, 0.1);
    p += across * (0.5 * w * aAlong.y);
    p.y += 0.5 * w * abs(across.y);             // stand on the ground, not half in it
  }

  // light: vehicles per metre x intensity toward the eye
  float n = aTraffic.x * shapeAt(aTraffic.y, uHow) / (3600.0 * aTraffic.z);
  float c = dot(aDir, toEye);
  float head = uLamps.x * pow(clamp(c, 0.0, 1.0), uLamps.y) + uLamps.z * clamp(0.5 + 0.5 * c, 0.0, 1.0);
  float tail = uLamps.w * clamp(-c, 0.0, 1.0);
  float k = n / (w * proj) * exp(-d / uVisibility) * fade * uGain;
  vLight = vec2(head, tail) * k;

  // the drift: cells of 60 m; amplitude from the Poisson spread of the vehicles in a cell, faded out where a cell
  // is under four pixels long on the screen (it would only shimmer)
  float cellPx = 60.0 * max(sinT, 0.05) / (d * uPixelAngle);
  vAmp = min(0.9, inversesqrt(n * 60.0 + 1e-6)) * smoothstep(1.5, 4.0, cellPx);
  vSpeed = driftSpeed(aTraffic.z);

  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * p, 1.0);
}
`;

export const valleyFragment = /* glsl */ `
uniform float uTime;           // drift time: simulation seconds, wrapped at 3600 (valleyModel.js driftTime)
uniform float uHashMean;       // valleyModel.js HASH_MEAN
uniform vec3 uHeadColor;       // linear sRGB at luminance 1
uniform vec3 uTailColor;

in vec2 vLight;
in float vU;
in float vSpeed;
in float vAmp;
in float vSide;

float hash11(float i) {
  float p = fract(i * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

// three's ACES fit on luminance, keeping the hue (as the light sprites do: sprites.glsl.js toneSprite)
float acesFit(float x) {
  x = x / 0.6;
  float a = x * (x + 0.0245786) - 0.000090537;
  float b = x * (0.983729 * x + 0.4329510) + 0.238081;
  return clamp(a / b, 0.0, 1.0);
}
vec3 toneRibbon(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (y <= 0.0) return vec3(0.0);
  vec3 o = c * (acesFit(y) / y);
  float m = max(o.r, max(o.g, o.b));
  if (m > 1.0) o = mix(o / m, vec3(1.0), (m - 1.0) / m);
  return o;
}

void main() {
  float x = (vU - vSpeed * uTime) / 60.0;
  float i = floor(x), f = x - i;
  float s = f * f * (3.0 - 2.0 * f);
  float v = mix(hash11(mod(i, 64.0)), hash11(mod(i + 1.0, 64.0)), s) - uHashMean + 0.5;
  float drift = 1.0 + vAmp * (2.0 * v - 1.0);
  float across = 1.5 * (1.0 - vSide * vSide);   // a soft line across the strip, of mean 1
  vec3 c = (uHeadColor * vLight.x + uTailColor * vLight.y) * (drift * across);
  gl_FragColor = vec4(toneRibbon(c), 1.0);
  #include <colorspace_fragment>
}
`;
