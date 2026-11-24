// Faces of one model that lie in one plane, face the same way and overlap, read from the GLB files (no browser).
// usage: node tools/stability/model-faces.mjs [--all] [--tolerance=0.01] [file.glb ...]
// Without files it reads every model in public/models/models.json, both cities, extras included. Lists the models
// with such faces, worst first, and for each the pairs of meshes, their materials and the plane. --all also counts
// pairs inside one mesh (one material, so not visible by day).
import fs from 'node:fs';
import path from 'node:path';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { coplanarOverlaps, modelTriangles } from '../../src/city/coplanar.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? Number(a.split('=')[1]) : dflt; };
const all = args.includes('--all'), tolerance = opt('tolerance', 0.01);
let files = args.filter((a) => !a.startsWith('--'));
if (!files.length) files = modelFiles();

export function modelFiles(root = 'public') {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'models/models.json'), 'utf8')), urls = new Set();
  const walk = (x) => { if (x && typeof x === 'object') { if (typeof x.url === 'string' && x.url.endsWith('.glb')) urls.add(x.url); for (const v of Object.values(x)) walk(v); } };
  walk(m);
  return [...urls].sort().map((u) => path.join(root, u));
}

const rows = [];
for (const f of files) {
  const buf = fs.readFileSync(f);
  const gltf = await new GLTFLoader().parseAsync(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  const { pos, part, meshes } = modelTriangles(gltf.scene);
  const pairs = coplanarOverlaps(pos, part, { tolerance, acrossOnly: !all });
  if (!pairs.length) continue;
  const groups = {};
  for (const p of pairs) {
    const [i, j] = [part[p.a], part[p.b]].sort((x, y) => x - y);
    const k = `${meshes[i].name}[${meshes[i].material}] ~ ${meshes[j].name}[${meshes[j].material}] n=${p.normal.map((x) => x.toFixed(2))} d=${p.d.toFixed(2)}`;
    groups[k] = (groups[k] || 0) + p.area;
  }
  rows.push({ f, area: pairs.reduce((s, p) => s + p.area, 0), groups });
}
rows.sort((a, b) => b.area - a.area);
for (const r of rows) {
  console.log(r.area.toFixed(1).padStart(9), 'm2 ', r.f);
  for (const [k, v] of Object.entries(r.groups).sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log('          ', v.toFixed(1).padStart(8), k);
}
console.log(`models read: ${files.length}, with coplanar faces: ${rows.length}`);
