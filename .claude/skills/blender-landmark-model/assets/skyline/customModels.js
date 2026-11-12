// skyline-integration: v6 (blender-landmark-model skill)
// (older tools test for the text "skyline-integration: v4" and replace files without it; v6 includes it here)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Buildings drawn from a glTF model instead of their extruded volumes. public/models/models.json lists them
// by city and building id:
//   { "lv": { "w135457469": { "url": "/models/strat.glb", "offset": [3.2, 0.8], "name": "Stratosphere Tower" } } }
// A model is in meters with its origin on the ground at the building's center: +x east, +y up, -z north.
// `offset` moves that origin from the footprint's center, in meters east and north.
// A building with a model is always drawn from it, also under the height cutoff (it then joins the blue,
// removable ones).
// The same file may also list extras and fountains (top-level "extras" and "fountains"); see attractions.js.
const MANIFEST = '/models/models.json';
// Faces whose material is named Led... (LedSkin, LedCanopy, Led_2; not Ledge) are animated LED surfaces.
const LED_MATERIAL = /^(Led(?![a-z])|LED(?![A-Za-z]))/;

async function listModels(cityId) {
  try {
    const r = await fetch(MANIFEST);
    // a dev server answers a missing file with the app's own page, so check that this really is JSON
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return {};
    const all = await r.json();
    return (all && all[cityId]) || {};
  } catch (err) {
    console.warn(`Could not read ${MANIFEST}; drawing every building from its footprint.`, err);
    return {};
  }
}

/**
 * Flatten a loaded glTF scene into loose triangles: positions, normals and one color per vertex.
 * A model may carry a `_GLOW` attribute, the light each vertex gives off at night (without one it stays dark),
 * and a `_WINDOWS` attribute, 0..1, where the night shader should draw lit windows. `led` is 1 on faces whose
 * material name starts with Led (animated LED surfaces), else 0.
 * Positions come out in world space, or with `frame` in that object's own space; `skip(object)` leaves out an
 * object and everything under it (a spinning extra flattens its rotor and each cabin separately).
 * @param {THREE.Object3D} root
 * @param {{frame?: THREE.Object3D, skip?: (o: THREE.Object3D) => boolean}} [options]
 * @returns {{pos: number[], nor: number[], col: number[], glow: number[], win: number[], led: number[]}}
 */
export function flatten(root, { frame = null, skip = null } = {}) {
  const out = { pos: [], nor: [], col: [], glow: [], win: [], led: [] };
  const p = new THREE.Vector3(), n = new THREE.Vector3(), normalMatrix = new THREE.Matrix3();
  const toFrame = new THREE.Matrix4(), matrix = new THREE.Matrix4();
  root.updateWorldMatrix(true, true);
  if (frame) toFrame.copy(frame.matrixWorld).invert();
  const visit = (o) => {
    if (o !== root && skip && skip(o)) return;
    if (o.isMesh) addMesh(o);
    for (const child of o.children) visit(child);
  };
  const addMesh = (o) => {
    const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const { position, normal, _glow: glow, _windows: win } = geo.attributes;
    const material = Array.isArray(o.material) ? o.material[0] : o.material;
    const c = material?.color || new THREE.Color(1, 1, 1);
    const led = LED_MATERIAL.test(material?.name || '') ? 1 : 0;
    if (frame) matrix.multiplyMatrices(toFrame, o.matrixWorld);
    else matrix.copy(o.matrixWorld);
    normalMatrix.getNormalMatrix(matrix);
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i).applyMatrix4(matrix);
      n.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      out.pos.push(p.x, p.y, p.z); out.nor.push(n.x, n.y, n.z); out.col.push(c.r, c.g, c.b);
      if (glow) out.glow.push(glow.getX(i), glow.getY(i), glow.getZ(i));
      else out.glow.push(0, 0, 0);
      out.win.push(win ? win.getX(i) : 0);
      out.led.push(led);
    }
  };
  visit(root);
  return out;
}

/** Load every model listed for a city. A model that fails to load is skipped, so its footprint is drawn instead. */
export async function loadCustomModels(cityId) {
  const loader = new GLTFLoader(), models = new Map();
  await Promise.all(Object.entries(await listModels(cityId)).map(async ([id, spec]) => {
    try {
      models.set(id, { ...flatten((await loader.loadAsync(spec.url)).scene), offset: spec.offset || [0, 0] });
    } catch (err) {
      console.warn(`Model for ${id} failed to load (${spec.url}); drawing its footprint instead.`, err);
    }
  }));
  return models;
}

/** Append a model to the output arrays, with its origin at `east`, `north` (map meters) and height `y`. */
export function placeModel(model, east, north, y, out) {
  const x0 = east + model.offset[0], z0 = -(north + model.offset[1]);
  for (let i = 0; i < model.pos.length; i += 3) out.pos.push(model.pos[i] + x0, model.pos[i + 1] + y, model.pos[i + 2] + z0);
  for (const v of model.nor) out.nor.push(v);
  for (const v of model.col) out.col.push(v);
  out.glow = out.glow || [];
  for (const v of model.glow) out.glow.push(v);
  out.win = out.win || [];
  for (const v of model.win) out.win.push(v);
  out.led = out.led || [];
  for (const v of model.led) out.led.push(v);
}
