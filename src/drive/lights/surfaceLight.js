// Light added to the drive's surfaces from outside their own code (plan 02, D5.4 and next D5.1, D5.2): one
// helper that extends a Lambert or standard material's shader with "terms" without disturbing what is there.
// Lamp pools add their term now; headlights and retroreflection add theirs the same way.
//
//   import { addSurfaceTerm } from './surfaceLight.js';
//   const remove = addSurfaceTerm(material, {
//     id: 'lampPools',                       // unique per term; part of the program cache key
//     uniforms: { uPool: { value: tex } },   // shared objects: updating .value reaches every material
//     head: 'uniform sampler2D uPool;',      // fragment declarations (functions, uniforms)
//     body: 'slE += texture(uPool, slWorld.xz * 0.001).rgb;',
//     key: 'v1',                             // change when the GLSL changes for the same id
//   });
//   remove();                                // takes the term out again (the material recompiles)
//
// In `body`, a term reads
//   vec3 slWorld    world position of the fragment (scene metres; map x = slWorld.x, map y = -slWorld.z)
//   vec3 slNormal   unit world normal (as shaded: after normal maps and double-side flips)
//   vec3 slView     unit world vector from the fragment toward the eye
//   vec3 slAlbedo   the diffuse colour (diffuseColor.rgb)
// and adds to
//   vec3 slE        irradiance on the surface, in scene units (lux x lighting.units.lux): it is reflected as
//                   albedo x E / pi, the same BRDF three uses for its own lights
//   vec3 slL        radiance leaving the surface toward the eye, scene units (cd/m^2 x lighting.units.nit):
//                   for anything that is not Lambertian (retroreflection, a wet sheen)
// Terms run in the order added, each in its own block, after three's lights and before fog. A term may define
// `defines` (merged into the material's) and per-vertex code is not needed: slWorld comes from one varying.
//
// How it extends: the material's own onBeforeCompile (the road's depth pull, night.js's windows) runs first, then
// this one patches the result; customProgramCacheKey chains the previous key with the term ids. Removing every
// term restores the material's original hooks.

const state = new WeakMap(); // material -> { terms: [], prevCompile, prevKey, ownKey }

const VERTEX_HEAD = 'varying vec3 slWorldPos;';
const VERTEX_BODY = `
{
  vec4 slW = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
  slW = batchingMatrix * slW;
  #endif
  #ifdef USE_INSTANCING
  slW = instanceMatrix * slW;
  #endif
  slWorldPos = ( modelMatrix * slW ).xyz;
}`;
const FRAGMENT_HEAD = 'varying vec3 slWorldPos;';

function fragmentBody(terms) {
  return `
{
  vec3 slWorld = slWorldPos;
  vec3 slNormal = normalize( inverseTransformDirection( normal, viewMatrix ) );
  vec3 slView = normalize( cameraPosition - slWorld );
  vec3 slAlbedo = diffuseColor.rgb;
  vec3 slE = vec3( 0.0 );
  vec3 slL = vec3( 0.0 );
${terms.map((t) => `  {\n${t.body}\n  }`).join('\n')}
  reflectedLight.directDiffuse += slE * BRDF_Lambert( slAlbedo ) + slL;
}`;
}

function insertAfter(src, anchor, text, what) {
  if (!src.includes(anchor)) throw new Error(`surfaceLight: the ${what} shader has no ${anchor}`);
  return src.replace(anchor, `${anchor}\n${text}`);
}

function install(material) {
  const prevCompile = material.onBeforeCompile;
  const ownKey = Object.prototype.hasOwnProperty.call(material, 'customProgramCacheKey') ? material.customProgramCacheKey : null;
  // three's default key is the hook's source, so read it from the hook in place before ours replaces it
  const prevKeyText = ownKey ? null : prevCompile.toString();
  const st = { terms: [], prevCompile, ownKey };
  material.onBeforeCompile = function surfaceLightCompile(shader, renderer) {
    prevCompile.call(this, shader, renderer);
    if (!st.terms.length) return;
    for (const t of st.terms) Object.assign(shader.uniforms, t.uniforms || {});
    shader.vertexShader = insertAfter(shader.vertexShader, '#include <common>', VERTEX_HEAD, 'vertex');
    shader.vertexShader = insertAfter(shader.vertexShader, '#include <project_vertex>', VERTEX_BODY, 'vertex');
    shader.fragmentShader = insertAfter(shader.fragmentShader, '#include <common>', `${FRAGMENT_HEAD}\n${st.terms.map((t) => t.head || '').join('\n')}`, 'fragment');
    shader.fragmentShader = insertAfter(shader.fragmentShader, '#include <lights_fragment_end>', fragmentBody(st.terms), 'fragment');
  };
  material.customProgramCacheKey = function surfaceLightKey() {
    const prev = ownKey ? ownKey.call(this) : prevKeyText;
    return `${prev}|sl:${st.terms.map((t) => `${t.id}@${t.key || ''}`).join(',')}`;
  };
  state.set(material, st);
  return st;
}

function uninstall(material, st) {
  material.onBeforeCompile = st.prevCompile;
  if (st.ownKey) material.customProgramCacheKey = st.ownKey;
  else delete material.customProgramCacheKey;
  state.delete(material);
}

/**
 * Add a light term to a material (see the header). Idempotent per (material, id): adding the same id again replaces
 * the term. Returns a function that removes it.
 * @param {import('three').Material} material  a Lambert, Phong or standard material (any with lights_fragment_end)
 * @param {{ id: string, body: string, head?: string, uniforms?: object, defines?: object, key?: string }} term
 */
export function addSurfaceTerm(material, term) {
  if (!material || !term?.id || typeof term.body !== 'string') throw new Error('surfaceLight: a material and a term { id, body } are required');
  const st = state.get(material) || install(material);
  const i = st.terms.findIndex((t) => t.id === term.id);
  if (i >= 0) st.terms[i] = term; else st.terms.push(term);
  if (term.defines) material.defines = { ...(material.defines || {}), ...term.defines };
  material.needsUpdate = true;
  return () => removeSurfaceTerm(material, term.id);
}

/** Take a term out; the last one out restores the material's own hooks. */
export function removeSurfaceTerm(material, id) {
  const st = state.get(material);
  if (!st) return;
  const term = st.terms.find((t) => t.id === id);
  st.terms = st.terms.filter((t) => t.id !== id);
  if (term?.defines && material.defines) for (const k of Object.keys(term.defines)) delete material.defines[k];
  if (!st.terms.length) uninstall(material, st);
  material.needsUpdate = true;
}

/** The term ids on a material, in order (for tests and stats). */
export const surfaceTerms = (material) => (state.get(material)?.terms || []).map((t) => t.id);
