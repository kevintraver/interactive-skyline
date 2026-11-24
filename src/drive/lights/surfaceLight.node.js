// Light added to the drive's surfaces on plan 01's renderer (plan 02, third stretch, decision 6): the node-material
// counterpart of surfaceLight.js. One helper adds, replaces and removes named "terms" on a MeshLambertNodeMaterial or
// MeshStandardNodeMaterial (plan 01's building and terrain materials included) without touching what the material
// already has (its colorNode, emissiveNode, the building material's diffuseFactorNode, its own lighting model), and
// the last term out restores the material exactly as it was.
//
//   import { addSurfaceTerm, removeSurfaceTerm, surfaceTerms } from './surfaceLight.node.js';
//   const remove = addSurfaceTerm(material, { id, key?, lux?, radiance?, filter? }, { photometry? });
//   remove();                                   // or removeSurfaceTerm(material, id)
//
// A term is functions of the surface, called once when the term is added; each returns TSL nodes. They receive
//   s.positionWorld  vec3 world position of the fragment (scene metres; map x = x, map y = -z)
//   s.normalWorld    vec3 unit world normal, as shaded (after normal maps and the back-face flip)
//   s.viewWorld      vec3 unit world vector from the fragment toward the eye
//   s.albedo         vec3 the diffuse colour (diffuseColor.rgb: map, vertex colours and colour; for a standard
//                    material the base colour, before metalness, as surfaceLight.js's slAlbedo)
// and return, in physical units (photometry.node.js scales them, so a term never multiplies by an exposure):
//   lux(s)       illuminance on the surface, lux (float or vec3 for a coloured light): it is reflected as
//                albedo x lux / pi x the light scale, the BRDF three uses for its own lights
//   radiance(s)  radiance leaving the surface toward the eye, cd/m^2 (float or vec3): anything not Lambertian, as
//                the retroreflected return of signs and the wet road's mirrored sky
//   filter(s, acc)  for a term that changes the light before it (the wet road): acc = { lux, radiance } are the sums
//                of the terms added before it; return { lux?, radiance?, diffuse? }: new sums, and a factor (float
//                or vec3) on three's own diffuse light (direct and indirect, already in buffer units)
// Terms run in the order added (adding an existing id replaces it in place), after three's lights and before fog,
// as surfaceLight.js's. The sums go to the material's direct diffuse light: albedo x lux / pi x scale +
// radiance x scale, where scale is photometry.node.js artificialScale (the exposure x cityFactor in the shipped look,
// LIGHTING_UNITS at the classic display), taken from `options.photometry` when the first term is added.
//
// Programs. three r187 keys a node program on the identity of its nodes, so a term's functions are called once per
// term object and the nodes they return are shared by every material the object is added to: pass one term object
// to all the materials that should share a program (as surfaceLight.js's callers pass one term), and a new object
// (or one closing over other uniforms) only where the program must differ. `key` is kept in the cache key for
// reading it (and for parity with surfaceLight.js); the node graphs decide.
//
// Worked example, an illuminance (a lamp's pool as a point source of I candela at P, no shadow):
//   const P = uniform(new Vector3(10, 9, -40)), I = uniform(20000);
//   addSurfaceTerm(road, { id: 'pool', key: 'v1', lux: ({ positionWorld, normalWorld }) => {
//     const v = P.sub(positionWorld), d2 = dot(v, v);
//     return I.mul(max(dot(normalWorld, v.normalize()), 0)).div(d2.max(0.25)).mul(vec3(1, 0.8, 0.55));   // lux
//   } });
//
// Worked example, a radiance (a retroreflective sign returning the visitor's headlamps, cd/m^2 toward the eye):
//   const E = uniform(30), RA = 250;   // lux on the sign from the lamps; coefficient of retroreflection, cd/(lx m^2)
//   addSurfaceTerm(sign, { id: 'retro', key: 'v1', radiance: ({ normalWorld, viewWorld }) =>
//     E.mul(RA).mul(max(dot(normalWorld, viewWorld), 0)) });
//
// And a filter (the wet road: three's diffuse light and the terms before it darkened, plus the mirrored sky):
//   addSurfaceTerm(road, { id: 'wet', key: 'v1', filter: ({ normalWorld, viewWorld }, acc) => {
//     const k = float(1).sub(cover.mul(0.6));
//     return { diffuse: k, lux: acc.lux.mul(k), radiance: acc.radiance.add(skyCdM2.mul(cover).mul(fresnel(dot(normalWorld, viewWorld)))) };
//   } });
//
// How it extends: an own `setupLightingModel` on the material wraps whatever model the material (or its class)
// returns; the wrapper's start() runs the model's lights and indirect light, then the terms. An own
// `customProgramCacheKey` chains the material's key with the terms. Both own properties are removed (or the
// material's own ones put back) with the last term. Only materials drawn with scene lights reach the lighting
// model, as with surfaceLight.js's lights_fragment_end.

import { positionWorld, normalWorld, cameraPosition, diffuseColor, vec3, property } from 'three/tsl';
import { photometryContext, artificialScale } from './photometry.node.js';

const state = new WeakMap(); // material -> { terms, ownModel, ownKey, scale }
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** The surface's inputs: global nodes, the same for every term and material. */
const surface = () => ({
  positionWorld,
  normalWorld,
  viewWorld: cameraPosition.sub(positionWorld).normalize(),
  albedo: diffuseColor.rgb,
});

const slLux = property('vec3', 'slLux');
const slRad = property('vec3', 'slRad');

const built = new WeakMap(); // term object -> its nodes, shared by every material it is added to

/** Build a term's nodes once per term object: { id, key, lux, radiance, filter: { lux, radiance, diffuse } | null }. */
function buildTerm(term) {
  const cached = built.get(term);
  if (cached) return cached;
  const s = surface();
  const out = { id: term.id, key: term.key || '', lux: null, radiance: null, filter: null, source: term };
  if (term.lux) out.lux = vec3(term.lux(s));
  if (term.radiance) out.radiance = vec3(term.radiance(s));
  if (term.filter) {
    const f = term.filter(s, { lux: slLux, radiance: slRad }) || {};
    out.filter = { lux: f.lux != null ? vec3(f.lux) : null, radiance: f.radiance != null ? vec3(f.radiance) : null, diffuse: f.diffuse ?? null };
  }
  built.set(term, out);
  return out;
}

const nodesOf = (t) => [t.lux, t.radiance, t.filter?.lux, t.filter?.radiance, t.filter?.diffuse].filter((n) => n && n.isNode);

function cacheKeyOf(terms) {
  return terms.map((t) => `${t.id}@${t.key}:${nodesOf(t).map((n) => n.getCacheKey(true)).join('.')}`).join(',');
}

/** The lighting model with the terms run after its own lights. */
function wrapModel(model, st) {
  const wrapped = Object.create(model);
  wrapped.start = function start(builder) {
    model.start.call(this, builder);
    const { reflectedLight } = builder.context;
    slLux.assign(vec3(0));
    slRad.assign(vec3(0));
    for (const t of st.terms) {
      if (t.lux) slLux.addAssign(t.lux);
      if (t.radiance) slRad.addAssign(t.radiance);
      if (t.filter) {
        const f = t.filter;
        if (f.diffuse != null) {
          reflectedLight.directDiffuse.mulAssign(f.diffuse);
          reflectedLight.indirectDiffuse.mulAssign(f.diffuse);
        }
        // both new sums are worked out from the old ones before either is written
        const nl = f.lux ? vec3().toVar() : null, nr = f.radiance ? vec3().toVar() : null;
        if (nl) nl.assign(f.lux);
        if (nr) nr.assign(f.radiance);
        if (nl) slLux.assign(nl);
        if (nr) slRad.assign(nr);
      }
    }
    reflectedLight.directDiffuse.addAssign(diffuseColor.rgb.mul(slLux).mul(1 / Math.PI).add(slRad).mul(st.scale));
  };
  return wrapped;
}

function install(material, photometry) {
  const st = {
    terms: [],
    ownModel: hasOwn(material, 'setupLightingModel') ? material.setupLightingModel : null,
    ownKey: hasOwn(material, 'customProgramCacheKey') ? material.customProgramCacheKey : null,
    scale: artificialScale(photometryContext(photometry)),
    key: '',
  };
  material.setupLightingModel = function surfaceLightModel(builder) {
    const base = (st.ownModel || Object.getPrototypeOf(this).setupLightingModel).call(this, builder);
    return base && st.terms.length ? wrapModel(base, st) : base;
  };
  material.customProgramCacheKey = function surfaceLightKey() {
    const prev = (st.ownKey || Object.getPrototypeOf(this).customProgramCacheKey).call(this);
    return `${prev}|sl:${st.key}`;
  };
  state.set(material, st);
  return st;
}

function uninstall(material, st) {
  if (st.ownModel) material.setupLightingModel = st.ownModel; else delete material.setupLightingModel;
  if (st.ownKey) material.customProgramCacheKey = st.ownKey; else delete material.customProgramCacheKey;
  state.delete(material);
}

/**
 * Add a light term to a node material (see the header). Adding the same id again replaces the term in place.
 * Returns a function that removes it.
 * @param {import('three/webgpu').NodeMaterial} material  a lit node material (Lambert, Phong, standard, physical)
 * @param {{ id: string, key?: string, lux?: Function, radiance?: Function, filter?: Function }} term
 * @param {{ photometry?: { display?: 'classic' | 'physical', nodes?: object } }} [options]  used when the material
 *   gets its first term
 */
export function addSurfaceTerm(material, term, { photometry } = {}) {
  if (!material?.isNodeMaterial) throw new Error('surfaceLight.node: a node material is required (surfaceLight.js is for the classic renderer)');
  if (!term?.id || !(term.lux || term.radiance || term.filter)) throw new Error('surfaceLight.node: a term { id, lux | radiance | filter } is required');
  const st = state.get(material) || install(material, photometry);
  const built = buildTerm(term);
  const i = st.terms.findIndex((t) => t.id === term.id);
  if (i >= 0) st.terms[i] = built; else st.terms.push(built);
  st.key = cacheKeyOf(st.terms);
  material.needsUpdate = true;
  return () => removeSurfaceTerm(material, term.id);
}

/** Take a term out; the last one out restores the material as it was. */
export function removeSurfaceTerm(material, id) {
  const st = state.get(material);
  if (!st) return;
  st.terms = st.terms.filter((t) => t.id !== id);
  st.key = cacheKeyOf(st.terms);
  if (!st.terms.length) uninstall(material, st);
  material.needsUpdate = true;
}

/** The term ids on a material, in order (for tests and stats). */
export const surfaceTerms = (material) => (state.get(material)?.terms || []).map((t) => t.id);
