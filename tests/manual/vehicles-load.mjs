// Loads public/models/drive/vehicles.glb with three.js's GLTFLoader in Node and checks what the traffic
// renderer relies on: twelve nodes, one material each, COLOR_0 -> `color`, the paint mask -> `_paint` (0 or 1,
// paint white in `color`), and that an InstancedMesh with per-instance colours paints only the paint.
//   node tests/manual/vehicles-load.mjs
import { readFileSync } from 'node:fs';
import { Color, InstancedMesh, Matrix4 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const root = new URL('../../public/models/drive/', import.meta.url);
const sidecar = JSON.parse(readFileSync(new URL('vehicles.json', root), 'utf8'));
const buf = readFileSync(new URL('vehicles.glb', root));
const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(ok ? 'ok  ' : 'FAIL', msg); };
const meshes = {};
gltf.scene.traverse((o) => { if (o.isMesh) meshes[o.name] = o; });

for (const [body, spec] of Object.entries(sidecar.bodies)) {
  for (const lod of ['lod0', 'lod1']) {
    const m = meshes[`${body}_${lod}`];
    check(!!m, `${body}_${lod} present`);
    if (!m) continue;
    const g = m.geometry;
    const col = g.getAttribute('color');
    const paint = g.getAttribute(sidecar.paint.three);
    check(!Array.isArray(m.material) && m.material.vertexColors === true, `${m.name}: one material, vertexColors on`);
    check(!!col && !!paint && paint.count === col.count, `${m.name}: color and ${sidecar.paint.three} attributes (${col?.itemSize}x${col?.array.constructor.name}, ${paint?.array.constructor.name})`);
    let painted = 0, bad = 0, notWhite = 0;
    for (let i = 0; i < paint.count; i++) {
      const p = paint.getX(i);
      if (p !== 0 && p !== 1) bad++;
      if (p === 1) {
        painted++;
        if (col.getX(i) < 0.99 || col.getY(i) < 0.99 || col.getZ(i) < 0.99) notWhite++;
      }
    }
    check(bad === 0 && notWhite === 0 && painted > 0 && painted < paint.count,
      `${m.name}: ${painted}/${paint.count} vertices paint, all white, mask only 0/1`);
    check(g.index.count / 3 === spec.triangles[lod], `${m.name}: ${g.index.count / 3} triangles = sidecar`);

    // one InstancedMesh per body and level, per-instance colour, and the paint rule applied on the CPU
    const inst = new InstancedMesh(g, m.material, 3);
    const colours = [new Color(0.6, 0.02, 0.02), new Color(0.02, 0.05, 0.4), new Color(0.9, 0.9, 0.9)];
    colours.forEach((c, k) => { inst.setMatrixAt(k, new Matrix4().makeTranslation(k * 4, 0, 0)); inst.setColorAt(k, c); });
    const c = new Color();
    inst.getColorAt(1, c);
    const iPaint = Array.from({ length: paint.count }, (_, i) => i).find((i) => paint.getX(i) === 1);
    const iOther = Array.from({ length: paint.count }, (_, i) => i).find((i) => paint.getX(i) === 0);
    const shade = (i) => [col.getX(i), col.getY(i), col.getZ(i)].map((v, a) => v * (1 + (c.toArray()[a] - 1) * paint.getX(i)));
    const sp = shade(iPaint), so = shade(iOther);
    check(Math.abs(sp[2] - 0.4) < 1e-6 && so[0] === col.getX(iOther),
      `${m.name}: instance colour reaches paint (${sp.map((v) => v.toFixed(2))}) and leaves the rest (${so.map((v) => v.toFixed(3))})`);
  }
}
console.log(failures ? `${failures} failures` : 'all checks passed');
process.exit(failures ? 1 : 0);
