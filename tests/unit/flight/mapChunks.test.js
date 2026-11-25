// The map's near and far ground drawn in chunks while flying (plan 03, sections 7.14 and 9.1; F8.2): the same triangles,
// so the same picture, with the chunks outside the view left out by three's frustum culling, and the map's own index
// given back bit for bit on leaving.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { terrainMesh } from '../../../src/city/terrain.js';
import { planMapChunks, reorderQuads, restoreQuads, createMapGroundChunks } from '../../../src/flight/terrain/mapChunks.js';

/** A height field as src/city/terrain.js heightField makes one. */
function field({ nx, ny, step, x0, y0 }) {
  const raw = new Uint16Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) raw[j * nx + i] = 1000 + ((i * 7 + j * 13) % 50);
  return { nx, ny, step, x0, y0, scale: 1, raw };
}
const far = field({ nx: 61, ny: 47, step: 80, x0: -2400, y0: -1800 });
const near = field({ nx: 41, ny: 53, step: 12, x0: -240, y0: -300 });
const farMesh = terrainMesh(far, near, null, 900);
const nearMesh = terrainMesh(near, null, null, 900);

describe('reorderQuads and restoreQuads', () => {
  for (const [name, mesh, g] of [['far (with a hole)', farMesh, far], ['near', nearMesh, near]]) {
    it(`${name}: groups the quads by chunk and gives the index back bit for bit`, () => {
      const index = mesh.geometry.index.array;
      const original = index.slice();
      const ranges = reorderQuads(index, g.nx, 16);
      // the same triangles, chunk by chunk, each chunk's quads in their old order
      expect(index.length).toBe(original.length);
      expect(index).not.toEqual(original);
      expect([...index].sort((a, b) => a - b)).toEqual([...original].sort((a, b) => a - b));
      let total = 0;
      for (const r of ranges) {
        expect(r.start % 6).toBe(0);
        expect(r.count % 6).toBe(0);
        for (let k = r.start; k < r.start + r.count; k += 6) {
          const a = index[k], i = a % g.nx, j = Math.floor(a / g.nx);
          expect(Math.floor(i / 16)).toBe(r.ci);
          expect(Math.floor(j / 16)).toBe(r.cj);
          if (k > r.start) expect(a).toBeGreaterThan(index[k - 6]);
        }
        total += r.count;
      }
      expect(total).toBe(index.length);
      restoreQuads(index, g.nx);
      expect(index).toEqual(original);
    });
  }

  it('plans the chunk size so a grid is cut into about eight chunks a side', () => {
    expect(planMapChunks({ nx: 685, ny: 1051 })).toBe(132);
    expect(planMapChunks({ nx: 976, ny: 901 })).toBe(122);
    expect(planMapChunks({ nx: 10, ny: 10 })).toBe(32);
  });
});

describe('createMapGroundChunks', () => {
  it('draws the map mesh as chunks that share its buffers while shown, and gives everything back after', () => {
    const scene = new THREE.Scene();
    const mesh = terrainMesh(far, near, null, 900);
    mesh.material = new THREE.MeshBasicMaterial();
    scene.add(mesh);
    const geo = mesh.geometry, original = geo.index.array.slice(), version = geo.index.version;
    const chunks = createMapGroundChunks(mesh, { grid: far, cells: 16 });
    expect(chunks).not.toBeNull();
    scene.add(chunks.group);
    expect(chunks.group.visible).toBe(false);

    chunks.show(true);
    expect(mesh.visible).toBe(false);
    expect(chunks.group.visible).toBe(true);
    const parts = chunks.group.children;
    expect(parts.length).toBe(chunks.stats().chunks);
    let drawn = 0;
    for (const p of parts) {
      expect(p.geometry.index).toBe(geo.index);
      expect(p.geometry.attributes.position).toBe(geo.attributes.position);
      expect(p.geometry.attributes.normal).toBe(geo.attributes.normal);
      expect(p.geometry.attributes.uv).toBe(geo.attributes.uv);
      expect(p.material).toBe(mesh.material);
      expect(p.receiveShadow).toBe(mesh.receiveShadow);
      // each chunk's bounds hold every vertex it draws
      const pos = geo.attributes.position, v = new THREE.Vector3();
      for (let k = p.geometry.drawRange.start; k < p.geometry.drawRange.start + p.geometry.drawRange.count; k++) {
        v.fromBufferAttribute(pos, geo.index.array[k]);
        expect(p.geometry.boundingBox.containsPoint(v)).toBe(true);
        expect(p.geometry.boundingSphere.containsPoint(v)).toBe(true);
      }
      drawn += p.geometry.drawRange.count;
    }
    expect(drawn).toBe(geo.index.count);
    expect(geo.index.version).toBeGreaterThan(version);

    // the material is followed when the map swaps it while flying
    const swapped = new THREE.MeshBasicMaterial();
    mesh.material = swapped;
    chunks.update();
    for (const p of parts) expect(p.material).toBe(swapped);

    chunks.show(false);
    expect(mesh.visible).toBe(true);
    expect(chunks.group.visible).toBe(false);
    expect(geo.index.array).toEqual(original);
    chunks.dispose();
    expect(chunks.group.parent).toBeNull();
    expect(geo.index.array).toEqual(original);
  });

  it('draws the map mesh itself when most of the grid is in view, and the chunks when little is', () => {
    const mesh = terrainMesh(far, near, null, 900);
    mesh.material = new THREE.MeshBasicMaterial();
    const chunks = createMapGroundChunks(mesh, { grid: far, cells: 16 });
    chunks.show(true);
    // high above the grid's middle, looking straight down: all of it in view
    const top = new THREE.PerspectiveCamera(60, 1.6, 1, 1e6);
    top.position.set(0, 40000, 0);
    top.lookAt(0, 0, 0);
    top.updateMatrixWorld();
    chunks.update(top);
    expect(chunks.stats().whole).toBe(true);
    expect(mesh.visible).toBe(true);
    expect(chunks.group.visible).toBe(false);
    // low over one corner, looking away from the grid: little of it in view
    const low = new THREE.PerspectiveCamera(40, 1.6, 1, 1e6);
    low.position.set(-2300, 200, 1700);
    low.lookAt(-4000, 150, 3000);
    low.updateMatrixWorld();
    chunks.update(low);
    expect(chunks.stats().whole).toBe(false);
    expect(chunks.stats().inViewShare).toBeLessThan(0.6);
    expect(mesh.visible).toBe(false);
    expect(chunks.group.visible).toBe(true);
    chunks.show(false);
    expect(mesh.visible).toBe(true);
  });

  it('leaves a mesh it does not understand alone', () => {
    const odd = new THREE.Mesh(new THREE.PlaneGeometry(10, 10, 3, 3), new THREE.MeshBasicMaterial());
    // PlaneGeometry's quads are not in the map's order (a, a+1, a+nx | a+1, a+nx+1, a+nx with a increasing)
    expect(createMapGroundChunks(odd, { grid: { nx: 4, ny: 4 } })).toBeNull();
  });
});
