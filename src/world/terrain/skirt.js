// A curtain hanging from the edge of a terrain grid mesh. Where a finer grid meets a coarser one, the
// coarser mesh is sunk 8 m under the finer one, which leaves a ledge with nothing in it: invisible from
// the air, a bright line across the ground from a car. The drive hangs one of these from the finer
// mesh's perimeter so the ledge is filled with ground. The map never shows them.

import * as THREE from 'three';

/**
 * Skirt arrays for a regular grid mesh laid out as terrainMesh() and buildWideMesh() lay theirs out:
 * post (i, j) is vertex j * nx + i, row 0 to the south, x east and scene z = -north.
 * Each perimeter post gives a top vertex (a copy of the post) and a bottom one `depth` metres below it,
 * with the post's normal and uv, so the skirt is lit and textured like the ground at its edge.
 * Triangles face outward, away from the grid.
 * @param {{ positions: ArrayLike<number>, normals?: ArrayLike<number>, uvs?: ArrayLike<number>,
 *           nx: number, ny: number, depth: number }} grid
 * @returns {{ positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array }}
 */
export function skirtArrays({ positions, normals, uvs, nx, ny, depth }) {
  // the perimeter counter-clockwise seen from above (east along the south edge first), corners once
  const ring = [];
  for (let i = 0; i < nx - 1; i++) ring.push(i);
  for (let j = 0; j < ny - 1; j++) ring.push(j * nx + nx - 1);
  for (let i = nx - 1; i > 0; i--) ring.push((ny - 1) * nx + i);
  for (let j = ny - 1; j > 0; j--) ring.push(j * nx);
  const P = ring.length;
  const pos = new Float32Array(P * 6), nor = new Float32Array(P * 6), uv = new Float32Array(P * 4);
  ring.forEach((v, k) => {
    for (let c = 0; c < 3; c++) {
      pos[k * 6 + c] = pos[k * 6 + 3 + c] = positions[v * 3 + c];
      nor[k * 6 + c] = nor[k * 6 + 3 + c] = normals ? normals[v * 3 + c] : c === 1 ? 1 : 0;
    }
    pos[k * 6 + 4] -= depth;
    for (let c = 0; c < 2; c++) uv[k * 4 + c] = uv[k * 4 + 2 + c] = uvs ? uvs[v * 2 + c] : 0;
  });
  const idx = new Uint32Array(P * 6);
  for (let k = 0; k < P; k++) {
    const a = 2 * k, b = 2 * ((k + 1) % P);
    idx.set([a + 1, b + 1, b, a + 1, b, a], k * 6);
  }
  return { positions: pos, normals: nor, uvs: uv, indices: idx };
}

/**
 * A skirt mesh for a grid mesh, sharing its material (so imagery and night glow follow it) and its transform.
 * @param {THREE.Mesh} ground  @param {{ nx: number, ny: number }} grid  @param {number} [depth]
 */
export function buildSkirt(ground, { nx, ny }, depth = 16) {
  const g = ground.geometry;
  const a = skirtArrays({
    positions: g.getAttribute('position').array, normals: g.getAttribute('normal')?.array, uvs: g.getAttribute('uv')?.array,
    nx, ny, depth,
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(a.normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(a.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(a.indices, 1));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, ground.material);
  mesh.position.copy(ground.position);
  mesh.quaternion.copy(ground.quaternion);
  mesh.name = `${ground.name || 'terrain'}-skirt`;
  return mesh;
}
