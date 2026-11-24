// The drive's light on plan 01's renderer (plan 02, third stretch, decision 6): the one place that turns the drive's
// physical quantities (candela, lux, cd/m^2) into what a node material writes. Every drive light is artificial, so
// every value here is also multiplied by the lights-out slider (env.nodes.cityFactor, plan 01 section 11.5 rule 2).
//
//   import { lightScale, luminance, illuminanceToRadiance, pointSource, photometryContext } from './photometry.node.js';
//   const ctx = photometryContext({ nodes: env.nodes });          // or {} for the defaults below
//   material.emissiveNode = luminance(uniform(300), ctx);         // a 300 cd/m^2 face
//   const pool = illuminanceToRadiance(diffuseColor.rgb, luxNode, ctx);   // albedo x lux / pi, in buffer units
//
// The scale (lightScale) is the display's:
//   'physical'  (the shipped look) env.nodes.exposure, the pre-exposure: cd/m^2 x exposure is what the HDR buffer
//               holds (plan 01, 7.2)
//   'classic'   (?display=classic, where look.js holds the exposure at 1) LIGHTING_UNITS, the constant scale the
//               classic renderer's drive used (src/drive/env.js): 0.1 scene units per cd/m^2 and per lux. The new
//               renderer then draws the drive's light at the values the classic one did, which is what the parity
//               tool compares.
// The display is fixed for the page (?display= is read once), so it is chosen when the node graph is built.
//
// Each node has a CPU twin (`...Cpu`) with the same arithmetic, for tests and CPU-side light work.

import { float } from 'three/tsl';
import { createEnvNodes } from '../../env/nodes.js';
import { LIGHTING_UNITS } from '../env.js';

export { LIGHTING_UNITS };

/** The display the address asks for, as src/render/look.js reads it: 'classic' or 'physical'. */
export const displayFromSearch = (search) => (new URLSearchParams(search || '').get('display') === 'classic' ? 'classic' : 'physical');

let defaultNodes = null;
/** env.nodes without an environment: the same shared uniforms (exposure, cityFactor) the app's env.nodes holds. */
const sharedNodes = () => (defaultNodes ||= createEnvNodes(null));

/**
 * A photometry context: { display: 'classic' | 'physical', nodes: env.nodes }. Missing fields take the page's
 * display (?display=) and plan 01's shared nodes, so `{}` works anywhere.
 * @param {{ display?: 'classic' | 'physical', nodes?: object }} [ctx]
 */
export function photometryContext(ctx = {}) {
  if (ctx && ctx.__photometry) return ctx;
  const display = ctx?.display === 'classic' || ctx?.display === 'physical'
    ? ctx.display
    : displayFromSearch(globalThis.location ? globalThis.location.search : '');
  return Object.freeze({ __photometry: true, display, nodes: ctx?.nodes || sharedNodes() });
}

const asNode = (v) => (typeof v === 'number' ? float(v) : v);

/**
 * Buffer units per cd/m^2 (and per lux of illuminance, per candela of intensity): a float node, the exposure in
 * the shipped look and LIGHTING_UNITS.nit at the classic display. Not multiplied by cityFactor (see artificialScale).
 */
export function lightScale(ctx) {
  const c = photometryContext(ctx);
  return c.display === 'classic' ? float(LIGHTING_UNITS.nit) : c.nodes.exposure;
}

/** lightScale x cityFactor: the scale of every drive light (all are artificial). */
export function artificialScale(ctx) {
  const c = photometryContext(ctx);
  return lightScale(c).mul(c.nodes.cityFactor);
}

/** cd/m^2 -> buffer units (an artificial light's luminance toward the eye). */
export function luminance(cdM2, ctx) {
  return asNode(cdM2).mul(artificialScale(ctx));
}

/**
 * The radiance a Lambertian surface of `albedo` (float or vec3 node) returns under `lux` of illuminance, in buffer
 * units: albedo x lux / pi x the scale. three's own lights use the same BRDF (BRDF_Lambert = albedo / pi).
 */
export function illuminanceToRadiance(albedo, lux, ctx) {
  return asNode(albedo).mul(asNode(lux)).mul(1 / Math.PI).mul(artificialScale(ctx));
}

/** E = I / d^2: the illuminance (lux) a lamp of `candela` gives at `distanceM` (nodes or numbers), no scale. */
export function illuminanceAt(candela, distanceM) {
  const d = asNode(distanceM).max(1e-3);
  return asNode(candela).div(d.mul(d));
}

/**
 * A lamp drawn as a sprite of `sizePx` pixels a side, each pixel subtending `pixelSr` steradians, conserving flux
 * (plan 01's env.nodes.pointSource, with the drive's scale): E = I / d^2 at the eye, so the sprite's luminance is
 * E / (sizePx^2 pixelSr) and its colour that times the scale. Returns { color, luminance, lux } nodes.
 * @param {*} candela  node or number
 * @param {{ distance: *, pixelSr: *, sizePx?: * }} o  nodes or numbers; sizePx at least 1 (default 1)
 */
export function pointSource(candela, { distance, pixelSr, sizePx = 1 }, ctx) {
  const s = asNode(sizePx).max(1);
  const lux = illuminanceAt(candela, distance);
  const cdM2 = lux.div(s.mul(s).mul(asNode(pixelSr)));
  return { color: cdM2.mul(artificialScale(ctx)), luminance: cdM2, lux };
}

// ---------------------------------------------------------------- CPU twins

/**
 * lightScale on the CPU: the exposure in the shipped look, LIGHTING_UNITS.nit at the classic display.
 * @param {{ display?: 'classic' | 'physical', exposure?: number }} [o]
 */
export const lightScaleCpu = ({ display = 'physical', exposure = 1 } = {}) => (display === 'classic' ? LIGHTING_UNITS.nit : exposure);

/** artificialScale on the CPU. */
export const artificialScaleCpu = ({ cityFactor = 1, ...o } = {}) => lightScaleCpu(o) * cityFactor;

/** luminance on the CPU (o: display, exposure, cityFactor). */
export const luminanceCpu = (cdM2, o) => cdM2 * artificialScaleCpu(o);

/** illuminanceToRadiance on the CPU, per channel when albedo is an array. */
export function illuminanceToRadianceCpu(albedo, lux, o) {
  const k = (lux / Math.PI) * artificialScaleCpu(o);
  return Array.isArray(albedo) ? albedo.map((a) => a * k) : albedo * k;
}

/** illuminanceAt on the CPU. */
export const illuminanceAtCpu = (candela, distanceM) => candela / Math.max(distanceM, 1e-3) ** 2;

/** pointSource on the CPU: { color, luminance, lux }. */
export function pointSourceCpu(candela, { distance, pixelSr, sizePx = 1 }, o) {
  const s = Math.max(1, sizePx);
  const lux = illuminanceAtCpu(candela, distance);
  const cdM2 = lux / (s * s * pixelSr);
  return { color: cdM2 * artificialScaleCpu(o), luminance: cdM2, lux };
}
