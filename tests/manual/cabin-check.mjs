// Loads the cabin GLBs with three.js's own GLTFLoader (in Node, no browser) and checks them against
// public/models/drive/cabin.json: named nodes, triangle counts, and that the JSON's numbers (eye, mirror and
// display rectangles, wheel pivot) match the geometry. Run from the repo root:
//   node tests/manual/cabin-check.mjs
import { readFileSync } from 'node:fs';
import { Box3, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const dir = new URL('../../public/models/drive/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('cabin.json', dir), 'utf8'));
const NODES = ['Cabin', 'Wheel', 'MirrorLeft', 'MirrorRight', 'MirrorCenter', 'Instruments', 'CenterScreen'];
const BUDGET = { 'cabin.glb': 40000, 'cabin-low.glb': 15000 };
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const v = (a) => new Vector3(...a);
const near = (a, b, tol = 0.002) => a.distanceTo(b) <= tol;

function load(file) {
  const buf = readFileSync(new URL(file, dir));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, '', resolve, reject));
}

const tris = (mesh) => (mesh.geometry.index ? mesh.geometry.index.count : mesh.geometry.attributes.position.count) / 3;

for (const file of ['cabin.glb', 'cabin-low.glb']) {
  const gltf = await load(file);
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  console.log(`\n${file}`);
  const byName = Object.fromEntries(NODES.map((n) => [n, scene.getObjectByName(n)]));
  for (const n of NODES) check(!!byName[n], `node ${n} present`);
  let total = 0;
  const counts = {};
  scene.traverse((o) => {
    if (o.isMesh) {
      total += tris(o);
      const top = NODES.find((n) => o === byName[n] || o.parent === byName[n]) || o.name;
      counts[top] = (counts[top] || 0) + tris(o);
    }
  });
  console.log('     triangles', counts);
  check(total <= BUDGET[file], `${total} triangles <= ${BUDGET[file]}`);
  const key = file === 'cabin.glb' ? 'high' : 'low';
  check(total === meta.triangles[key], `cabin.json triangles.${key} (${meta.triangles[key]}) matches`);

  const mats = new Set();
  scene.traverse((o) => o.isMesh && [].concat(o.material).forEach((m) => mats.add(m.name)));
  check([...mats].every((m) => meta.materials.includes(m)), `materials ${[...mats].join(', ')}`);
  check(![...mats].some((m) => /logo|badge|brand/i.test(m)), 'no brand-like material names');

  // flat faces: every vertex lies on the plane of the JSON's centre and normal, inside its rectangle
  const faces = { ...Object.fromEntries(Object.entries(meta.mirrors)), instruments: meta.instruments, centerScreen: meta.centerScreen };
  for (const [k, f] of Object.entries(faces)) {
    const obj = byName[f.node];
    if (!obj) continue;
    const box = new Box3().setFromObject(obj);
    const c = box.getCenter(new Vector3());
    const pos = [];
    obj.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) pos.push(new Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld));
    });
    const n = v(f.normal), r = v(f.right), u = v(f.up), c0 = v(f.center);
    const off = Math.max(...pos.map((p) => Math.abs(p.clone().sub(c0).dot(n))));
    const sx = Math.max(...pos.map((p) => Math.abs(p.clone().sub(c0).dot(r))));
    const sy = Math.max(...pos.map((p) => Math.abs(p.clone().sub(c0).dot(u))));
    check(near(c, c0, 0.003), `${k}: bbox centre ${c.toArray().map((x) => x.toFixed(3))} ~ json centre`);
    check(off < 1e-3, `${k}: flat on the json plane (max off ${off.toExponential(1)} m)`);
    check(Math.abs(2 * sx - f.width) < 2e-3 && Math.abs(2 * sy - f.height) < 2e-3,
      `${k}: ${(2 * sx).toFixed(3)} x ${(2 * sy).toFixed(3)} m ~ json ${f.width} x ${f.height}`);
    const eyeSide = v(meta.eye).sub(c0).dot(n) > 0;
    check(eyeSide, `${k}: normal faces the eye`);
    const mesh = obj.isMesh ? obj : obj.children.find((o) => o.isMesh);
    const uv = mesh?.geometry.attributes.uv;
    if (uv) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < uv.count; i++) { lo = Math.min(lo, uv.getX(i), uv.getY(i)); hi = Math.max(hi, uv.getX(i), uv.getY(i)); }
      check(lo > -1e-3 && hi < 1 + 1e-3, `${k}: UVs within 0..1 (${lo.toFixed(3)}..${hi.toFixed(3)})`);
    } else check(false, `${k}: has UVs`);
  }

  const wheel = byName.Wheel;
  check(near(wheel.getWorldPosition(new Vector3()), v(meta.wheel.pivot)), 'Wheel node origin = json pivot');
  check(wheel.quaternion.equals(wheel.quaternion.clone().identity()), 'Wheel node rotation is identity');
  const wbox = new Box3().setFromObject(wheel);
  const size = wbox.getSize(new Vector3());
  check(size.x > 0.38 && size.x < 0.42, `wheel spans ${size.x.toFixed(3)} m across (rim 0.37 m + section)`);
  check(Math.abs(v(meta.wheel.axis).length() - 1) < 1e-3 && meta.wheel.axis[2] > 0, 'wheel axis is a unit vector toward the driver');

  const all = new Box3().setFromObject(scene);
  check(all.min.y > 0.3 && all.max.y < 1.7, `cabin height range ${all.min.y.toFixed(2)}..${all.max.y.toFixed(2)} m`);
  check(meta.eye[0] === 0 && meta.eye[1] === 1.2 && meta.eye[2] === 0, 'eye at (0, 1.2, 0)');
}
console.log(failures ? `\n${failures} failures` : '\nall checks passed');
process.exit(failures ? 1 : 0);
