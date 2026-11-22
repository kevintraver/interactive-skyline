// The windshield layer's shader (plan 02, D4.4): drawn in the cabin pass over the windshield opening, additive.
// Its arithmetic is mirrored in windshield.js (phaseVeil, veilLuminance, glassReflectance), where the unit tests
// check it; the constants come from there. Written for three's ShaderMaterial on WebGLRenderer; to be ported with
// the other custom shaders (see the plan's port table).
//
// Per fragment (cabin coordinates; cameraPosition is the eye):
//   v      the view through this point of the glass
//   m      the dirt mask (windshield.js windshieldMask): dust, wiper arcs, streaks
//   sun    uSun * phase(v . uSunDir), uSun = colour x K x E_sun,normal x lit x (scene per lux), soft-capped
//   sky    uSky, the dust's share of the sky's light
//   lamps  sum of uLamps[i].w * phase(v . uLamps[i].xyz) (the brightest oncoming head lamps), soft-capped
//   veil   m x (sun + sky + lamps)
//   dash   the dashboard top seen in the glass: the view reflected in the glass plane, where it meets the dash's
//          plane inside its outline, at the glass's Fresnel reflectance for that angle, times uDash
//   phase(c) = c / (theta_deg^2 + THETA_C^2), theta the angle between v and the source (the Stiles-Holladay form
//          E / theta^2, with cos theta for the illuminance at the eye and a core of THETA_C)

/** @param {{ thetaC: number, glassN: number, maxLamps: number }} k */
export function windshieldShaders({ thetaC, glassN, maxLamps }) {
  const f = (x) => (Number.isInteger(x) ? `${x}.0` : String(x));
  const vertex = /* glsl */ `
varying vec3 vPos;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 p = modelMatrix * vec4(position, 1.0);
  vPos = p.xyz;
  gl_Position = projectionMatrix * viewMatrix * p;
}
`;
  const fragment = /* glsl */ `
#define THETA_C2 ${f(thetaC * thetaC)}
#define GLASS_N ${f(glassN)}
#define MAX_LAMPS ${maxLamps}
uniform sampler2D uMask;
uniform vec3 uSunDir;
uniform vec3 uSun;
uniform float uCapSun;
uniform vec3 uSky;
uniform vec4 uLamps[MAX_LAMPS];
uniform vec3 uLampColor;
uniform float uCapLamp;
uniform vec3 uGlassN;     // the glass's normal toward the driver
uniform vec3 uDash;       // the lit dashboard top's radiance
uniform vec4 uDashRect;   // x min, x max, z min, z max of the dash top
uniform float uDashY;     // the dash top's height
varying vec3 vPos;
varying vec2 vUv;

float phaseVeil(float c) {
  if (c <= 0.0) return 0.0;
  float th = degrees(acos(min(c, 1.0)));
  return c / (th * th + THETA_C2);
}

// unpolarised Fresnel reflectance of one glass surface, then both faces of the pane
float glassReflectance(float ci) {
  ci = clamp(ci, 1e-4, 1.0);
  float si = sqrt(max(0.0, 1.0 - ci * ci)) / GLASS_N;
  float ct = sqrt(max(0.0, 1.0 - si * si));
  float rs = (ci - GLASS_N * ct) / (ci + GLASS_N * ct);
  float rp = (GLASS_N * ci - ct) / (GLASS_N * ci + ct);
  float r = 0.5 * (rs * rs + rp * rp);
  return 2.0 * r / (1.0 + r);
}

void main() {
  vec3 v = normalize(vPos - cameraPosition);
  float m = texture2D(uMask, vUv).r;
  vec3 sun = uSun * phaseVeil(dot(v, uSunDir));
  float ls = dot(sun, vec3(0.2126, 0.7152, 0.0722));
  sun /= 1.0 + ls / uCapSun;
  float lamp = 0.0;
  for (int i = 0; i < MAX_LAMPS; i++) lamp += uLamps[i].w * phaseVeil(dot(v, uLamps[i].xyz));
  lamp /= 1.0 + lamp / uCapLamp;
  vec3 col = m * (sun + uSky + uLampColor * lamp);
  // the dashboard top, mirrored in the glass
  vec3 r = reflect(v, uGlassN);
  if (r.y < -0.02) {
    float t = (uDashY - vPos.y) / r.y;
    vec3 h = vPos + t * r;
    if (h.x > uDashRect.x && h.x < uDashRect.y && h.z > uDashRect.z && h.z < uDashRect.w) {
      // fade toward the outline; the defroster grille along the cowl a little darker
      float e = min(min(h.x - uDashRect.x, uDashRect.y - h.x), min(h.z - uDashRect.z, uDashRect.w - h.z));
      float grille = h.z < uDashRect.z + 0.07 ? 0.55 : 1.0;
      col += glassReflectance(abs(dot(v, uGlassN))) * uDash * grille * smoothstep(0.0, 0.08, e);
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
  return { vertex, fragment };
}
