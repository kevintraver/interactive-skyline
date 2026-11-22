// GLSL of the falling rain (plan 02, phase 8): instanced streaks, one camera-facing thin quad per drop. To be ported
// with the renderer (plan 02, port table). Mirror: rainMirror.js (dropLocal, lowBeamShare, streakLight);
// tests/unit/weather/rain.test.js. Positions are relative to the eye throughout (no large numbers on the GPU).

export const rainVertex = /* glsl */ `
precision highp float;
in vec2 corner;          // x: 0 at the drop, 1 at its streak's tail; y: -1..1 across
in vec4 aSeed;           // base position in [0, 1)^3, class slot (class = floor(w x 4))

uniform float uBox;      // the cube's side (m)
uniform vec3 uOff[4];    // per class, (v t - centre) mod box (rainOffsets)
uniform vec3 uStreak[4]; // per class, the drop's motion relative to the eye over the shutter (m)
uniform vec4 uDiam;      // per class, drop diameter (m)
uniform vec3 uCentre;    // the cube's centre relative to the eye
uniform vec2 uViewport;  // drawing buffer (px)
uniform float uPixelAngle;
uniform vec3 uLamp[2];   // the visitor's headlamps relative to the eye
uniform mat3 uCar;       // columns: the car's right, up, forward
uniform vec4 uLight;     // x headlamp peak cd x on, y lighting.units.nit, z backscatter x gain, w day contrast x gain
uniform vec3 uSky;       // the sky's radiance near the horizon (scene units, linear)
uniform vec3 uLampColour;
uniform vec3 uCarRel;    // the car's centre relative to the eye
uniform vec4 uCarBox;    // half width, roof above the road point, half length, floor (m)
uniform float uVisibility;

out float vAcross;       // pixels from the streak's axis
out float vAlong;        // 0 at the drop, 1 at the tail
out float vLen;          // the streak's length (px)
out vec3 vAmp;           // scene value per pixel at the axis

float lowBeam(vec3 c) {
  if (c.z <= 0.0) return 0.0;
  float h = degrees(atan(c.x, c.z));
  float v = degrees(atan(c.y, length(c.xz)));
  float dv = v + 1.75;
  float sv = dv < 0.0 ? 4.5 : 1.0;
  float hh = (h - 2.0) / 14.0;
  return exp(-hh * hh) * exp(-(dv / sv) * (dv / sv));
}

void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vAcross = 0.0; vAlong = 0.0; vLen = 1.0; vAmp = vec3(0.0);
  int c = int(min(floor(aSeed.w * 4.0), 3.0));
  vec3 local = mod(aSeed.xyz * uBox + uOff[c], uBox) - 0.5 * uBox;
  vec3 head = local + uCentre;
  float d = length(head);
  if (d < 0.6) return;
  // inside the car: none
  vec3 q = (head - uCarRel) * uCar;
  if (abs(q.x) < uCarBox.x && q.y < uCarBox.y && q.y > uCarBox.w && abs(q.z) < uCarBox.z) return;
  float edge = max(abs(local.x), max(abs(local.y), abs(local.z))) / (0.5 * uBox);
  float fade = 1.0 - smoothstep(0.7, 1.0, edge);
  // light on the drop: the headlamps (both), and the sky
  float lux = 0.0;
  for (int i = 0; i < 2; i++) {
    vec3 v = head - uLamp[i];
    float r2 = max(dot(v, v), 0.25);
    lux += uLight.x * lowBeam(v * uCar) / r2;
  }
  float D = uDiam[c];
  float A = 0.7853981633974483 * D * D;
  float T = exp(-d / uVisibility);
  vec3 E = (uLampColour * (lux * A * uLight.z * uLight.y) + uSky * (uLight.w * A)) * (fade * T / (d * d));
  // the streak on screen
  vec3 tail = head - uStreak[c];
  mat3 vr = mat3(viewMatrix);
  vec4 ch = projectionMatrix * vec4(vr * head, 1.0);
  vec4 ct = projectionMatrix * vec4(vr * tail, 1.0);
  if (ch.w <= 0.05 || ct.w <= 0.05) return;
  vec2 sh = ch.xy / ch.w * 0.5 * uViewport, st = ct.xy / ct.w * 0.5 * uViewport;
  vec2 dir = st - sh;
  float len = length(dir);
  vec2 ax = len > 1e-3 ? dir / len : vec2(0.0, -1.0);
  vec2 side = vec2(-ax.y, ax.x);
  float L = max(len, 1.5);
  float sigma = 0.6;
  float halfW = 1.6;
  // summed light E over the streak: per pixel E / pixelAngle^2 / (L x sqrt(2 pi) sigma) on its axis
  vAmp = E / (uPixelAngle * uPixelAngle * L * 2.5066282746310002 * sigma);
  if (max(vAmp.r, max(vAmp.g, vAmp.b)) < 1e-4) { vAmp = vec3(0.0); return; }
  vec4 cl = mix(ch, ct, corner.x);
  vec2 offPx = side * corner.y * halfW + ax * (corner.x * 2.0 - 1.0) * 0.75 + ax * corner.x * (L - len);
  cl.xy += offPx * 2.0 / uViewport * cl.w;
  vAcross = corner.y * halfW;
  vAlong = corner.x;
  vLen = L;
  gl_Position = cl;
}
`;

export const rainFragment = /* glsl */ `
precision highp float;
in float vAcross;
in float vAlong;
in float vLen;
in vec3 vAmp;
void main() {
  float a = vAcross / 0.6;
  // soft ends over about a pixel each
  float ends = smoothstep(0.0, 1.0 / vLen, vAlong) * smoothstep(0.0, 1.0 / vLen, 1.0 - vAlong);
  gl_FragColor = vec4(vAmp * (exp(-0.5 * a * a) * ends), 1.0);
  #include <colorspace_fragment>
}
`;
