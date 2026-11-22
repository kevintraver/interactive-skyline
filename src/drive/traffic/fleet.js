// The vehicles of one frame, placed on the road (plan 02, D6.4). Pure: no three.js, no DOM, no
// allocation per frame (buffers grow, and only then allocate, when a frame holds more vehicles than ever).
//
// Every frame is a function of (simulation time, the visitor's pose): the traffic model says which
// vehicles are where along the route (demand.js), the lane map says where their lane is on their own
// carriageway (lanemap.js), and each vehicle is put on its lane's centre line on the road surface:
//   position  the reference line at the road's chainage, moved sideways by the lane offset, at the
//             pavement height there (reference height + crossfall x offset), in scene axes with the
//             earth's curvature as the road mesh has it (frame.sceneY);
//   forward   along the road in the vehicle's direction of travel, pitched with the grade (and the curve
//             drop), turned by the lane's sideways drift where its centre line moves (tapers, blends);
//   up        normal to the pavement: banked with the crossfall.
// The model's origin is on the ground under the footprint centre, so the wheels sit on the pavement.
//
// Opacity (alpha, 0..1; the renderer dissolves a vehicle by it, so nothing pops) is the product of
//   - the model's fade where a vehicle joins or leaves at a segment boundary (fadeSeconds of travel);
//   - the lane map's weight (a lane narrowing in a taper, a traffic lane with no road lane);
//   - the gap kept around the visitor's car (below).
//
// The gap around the visitor's car (until D6.5 lets the car follow traffic). The car drives its lane at
// the posted speed, so vehicles of the same stream would run through it. A vehicle of the car's own
// direction is left out when it overlaps the car's path sideways (|lateral| < LAT_IN m between centres,
// fading out from LAT_OUT, so a lane change of the car does not pop anyone) AND it is within the headway
// window: measured in the model's slots (slotAt at the car's place, in the vehicle's own lane: slot
// headway h = (n_car - k) / slot rate, seconds), a vehicle ahead is gone at h < AHEAD_S and whole at
// h > AHEAD_S + BAND_S, one behind gone at -h < BEHIND_S and whole beyond BEHIND_S + BAND_S; and, so that
// the rule holds in a queue where slots are packed tight, a metric gap (bumper to bumper) of at least
// AHEAD_M ahead and BEHIND_M behind, fading over BAND_M. So alpha_gap = max(side, min(slot, metric)),
// side being 1 clear of the car's path. Anything closer than the bodies' half lengths plus HARD_M is 0
// whatever the slots say, so nothing ever overlaps the car; and since every factor is a smooth function
// of the simulation time, a vehicle the car closes on dissolves over the band instead of vanishing.

import { createVehicleBuffer } from './demand.js';

export const CAR_LENGTH = 4.8;
export const GAP = Object.freeze({
  LAT_IN: 2.3, LAT_OUT: 3.0, // m, centre to centre sideways
  AHEAD_S: 2.0, BEHIND_S: 1.2, BAND_S: 1.0, // s of slot headway
  AHEAD_M: 12, BEHIND_M: 6, BAND_M: 20, // m, bumper to bumper
  HARD_M: 2, // m beyond the half lengths: always 0
});
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Body index (demand.js BODIES order) -> name in vehicles.json. */
export const BODY_NAMES = ['sedan', 'crossover', 'pickup', 'van', 'tractor_trailer', 'coach'];

/**
 * @param {{ traffic: object, laneMap: object, frame: { sceneY(h, x, y): number }, lengths: number[], earthR: number }} opts
 *   lengths: body lengths (m) in BODY_NAMES order; earthR: the radius the scene's curve drop uses.
 */
export function createFleet({ traffic, laneMap, frame, lengths, earthR }) {
  const bufs = { with: createVehicleBuffer(512), against: createVehicleBuffer(512) };
  const slotRate = { with: new Float64Array(9), against: new Float64Array(9) };
  for (const dir of ['with', 'against']) for (const L of traffic.lanes(dir)) slotRate[dir][L.lane] = L.slotVph / 3600;

  // the placed vehicles, struct of arrays
  const out = { count: 0, capacity: 0 };
  const FIELDS = {
    pos: [Float64Array, 3], fwd: [Float32Array, 3], up: [Float32Array, 3],
    alpha: [Float32Array, 1], brake: [Uint8Array, 1], body: [Uint8Array, 1], colour: [Uint32Array, 1],
    id: [Float64Array, 1], dir: [Uint8Array, 1], lane: [Uint8Array, 1], s: [Float64Array, 1], k: [Float64Array, 1],
    speed: [Float32Array, 1], sRoad: [Float64Array, 1], d: [Float32Array, 1], fade: [Float32Array, 1], weight: [Float32Array, 1], gap: [Float32Array, 1],
  };
  function grow(n) {
    for (const [name, [T, w]] of Object.entries(FIELDS)) {
      const a = new T(n * w);
      if (out.capacity) a.set(out[name].subarray(0, out.count * w));
      out[name] = a;
    }
    out.capacity = n;
  }
  grow(1024);

  const r = {}, lm = { sRoad: 0, d: 0, dds: 0, w: 0 };
  const nCar = new Float64Array(9);
  const nCarOk = new Uint8Array(9);
  const stats = { enumerated: 0, placed: 0, hidden: 0, gapped: 0 };

  /**
   * Place the vehicles between route chainages sA and sB at simMs.
   * @param {number} simMs  @param {number} sA  @param {number} sB
   * @param {{ s: number, position: {x,y,z}, forward: {x,y,z}, right: {x,y,z} } | null} car the visitor's pose (null: no gap)
   * @returns the placed vehicles { count, pos[3n], fwd[3n], up[3n], alpha, brake, body, colour, id, dir (0 with, 1 against), lane, s, k, speed, ... }
   */
  function place(simMs, sA, sB, car) {
    out.count = 0;
    stats.enumerated = 0; stats.hidden = 0; stats.gapped = 0;
    nCarOk.fill(0);
    for (let di = 0; di < 2; di++) {
      const dir = di === 0 ? 'with' : 'against';
      const b = bufs[dir];
      traffic.vehiclesIn(dir, sA, sB, simMs, b);
      stats.enumerated += b.count;
      const ld = laneMap.dirs[dir];
      const ref = ld.refline;
      const bLane = b.lane, bS = b.s, bFade = b.fade, bBody = b.body, bK = b.k, bAccel = b.accel, bColour = b.colour, bId = b.id, bSpeed = b.speed;
      let P = out.pos, FW = out.fwd, UP = out.up;
      for (let v = 0; v < b.count; v++) {
        const lane = bLane[v];
        laneMap.atDir(ld, lane, bS[v], lm);
        const fade = bFade[v];
        let alpha = fade * lm.w;
        if (alpha <= 0.002) { stats.hidden++; continue; }
        ref.at(lm.sRoad, r);
        const ch = Math.cos(r.heading), sh = Math.sin(r.heading);
        const d = lm.d;
        const mx = r.x - sh * d, my = r.y + ch * d;
        const Y = frame.sceneY(r.h + r.crossfall * d, mx, my);
        // scene position (x, Y, -y)
        const px = mx, py = Y, pz = -my;
        // forward along the road's own direction (every vehicle drives its road's +s: "against" is the other
        // carriageway, whose chainage runs its way), drifting sideways by dd/ds
        const tx = ch - sh * lm.dds, ty = sh + ch * lm.dds;
        const tl = Math.sqrt(tx * tx + ty * ty);
        const fx0 = tx / tl, fy0 = ty / tl;
        const rise = (r.grade + r.crossfall * lm.dds) - (mx * fx0 + my * fy0) / earthR;
        // scene forward (fx, rise, -fy), normalised
        let Fx = fx0, Fy = rise, Fz = -fy0;
        const fl = Math.sqrt(Fx * Fx + Fy * Fy + Fz * Fz);
        Fx /= fl; Fy /= fl; Fz /= fl;
        // left across the pavement: map (-sh, ch), rising by the crossfall less the curve drop
        const lx = -sh, lzMap = ch;
        const lrise = r.crossfall - (mx * lx + my * lzMap) / earthR;
        const Lx = lx, Ly = lrise, Lz = -lzMap;
        // up = forward x left
        let Ux = Fy * Lz - Fz * Ly, Uy = Fz * Lx - Fx * Lz, Uz = Fx * Ly - Fy * Lx;
        const ul = Math.sqrt(Ux * Ux + Uy * Uy + Uz * Uz);
        Ux /= ul; Uy /= ul; Uz /= ul;

        // the gap around the visitor's car
        let gapA = 1;
        if (car && di === 0) {
          const ex = px - car.position.x, ey = py - car.position.y, ez = pz - car.position.z;
          const lat = ex * car.right.x + ey * car.right.y + ez * car.right.z;
          const lon = ex * car.forward.x + ey * car.forward.y + ez * car.forward.z;
          const alat = Math.abs(lat);
          if (alat < GAP.LAT_OUT && Math.abs(lon) < 400) {
            const side = smooth((alat - GAP.LAT_IN) / (GAP.LAT_OUT - GAP.LAT_IN));
            const half = 0.5 * (lengths[bBody[v]] + CAR_LENGTH);
            const gapM = Math.abs(lon) - half;
            let along;
            if (gapM < GAP.HARD_M) along = 0;
            else {
              // slot headway in the vehicle's lane
              if (!nCarOk[lane]) {
                nCar[lane] = slotRate.with[lane] > 0 ? traffic.slotAt('with', lane, car.s, simMs) : NaN;
                nCarOk[lane] = 1;
              }
              const rate = slotRate.with[lane];
              const h = rate > 0 ? (nCar[lane] - bK[v]) / rate : (lon > 0 ? Infinity : -Infinity);
              let slotF, metF;
              if (lon > 0) {
                slotF = smooth((h - GAP.AHEAD_S) / GAP.BAND_S);
                metF = smooth((gapM - GAP.AHEAD_M) / GAP.BAND_M);
              } else {
                slotF = smooth((-h - GAP.BEHIND_S) / GAP.BAND_S);
                metF = smooth((gapM - GAP.BEHIND_M) / GAP.BAND_M);
              }
              along = slotF < metF ? slotF : metF;
            }
            gapA = side > along ? side : along;
            if (gapA < 1) stats.gapped++;
          }
        }
        alpha *= gapA;
        if (alpha <= 0.002) { stats.hidden++; continue; }

        if (out.count >= out.capacity) { grow(out.capacity * 2); P = out.pos; FW = out.fwd; UP = out.up; }
        const i = out.count++, i3 = 3 * i;
        P[i3] = px; P[i3 + 1] = py; P[i3 + 2] = pz;
        FW[i3] = Fx; FW[i3 + 1] = Fy; FW[i3 + 2] = Fz;
        UP[i3] = Ux; UP[i3 + 1] = Uy; UP[i3 + 2] = Uz;
        out.alpha[i] = alpha > 1 ? 1 : alpha;
        out.brake[i] = bAccel[v] < 0 ? 1 : 0;
        out.body[i] = bBody[v];
        out.colour[i] = bColour[v];
        out.id[i] = bId[v] * 2 + di;
        out.dir[i] = di;
        out.lane[i] = lane;
        out.s[i] = bS[v];
        out.k[i] = bK[v];
        out.speed[i] = bSpeed[v];
        out.sRoad[i] = lm.sRoad;
        out.d[i] = d;
        out.fade[i] = fade;
        out.weight[i] = lm.w;
        out.gap[i] = gapA;
      }
    }
    stats.placed = out.count;
    return out;
  }

  return {
    place,
    placed: out,
    stats: () => ({ ...stats }),
  };
}
