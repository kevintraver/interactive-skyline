// A small interchange for the tests: a straight carriageway going east, an exit ramp leaving it on
// the right through a gore, and a road crossing it on a deck with a pier and two abutments.
import { encodeRoadNet, decodeRoadNet } from '../../../src/drive/roadnet/format.js';

export const MAIN_H = 700;
export const CF = 0.02;
const SP = 4;

function line({ x0, y0, h0 = 0, heading0, n, curvature = () => 0, h = () => h0, crossfall = () => CF }) {
  const x = [], y = [], hh = [], hd = [], k = [], cf = [];
  let px = x0, py = y0, a = heading0;
  for (let i = 0; i < n; i++) {
    const s = i * SP;
    x.push(px); y.push(py); hh.push(h(s)); hd.push(a); k.push(curvature(s)); cf.push(crossfall(s));
    // integrate over the next 4 m with the curvature at its middle (keeps chords at 4 m)
    const kk = curvature(s + SP / 2);
    const a1 = a + kk * SP;
    const am = (a + a1) / 2;
    const chord = Math.abs(kk) > 1e-12 ? (2 * Math.sin((kk * SP) / 2)) / kk : SP;
    px += chord * Math.cos(am); py += chord * Math.sin(am);
    a = a1;
  }
  return { x, y, h: hh, heading: hd, curvature: k, crossfall: cf };
}

export function interchangeInput() {
  const main = {
    id: 'm.main', ref: 'I 99', dir: 'east',
    sections: [{ s0: 0, s1: 1000, lanes: [{}, {}, {}] }],
    ...line({ x0: 0, y0: 0, heading0: 0, n: 251, h: () => MAIN_H }),
  };
  // the ramp's reference line is its lane's left edge, 0.9 m right of the main's right lane edge
  const d0 = -(3 * 3.66) / 2 - 0.9;
  const ramp = {
    id: 'm.x1.off', role: 'ramp', class: 'motorway_link',
    sections: [
      { s0: 0, s1: 4, lanes: [{ w: 0.05, kind: 'ramp' }], placement: 'left_of:1', left: { shoulder: 0.3, edge: 'white' }, right: { shoulder: 2.44 } },
      { s0: 4, s1: 180, lanes: [{ w: 3.66, kind: 'ramp' }], placement: 'left_of:1', left: { shoulder: 0.3, edge: 'white' }, right: { shoulder: 2.44 }, taper: { s0: 4, s1: 144 } },
      { s0: 180, s1: 400, lanes: [{ w: 3.66, kind: 'ramp' }], placement: 'left_of:1', left: { shoulder: 1.22 }, right: { shoulder: 2.44 }, taper: { s0: 180, s1: 220 } },
    ],
    embankment: [{ s0: 0, s1: 400, side: 'right', w: 2 }],
    ...line({ x0: 200, y0: d0, heading0: 0, n: 101, curvature: (s) => (s > 100 ? -1 / 300 : 0), h: () => MAIN_H + CF * d0 }),
  };
  // the crossing road goes north over the main at x = 700, 7.5 m up at its middle
  const crossing = {
    id: 'x.cross', role: 'crossing', class: 'secondary',
    sections: [{ s0: 0, s1: 300, lanes: [{ w: 3.5 }, { w: 3.5, line: 'solid' }, { w: 3.5 }, { w: 3.5 }], left: { shoulder: 1.5, edge: 'white' }, right: { shoulder: 1.5 } }],
    bridges: [{ s0: 120, s1: 180, kind: 'bridge', deck: true }],
    ...line({ x0: 700, y0: -150, heading0: Math.PI / 2, n: 76, crossfall: () => 0, h: (s) => MAIN_H - 0.5 + 8 * Math.exp(-(((s - 150) / 70) ** 2)) }),
  };
  return {
    version: 1, source: { test: 'interchange' },
    roads: [main, ramp, crossing],
    junctions: [{
      id: 'm.x1.off.g0', kind: 'diverge', side: 'right',
      a: { road: 'm.main', s0: 200, s1: 380 }, b: { road: 'm.x1.off', s0: 0, s1: 180 },
      gore: { a: [200, 260, 300, 340, 380], b: [0, 60, 100, 140, 180] },
    }],
    structures: [
      { kind: 'pier', road: 'x.cross', s: 150, d: 0, w: 14, t: 1.2, h0: MAIN_H - 2, h1: MAIN_H + 7.5 - 1.2 - 0.6 },
      { kind: 'abutment', road: 'x.cross', s: 120, dir: 1, d: 0, w: 18, len: 6, h1: MAIN_H + 4.5, h0: MAIN_H - 1 },
      { kind: 'abutment', road: 'x.cross', s: 180, dir: -1, d: 0, w: 18, len: 6, h1: MAIN_H + 4.5, h0: MAIN_H - 1 },
      { kind: 'sign-gantry', note: 'an unknown kind, kept and ignored' },
    ],
  };
}

/** The interchange as files and decoded. */
export function interchange() {
  const { json, bin } = encodeRoadNet(interchangeInput());
  return { json, bin, net: decodeRoadNet(JSON.parse(JSON.stringify(json)), bin) };
}
