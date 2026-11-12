// skyline-integration: v6 (blender-landmark-model skill)
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// namespace imports: an older night.js or customModels.js (without these exports) must not stop the app loading
import * as customModels from './customModels.js';
import * as nightModule from './night.js';
import { createFountain } from './fountain.js';

const { lightAtNight } = nightModule;
const clock = nightModule.clock || { value: 0 };
const flatten = customModels.flatten;

// Things that are not buildings in the app's data, listed in public/models/models.json next to the cities:
//   "extras":    { "lv": [{ "name": "High Roller", "url": "/models/lv/high_roller.glb", "east": 417.5, "north": 331.1,
//                           "rotation_deg": 90, "visible": "always" | "night", "blend": "opaque" | "additive",
//                           "spin": { "node": "Rotor", "period_s": 180, "direction": 1 } }] }
//   "fountains": { "lv": [{ "name": "Fountains of Bellagio", "url": "/models/lv/attractions/bellagio.json" }] }
// An extra stands on the terrain at `east`, `north` (meters from the city origin), turned `rotation_deg`
// counter-clockwise from east. It is static and not removable, lit at night like the models (its `_GLOW`
// colors; lit windows only where `_WINDOWS` says), and with `visible: "night"` shown only at night.
// `blend: "additive"` adds its night glow as light (a beam) instead of drawing a solid.
// `spin` (a wheel; see high_roller/SPIN_CONTRACT.md): the GLB node `spin.node` (default Rotor) turns about its
// own axle (its local -Z, the exporter's name for Blender's +Y) once every `period_s` seconds, and its
// `Cabin_*` children turn back about their own pivots so they stay level. Without `spin` the GLB draws at rest.
// Faces whose material is named Led... (on extras and on building models) animate (see night.js).
// The app renders on demand: frames are asked for only while a fountain show (up to 30 a second), an LED
// surface (15) or a turning wheel (12) is in view and near the camera, and never for a hidden tab.

const MANIFEST = '/models/models.json';
const SHOW_RANGE = 4000; // m: a fountain farther from the camera than this stops animating
const LED_RANGE = 3000; // m: likewise for LED surfaces
const SPIN_RANGE = 3000; // m: and for turning wheels
const FRAME_MS = 1000 / 30; // water moves fast
const LED_FRAME_MS = 1000 / 15; // LED bands drift slowly
const SPIN_FRAME_MS = 1000 / 12; // a slow wheel needs few frames

async function readManifest() {
  try {
    const r = await fetch(MANIFEST);
    if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) return {};
    return (await r.json()) || {};
  } catch (err) {
    console.warn(`Could not read ${MANIFEST}; no extras or fountains.`, err);
    return {};
  }
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Problems with one extras entry, or an empty list when it can be placed. */
function extraProblems(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['not an object'];
  if (typeof spec.name !== 'string' || !spec.name) problems.push('no name');
  if (typeof spec.url !== 'string' || !spec.url) problems.push('no url');
  if (!finite(spec.east) || !finite(spec.north)) problems.push('east and north must be numbers');
  if (spec.rotation_deg !== undefined && !finite(spec.rotation_deg)) problems.push('rotation_deg must be a number');
  if (spec.visible !== undefined && !['always', 'night'].includes(spec.visible)) problems.push('visible must be "always" or "night"');
  if (spec.blend !== undefined && !['opaque', 'additive'].includes(spec.blend)) problems.push('blend must be "opaque" or "additive"');
  const spin = spec.spin;
  if (spin !== undefined) {
    if (!spin || typeof spin !== 'object') problems.push('spin must be an object');
    else {
      if (spin.node !== undefined && (typeof spin.node !== 'string' || !spin.node)) problems.push('spin.node must be a node name');
      if (!finite(spin.period_s) || spin.period_s <= 0) problems.push('spin.period_s must be a positive number of seconds');
      if (spin.direction !== undefined && spin.direction !== 1 && spin.direction !== -1) problems.push('spin.direction must be 1 or -1');
      if (spin.axis !== undefined && !(Array.isArray(spin.axis) && spin.axis.length === 3 && spin.axis.every(finite)
        && spin.axis.some((v) => v !== 0))) problems.push('spin.axis must be three numbers, not all 0');
    }
  }
  return problems;
}

function partGeometry(model, additive) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(model.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(model.nor, 3));
  // an additive extra is light only: no surface color, so nothing but its glow is added to the picture
  geo.setAttribute('color', new THREE.Float32BufferAttribute(additive ? new Float32Array(model.col.length) : model.col, 3));
  geo.setAttribute('glow', new THREE.Float32BufferAttribute(model.glow, 3));
  geo.setAttribute('windows', new THREE.Float32BufferAttribute(model.win, 1));
  geo.setAttribute('led', new THREE.Float32BufferAttribute(model.led, 1));
  geo.computeBoundingSphere();
  return geo;
}

function partMesh(model, spec, material) {
  const additive = spec.blend === 'additive';
  const mesh = new THREE.Mesh(partGeometry(model, additive), material);
  mesh.castShadow = mesh.receiveShadow = !additive;
  return mesh;
}

function extraMaterial(spec) {
  const material = lightAtNight(new THREE.MeshLambertMaterial({ vertexColors: true }), { windows: false });
  if (spec.blend === 'additive') Object.assign(material, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  return material;
}

/** Stand an extra (a mesh, or a group for a wheel) on the terrain at its spot, turned as listed. */
function placeExtra(object, spec, groundY) {
  object.name = spec.name;
  object.position.set(spec.east, groundY(spec.east, spec.north), -spec.north);
  object.rotation.y = THREE.MathUtils.degToRad(spec.rotation_deg || 0);
  object.userData.extra = { ...spec, visible: spec.visible || 'always', blend: spec.blend || 'opaque' };
  object.updateMatrixWorld(true);
  return object;
}

const nodeName = (o) => o.userData.name || o.name; // GLTFLoader keeps the glTF node name in userData.name

function findNode(root, name) {
  let hit = null;
  root.traverse((o) => { if (!hit && o.userData.name === name) hit = o; });
  if (!hit) root.traverse((o) => { if (!hit && o.name === name) hit = o; });
  return hit;
}

/**
 * A wheel: the static parts, the rotor and each cabin as separate meshes, each in its own frame, so the rotor
 * can turn about its axle and the cabins back about their pivots. Null when the GLB has no such node.
 */
function spinningExtra(spec, scene) {
  const rotorNode = findNode(scene, spec.spin.node || 'Rotor');
  if (!rotorNode) return null;
  const isCabin = (o) => o.parent === rotorNode && /^Cabin_/.test(nodeName(o));
  const material = extraMaterial(spec);
  scene.updateWorldMatrix(true, true);
  const root = new THREE.Group();
  root.add(partMesh(flatten(scene, { skip: (o) => o === rotorNode }), spec, material));
  const rotor = new THREE.Object3D();
  rotorNode.matrixWorld.decompose(rotor.position, rotor.quaternion, rotor.scale);
  rotor.add(partMesh(flatten(rotorNode, { frame: rotorNode, skip: isCabin }), spec, material));
  const toRotor = rotorNode.matrixWorld.clone().invert();
  const cabins = rotorNode.children.filter(isCabin).map((node) => {
    const pivot = new THREE.Object3D();
    new THREE.Matrix4().multiplyMatrices(toRotor, node.matrixWorld).decompose(pivot.position, pivot.quaternion, pivot.scale);
    pivot.userData.rest = pivot.quaternion.clone();
    pivot.add(partMesh(flatten(node, { frame: node }), spec, material));
    rotor.add(pivot);
    return pivot;
  });
  root.add(rotor);
  const axis = new THREE.Vector3(...(spec.spin.axis || [0, 0, -1])).normalize();
  return { root, rotor, rest: rotor.quaternion.clone(), cabins, axis, node: spec.spin.node || 'Rotor',
    period: spec.spin.period_s, direction: spec.spin.direction === -1 ? -1 : 1, angle: 0, sphere: new THREE.Sphere() };
}

const turn = new THREE.Quaternion(), back = new THREE.Quaternion();
/** Rotor at `angle` about its axle; each cabin turned back by the same angle about its pivot, so it stays level. */
function setAngle(wheel, angle) {
  wheel.angle = angle;
  wheel.rotor.quaternion.copy(wheel.rest).multiply(turn.setFromAxisAngle(wheel.axis, angle));
  back.setFromAxisAngle(wheel.axis, -angle);
  for (const c of wheel.cabins) c.quaternion.copy(back).multiply(c.userData.rest);
}

/** A checkbox in Settings after Night (and the fountain one), kept like the app's own settings. */
function addCheckbox(settings, key, title, note) {
  const form = document.getElementById('settings');
  if (!form || form.elements[key]) return;
  const label = document.createElement('label');
  label.className = 'check';
  label.innerHTML = `<input type="checkbox" name="${key}" /><span></span>`;
  label.querySelector('span').append(title, Object.assign(document.createElement('small'), { textContent: note }));
  label.querySelector('input').checked = settings[key];
  const after = ['fountain', 'night'].map((k) => form.elements[k]).find((el) => el && el.closest);
  if (after) after.closest('label').after(label);
  else (form.querySelector('fieldset:last-of-type') || form).append(label);
}

const shown = (o) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
const countVerts = (o) => {
  let n = 0;
  o.traverse((m) => { if (m.isMesh && !m.isInstancedMesh) n += m.geometry.attributes.position.count; });
  return n;
};

/**
 * Add extras, fountain shows, turning wheels and LED animation to the scene. Call once, after the app is set
 * up; it loads in the background and returns at once. `tall` is the app's list of removable buildings (for LED
 * surfaces).
 */
export function initAttractions({ cityId, scene, camera, renderer, settings, invalidate, groundY, tall = [] }) {
  // older saved settings have no such keys: the show and the wheels are on by default
  if (typeof settings.fountain !== 'boolean') settings.fountain = true;
  if (typeof settings.wheel !== 'boolean') settings.wheel = true;
  const extras = [], parts = [], fountains = [], wheels = [], ledSpheres = new WeakMap();
  const state = { frozen: null, animating: false, last: 0, prev: null, wheelTime: 0, night: null, fountain: null, problems: [] };
  const t0 = performance.now();
  const group = new THREE.Group();
  group.name = 'attractions';
  scene.add(group);

  async function loadExtra(spec, loader) {
    const gltf = await loader.loadAsync(spec.url);
    let object = null;
    if (spec.spin) {
      const wheel = spinningExtra(spec, gltf.scene);
      if (wheel) {
        object = placeExtra(wheel.root, spec, groundY);
        wheel.sphere.copy(new THREE.Box3().setFromObject(object).getBoundingSphere(new THREE.Sphere()));
        wheel.sphere.radius *= 1.1; // the turning rotor sweeps a little beyond its rest pose
        wheels.push(wheel);
      } else {
        state.problems.push(`extra ${spec.name}: no node named ${spec.spin.node || 'Rotor'} in the GLB; drawn without turning`);
        console.warn(`Extra ${spec.name}: no node named ${spec.spin.node || 'Rotor'} in ${spec.url}; drawn without turning.`);
      }
    }
    if (!object) object = placeExtra(partMesh(flatten(gltf.scene), spec, extraMaterial(spec)), spec, groundY);
    extras.push(object);
    object.traverse((m) => { if (m.isMesh) parts.push(m); });
    group.add(object);
  }

  async function load() {
    if (typeof flatten !== 'function') throw new Error('src/customModels.js is older than v5; run skyline_tool.py upgrade');
    const manifest = await readManifest();
    const extraSpecs = (manifest.extras && manifest.extras[cityId]) || [];
    const showSpecs = (manifest.fountains && manifest.fountains[cityId]) || [];
    const loader = new GLTFLoader();
    await Promise.all([
      ...extraSpecs.map(async (spec) => {
        const problems = extraProblems(spec);
        if (problems.length) {
          state.problems.push(`extra ${JSON.stringify(spec && spec.name)}: ${problems.join('; ')}`);
          console.warn(`Skipping extra ${JSON.stringify(spec && spec.name)} in ${MANIFEST}: ${problems.join('; ')}`);
          return;
        }
        try {
          await loadExtra(spec, loader);
        } catch (err) {
          state.problems.push(`extra ${spec.name}: ${err && err.message}`);
          console.warn(`Extra ${spec.name} failed to load (${spec.url}).`, err);
        }
      }),
      ...showSpecs.map(async (spec) => {
        try {
          const r = await fetch(spec.url);
          if (!r.ok || !(r.headers.get('content-type') || '').includes('json')) throw new Error(`HTTP ${r.status}`);
          const mesh = createFountain({ ...(await r.json()), name: spec.name }, groundY);
          fountains.push(mesh);
          group.add(mesh);
        } catch (err) {
          state.problems.push(`fountain ${spec && spec.name}: ${err && err.message}`);
          console.warn(`Fountain ${spec && spec.name} failed to load (${spec && spec.url}).`, err);
        }
      }),
    ]);
    if (fountains.length) addCheckbox(settings, 'fountain', 'Fountain show', `${fountains.map((f) => f.name).join(', ')}, on a loop.`);
    if (wheels.length) {
      const minutes = (s) => (s >= 90 ? `${+(s / 60).toFixed(1)} minutes` : `${Math.round(s)} seconds`);
      addCheckbox(settings, 'wheel', 'Wheel turns', wheels.map((w) => `${w.root.name}: one turn every ${minutes(w.period)}`).join('; ') + '.');
    }
    turnWheels();
    state.night = state.fountain = null; // the objects just added have not been set yet
    applyVisibility();
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  }

  // night-only extras follow the Night setting, fountains the Fountain show one; true if anything changed
  function applyVisibility() {
    if (state.night === settings.night && state.fountain === settings.fountain) return false;
    state.night = settings.night;
    state.fountain = settings.fountain;
    for (const m of extras) m.visible = m.userData.extra.visible !== 'night' || settings.night;
    for (const f of fountains) f.visible = settings.fountain;
    return true;
  }

  function turnWheels() {
    for (const w of wheels) setAngle(w, w.direction * 2 * Math.PI * (state.wheelTime / w.period));
  }

  const frustum = new THREE.Frustum(), viewProjection = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const near = (s, range) => !!s && frustum.intersectsSphere(s) && s.distanceToPoint(camera.position) < range;

  // is this mesh's geometry an LED surface (cached per geometry) that is in view and close enough?
  function ledNear(object) {
    const geo = object.geometry;
    if (!ledSpheres.has(geo)) {
      const led = geo.getAttribute('led');
      const has = !!led && led.array.some((v) => v > 0);
      if (has && !geo.boundingSphere) geo.computeBoundingSphere();
      ledSpheres.set(geo, has);
    }
    return ledSpheres.get(geo) && shown(object) && near(sphere.copy(geo.boundingSphere).applyMatrix4(object.matrixWorld), LED_RANGE);
  }

  function tick(now) {
    requestAnimationFrame(tick);
    // the wheels' own clock runs only while they may turn; a long pause (a hidden tab) does not jump them
    const dt = state.prev === null ? 0 : Math.min(Math.max(now - state.prev, 0), 250) / 1000;
    state.prev = now;
    if (state.frozen === null && settings.wheel) state.wheelTime += dt;
    turnWheels();
    const changed = applyVisibility();
    if (changed) renderer.shadowMap.needsUpdate = true;
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    const show = settings.fountain && fountains.some((f) => near(f.boundingSphere, SHOW_RANGE));
    const led = parts.some(ledNear) || tall.some((t) => ledNear(t.mesh));
    const turning = settings.wheel && wheels.some((w) => shown(w.root) && near(w.sphere, SPIN_RANGE));
    state.animating = (show || led || turning) && state.frozen === null;
    clock.value = state.frozen ?? (now - t0) / 1000;
    const every = show ? FRAME_MS : led ? LED_FRAME_MS : SPIN_FRAME_MS;
    const due = state.animating && !document.hidden && now - state.last >= every - 2; // (- 2: whole 60 Hz ticks)
    if (changed || due) {
      state.last = now;
      invalidate();
    }
  }
  requestAnimationFrame(tick);

  const ready = load().catch((err) => {
    state.problems.push(String(err && err.message));
    console.warn('Extras and fountains failed to load.', err);
  });

  const describe = (o) => {
    const wheel = wheels.find((w) => w.root === o);
    return {
      name: o.name, kind: o.userData.fountain ? 'fountain' : 'extra', visible: o.visible,
      ...(o.userData.extra ? { url: o.userData.extra.url, verts: countVerts(o) } : {}),
      ...(o.userData.fountain ? { jets: o.userData.fountain.jets } : {}),
      ...(wheel ? { spin: { node: wheel.node, period_s: wheel.period, direction: wheel.direction, cabins: wheel.cabins.length,
        angle_deg: +((THREE.MathUtils.radToDeg(wheel.angle) % 360 + 360) % 360).toFixed(2) } } : {}),
    };
  };
  const api = {
    ready,
    extras,
    fountains,
    /** The extra or fountain with this name (exact, else the first whose name contains it), or null. */
    find(name) {
      applyVisibility();
      const all = [...extras, ...fountains], q = String(name).toLowerCase();
      return all.find((o) => o.name.toLowerCase() === q) || all.find((o) => o.name.toLowerCase().includes(q)) || null;
    },
    /** Hold the show, LED and wheel clocks at `seconds` (for screenshots), or run them again with null. */
    freeze(seconds) {
      state.frozen = seconds === null || seconds === undefined ? null : Number(seconds);
      if (state.frozen !== null) {
        clock.value = state.wheelTime = state.frozen;
        turnWheels();
      }
      invalidate();
    },
    animating: () => state.animating,
    summary: () => {
      applyVisibility();
      return { extras: extras.map(describe), fountains: fountains.map(describe), problems: [...state.problems] };
    },
  };
  if (window.__skyline) window.__skyline.attractions = api;
  return api;
}
