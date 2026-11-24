// Find surfaces that lie in the same plane and face the same way, drawn by different meshes or twice by one mesh:
// the geometry behind the flicker survey.mjs counts. For each tall building it lists the overlapping coplanar
// triangle pairs by partner: itself (two of its own faces), another tall building, the merged mesh of low buildings,
// or anything else in the scene (extras, LED skins).
// usage: node tools/stability/coplanar.mjs <outDir> <baseUrl> <city> [id...]
// Without ids it lists every tall building with any overlap, worst first.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(process.cwd() + '/');
const { chromium } = require('@playwright/test');
const [out, base, city, ...ids] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=metal', '--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
await page.goto(`${base}/?city=${city}`, { timeout: 180000 });
await page.waitForFunction(() => window.__skyline && window.__skyline.attractions, null, { timeout: 180000 });
await page.evaluate(() => window.__skyline.attractions.ready);
const result = await page.evaluate((only) => {
  const s = window.__skyline, scene = s.scene;
  scene.updateMatrixWorld(true);
  const tallMeshes = new Map(s.tall.map((t) => [t.mesh, t.data.id]));
  const markers = new Set(s.tall.map((t) => t.marker));
  // the merged low mesh: the scene's direct child with vertex colours and no uv, largest
  let low = null;
  for (const o of scene.children) if (o.isMesh && o.geometry.attributes.color && !o.geometry.attributes.uv && !tallMeshes.has(o) && (!low || o.geometry.attributes.position.count > low.geometry.attributes.position.count)) low = o;
  const sources = [];
  scene.traverse((o) => {
    if (!o.isMesh || o.isLine || markers.has(o) || (o.parent && markers.has(o.parent))) return;
    if (o.geometry.attributes.uv && !tallMeshes.has(o)) return; // terrain and the like
    if (o.name === 'terrain apron' || o.material.side === 1) return; // the dome is drawn from inside
    const label = tallMeshes.has(o) ? tallMeshes.get(o) : o === low ? 'low' : `other:${o.name || o.type}`;
    sources.push({ o, label });
  });
  const tris = []; // [label, nx, ny, nz, d, ax, ay, az, bx, by, bz, cx, cy, cz]
  const v = (a, i, m) => { const e = m.elements, x = a.getX(i), y = a.getY(i), z = a.getZ(i); return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]; };
  for (const { o, label } of sources) {
    const g = o.geometry, p = g.attributes.position, idx = g.index, m = o.matrixWorld;
    const n = idx ? idx.count : p.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const ia = idx ? idx.getX(t) : t, ib = idx ? idx.getX(t + 1) : t + 1, ic = idx ? idx.getX(t + 2) : t + 2;
      const A = v(p, ia, m), B = v(p, ib, m), C = v(p, ic, m);
      const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      let nx = u[1] * w[2] - u[2] * w[1], ny = u[2] * w[0] - u[0] * w[2], nz = u[0] * w[1] - u[1] * w[0];
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-4) continue;
      nx /= l; ny /= l; nz /= l;
      tris.push({ label, n: [nx, ny, nz], d: nx * A[0] + ny * A[1] + nz * A[2], A, B, C, area: l / 2 });
    }
  }
  const key = (t, dd = 0) => `${Math.round(t.n[0] * 200)},${Math.round(t.n[1] * 200)},${Math.round(t.n[2] * 200)},${Math.round(t.d * 4) + dd}`;
  const bins = new Map();
  for (const t of tris) { const k = key(t); if (!bins.has(k)) bins.set(k, []); bins.get(k).push(t); }
  // 2D overlap of two coplanar triangles, each shrunk by 2 cm toward its centroid (edges that only touch do not count)
  const proj = (t, ax) => [t.A, t.B, t.C].map((P) => [P[ax[0]], P[ax[1]]]);
  const shrink = (pts) => { const c = [(pts[0][0] + pts[1][0] + pts[2][0]) / 3, (pts[0][1] + pts[1][1] + pts[2][1]) / 3]; return pts.map((p) => { const dx = p[0] - c[0], dy = p[1] - c[1], l = Math.hypot(dx, dy) || 1, k = Math.max(0, l - 0.02) / l; return [c[0] + dx * k, c[1] + dy * k]; }); };
  const sep = (P, Q) => {
    for (const S of [P, Q]) for (let i = 0; i < 3; i++) {
      const a = S[i], b = S[(i + 1) % 3], nx = b[1] - a[1], ny = a[0] - b[0];
      let pmin = Infinity, pmax = -Infinity, qmin = Infinity, qmax = -Infinity;
      for (const p of P) { const d = p[0] * nx + p[1] * ny; pmin = Math.min(pmin, d); pmax = Math.max(pmax, d); }
      for (const q of Q) { const d = q[0] * nx + q[1] * ny; qmin = Math.min(qmin, d); qmax = Math.max(qmax, d); }
      if (pmax <= qmin || qmax <= pmin) return true;
    }
    return false;
  };
  const byId = {};
  const want = only.length ? new Set(only) : null;
  for (const t of tris) {
    if (t.label === 'low' || t.label.startsWith('other:')) continue;
    if (want && !want.has(t.label)) continue;
    const big = Math.abs(t.n[0]) >= Math.abs(t.n[1]) && Math.abs(t.n[0]) >= Math.abs(t.n[2]) ? 0 : Math.abs(t.n[1]) >= Math.abs(t.n[2]) ? 1 : 2;
    const ax = [0, 1, 2].filter((a) => a !== big);
    const P = shrink(proj(t, ax));
    for (const dd of [-1, 0, 1]) {
      for (const q of bins.get(key(t, dd)) || []) {
        if (q === t || Math.abs(q.d - t.d) > 0.15) continue;
        if (q.label === t.label && q.A === t.A) continue;
        if (q.n[0] * t.n[0] + q.n[1] * t.n[1] + q.n[2] * t.n[2] < 0.9998) continue;
        if (sep(P, shrink(proj(q, ax)))) continue;
        const partner = q.label === t.label ? 'self' : q.label === 'low' || q.label.startsWith('other:') ? q.label : 'tall';
        const rec = (byId[t.label] ||= { id: t.label, self: 0, tall: 0, low: 0, other: 0, partners: {}, kinds: {} });
        const cls = partner.startsWith('other:') ? 'other' : partner;
        rec[cls] += t.area;
        if (partner === 'tall' || cls === 'other') rec.partners[q.label] = (rec.partners[q.label] || 0) + t.area;
        const kind = Math.abs(t.n[1]) > 0.99 ? 'roof' : Math.abs(t.n[1]) < 0.01 ? 'wall' : 'slope';
        rec.kinds[kind] = (rec.kinds[kind] || 0) + t.area;
      }
    }
  }
  const names = Object.fromEntries(s.tall.map((t) => [t.data.id, t.data.name || '']));
  return Object.values(byId).map((r) => ({ ...r, name: names[r.id], total: r.self + r.tall + r.low + r.other }))
    .sort((a, b) => b.total - a.total).map((r) => ({ ...r, self: Math.round(r.self), tall: Math.round(r.tall), low: Math.round(r.low), other: Math.round(r.other), total: Math.round(r.total), kinds: Object.fromEntries(Object.entries(r.kinds).map(([k, x]) => [k, Math.round(x)])), partners: Object.fromEntries(Object.entries(r.partners).map(([k, x]) => [k, Math.round(x)])) }));
}, ids);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(`${out}/coplanar-${city}.json`, JSON.stringify(result, null, 1));
console.log('id'.padEnd(14), 'm2: total  self  tall   low other  kinds  name');
for (const r of result.slice(0, 40)) console.log(r.id.padEnd(14), String(r.total).padStart(6), String(r.self).padStart(5), String(r.tall).padStart(5), String(r.low).padStart(5), String(r.other).padStart(5), JSON.stringify(r.kinds), r.name, JSON.stringify(r.partners));
console.log('buildings with any:', result.length);
await browser.close();
