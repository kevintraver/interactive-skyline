// The ground: two height grids (a coarse far one with a hole where the fine near one sits), draped with the
// aerial photos and lowered onto the curved Earth.
import * as THREE from 'three';
import { curveDrop } from '../core/earth.js';

const lerp = THREE.MathUtils.lerp;

export function heightField(buf, g) {
  const raw = new Uint16Array(buf);
  const at = (i, j) => raw[j * g.nx + i] * g.scale;
  return {
    ...g, raw, at,
    sample(x, y) {
      const fx = THREE.MathUtils.clamp((x - g.x0) / g.step, 0, g.nx - 1.001);
      const fy = THREE.MathUtils.clamp((y - g.y0) / g.step, 0, g.ny - 1.001);
      const i = Math.floor(fx), j = Math.floor(fy), ax = fx - i, ay = fy - j;
      return lerp(lerp(at(i, j), at(i + 1, j), ax), lerp(at(i, j + 1), at(i + 1, j + 1), ax), ay);
    },
    contains(x, y, inset = 0) {
      return x > g.x0 + inset && x < g.x0 + (g.nx - 1) * g.step - inset
        && y > g.y0 + inset && y < g.y0 + (g.ny - 1) * g.step - inset;
    },
  };
}

export function terrainMesh(hf, hole, map, BASE) {
  const { nx, ny, step, x0, y0, scale, raw } = hf;
  const pos = new Float32Array(nx * ny * 3), nor = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
  // the fine grid's footprint, as index ranges on this grid
  const inside = (v, lo, hi, inset) => v > lo + inset && v < hi - inset;
  const hx = hole && [hole.x0, hole.x0 + (hole.nx - 1) * hole.step], hy = hole && [hole.y0, hole.y0 + (hole.ny - 1) * hole.step];
  const inX = new Uint8Array(nx), inY = new Uint8Array(ny), cutX = new Uint8Array(nx), cutY = new Uint8Array(ny);
  if (hole) {
    for (let i = 0; i < nx; i++) { const x = x0 + i * step; inX[i] = inside(x, ...hx, 0); cutX[i] = inside(x, ...hx, step) && inside(x + step, ...hx, step); }
    for (let j = 0; j < ny; j++) { const y = y0 + j * step; inY[j] = inside(y, ...hy, 0); cutY[j] = inside(y, ...hy, step) && inside(y + step, ...hy, step); }
  }
  const half = 1 / (2 * step);
  for (let j = 0; j < ny; j++) {
    const row = j * nx, up = Math.min(j + 1, ny - 1) * nx, dn = Math.max(j - 1, 0) * nx, y = y0 + j * step, v = j / (ny - 1);
    for (let i = 0; i < nx; i++) {
      const k = (row + i) * 3, x = x0 + i * step;
      // inside the fine grid's footprint the coarse grid sits just underneath it
      const sink = inX[i] && inY[j] ? 8 : 0;
      pos[k] = x; pos[k + 1] = raw[row + i] * scale - BASE - curveDrop(x, y) - sink; pos[k + 2] = -y;
      const dx = (raw[row + Math.min(i + 1, nx - 1)] * scale - raw[row + Math.max(i - 1, 0)] * scale) * half;
      const dy = (raw[up + i] * scale - raw[dn + i] * scale) * half;
      const l = Math.hypot(dx, 1, dy);
      nor[k] = -dx / l; nor[k + 1] = 1 / l; nor[k + 2] = dy / l;
      uv[(row + i) * 2] = i / (nx - 1); uv[(row + i) * 2 + 1] = v;
    }
  }
  const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let n = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (cutX[i] && cutY[j]) continue;
      const a = j * nx + i, b = a + 1, d = a + nx, e = d + 1;
      idx[n++] = a; idx[n++] = b; idx[n++] = d; idx[n++] = b; idx[n++] = e; idx[n++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx.slice(0, n), 1));
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map }));
  mesh.receiveShadow = !hole;
  return mesh;
}

/** Ground height in world units at map position (x east, y north): fine grid where it reaches, else the coarse one. */
export const makeGroundY = (near, far, BASE) => (x, y) => (near.contains(x, y) ? near.sample(x, y) : far.sample(x, y)) - BASE - curveDrop(x, y);

/** The highest point of the fine grid within `radius` meters of p. */
export function summit(near, p, radius = 120) {
  let best = { ...p, h: -Infinity };
  for (let dx = -radius; dx <= radius; dx += 10) {
    for (let dy = -radius; dy <= radius; dy += 10) {
      const h = near.sample(p.x + dx, p.y + dy);
      if (h > best.h) best = { x: p.x + dx, y: p.y + dy, h };
    }
  }
  return best;
}

/** Build both ground meshes once the downloads are in, and add them to the scene. */
export async function loadTerrain({ scene, renderer, base }, terrainData, mapsPending) {
  const { meta: terrainMeta, far: farBuf, near: nearBuf } = terrainData;
  const near = heightField(nearBuf, terrainMeta.grids.near);
  const far = heightField(farBuf, terrainMeta.grids.far);
  const [farMap, nearMap] = (await Promise.all(mapsPending)).map((bitmap) => {
    const t = new THREE.Texture(bitmap);
    t.flipY = false;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    t.needsUpdate = true;
    return t;
  });
  const terrain = [{ mesh: terrainMesh(far, near, farMap, base), map: farMap }, { mesh: terrainMesh(near, null, nearMap, base), map: nearMap }];
  scene.add(terrain[0].mesh, terrain[1].mesh);
  return { near, far, terrain, groundY: makeGroundY(near, far, base) };
}
