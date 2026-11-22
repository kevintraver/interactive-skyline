/**
 * A synthetic RoadNet for tests and the manual page, about 55 km from the origin so float32
 * precision problems would show.
 *
 * Road A "test.main", 3000 m northeast-bound: straight 800 m, a 60 m spiral into a 600 m radius left
 * curve for 700 m, a spiral out, straight to the end. Flat at 790 m to s = 1000, then a 200 m vertical
 * curve into a 4% climb, another back to level at s = 2400. Crossfall 2% (left edge higher), banked
 * -3% through the curve. Three lanes to s = 1600, then four.
 * Road B "test.south", the opposite carriageway: 1200 m alongside the first straight, 30 m to the
 * right of A, two lanes, its reference line on lane 1's left edge.
 *
 * Run `node tests/fixtures/roadnet/synthetic.js` to rewrite roadnet.json and roadnet.bin beside it.
 */
import { encodeRoadNet } from '../../../src/drive/roadnet/format.js';

export const START = { x: -38000, y: -40000, heading: 0.6, h: 790 };
const SPACING = 4;
const R = 600;

/** Curvature of road A at s. */
function curvatureA(s) {
  if (s < 800 || s >= 1620) return 0;
  if (s < 860) return (s - 800) / 60 / R;
  if (s < 1560) return 1 / R;
  return (1620 - s) / 60 / R;
}

/** Height of road A at s: level, vertical curve, 4% climb, vertical curve, level. */
export function heightA(s) {
  const g = 0.04, L = 200;
  if (s <= 1000) return START.h;
  if (s <= 1200) return START.h + (g * (s - 1000) ** 2) / (2 * L);
  if (s <= 2200) return START.h + g * L / 2 + g * (s - 1200);
  if (s <= 2400) return START.h + g * L / 2 + g * 1000 + g * (s - 2200) - (g * (s - 2200) ** 2) / (2 * L);
  return START.h + g * 1200;
}

function crossfallA(s) {
  if (s < 800 || s >= 1620) return 0.02;
  if (s < 860) return 0.02 - (0.05 * (s - 800)) / 60;
  if (s < 1560) return -0.03;
  return -0.03 + (0.05 * (s - 1560)) / 60;
}

/** Stations of road A by integrating heading in 1 cm steps (midpoint rule; exact to micrometres). */
export function stationsA(length = 3000) {
  const n = length / SPACING + 1;
  const out = { x: new Float64Array(n), y: new Float64Array(n), h: new Float64Array(n), heading: new Float64Array(n), curvature: new Float64Array(n), crossfall: new Float64Array(n) };
  let x = START.x, y = START.y, th = START.heading;
  const ds = 0.01, per = Math.round(SPACING / ds);
  for (let i = 0; i < n; i++) {
    const s = i * SPACING;
    out.x[i] = x; out.y[i] = y; out.heading[i] = th; out.h[i] = heightA(s);
    out.curvature[i] = curvatureA(s); out.crossfall[i] = crossfallA(s);
    if (i === n - 1) break;
    for (let k = 0; k < per; k++) {
      const sm = s + (k + 0.5) * ds;
      const thm = th + curvatureA(sm) * ds / 2;
      x += Math.cos(thm) * ds; y += Math.sin(thm) * ds;
      th += curvatureA(sm) * ds;
    }
  }
  return out;
}

export function buildSyntheticRoadNet() {
  const a = stationsA();
  // B runs back along A's first 1200 m (straight), 30 m to A's right
  const nB = 1200 / SPACING + 1;
  const b = { x: new Float64Array(nB), y: new Float64Array(nB), h: new Float64Array(nB), heading: new Float64Array(nB), curvature: new Float64Array(nB), crossfall: new Float64Array(nB) };
  const c = Math.cos(START.heading), sn = Math.sin(START.heading);
  for (let i = 0; i < nB; i++) {
    const sA = 1200 - i * SPACING;
    b.x[i] = START.x + c * sA + 30 * sn;
    b.y[i] = START.y + sn * sA - 30 * c;
    b.h[i] = heightA(sA);
    b.heading[i] = START.heading + Math.PI;
    b.crossfall[i] = 0.02;
  }
  return {
    version: 1,
    source: { generator: 'tests/fixtures/roadnet/synthetic.js' },
    roads: [
      {
        id: 'test.main', ref: 'T 1', dir: 'northeast', class: 'motorway', spacing: SPACING,
        sections: [
          { s0: 0, s1: 1600, lanes: [{ w: 3.66 }, { w: 3.66 }, { w: 3.66 }], left: { shoulder: 3.05, edge: 'yellow' }, right: { shoulder: 3.05, edge: 'white', rumble: true }, placement: 'centre' },
          { s0: 1600, s1: 3000, lanes: [{ w: 3.66 }, { w: 3.66 }, { w: 3.66 }, { w: 3.66 }], left: { shoulder: 3.05 }, right: { shoulder: 3.05 }, placement: 'centre' },
        ],
        speed: [{ s0: 0, mph: 70 }],
        links: [{ s: 1500, side: 'right', kind: 'exit', ref: '1', to: 'test.x1' }],
        ...a,
      },
      {
        id: 'test.south', ref: 'T 1', dir: 'southwest', class: 'motorway', spacing: SPACING,
        sections: [{ s0: 0, s1: 1200, lanes: [{ w: 3.66 }, { w: 3.66 }], placement: 'left_of:1' }],
        ...b,
      },
    ],
  };
}

// Write the files when run directly.
if (typeof process !== 'undefined' && process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { writeFileSync } = await import('node:fs');
  const { json, bin } = encodeRoadNet(buildSyntheticRoadNet());
  const dir = new URL('.', import.meta.url);
  writeFileSync(new URL('roadnet.json', dir), JSON.stringify(json, null, 2) + '\n');
  writeFileSync(new URL('roadnet.bin', dir), new Uint8Array(bin));
  console.log(`wrote roadnet.json and roadnet.bin (${bin.byteLength} bytes)`);
}
