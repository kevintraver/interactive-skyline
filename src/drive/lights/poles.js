// Street-lamp poles near the car (plan 02, D5.4): an instanced pole, and an instanced arm with its head, for the
// lamps within POLE_ROAD_M of a road of the RoadNet and within POLE_CAR_M of the car, so a pool on the pavement
// has a visible source. The lamp position in the inventory is the head; the pole stands an arm's length back from
// it, against the aim, or where the aim is unknown, on the side away from the nearest road. The packer has already moved
// every pole off the modelled pavement (scripts/pack_lamps.py); one on a crossing road's deck stands on the deck (`lift`). The set is a function of
// the car's position snapped to SNAP_M, so scrubbing gives the same poles.

import * as THREE from 'three';

export const POLE_ROAD_M = 300;
export const POLE_CAR_M = 1500;
const SNAP_M = 250;
const BUCKET_M = 100;
const ARM_M = 2.4; // 8 ft arm (plan 02, 7.8; Clark County's specification)
const HIGHMAST_TYPE_KEY = 'led_highmast';

/** A spatial hash of road points (map metres) for nearest-road queries. */
export function createRoadIndex(roads, step = 10) {
  const buckets = new Map();
  const key = (bx, by) => bx * 73856093 ^ by * 19349663;
  for (const r of roads) {
    const every = Math.max(1, Math.round(step / (r.spacing || step)));
    for (let i = 0; i < r.x.length; i += every) {
      const x = r.x[i], y = r.y[i];
      const k = key(Math.floor(x / BUCKET_M), Math.floor(y / BUCKET_M));
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(x, y);
    }
  }
  return {
    /** Nearest road point within maxD of (x, y): [x, y, d] or null. */
    nearest(x, y, maxD) {
      const r = Math.ceil(maxD / BUCKET_M), bx = Math.floor(x / BUCKET_M), by = Math.floor(y / BUCKET_M);
      let best = null, bd = maxD * maxD;
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const b = buckets.get(key(bx + i, by + j));
          if (!b) continue;
          for (let k = 0; k < b.length; k += 2) {
            const d = (b[k] - x) ** 2 + (b[k + 1] - y) ** 2;
            if (d < bd) { bd = d; best = [b[k], b[k + 1]]; }
          }
        }
      }
      return best && [best[0], best[1], Math.sqrt(bd)];
    },
  };
}

/**
 * @param {{ pack: object, types: object, roads: object[], groundY: (x: number, y: number) => number, parent: THREE.Object3D,
 *   capacity?: number }} opts
 */
export function createPoles({ pack, types, roads, groundY, parent, capacity = 6000 }) {
  const roadIndex = createRoadIndex(roads);
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.14, 1, 6, 1, true).translate(0, 0.5, 0);
  // the arm from the pole top toward +x, and the head at its end (the lamp's position)
  const arm = new THREE.BoxGeometry(ARM_M, 0.1, 0.1).translate(ARM_M / 2, 0, 0);
  const head = new THREE.BoxGeometry(0.8, 0.16, 0.34).translate(ARM_M - 0.1, -0.06, 0);
  const armGeo = mergeBoxes(arm, head);
  const mat = new THREE.MeshLambertMaterial({ color: 0x8c8f91 });
  const poles = new THREE.InstancedMesh(poleGeo, mat, capacity);
  const arms = new THREE.InstancedMesh(armGeo, mat, capacity);
  poles.name = 'lamp-poles'; arms.name = 'lamp-arms';
  for (const m of [poles, arms]) { m.count = 0; m.frustumCulled = false; parent.add(m); }
  const highmast = [...types.byId.values()].find((t) => t.key === HIGHMAST_TYPE_KEY)?.id;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  // per lamp, worked out the first time it is near the car: the map angle toward its nearest road, or Infinity when
  // no road is within POLE_ROAD_M (NaN: not yet known)
  const toRoad = new Float32Array(pack.count).fill(NaN);
  let key = null, count = 0;

  function rebuild(cx, cy) {
    count = 0;
    const c0x = Math.max(0, Math.floor((cx - POLE_CAR_M - pack.x0) / pack.cell)), c1x = Math.min(pack.nx - 1, Math.floor((cx + POLE_CAR_M - pack.x0) / pack.cell));
    const c0y = Math.max(0, Math.floor((cy - POLE_CAR_M - pack.y0) / pack.cell)), c1y = Math.min(pack.ny - 1, Math.floor((cy + POLE_CAR_M - pack.y0) / pack.cell));
    for (let gy = c0y; gy <= c1y; gy++) {
      for (let gx = c0x; gx <= c1x && count < capacity; gx++) {
        const c = gy * pack.nx + gx;
        for (let i = pack.cellStart[c]; i < pack.cellStart[c + 1] && count < capacity; i++) {
          if (pack.enclosed[i]) continue;
          const x = pack.x[i], y = pack.y[i];
          if ((x - cx) ** 2 + (y - cy) ** 2 > POLE_CAR_M ** 2) continue;
          if (Number.isNaN(toRoad[i])) {
            const road = roadIndex.nearest(x, y, POLE_ROAD_M);
            toRoad[i] = road ? Math.atan2(road[1] - y, road[0] - x) : Infinity;
          }
          if (toRoad[i] === Infinity) continue;
          const mast = pack.type[i] === highmast;
          const len = mast ? 0.6 : ARM_M;
          // the arm points along the aim; unknown, toward the road
          let a = Number.isFinite(pack.aim[i]) ? (pack.aim[i] * Math.PI) / 180 : toRoad[i];
          if (!Number.isFinite(a)) a = 0;
          const fx = x - Math.cos(a) * len, fy = y - Math.sin(a) * len;
          const lift = pack.lift ? pack.lift[i] : 0; // on a deck, the pole stands on it (scripts/pack_lamps.py)
          const gyY = groundY(fx, fy);
          const top = gyY + pack.mount[i];
          m4.makeScale(1, pack.mount[i] - lift, 1).setPosition(fx, gyY + lift - 0.3, -fy);
          poles.setMatrixAt(count, m4);
          q.setFromAxisAngle(up, a); // map angle a about +y turns +x toward map +y (scene -z)
          s.setScalar(len / ARM_M);
          p.set(fx, top + 0.05, -fy);
          m4.compose(p, q, s);
          arms.setMatrixAt(count, m4);
          count++;
        }
      }
    }
    poles.count = arms.count = count;
    poles.instanceMatrix.needsUpdate = arms.instanceMatrix.needsUpdate = true;
    poles.instanceMatrix.clearUpdateRanges(); arms.instanceMatrix.clearUpdateRanges();
  }

  return {
    meshes: [poles, arms],
    material: mat,
    get count() { return count; },
    /** Follow the car (map metres); rebuilds when it enters another SNAP_M square. Returns whether it rebuilt. */
    update(x, y) {
      const sx = Math.round(x / SNAP_M) * SNAP_M, sy = Math.round(y / SNAP_M) * SNAP_M, k = `${sx},${sy}`;
      if (k === key) return false;
      key = k;
      rebuild(sx, sy);
      return true;
    },
    setVisible(on) { poles.visible = arms.visible = on; },
    dispose() {
      for (const m of [poles, arms]) { m.parent?.remove(m); m.dispose?.(); }
      poleGeo.dispose(); armGeo.dispose(); mat.dispose();
    },
  };
}

function mergeBoxes(a, b) {
  const g = new THREE.BufferGeometry();
  const attrs = ['position', 'normal'];
  for (const name of attrs) {
    const x = a.getAttribute(name).array, y = b.getAttribute(name).array;
    const arr = new Float32Array(x.length + y.length);
    arr.set(x); arr.set(y, x.length);
    g.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  const na = a.getAttribute('position').count;
  const ia = a.index.array, ib = b.index.array;
  const idx = new Uint16Array(ia.length + ib.length);
  idx.set(ia);
  for (let i = 0; i < ib.length; i++) idx[ia.length + i] = ib[i] + na;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  a.dispose(); b.dispose();
  return g;
}
