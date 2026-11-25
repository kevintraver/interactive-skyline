// The modelled airframe in the scene (plan 03, section 7.8; F3.4, F3.8): public/models/aircraft/airframe.glb, its
// named parts moved each frame from an AircraftState by rig.js, its wing bent in the vertex stage, and its skin and
// lamps lit by its own lights (lightsDraw.js). Everything is set from (state, presentation time): nothing integrates.
//
// The GLB's frame is the body frame of section 5.5 (nose -Z, right wing +X, up +Y, origin at the main-gear contact
// point), every node's origin on its pivot with no rest rotation, so a pose is position = rest + t and
// quaternion = (axis, r). The root turns nose-down about the main wheels by rig.groundPitchDeg once the nose is down on
// the runway (rig.js groundPitchCorrection): the track gives the body level there, the model sits a little nose-down on
// its gear.
//
// Flex (7.8): the wing, and everything it carries (flaps, slats, spoilers, aileron, nacelle), bends by
// w(eta) = tip eta^2 (3 - eta) / 2 along the span, eta measured in body axes. Each mesh knows its own body-from-local
// matrix through a per-object uniform, so a flap turned 30 degrees still bends with the wing it hangs on.

import { FrontSide, Group, Matrix4, Quaternion, Vector3 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { uniform, positionLocal, vec3, vec4, float, clamp, abs, select, materialColor } from 'three/tsl';
import { rigPoses, flexTip, groundPitchCorrection } from './rig.js';
import { lampTable, lightBits, lampLevels, GROUPS } from './lights.js';
import { createLampUniforms, setLampUniforms, skinLightNode, createLampPoints, decodeBaked } from './lightsDraw.js';

export { decodeBaked };

/** Where the app serves the model and its rig (public/ at the site's root, as the city's models are). */
export const AIRFRAME_URL = '/models/aircraft/airframe.glb';
export const RIG_URL = '/models/aircraft/rig.json';

const DEG = Math.PI / 180;
const X = new Vector3(1, 0, 0);

/** Body-from-local and local-from-body matrices of the object being drawn, relative to `root`. */
function bodyMatrices(root) {
  const inv = new Matrix4();
  const toBody = uniform(new Matrix4()).onObjectUpdate(({ object }, self) => {
    inv.copy(root.matrixWorld).invert();
    return self.value.multiplyMatrices(inv, object.matrixWorld);
  });
  const toLocal = uniform(new Matrix4()).onObjectUpdate(({ object }, self) => {
    inv.copy(root.matrixWorld).invert();
    return self.value.multiplyMatrices(inv, object.matrixWorld).invert();
  });
  return { toBody, toLocal };
}

/**
 * The airframe from a loaded glTF scene: { root, parts, rest, materials, triangles, drawCalls, flex, lampUniforms,
 * lamps, update(state, o), dispose() }.
 * @param {import('three').Object3D} scene  GLTFLoader's scene of airframe.glb
 * @param {object} rig  rig.json
 * @param {{ nodes: { emissive: Function, pointSource: Function }, lampPoints?: boolean }} o  the environment's nodes
 *   (app.env.nodes, or src/env/nodes.js createEnvNodes for a harness)
 */
export function buildAirframeModel(scene, rig, { nodes, lampPoints = true }) {
  const airframe = scene.getObjectByName('Airframe') ?? scene;
  const root = new Group();
  root.name = 'airframe-model';
  root.add(airframe);

  /** @type {Map<string, import('three').Object3D>} */
  const parts = new Map();
  airframe.traverse((o) => { if (o.name && !parts.has(o.name)) parts.set(o.name, o); });
  const rest = new Map();
  for (const p of rig.parts) {
    const o = parts.get(p.node);
    if (!o) throw new Error(`airframe: node ${p.node} of rig.json is missing from the model`);
    rest.set(p.node, o.position.clone());
  }
  const proxy = parts.get('ShadowProxy');
  if (proxy) proxy.visible = false; // for the shadow pass of F3.9; never drawn in colour

  const flexSides = new Set(Object.values(rig.flex.nodes).flat());
  const inFlex = (o) => { for (let p = o; p; p = p.parent) if (flexSides.has(p.name)) return true; return false; };

  const lamps = lampTable(rig);
  const lampUniforms = createLampUniforms();
  const tipL = uniform(0), tipR = uniform(0);
  const { toBody, toLocal } = bodyMatrices(root);
  const bodyPosition = toBody.mul(vec4(positionLocal, 1)).xyz;
  const { rootY, tipY } = rig.flex;
  const eta = clamp(abs(bodyPosition.x).sub(rootY).div(tipY - rootY), 0, 1);
  const bend = eta.mul(eta).mul(float(3).sub(eta)).div(2).mul(select(bodyPosition.x.lessThan(0), tipL, tipR));
  const flexed = positionLocal.add(toLocal.mul(vec4(0, bend, 0, 0)).xyz);

  /** One node material per source material and role (flexing or not). */
  const made = new Map();
  const materialFor = (src, flex) => {
    const key = `${src.uuid}:${flex}`;
    if (made.has(key)) return made.get(key);
    const m = new MeshStandardNodeMaterial({
      name: `${src.name}${flex ? '-wing' : ''}`, color: src.color, roughness: src.roughness ?? 0.5, metalness: src.metalness ?? 0,
      // front faces only, whatever the file says (Blender exports its materials double-sided): from the cabin the
      // eye is inside the fuselage, and its inner faces must not hide the view
      side: FrontSide,
    });
    m.emissiveNode = skinLightNode({ nodes, uniforms: lampUniforms, bodyPosition, albedo: materialColor, bake: rig.lightBake });
    if (flex) m.positionNode = flexed;
    made.set(key, m);
    return m;
  };

  let triangles = 0, drawCalls = 0;
  const sourceMaterials = new Set();
  airframe.traverse((o) => {
    if (!o.isMesh) return;
    const flex = inFlex(o);
    const swap = (s) => { sourceMaterials.add(s); return materialFor(s, flex); };
    o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    o.castShadow = true;
    o.receiveShadow = true;
    let hidden = false;
    for (let p = o; p; p = p.parent) if (p.visible === false) hidden = true;
    if (hidden) return;
    triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.getAttribute('position').count) / 3;
    drawCalls++;
  });
  for (const s of sourceMaterials) s.dispose();

  const points = lampPoints ? createLampPoints(lamps, { nodes }) : null;
  if (points) root.add(points.mesh);
  const levels = new Float32Array(GROUPS.length);
  const poses = new Map();
  const axes = new Map(rig.parts.map((p) => [p.node, new Vector3(...p.axis)]));
  const _q = new Quaternion();

  const model = {
    root, parts, rest, triangles, drawCalls, lamps, lampUniforms,
    materials: [...made.values()],
    flex: { get tipL() { return tipL.value; }, get tipR() { return tipR.value; }, rootY, tipY },
    /** The lamp group levels last set, GROUPS order. */
    levels,
    /**
     * Pose the airframe for a state at presentation time `wallS`.
     * @param {import('../types.d.ts').AircraftState | object} state
     * @param {{ wallS?: number, reducedMotion?: boolean, flex?: boolean, shake?: boolean, hasLightsChannel?: boolean,
     *   night?: boolean, groundPitch?: boolean }} [o]  flex: false holds the wing at its ground shape; shake: false (the
     *   Low preset) keeps the static bend without the vibration; groundPitch: false when the caller has already turned
     *   the state's attitude by rig.js groundPitchCorrection (so the cabin and the camera sit nose-down with it)
     */
    update(state, { wallS = 0, reducedMotion = false, flex = true, shake = true, hasLightsChannel = false, night = false, groundPitch = true } = {}) {
      rigPoses(rig, state, poses);
      for (const [name, pose] of poses) {
        const o = parts.get(name);
        o.position.copy(rest.get(name));
        o.position.x += pose.t[0]; o.position.y += pose.t[1]; o.position.z += pose.t[2];
        o.quaternion.setFromAxisAngle(axes.get(name), pose.r * DEG);
      }
      root.quaternion.copy(_q.setFromAxisAngle(X, groundPitch ? groundPitchCorrection(state, rig) : 0));
      tipL.value = flex ? flexTip(state, rig, wallS, { reducedMotion, shake, side: -1 }) : 0;
      tipR.value = flex ? flexTip(state, rig, wallS, { reducedMotion, shake, side: 1 }) : 0;
      const bits = lightBits(state, { hasChannel: hasLightsChannel, night });
      if (points) levels.set(points.update(bits, wallS, { reducedMotion }));
      else lampLevels(bits, wallS, { reducedMotion }, levels);
      setLampUniforms(lampUniforms, levels, rig.lightBake);
      return model;
    },
    dispose() {
      airframe.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      for (const m of made.values()) m.dispose();
      points?.dispose();
    },
  };
  return model;
}

/**
 * Load airframe.glb and rig.json and build the model.
 * @param {{ url?: string, rigUrl?: string, rig?: object, nodes: object, loader?: { loadAsync(url: string): Promise<{ scene: import('three').Object3D }> },
 *   fetch?: typeof fetch, lampPoints?: boolean }} o  loader: a GLTFLoader (the caller's, so the main bundle does not
 *   import it until the flight needs it)
 */
export async function loadAirframeModel({ url = AIRFRAME_URL, rigUrl = RIG_URL, rig = null, nodes, loader = null,
  fetch: get = globalThis.fetch, lampPoints = true }) {
  const gltfLoader = loader ?? new (await import('three/addons/loaders/GLTFLoader.js')).GLTFLoader();
  const [gltf, rigData] = await Promise.all([gltfLoader.loadAsync(url), rig ? rig : get(rigUrl).then((r) => {
    if (!r.ok) throw new Error(`airframe: ${rigUrl} ${r.status}`);
    return r.json();
  })]);
  return buildAirframeModel(gltf.scene, rigData, { nodes, lampPoints });
}
