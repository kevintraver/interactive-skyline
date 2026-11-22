// The city's buildings, split at the height cutoff: one mesh per removable tower (with its ground marker), one
// merged mesh for everything else.
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker';
import { placeModel } from '../customModels.js';
import { lightAtNight } from '../night.js';
import { ring, extrude, toGeometry, fresh } from './extrude.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// Removable towers wear their own color so they read at a glance against the gray city.
export const REMOVABLE = new THREE.Color(0x6fb0ea);
export const GRAY = new THREE.Color().setRGB(0.80, 0.775, 0.74);

/**
 * Set up the building meshes' shared materials and groups. `build()` (re)splits the city at the current cutoff;
 * `tall` is filled in place, tallest first: { data, mesh, marker, row, offset }.
 */
export function createBuildings({ scene, settings, base: BASE }, model, customModels) {
  const lowMat = lightAtNight(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const tall = []; // removable buildings, tallest first: { data, mesh, marker, row, offset }
  let low = null; // every other building, merged into one mesh
  const tallGroup = new THREE.Group();
  const markerGroup = new THREE.Group();
  scene.add(tallGroup, markerGroup);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x16324d, transparent: true, opacity: 0.7 });
  const outlineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });

  /** Flat footprint on the ground where a tower really stands, shown once it is hidden or moved away. */
  function groundMarker(b) {
    const y = b.ground - BASE + 1.2, fill = [], line = [];
    // only what touches the ground: a pod or an upper setback is not part of the footprint
    const grounded = b.v.filter((v) => v.b <= b.ground + 1);
    for (const v of grounded.length ? grounded : b.v) {
      const outer = ring(v.o), holes = v.h.map(ring), all = [outer, ...holes].flat();
      for (const tri of THREE.ShapeUtils.triangulateShape(outer, holes)) for (const i of tri) fill.push(all[i].x, y, -all[i].y);
      for (const r of [outer, ...holes]) {
        for (let i = 0; i < r.length; i++) {
          const p = r[i], q = r[(i + 1) % r.length];
          line.push(p.x, y + 0.3, -p.y, q.x, y + 0.3, -q.y);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(fill, 3));
    const marker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: REMOVABLE, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false, fog: false,
    }));
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(line, 3));
    marker.add(new THREE.LineSegments(lineGeo, outlineMat));
    marker.visible = false;
    return marker;
  }

  function disposeGeometry(obj) {
    obj.traverse((o) => { if (o.geometry) { o.geometry.disposeBoundsTree(); o.geometry.dispose(); } });
  }

  /** Split the city at the height cutoff: one mesh per removable tower, one merged mesh for the rest. */
  function buildCity() {
    const wasHidden = new Set(tall.filter((t) => !t.mesh.visible).map((t) => t.data.id));
    const wasMoved = new Map(tall.map((t) => [t.data.id, t.offset]));
    for (const t of tall) {
      disposeGeometry(t.mesh); t.mesh.material.dispose();
      disposeGeometry(t.marker); t.marker.material.dispose();
    }
    tallGroup.clear();
    markerGroup.clear();
    if (low) { scene.remove(low); disposeGeometry(low); }
    tall.length = 0;

    const lowOut = fresh(1 << 20);
    for (const b of model.buildings) {
      if (b.h >= settings.cutoff || customModels.has(b.id)) {
        const custom = customModels.get(b.id);
        const out = custom ? placeModel(custom, b.c[0], b.c[1], b.ground - BASE) : fresh();
        if (!custom) for (const v of b.v) extrude(v, out, [1, 1, 1], BASE);
        const geo = toGeometry(out);
        geo.computeBoundsTree();
        // a little self-light keeps the shaded faces blue instead of near-black
        const mesh = new THREE.Mesh(geo, lightAtNight(new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x2a5f96 }), { windows: !custom }));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.visible = !wasHidden.has(b.id);
        mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), edgeMat));
        const marker = groundMarker(b);
        // offset: how far the user has dragged it from where it really stands
        mesh.userData.entry = marker.userData.entry = { data: b, mesh, marker, row: null, offset: wasMoved.get(b.id) || new THREE.Vector3() };
        tall.push(mesh.userData.entry);
        tallGroup.add(mesh);
        markerGroup.add(marker);
      } else {
        // a little per-building variation so blocks of houses read as separate roofs
        const n = Math.sin(b.c[0] * 12.9898 + b.c[1] * 78.233) * 43758.5453;
        const k = 0.93 + 0.07 * (n - Math.floor(n));
        for (const v of b.v) extrude(v, lowOut, [GRAY.r * k, GRAY.g * k, GRAY.b * k], BASE);
      }
    }
    const lowGeo = toGeometry(lowOut);
    low = new THREE.Mesh(lowGeo, lowMat);
    low.castShadow = low.receiveShadow = true;
    scene.add(low);
    indexLow(low);
  }

  const bvhWorker = new GenerateMeshBVHWorker();
  let indexing = Promise.resolve();
  /**
   * Build the merged mesh's ray-test index in a worker. The worker takes ownership of the positions
   * it is given, so it gets a copy and the mesh stays drawable. Until it finishes, low buildings
   * do not block clicks.
   */
  function indexLow(mesh) {
    indexing = indexing.then(async () => {
      if (mesh !== low) return;
      const copy = new THREE.BufferGeometry();
      copy.setAttribute('position', mesh.geometry.getAttribute('position').clone());
      const tree = await bvhWorker.generate(copy);
      if (mesh === low) mesh.geometry.boundsTree = tree;
    });
  }

  return {
    tall, build: buildCity,
    /** The merged mesh of every building under the cutoff (replaced by each build). */
    get low() { return low; },
    /** Resolves when the merged mesh's ray-test index is built. */
    get indexed() { return indexing; },
  };
}
