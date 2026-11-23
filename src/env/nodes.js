// env.nodes (plan 01, section 11.5): the shader nodes other plans' materials import. Real TSL nodes since phase 2
// (T2.5): `exposure` is the pre-exposure uniform, emissive() turns cd/m2 into HDR-buffer units, pointSource()
// draws a lamp smaller than a pixel as a sprite that conserves its flux. The lighting nodes keep the stub values of
// section 11.1 until phase 3 (no cloud shadow, dry surfaces, no aerial perspective); they are nodes now, so
// material code written against them compiles today.
//
// Each node has a CPU twin under `cpu` with the same arithmetic, for tests and for CPU-side light work.
import {
  float, vec2, vec3, vec4, length, max, cameraPosition, positionWorld, cameraProjectionMatrix, screenSize,
} from 'three/tsl';
import { exposure, cityFactor, switchOn } from '../render/materials/shared.js';

/**
 * Point source: a lamp of `candela` at `distanceM` lights the eye with E = I / d^2 lux. Drawn as a square sprite of
 * `sizePx` pixels a side, each pixel subtending `pixelSr` steradians, its luminance must be E / (sizePx^2 pixelSr)
 * so that the sprite delivers the same flux whatever its size. The size is `minPixels`, at least 1.
 */
export function pointSourceCpu(candela, distanceM, pixelSr, { minPixels = 1, exposure: k = 1, cityFactor: f = 1, artificial = false } = {}) {
  const sizePx = Math.max(1, minPixels);
  const lux = (candela * (artificial ? f : 1)) / Math.max(distanceM, 1e-3) ** 2;
  return { luminanceCdM2: lux / (sizePx * sizePx * pixelSr), color: (lux / (sizePx * sizePx * pixelSr)) * k, sizePx, lux };
}

/** cd/m2 -> HDR-buffer units (x cityFactor when artificial). */
export const emissiveCpu = (cdM2, { exposure: k = 1, cityFactor: f = 1, artificial = false } = {}) => cdM2 * k * (artificial ? f : 1);

const asNode = (v) => (typeof v === 'number' ? float(v) : v);

export function createEnvNodes(env) {
  const nodes = {
    exposure,
    cityFactor,
    switchOn,
    /** cd/m2 -> HDR-buffer units, multiplied by the current exposure; x cityFactor when artificial. */
    emissive(cdM2, o = {}) {
      const v = asNode(cdM2).mul(exposure);
      return o.artificial ? v.mul(cityFactor) : v;
    },
    /**
     * A lamp of `candela` as a sprite: { color: HDR units per pixel, sizePx }. Uses the distance from the camera to
     * positionWorld and the projection's pixel size, as pointSourceCpu().
     */
    pointSource(candela, o = {}) {
      const sizePx = float(Math.max(1, o.minPixels ?? 1));
      const d = max(length(positionWorld.sub(cameraPosition)), 1e-3);
      // one pixel's solid angle at the centre of the view: (2 / (P11 * height))^2
      const pixel = float(2).div(cameraProjectionMatrix.element(1).y.mul(screenSize.y).max(1));
      const lux = asNode(candela).mul(o.artificial ? cityFactor : 1).div(d.mul(d));
      return { color: lux.div(sizePx.mul(sizePx).mul(pixel.mul(pixel))).mul(exposure), sizePx };
    },
    keyLightDir: vec3(0, 1, 0),
    /** vec3 illuminance x colour from the key light at that point (no terrain or cloud shadow until phase 3). */
    keyLight: () => vec3(0),
    ambient: () => vec3(0),
    skyReflection: () => vec3(0),
    artificialLight: () => vec3(0),
    aerialPerspective: () => vec4(0, 0, 0, 1),
    transmittance: () => vec3(1),
    cloudShadow: () => float(1),
    wetness: () => vec2(0),
    wetLayer: (surface) => surface,
    applyWetSurface: () => {},
    cpu: { emissive: emissiveCpu, pointSource: pointSourceCpu },
  };
  // the stubs above that depend on the state follow it each frame (env.update calls sync)
  nodes.sync = () => {
    const s = env.state;
    if (!s) return;
    cityFactor.value = s.lights.cityFactor;
    switchOn.windows.value = s.lights.windows;
    switchOn.street.value = s.lights.street;
    switchOn.signs.value = s.lights.signs;
  };
  return nodes;
}
