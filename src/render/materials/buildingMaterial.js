// The building material on the new renderer (plan 01, section 7.12; task T2.2): night.js's GLSL ported to TSL, with
// the same inputs and the same look. Lit windows on facades, the `glow` colours baked into hand-made models,
// animated LED skins and, by day, the mullion grid and sky reflection on a model's marked glass.
//
// Two variants, compiled separately, because WebGPU validates vertex buffers against the shader (a missing
// attribute is an error there, not a zero as in WebGL):
//   'extruded'  no attribute nodes: windows on every wall, no glow, no LED, no day facade detail
//   'landmark'  reads `glow` (vec3), `windows` and `led` (float); windows only where `windows` asks
//
// Two looks, blended by the shared `physical` uniform (T2.5):
//   classic   (?display=classic, the parity specs) exactly night.js v6: the `night` uniform scales the night light
//   physical  windows, glow and LED skins in cd/m2 (src/render/photometry.js) times the exposure and the
//             lights-out factor; windows switch on one by one through dusk, each against its own threshold
//             (switchOn.windows); the facade's reflected sky is a legacy surface, scaled like the dome
import { MeshLambertNodeMaterial } from 'three/webgpu';
import {
  attribute, varying, positionGeometry, normalGeometry, normalWorld, positionWorld, cameraPosition, materialColor,
  materialEmissive, vec2, vec3, float, fract, floor, dot, normalize, step, smoothstep, mix, max, abs, fwidth, cos,
  sin, pow, clamp, reflect,
} from 'three/tsl';
import { night as sharedNight, clock as sharedClock, haze as sharedHaze, exposure as sharedExposure, physical as sharedPhysical,
  switchOn as sharedSwitchOn, cityFactor as sharedCityFactor, legacyScale as sharedLegacyScale } from './shared.js';
import { PHOTOMETRY } from '../photometry.js';

/** fract-based hash of a 2D cell, as nightHash() in night.js v6 */
// Pure (no mutable variable): TSL may emit a call's body more than once, in different branches, and a variable
// updated in place would then be hashed twice.
export const nightHash = (p0) => {
  const p = fract(p0.mul(vec2(123.34, 456.21)));
  const q = p.add(dot(p, p.add(45.32)));
  return fract(q.x.mul(q.y));
};

const ledHash = (p) => nightHash(p.xy.add(vec2(p.z.mul(7.13), p.z.mul(3.71))));

/** smooth value noise in 3D for the LED skins (no texture lookups) */
const ledNoise = (p) => {
  const i = floor(p), f0 = fract(p);
  const f = f0.mul(f0).mul(f0.mul(-2).add(3));
  const h = (x, y, z) => ledHash(i.add(vec3(x, y, z)));
  const a = mix(h(0, 0, 0), h(1, 0, 0), f.x), b = mix(h(0, 1, 0), h(1, 1, 0), f.x);
  const c = mix(h(0, 0, 1), h(1, 0, 1), f.x), d = mix(h(0, 1, 1), h(1, 1, 1), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
};

/**
 * The night light, LED light and day facade terms of one variant, as nodes: { color, emissive }. `color` scales
 * the diffuse colour (the mullion grid), `emissive` is added to the material's own emissive.
 */
export function buildingNodes({ variant = 'extruded', night = sharedNight, clock = sharedClock, haze = sharedHaze,
  exposure = sharedExposure, physical = sharedPhysical, switchOn = sharedSwitchOn, cityFactor = sharedCityFactor,
  legacyScale = sharedLegacyScale } = {}) {
  const landmark = variant === 'landmark';
  // geometry is in world coordinates and a moved building only shifts its mesh: the untransformed position keeps
  // the windows fixed to the building
  const pos = varying(positionGeometry, 'vNightPos');
  const nrm = varying(normalGeometry, 'vNightNormal');
  const glow = landmark ? varying(attribute('glow', 'vec3'), 'vGlow') : vec3(0);
  const windowsAttr = landmark ? varying(attribute('windows', 'float'), 'vWindows') : float(0);
  const led = landmark ? varying(attribute('led', 'float'), 'vLed') : float(0);

  // facade: walls within about 12 degrees of vertical; on a model's marked glass also slopes up to about 60 degrees
  const facing = float(1).sub(step(landmark ? 0.2 : 0.87, abs(nrm.y)));
  // one bay (3.6 m) across, one floor (3.4 m) up, along the face's horizontal direction
  const wall = nrm.xz.add(vec2(1e-5, 0));
  const along = normalize(vec2(wall.y.negate(), wall.x));
  const cell = vec2(dot(pos.xz, along).div(3.6), pos.y.div(3.4));
  // far away a window is smaller than a pixel: fade to the wall's average so it does not shimmer
  const detail = float(1).sub(smoothstep(0.35, 1.2, max(fwidth(cell.x), fwidth(cell.y))));
  const id = floor(cell).add(floor(along.mul(5)).mul(17));
  const f = fract(cell);

  // lit windows: extruded buildings everywhere, a hand-made model only where its windows attribute says
  const windowed = landmark ? windowsAttr : float(1);
  const busy = mix(0.05, 0.4, nightHash(floor(pos.xz.div(90)))); // share of windows lit, block by block
  const lit = step(float(1).sub(busy), nightHash(id));
  const pane = step(0.18, f.x).mul(step(f.x, 0.82)).mul(step(0.25, f.y)).mul(step(f.y, 0.8));
  const amount = mix(busy.mul(0.35), lit.mul(pane), detail);
  const tint = mix(vec3(1.0, 0.72, 0.38), vec3(0.7, 0.82, 1.0), step(0.8, nightHash(id.add(3.7))));
  // masks instead of branches: a select() of a large expression becomes an `if`, and fwidth() must not sit in one
  const onFacade = step(1e-6, windowed).mul(step(0.5, facing));
  const windowLight = tint.mul(amount).mul(0.75).mul(windowed).mul(onFacade);
  const nightGlow = glow.add(windowLight).mul(night);

  // physical: each window its own dusk threshold, 60 cd/m2 +-50 %, the tint at luminance 1
  const on = step(nightHash(id.add(11.3)), switchOn.windows);
  const tintLum = dot(tint, vec3(0.2126, 0.7152, 0.0722));
  const cd = nightHash(id.add(5.1)).add(0.5).mul(PHOTOMETRY.windowCdM2);
  const amountPhys = mix(busy.mul(0.35).mul(switchOn.windows).mul(PHOTOMETRY.windowCdM2), lit.mul(pane).mul(on).mul(cd), detail);
  const windowPhys = tint.div(tintLum).mul(amountPhys).mul(windowed).mul(onFacade);
  const glowPhys = glow.mul(PHOTOMETRY.glowCdM2PerUnit).mul(switchOn.windows);
  const artificial = exposure.mul(cityFactor);
  let classicEmissive = nightGlow;
  let physicalEmissive = windowPhys.add(glowPhys).mul(artificial);
  let color = float(1);
  if (landmark) {
    // an LED skin: soft colour bands drifting up and across the surface, broken up by slow noise
    const t = clock;
    const noise = ledNoise(pos.mul(0.022).add(vec3(0, t.mul(-0.11), t.mul(0.05))));
    const band = pos.y.mul(0.018).add(dot(pos.xz, vec2(0.009, 0.006))).sub(t.mul(0.05)).add(noise.mul(0.7));
    const ledColor = cos(band.add(vec3(0, 0.33, 0.67)).mul(6.2832)).mul(0.45).add(0.55);
    const pulse = sin(band.mul(2).sub(t.mul(0.07)).mul(6.2832)).mul(0.35).add(0.65);
    const ledPattern = ledColor.mul(pulse).mul(led); // zero where led is zero
    const ledLight = ledPattern.mul(mix(0.05, 1.2, night));
    const ledPhys = ledPattern.mul(float(PHOTOMETRY.ledNightDim - 1).mul(switchOn.signs).add(1).mul(PHOTOMETRY.ledCdM2)).mul(artificial);

    // by day, on marked glass: mullions and floor slabs darken the albedo, panes vary a little, and the sky is
    // reflected (Schlick: little head-on, a lot at grazing angles). Worked out in world space; night.js v6 did it
    // in view space and turned the reflection back to world, which is the same vector.
    const glass = clamp(windowsAttr, 0, 1).mul(facing);
    const frame = float(1).sub(step(0.07, f.x).mul(step(f.x, 0.93)).mul(step(0.1, f.y)).mul(step(f.y, 0.92)));
    const paneVar = nightHash(id.add(9.1)).sub(0.5).mul(0.16);
    color = glass.mul(detail).mul(paneVar.sub(frame.mul(0.35))).add(1); // 1 where there is no glass
    const toEye = normalize(cameraPosition.sub(positionWorld));
    const n = normalize(normalWorld);
    const rw = normalize(reflect(toEye.negate(), n));
    const zenith = haze.mul(vec3(0.38, 0.55, 0.92));
    const sky = mix(haze.mul(0.35), mix(haze, zenith, pow(clamp(rw.y, 0, 1), 0.5)), step(1e-6, rw.y));
    const fres = pow(float(1).sub(clamp(dot(n, toEye), 0, 1)), 5).mul(0.96).add(0.04);
    const facadeDay = sky.mul(fres).mul(glass).mul(float(1).sub(night.mul(0.7))).mul(float(1).sub(frame.mul(detail).mul(0.6)));
    classicEmissive = classicEmissive.add(ledLight).add(facadeDay);
    physicalEmissive = physicalEmissive.add(ledPhys).add(facadeDay.mul(legacyScale));
  }
  return { color, emissive: mix(classicEmissive, physicalEmissive, physical) };
}

/**
 * A MeshLambertNodeMaterial for buildings, taking colour, emissive, vertex colours, blending and the like from
 * `from` (the MeshLambertMaterial the caller made, as night.js's lightAtNight() received it).
 */
export function createBuildingMaterial({ variant = 'extruded', from = null, night, clock, haze } = {}) {
  const material = new MeshLambertNodeMaterial();
  if (from) {
    for (const k of ['vertexColors', 'transparent', 'opacity', 'depthWrite', 'depthTest', 'blending', 'side', 'fog', 'name', 'emissiveIntensity']) material[k] = from[k];
    material.color.copy(from.color);
    material.emissive.copy(from.emissive);
  }
  const nodes = buildingNodes({ variant, night, clock, haze });
  material.colorNode = materialColor.mul(nodes.color);
  // the material's own emissive is the blue highlight of the removable towers and the selection tint: display-
  // referred (it reads the same at noon and midnight), but in the physical look scaled by legacyScale, which is 1
  // when the exposure sits where the prior puts it. Left unscaled, its share of the metered light moved against
  // the exposure and the automatic exposure chased itself (measured: 15.5 down past 14.2 EV, still sliding)
  material.emissiveNode = materialEmissive.mul(mix(float(1), sharedLegacyScale, sharedPhysical)).add(nodes.emissive);
  material.userData.buildingVariant = variant;
  return material;
}
